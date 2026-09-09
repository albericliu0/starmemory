//! Pure-Rust BM25 engine over tantivy. Deliberately knows nothing about LMDB,
//! embeddings, or napi -- see design doc §08: "addon 里不碰 LMDB，不碰业务逻辑".
//! That is what makes this file testable on its own.

use std::ops::Bound;
use std::path::Path;

use tantivy::collector::TopDocs;
use tantivy::directory::MmapDirectory;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{
    Field, IndexRecordOption, Schema, TextFieldIndexing, TextOptions, Value, FAST, INDEXED, STORED,
    STRING,
};
use tantivy::tokenizer::{
    Language, LowerCaser, RemoveLongFilter, Stemmer, TextAnalyzer, Token, TokenStream, Tokenizer,
};
use tantivy::{Index, IndexReader, IndexWriter, ReloadPolicy, TantivyDocument, TantivyError, Term};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Schema/tokenizer generation. Bump this whenever the schema or the analyzer
/// chain changes: an index built by an older version cannot answer queries
/// parsed by a newer one, so the caller rebuilds from LMDB (design doc §10).
pub const INDEX_VERSION: u32 = 2; // 2: harness field

const TOKENIZER: &str = "mixed";

/// tantivy's floor is 15 MB per writer thread; this is a comfortable single-thread budget.
const WRITER_HEAP_BYTES: usize = 50_000_000;

/// Transcripts contain base64 blobs and minified bundles. Nobody searches for a
/// 900-character "word", so drop them instead of paying to index them.
const MAX_TOKEN_BYTES: usize = 40;

#[derive(Debug, Clone)]
pub struct Doc {
    pub id: u64,
    pub text: String,
    pub project: String,
    pub session_id: String,
    /// Which coding agent wrote the transcript: `claude` or `codex`.
    pub harness: String,
    pub timestamp_ms: u64,
    pub is_sidechain: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub harness: Option<String>,
    pub after_ms: Option<u64>,
    pub before_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: u64,
    pub score: f32,
}

#[derive(Debug, Clone, Copy)]
struct Fields {
    id: Field,
    text: Field,
    project: Field,
    session: Field,
    harness: Field,
    timestamp: Field,
    sidechain: Field,
}

fn build_schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();

    // Stored so a hit can be turned back into an LMDB key.
    let id = builder.add_u64_field("id", STORED | INDEXED | FAST);

    // Positions are what make a quoted phrase query possible. The body itself is
    // not stored -- LMDB already holds the only copy of the text (design doc §04).
    let text = builder.add_text_field(
        "text",
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(TOKENIZER)
                .set_index_option(IndexRecordOption::WithFreqsAndPositions),
        ),
    );

    // STRING means "one raw token, exact match" -- right for identifiers, wrong for prose.
    let project = builder.add_text_field("project", STRING);
    let session = builder.add_text_field("session_id", STRING);
    let harness = builder.add_text_field("harness", STRING);
    let timestamp = builder.add_u64_field("timestamp_ms", INDEXED | FAST);
    let sidechain = builder.add_u64_field("is_sidechain", INDEXED);

    (
        builder.build(),
        Fields { id, text, project, session, harness, timestamp, sidechain },
    )
}

/// jieba on its own emits one token per space, and tantivy-jieba's ordinal mode
/// then numbers those spaces as positions. A phrase query would end up depending
/// on how many spaces the writer typed. This wrapper keeps only tokens that carry
/// a letter or a digit and numbers the positions over those, so "adjacent" means
/// adjacent words. `char::is_alphanumeric` is true for Chinese characters, which
/// is why the rule can be one rule for both languages.
#[derive(Clone)]
struct WordTokenizer(tantivy_jieba::JiebaTokenizer);

struct WordStream {
    tokens: Vec<Token>,
    cursor: usize,
}

impl Tokenizer for WordTokenizer {
    type TokenStream<'a> = WordStream;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        let mut inner = self.0.token_stream(text);
        let mut tokens: Vec<Token> = Vec::new();
        while inner.advance() {
            let token = inner.token();
            if token.text.chars().any(char::is_alphanumeric) {
                tokens.push(Token {
                    offset_from: token.offset_from,
                    offset_to: token.offset_to,
                    position: tokens.len(),
                    text: token.text.clone(),
                    position_length: 1,
                });
            }
        }
        WordStream { tokens, cursor: 0 }
    }
}

impl TokenStream for WordStream {
    fn advance(&mut self) -> bool {
        if self.cursor < self.tokens.len() {
            self.cursor += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.tokens[self.cursor - 1]
    }

    fn token_mut(&mut self) -> &mut Token {
        let index = self.cursor - 1;
        &mut self.tokens[index]
    }
}

/// jieba segments Chinese and passes Latin words through untouched, so one field
/// handles the mixed-language text our transcripts are full of. Lowercasing and
/// English stemming run after it (design doc §05).
fn build_analyzer() -> TextAnalyzer {
    let jieba = tantivy_jieba::JiebaTokenizer::with_ordinal_position_mode(true);
    TextAnalyzer::builder(WordTokenizer(jieba))
        .filter(RemoveLongFilter::limit(MAX_TOKEN_BYTES))
        .filter(LowerCaser)
        .filter(Stemmer::new(Language::English))
        .build()
}

fn register_tokenizer(index: &Index) {
    index.tokenizers().register(TOKENIZER, build_analyzer());
}

pub struct TextEngine {
    index: Index,
    reader: IndexReader,
    fields: Fields,
    writer: Option<IndexWriter>,
}

impl TextEngine {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let (schema, fields) = build_schema();
        let index = match Index::open_or_create(MmapDirectory::open(dir)?, schema.clone()) {
            Ok(index) => index,
            // An index left by an older INDEX_VERSION. tantivy will not open it,
            // and the version check on the TypeScript side never gets to run.
            // The index is a cache over LMDB (design doc §10), so start it over;
            // the caller's version mismatch then reloads every row from the store.
            Err(TantivyError::SchemaError(_)) => {
                for entry in std::fs::read_dir(dir)? {
                    let path = entry?.path();
                    if path.is_dir() {
                        std::fs::remove_dir_all(&path)?;
                    } else {
                        std::fs::remove_file(&path)?;
                    }
                }
                Index::open_or_create(MmapDirectory::open(dir)?, schema)?
            }
            Err(e) => return Err(e.into()),
        };
        register_tokenizer(&index);

        // Manual reload keeps "when do new documents become visible" explicit:
        // they appear on commit(), not on a background timer.
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        Ok(Self { index, reader, fields, writer: None })
    }

    /// Tries to take tantivy's exclusive `.tantivy-writer.lock`. Returns false
    /// when another process already holds it (design doc §09) -- that is a normal
    /// outcome, not an error.
    pub fn try_acquire_writer(&mut self) -> Result<bool> {
        if self.writer.is_some() {
            return Ok(true);
        }
        match self.index.writer(WRITER_HEAP_BYTES) {
            Ok(writer) => {
                self.writer = Some(writer);
                Ok(true)
            }
            Err(TantivyError::LockFailure(..)) => Ok(false),
            Err(e) => Err(Box::new(e)),
        }
    }

    /// Idempotent: adding an id that is already indexed replaces it. sync commits
    /// the index and then advances a cursor in LMDB; a crash between the two
    /// replays the batch, and a replay must not double the index (design doc
    /// §17 item 1). tantivy applies a delete only to documents added before it,
    /// so delete-then-add in one commit is exactly "replace".
    pub fn add_documents(&mut self, docs: &[Doc]) -> Result<()> {
        let fields = self.fields;
        let writer = self.writer.as_mut().ok_or(NO_WRITER)?;
        for d in docs {
            writer.delete_term(Term::from_field_u64(fields.id, d.id));
            let mut doc = TantivyDocument::new();
            doc.add_u64(fields.id, d.id);
            doc.add_text(fields.text, &d.text);
            doc.add_text(fields.project, &d.project);
            doc.add_text(fields.session, &d.session_id);
            doc.add_text(fields.harness, &d.harness);
            doc.add_u64(fields.timestamp, d.timestamp_ms);
            doc.add_u64(fields.sidechain, u64::from(d.is_sidechain));
            writer.add_document(doc)?;
        }
        Ok(())
    }

    /// fsyncs, then makes the new segments visible to this handle's reader.
    /// Batch your writes: this is the expensive call (design doc §10).
    pub fn commit(&mut self) -> Result<()> {
        if let Some(writer) = self.writer.as_mut() {
            writer.commit()?;
        }
        self.reader.reload()?;
        Ok(())
    }

    pub fn delete_all(&mut self) -> Result<()> {
        let writer = self.writer.as_mut().ok_or(NO_WRITER)?;
        writer.delete_all_documents()?;
        Ok(())
    }

    pub fn search(&self, query: &str, k: usize, filter: &Filter) -> Result<Vec<Hit>> {
        if k == 0 {
            return Ok(Vec::new());
        }
        let Some(user_query) = self.parse(query) else {
            return Ok(Vec::new());
        };
        let fields = self.fields;

        let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, user_query)];

        if let Some(project) = &filter.project {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(fields.project, project),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if let Some(session) = &filter.session_id {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(fields.session, session),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if let Some(harness) = &filter.harness {
            clauses.push((
                Occur::Must,
                Box::new(TermQuery::new(
                    Term::from_field_text(fields.harness, harness),
                    IndexRecordOption::Basic,
                )),
            ));
        }
        if filter.after_ms.is_some() || filter.before_ms.is_some() {
            let lower = match filter.after_ms {
                Some(v) => Bound::Included(Term::from_field_u64(fields.timestamp, v)),
                None => Bound::Unbounded,
            };
            let upper = match filter.before_ms {
                Some(v) => Bound::Included(Term::from_field_u64(fields.timestamp, v)),
                None => Bound::Unbounded,
            };
            clauses.push((Occur::Must, Box::new(RangeQuery::new(lower, upper))));
        }

        // Subagent turns are stored but never searched (design doc §04). Excluding
        // them here rather than after the fact means they do not consume top-k slots.
        clauses.push((
            Occur::MustNot,
            Box::new(TermQuery::new(
                Term::from_field_u64(fields.sidechain, 1),
                IndexRecordOption::Basic,
            )),
        ));

        let searcher = self.reader.searcher();
        let top = searcher.search(&BooleanQuery::new(clauses), &TopDocs::with_limit(k).order_by_score())?;

        let mut hits = Vec::with_capacity(top.len());
        for (score, address) in top {
            let doc: TantivyDocument = searcher.doc(address)?;
            if let Some(id) = doc.get_first(fields.id).and_then(|v| v.as_u64()) {
                hits.push(Hit { id, score });
            }
        }
        Ok(hits)
    }

    pub fn num_docs(&self) -> Result<u64> {
        Ok(self.reader.searcher().num_docs())
    }

    /// A query containing a double quote is treated as tantivy query syntax, so
    /// phrases and boolean operators keep working. Anything else is prose: we
    /// analyze it ourselves and OR the terms together.
    ///
    /// Doing the prose case by hand avoids a rule that quietly breaks Chinese.
    /// tantivy's parser turns any single word that produces several tokens into a
    /// *phrase* query, and every Chinese query is one word producing several
    /// tokens. Searching 内存泄漏 would then demand exactly that segmentation, so
    /// a transcript saying 内存的泄漏 would never be found -- which is the whole
    /// reason this index exists (design doc §01).
    fn parse(&self, query: &str) -> Option<Box<dyn Query>> {
        if query.contains('"') {
            let parser = QueryParser::for_index(&self.index, vec![self.fields.text]);
            if let Ok(parsed) = parser.parse_query(query) {
                return Some(parsed);
            }
        }

        let terms = self.analyze(query);
        if terms.is_empty() {
            return None;
        }
        let clauses: Vec<(Occur, Box<dyn Query>)> = terms
            .into_iter()
            .map(|text| {
                let term = Term::from_field_text(self.fields.text, &text);
                let query: Box<dyn Query> =
                    Box::new(TermQuery::new(term, IndexRecordOption::WithFreqs));
                (Occur::Should, query)
            })
            .collect();
        Some(Box::new(BooleanQuery::new(clauses)))
    }

    /// Run text through the same analyzer the index used, so the terms we search
    /// for are exactly the terms that were stored.
    fn analyze(&self, text: &str) -> Vec<String> {
        let mut analyzer = build_analyzer();
        let mut stream = analyzer.token_stream(text);
        let mut out = Vec::new();
        while stream.advance() {
            out.push(stream.token().text.clone());
        }
        out
    }
}

const NO_WRITER: &str = "index writer not acquired -- call try_acquire_writer() first";

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn doc(id: u64, text: &str) -> Doc {
        Doc {
            id,
            text: text.to_string(),
            project: "proj-a".to_string(),
            session_id: "sess-1".to_string(),
            harness: "claude".to_string(),
            timestamp_ms: 1_700_000_000_000,
            is_sidechain: false,
        }
    }

    /// Build an engine in a temp dir, write the docs, commit.
    fn engine_with(docs: &[Doc]) -> (TempDir, TextEngine) {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        assert!(engine.try_acquire_writer().unwrap(), "fresh index should not be locked");
        engine.add_documents(docs).unwrap();
        engine.commit().unwrap();
        (dir, engine)
    }

    fn ids(hits: &[Hit]) -> Vec<u64> {
        hits.iter().map(|h| h.id).collect()
    }

    #[test]
    fn ranks_the_document_that_is_actually_about_the_term_first() {
        let (_d, engine) = engine_with(&[
            doc(1, "we talked about lunch and then someone mentioned compaction once"),
            doc(2, "compaction is stuck. the compaction thread pool never drains, so compaction lags"),
        ]);

        let hits = engine.search("compaction", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits)[0], 2, "the denser document should outrank the passing mention");
    }

    #[test]
    fn matches_english_words_in_a_different_form() {
        let (_d, engine) = engine_with(&[doc(1, "the compaction has failed on this tablet")]);

        let hits = engine.search("compaction failed", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![1], "stemming should bridge failed/failing/fails");
    }

    #[test]
    fn segments_chinese_so_a_query_matches_across_an_inserted_character() {
        // Substring matching fails here: the text says 内存的泄漏, the query says 内存泄漏.
        let (_d, engine) = engine_with(&[
            doc(1, "这次排查了很久，最后发现是内存的泄漏问题"),
            doc(2, "我们讨论了磁盘空间和网络超时的处理"),
        ]);

        let hits = engine.search("内存泄漏", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![1]);
    }

    #[test]
    fn ranks_a_chinese_document_matching_both_terms_above_one_matching_a_single_term() {
        let (_d, engine) = engine_with(&[
            doc(1, "内存使用率一直很高，需要盯着"),
            doc(2, "内存的泄漏定位到了，是连接池没有关闭导致的泄漏"),
        ]);

        let hits = engine.search("内存泄漏", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits)[0], 2);
    }

    #[test]
    fn a_quoted_query_requires_the_words_to_be_adjacent() {
        let (_d, engine) = engine_with(&[
            doc(1, "the connection pool was exhausted"),
            doc(2, "the connection was slow and the pool was full"),
        ]);

        let hits = engine.search("\"connection pool\"", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![1]);
    }

    #[test]
    fn ranks_a_document_matching_every_query_word_above_one_matching_only_part() {
        // Real transcripts are full of build logs that repeat one common word.
        // Matching more of the query has to count for more than repeating less of it.
        let (_d, engine) = engine_with(&[
            doc(1, "the compaction job failed after ten minutes"),
            doc(2, "the upload failed, then it failed again, and failed once more"),
        ]);

        let hits = engine.search("compaction failed", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits)[0], 1);
    }

    #[test]
    fn still_returns_partial_matches_below_the_full_ones() {
        let (_d, engine) = engine_with(&[
            doc(1, "the compaction job failed after ten minutes"),
            doc(2, "the upload failed once"),
        ]);

        let hits = engine.search("compaction failed", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![1, 2], "partial matches are ranked lower, not dropped");
    }

    #[test]
    fn weighs_the_rarer_query_word_more_when_the_other_is_everywhere() {
        // "compaction" appears in every document here, so it carries almost no
        // information; "failed" is what actually narrows the corpus. BM25's IDF
        // term is what makes this come out right.
        let mut docs: Vec<Doc> = (1..=8)
            .map(|i| doc(i, "compaction settings discussion about compaction tuning"))
            .collect();
        docs.push(doc(9, "the compaction job failed after ten minutes"));
        let (_d, engine) = engine_with(&docs);

        let hits = engine.search("compaction failed", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits)[0], 9);
    }

    #[test]
    fn adding_the_same_id_twice_keeps_one_document() {
        // sync writes the index, commits, then advances a cursor in LMDB. A crash
        // between those two steps replays the batch on the next run. The replay
        // must be a no-op, not a duplicate -- design doc §17 item 1.
        let (_d, mut engine) = engine_with(&[doc(7, "the same exchange")]);

        engine.add_documents(&[doc(7, "the same exchange")]).unwrap();
        engine.commit().unwrap();

        assert_eq!(engine.num_docs().unwrap(), 1);
        assert_eq!(ids(&engine.search("exchange", 10, &Filter::default()).unwrap()), vec![7]);
    }

    #[test]
    fn re_adding_an_id_replaces_its_text() {
        let (_d, mut engine) = engine_with(&[doc(7, "old wording about compaction")]);

        engine.add_documents(&[doc(7, "new wording about tokenizers")]).unwrap();
        engine.commit().unwrap();

        assert!(engine.search("compaction", 10, &Filter::default()).unwrap().is_empty());
        assert_eq!(ids(&engine.search("tokenizers", 10, &Filter::default()).unwrap()), vec![7]);
    }

    #[test]
    fn a_quoted_query_is_not_confused_by_irregular_spacing() {
        // Positions must be token ordinals. If they were character offsets, whether
        // this matched would depend on how many spaces the writer happened to type.
        let (_d, engine) = engine_with(&[
            doc(1, "the connection     pool was exhausted"),
            doc(2, "the connection was slow and the pool was full"),
        ]);

        let hits = engine.search("\"connection pool\"", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![1]);
    }

    #[test]
    fn a_query_full_of_punctuation_returns_results_instead_of_erroring() {
        // Real queries are pasted from logs and carry tantivy's own syntax characters.
        let (_d, engine) = engine_with(&[doc(1, "the segment failed to load from s3")]);

        let hits = engine
            .search("segment: failed (s3) [not] ^good~", 10, &Filter::default())
            .unwrap();

        assert_eq!(ids(&hits), vec![1]);
    }

    #[test]
    fn filters_to_one_project() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        engine
            .add_documents(&[
                Doc { project: "proj-a".into(), ..doc(1, "shared keyword here") },
                Doc { project: "proj-b".into(), ..doc(2, "shared keyword here") },
            ])
            .unwrap();
        engine.commit().unwrap();

        let filter = Filter { project: Some("proj-b".into()), ..Default::default() };
        let hits = engine.search("keyword", 10, &filter).unwrap();

        assert_eq!(ids(&hits), vec![2]);
    }

    #[test]
    fn filters_to_one_session() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        engine
            .add_documents(&[
                Doc { session_id: "sess-1".into(), ..doc(1, "shared keyword here") },
                Doc { session_id: "sess-2".into(), ..doc(2, "shared keyword here") },
            ])
            .unwrap();
        engine.commit().unwrap();

        let filter = Filter { session_id: Some("sess-1".into()), ..Default::default() };
        let hits = engine.search("keyword", 10, &filter).unwrap();

        assert_eq!(ids(&hits), vec![1]);
    }

    /// INDEX_VERSION bumps change the schema. tantivy refuses to open a
    /// directory whose stored schema differs, and that refusal happened before
    /// the TypeScript side could compare versions and rebuild. The index is a
    /// cache over LMDB, so the right move is to start it over.
    #[test]
    fn opens_over_an_index_built_with_an_older_schema_by_starting_it_over() {
        let dir = TempDir::new().unwrap();
        let mut old = Schema::builder();
        old.add_u64_field("id", STORED | INDEXED);
        old.add_text_field("text", tantivy::schema::TEXT);
        let old_index = Index::create_in_dir(dir.path(), old.build()).unwrap();
        let mut w = old_index.writer(15_000_000).unwrap();
        let mut d = TantivyDocument::new();
        d.add_u64(old_index.schema().get_field("id").unwrap(), 1);
        w.add_document(d).unwrap();
        w.commit().unwrap();
        drop(w);
        drop(old_index);

        let engine = TextEngine::open(dir.path()).unwrap();

        assert_eq!(engine.num_docs().unwrap(), 0);
    }

    #[test]
    fn filters_to_one_harness() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        engine
            .add_documents(&[
                Doc { harness: "claude".into(), ..doc(1, "shared keyword here") },
                Doc { harness: "codex".into(), ..doc(2, "shared keyword here") },
            ])
            .unwrap();
        engine.commit().unwrap();

        let filter = Filter { harness: Some("codex".into()), ..Default::default() };
        let hits = engine.search("keyword", 10, &filter).unwrap();

        assert_eq!(ids(&hits), vec![2]);
    }

    #[test]
    fn filters_by_time_range_inclusively() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        engine
            .add_documents(&[
                Doc { timestamp_ms: 1_000, ..doc(1, "shared keyword here") },
                Doc { timestamp_ms: 2_000, ..doc(2, "shared keyword here") },
                Doc { timestamp_ms: 3_000, ..doc(3, "shared keyword here") },
            ])
            .unwrap();
        engine.commit().unwrap();

        let filter = Filter { after_ms: Some(2_000), before_ms: Some(3_000), ..Default::default() };
        let mut got = ids(&engine.search("keyword", 10, &filter).unwrap());
        got.sort();

        assert_eq!(got, vec![2, 3]);
    }

    #[test]
    fn never_returns_sidechain_documents() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        engine
            .add_documents(&[
                Doc { is_sidechain: true, ..doc(1, "shared keyword here") },
                Doc { is_sidechain: false, ..doc(2, "shared keyword here") },
            ])
            .unwrap();
        engine.commit().unwrap();

        let hits = engine.search("keyword", 10, &Filter::default()).unwrap();

        assert_eq!(ids(&hits), vec![2]);
    }

    #[test]
    fn honours_the_result_limit() {
        let docs: Vec<Doc> = (1..=10).map(|i| doc(i, "shared keyword here")).collect();
        let (_d, engine) = engine_with(&docs);

        let hits = engine.search("keyword", 3, &Filter::default()).unwrap();

        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn returns_nothing_when_no_document_matches() {
        let (_d, engine) = engine_with(&[doc(1, "the connection pool was exhausted")]);

        let hits = engine.search("kubernetes", 10, &Filter::default()).unwrap();

        assert!(hits.is_empty());
    }

    #[test]
    fn delete_all_empties_the_index() {
        let (_d, mut engine) = engine_with(&[doc(1, "shared keyword here"), doc(2, "shared keyword here")]);
        assert_eq!(engine.num_docs().unwrap(), 2);

        engine.delete_all().unwrap();
        engine.commit().unwrap();

        assert_eq!(engine.num_docs().unwrap(), 0);
        assert!(engine.search("keyword", 10, &Filter::default()).unwrap().is_empty());
    }

    #[test]
    fn a_second_writer_is_refused_while_the_first_holds_the_lock() {
        let dir = TempDir::new().unwrap();
        let mut first = TextEngine::open(dir.path()).unwrap();
        assert!(first.try_acquire_writer().unwrap());

        let mut second = TextEngine::open(dir.path()).unwrap();

        assert!(!second.try_acquire_writer().unwrap(), "the lock must be exclusive");
    }

    #[test]
    fn a_reader_opened_before_a_commit_sees_the_new_documents_after_it() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();
        engine.try_acquire_writer().unwrap();
        assert!(engine.search("keyword", 10, &Filter::default()).unwrap().is_empty());

        engine.add_documents(&[doc(1, "shared keyword here")]).unwrap();
        engine.commit().unwrap();

        assert_eq!(ids(&engine.search("keyword", 10, &Filter::default()).unwrap()), vec![1]);
    }

    #[test]
    fn documents_survive_reopening_the_index() {
        let dir = TempDir::new().unwrap();
        {
            let mut engine = TextEngine::open(dir.path()).unwrap();
            engine.try_acquire_writer().unwrap();
            engine.add_documents(&[doc(1, "shared keyword here")]).unwrap();
            engine.commit().unwrap();
        }

        let reopened = TextEngine::open(dir.path()).unwrap();

        assert_eq!(ids(&reopened.search("keyword", 10, &Filter::default()).unwrap()), vec![1]);
    }

    #[test]
    fn writing_without_acquiring_the_writer_is_an_error_not_a_silent_no_op() {
        let dir = TempDir::new().unwrap();
        let mut engine = TextEngine::open(dir.path()).unwrap();

        assert!(engine.add_documents(&[doc(1, "shared keyword here")]).is_err());
    }
}
