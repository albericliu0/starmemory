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
    pub timestamp_ms: i64,
    pub is_sidechain: bool,
}

#[napi(object)]
pub struct TextFilter {
    pub project: Option<String>,
    pub session_id: Option<String>,
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
