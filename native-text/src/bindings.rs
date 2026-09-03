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
