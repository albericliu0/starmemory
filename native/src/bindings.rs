//! The Node surface. Deliberately a pure adapter: every decision worth testing
//! lives in `engine.rs`, which is why this file has no branches beyond
//! converting types and errors.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::engine::{Doc, Filter, TextEngine, INDEX_VERSION};

fn to_js(error: Box<dyn std::error::Error + Send + Sync>) -> Error {
    Error::from_reason(error.to_string())
}

#[napi(object)]
pub struct TextDoc {
    pub id: i64,
    /// The user and assistant messages joined together. Indexed, never stored:
    /// LMDB holds the only copy of the text.
    pub text: String,
    pub project: String,
    pub session_id: String,
    pub harness: String,
    pub timestamp_ms: i64,
    pub is_sidechain: bool,
}

#[napi(object)]
pub struct TextFilter {
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub harness: Option<String>,
    pub after_ms: Option<i64>,
    pub before_ms: Option<i64>,
}

#[napi(object)]
pub struct TextHit {
    pub id: i64,
    pub score: f64,
}

#[napi]
pub struct TextIndex {
    engine: TextEngine,
}

#[napi]
impl TextIndex {
    #[napi(factory)]
    pub fn open(path: String) -> Result<Self> {
        let engine = TextEngine::open(std::path::Path::new(&path)).map_err(to_js)?;
        Ok(Self { engine })
    }

    /// False means another process is already indexing. That is the expected
    /// outcome for a second concurrent sync, not a failure.
    #[napi]
    pub fn try_acquire_writer(&mut self) -> Result<bool> {
        self.engine.try_acquire_writer().map_err(to_js)
    }

    #[napi]
    pub fn add_documents(&mut self, docs: Vec<TextDoc>) -> Result<()> {
        let docs: Vec<Doc> = docs
            .into_iter()
            .map(|d| Doc {
                id: d.id as u64,
                text: d.text,
                project: d.project,
                session_id: d.session_id,
                harness: d.harness,
                timestamp_ms: d.timestamp_ms.max(0) as u64,
                is_sidechain: d.is_sidechain,
            })
            .collect();
        self.engine.add_documents(&docs).map_err(to_js)
    }

    #[napi]
    pub fn commit(&mut self) -> Result<()> {
        self.engine.commit().map_err(to_js)
    }

    #[napi]
    pub fn delete_all(&mut self) -> Result<()> {
        self.engine.delete_all().map_err(to_js)
    }

    #[napi]
    pub fn search(
        &self,
        query: String,
        limit: u32,
        filter: Option<TextFilter>,
    ) -> Result<Vec<TextHit>> {
        let filter = filter
            .map(|f| Filter {
                project: f.project,
                session_id: f.session_id,
                harness: f.harness,
                after_ms: f.after_ms.map(|v| v.max(0) as u64),
                before_ms: f.before_ms.map(|v| v.max(0) as u64),
            })
            .unwrap_or_default();

        let hits = self
            .engine
            .search(&query, limit as usize, &filter)
            .map_err(to_js)?;

        Ok(hits
            .into_iter()
            .map(|h| TextHit { id: h.id as i64, score: h.score as f64 })
            .collect())
    }

    #[napi]
    pub fn num_docs(&self) -> Result<i64> {
        self.engine.num_docs().map(|n| n as i64).map_err(to_js)
    }
}

/// Bumped when the schema or the analyzer chain changes, so the TypeScript side
/// knows an existing index has to be thrown away and rebuilt from LMDB.
#[napi]
pub fn index_version() -> u32 {
    INDEX_VERSION
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

use crate::vector::{VectorIndex, VectorOptions, VECTOR_INDEX_VERSION};

#[napi(object)]
pub struct VectorOptionsJs {
    pub dim: u32,
    /// HNSW's M.
    pub connectivity: u32,
    pub expansion_add: u32,
    pub expansion_search: u32,
}

impl From<&VectorOptionsJs> for VectorOptions {
    fn from(o: &VectorOptionsJs) -> Self {
        VectorOptions {
            dim: o.dim as usize,
            connectivity: o.connectivity as usize,
            expansion_add: o.expansion_add as usize,
            expansion_search: o.expansion_search as usize,
        }
    }
}

#[napi(object)]
pub struct VectorHit {
    /// The LMDB exchange id. A JS number, so ids stay plain integers on the
    /// TypeScript side rather than BigInt.
    pub id: f64,
    /// Cosine similarity, higher is better.
    pub score: f64,
}

/// Build the graph from every vector and write it to `path`.
#[napi]
pub fn build_vector_index(
    options: VectorOptionsJs,
    ids: Float64Array,
    vectors: Float32Array,
    path: String,
) -> Result<()> {
    let ids: Vec<u64> = ids.as_ref().iter().map(|&v| v as u64).collect();
    VectorIndex::build(
        (&options).into(),
        &ids,
        vectors.as_ref(),
        std::path::Path::new(&path),
    )
    .map_err(to_js)
}

#[napi]
pub struct VectorSearcher {
    index: VectorIndex,
}

#[napi]
impl VectorSearcher {
    #[napi(factory)]
    pub fn open(options: VectorOptionsJs, path: String) -> Result<Self> {
        let index = VectorIndex::open((&options).into(), std::path::Path::new(&path))
            .map_err(to_js)?;
        Ok(Self { index })
    }

    /// `filter_ids` restricts the traversal itself, so a filtered query does not
    /// over-fetch and trim.
    #[napi]
    pub fn search(
        &self,
        query: Float32Array,
        limit: u32,
        filter_ids: Option<Float64Array>,
    ) -> Result<Vec<VectorHit>> {
        let allowed: Option<Vec<u64>> =
            filter_ids.map(|ids| ids.as_ref().iter().map(|&v| v as u64).collect());

        let hits = self
            .index
            .search(query.as_ref(), limit as usize, allowed.as_deref())
            .map_err(to_js)?;

        Ok(hits
            .into_iter()
            .map(|h| VectorHit { id: h.id as f64, score: h.score as f64 })
            .collect())
    }

    #[napi]
    pub fn len(&self) -> u32 {
        self.index.len() as u32
    }
}

#[napi]
pub fn vector_index_version() -> u32 {
    VECTOR_INDEX_VERSION
}

// ---------------------------------------------------------------------------
// LMDB store
// ---------------------------------------------------------------------------

use crate::store as db;

#[napi(object)]
pub struct StoreRow {
    /// The exchange as JSON, without `id`; the store assigns and writes it in.
    pub json: String,
    pub project: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    pub line_end: f64,
    pub is_sidechain: bool,
    pub embedding: Option<Float32Array>,
    pub harness: Option<String>,
}

#[napi(object)]
pub struct InsertResult {
    pub ids: Vec<f64>,
    /// Rows already past the cursor when the transaction began -- another sync
    /// stored them first. Expected under concurrency, not an error.
    pub skipped: u32,
}

#[napi(object)]
pub struct StoreFilter {
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub harness: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
}

#[napi(object)]
pub struct VectorDump {
    pub ids: Float64Array,
    /// `ids.length * dim` floats, row-major.
    pub data: Float32Array,
}

#[napi]
pub struct StoreHandle {
    inner: Option<db::Store>,
}

const STORE_CLOSED: &str = "store is closed";

#[napi]
impl StoreHandle {
    #[napi(factory)]
    pub fn open(path: String) -> Result<Self> {
        let inner = db::Store::open(std::path::Path::new(&path)).map_err(to_js)?;
        Ok(Self { inner: Some(inner) })
    }

    fn store(&self) -> Result<&db::Store> {
        self.inner.as_ref().ok_or_else(|| Error::from_reason(STORE_CLOSED))
    }

    /// One write transaction for the whole batch, including the per-file cursor
    /// check-and-advance. That single transaction is what stops two concurrent
    /// syncs from inserting the same rows.
    #[napi]
    pub fn insert(&self, rows: Vec<StoreRow>, cursor_key: Option<String>) -> Result<InsertResult> {
        let rows: Vec<db::Row> = rows
            .into_iter()
            .map(|r| db::Row {
                json: r.json,
                project: r.project,
                session_id: r.session_id,
                timestamp: r.timestamp,
                line_end: r.line_end.max(0.0) as u64,
                is_sidechain: r.is_sidechain,
                embedding: r.embedding.map(|e| e.as_ref().to_vec()),
                harness: r.harness,
            })
            .collect();
        let out = self.store()?.insert(&rows, cursor_key.as_deref()).map_err(to_js)?;
        Ok(InsertResult { ids: out.ids.into_iter().map(|i| i as f64).collect(), skipped: out.skipped as u32 })
    }

    #[napi]
    pub fn get(&self, id: f64) -> Result<Option<String>> {
        self.store()?.get(id as u64).map_err(to_js)
    }

    #[napi]
    pub fn get_vector(&self, id: f64) -> Result<Option<Float32Array>> {
        Ok(self.store()?.get_vector(id as u64).map_err(to_js)?.map(Float32Array::new))
    }

    #[napi]
    pub fn put_vector(&self, id: f64, vector: Float32Array) -> Result<()> {
        self.store()?.put_vector(id as u64, vector.as_ref()).map_err(to_js)
    }

    #[napi]
    pub fn all_vectors(&self, dim: u32) -> Result<VectorDump> {
        let (ids, data) = self.store()?.all_vectors(dim as usize).map_err(to_js)?;
        Ok(VectorDump {
            ids: Float64Array::new(ids.into_iter().map(|i| i as f64).collect()),
            data: Float32Array::new(data),
        })
    }

    /// `null` when no filter was given, so the caller can tell that apart from
    /// "filter matched nothing".
    #[napi]
    pub fn filter_ids(&self, filter: StoreFilter) -> Result<Option<Float64Array>> {
        let f = db::IdFilter {
            project: filter.project,
            session_id: filter.session_id,
            harness: filter.harness,
            after: filter.after,
            before: filter.before,
        };
        Ok(self
            .store()?
            .filter_ids(&f)
            .map_err(to_js)?
            .map(|ids| Float64Array::new(ids.into_iter().map(|i| i as f64).collect())))
    }

    /// Backfill `idx_harness` for rows stored before the harness tag existed.
    #[napi]
    pub fn reindex_harness(&self) -> Result<f64> {
        self.store()?.reindex_harness().map(|n| n as f64).map_err(to_js)
    }

    #[napi]
    pub fn exchanges_from(&self, from: f64) -> Result<Vec<String>> {
        self.store()?.exchanges_from(from.max(0.0) as u64).map_err(to_js)
    }

    #[napi]
    pub fn next_id(&self) -> Result<f64> {
        self.store()?.next_id().map(|i| i as f64).map_err(to_js)
    }

    #[napi]
    pub fn meta_get(&self, key: String) -> Result<Option<String>> {
        self.store()?.meta_get(&key).map_err(to_js)
    }

    #[napi]
    pub fn meta_put(&self, key: String, value: String) -> Result<()> {
        self.store()?.meta_put(&key, &value).map_err(to_js)
    }

    #[napi]
    pub fn meta_remove(&self, key: String) -> Result<bool> {
        self.store()?.meta_remove(&key).map_err(to_js)
    }

    /// Releases the LMDB environment. LMDB allows one open environment per path
    /// per process, so a test that reopens the same path must close first.
    #[napi]
    pub fn close(&mut self) {
        self.inner.take();
    }
}
