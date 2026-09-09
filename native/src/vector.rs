//! HNSW vector search over usearch. Replaces the vendored C++ faiss/tenann
//! addon: same algorithm and the same M / efConstruction / efSearch, but it
//! builds from crates.io with no CMake, no 821 MB vendor tree, and no external
//! OpenMP runtime to find at load time.
//!
//! Like `engine.rs`, this knows nothing about napi or LMDB so it can be tested
//! on its own.

use std::path::Path;

use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Bumped when the on-disk layout or the graph parameters change, so a stale
/// index file is rebuilt from LMDB rather than silently answering differently.
pub const VECTOR_INDEX_VERSION: u32 = 2; // 2: vectors stored as f16

#[derive(Debug, Clone, Copy)]
pub struct VectorOptions {
    pub dim: usize,
    /// usearch calls this `connectivity`; it is HNSW's M.
    pub connectivity: usize,
    pub expansion_add: usize,
    pub expansion_search: usize,
}

impl Default for VectorOptions {
    fn default() -> Self {
        // Matches what the faiss path used, so recall is comparable.
        Self { dim: 384, connectivity: 16, expansion_add: 40, expansion_search: 64 }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub id: u64,
    /// Cosine similarity. Embeddings are L2-normalised before they get here, so
    /// inner product and cosine are the same number, and higher is better.
    pub score: f32,
}

fn index_options(options: &VectorOptions) -> IndexOptions {
    IndexOptions {
        dimensions: options.dim,
        metric: MetricKind::IP,
        // f16 storage: on 20k x 1024 clustered vectors recall@10 was 0.998 vs
        // 0.996 for f32, search 25% faster, index file half the size. i8 was
        // tried and rejected: recall fell to 0.80 on inner product.
        quantization: ScalarKind::F16,
        connectivity: options.connectivity,
        expansion_add: options.expansion_add,
        expansion_search: options.expansion_search,
        multi: false,
    }
}

pub struct VectorIndex {
    index: Index,
    options: VectorOptions,
}

impl VectorIndex {
    /// Build the whole graph from scratch and write it to `path`.
    ///
    /// Rebuilding wholesale is deliberate (design doc §07): inserting into an
    /// HNSW graph degrades it over time, and at this corpus size a full rebuild
    /// is a sub-second operation.
    pub fn build(options: VectorOptions, ids: &[u64], vectors: &[f32], path: &Path) -> Result<()> {
        if ids.len() * options.dim != vectors.len() {
            return Err(format!(
                "{} ids does not match {} floats at dim {}",
                ids.len(),
                vectors.len(),
                options.dim
            )
            .into());
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let index = Index::new(&index_options(&options))?;
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        index.reserve_capacity_and_threads(ids.len().max(1), threads)?;

        // usearch's `add` takes &self and is safe to call concurrently. This is
        // what closes the build-time gap against faiss's OpenMP bulk build,
        // without needing an OpenMP runtime on the user's machine.
        let dim = options.dim;
        std::thread::scope(|scope| -> Result<()> {
            let mut handles = Vec::with_capacity(threads);
            for shard in 0..threads {
                let index = &index;
                handles.push(scope.spawn(move || -> Result<()> {
                    for i in (shard..ids.len()).step_by(threads) {
                        index.add(ids[i], &vectors[i * dim..(i + 1) * dim])?;
                    }
                    Ok(())
                }));
            }
            for handle in handles {
                handle.join().map_err(|_| "index build thread panicked")??;
            }
            Ok(())
        })?;

        // Straight to `path`. Callers never hand us a path a reader may have
        // mapped: the TypeScript side writes each rebuild to the next generation
        // file and switches readers through LMDB meta (design doc
        // windows-support §07), so nothing here depends on how the OS treats a
        // rename over, or a delete of, a mapped file.
        index.save(path.to_str().ok_or("index path is not valid UTF-8")?)?;
        Ok(())
    }

    /// Memory-map an index built earlier. Read-only and lock-free, so every MCP
    /// server process can open the same file at once.
    pub fn open(options: VectorOptions, path: &Path) -> Result<Self> {
        // Checked here, before usearch sees the path: its view() of a missing
        // file fails and then runs `::close(0)` on the way out (the descriptor
        // field is still zero), which would take the MCP server's stdin with it.
        if !path.is_file() {
            return Err(format!("no index file at {}", path.display()).into());
        }
        let index = Index::new(&index_options(&options))?;
        index.view(path.to_str().ok_or("index path is not valid UTF-8")?)?;
        Ok(Self { index, options })
    }

    /// Top-k by cosine similarity, optionally restricted to `allowed`.
    ///
    /// The filter is applied during graph traversal, not to the results
    /// afterwards, so a filtered query does not need to over-fetch and trim.
    pub fn search(&self, query: &[f32], k: usize, allowed: Option<&[u64]>) -> Result<Vec<Hit>> {
        if query.len() != self.options.dim {
            return Err(format!(
                "query has {} dimensions, index has {}",
                query.len(),
                self.options.dim
            )
            .into());
        }
        if k == 0 || self.index.size() == 0 {
            return Ok(Vec::new());
        }

        let matches = match allowed {
            None => self.index.search(query, k)?,
            Some(ids) => {
                if ids.is_empty() {
                    return Ok(Vec::new());
                }
                let allowed: std::collections::HashSet<u64> = ids.iter().copied().collect();
                self.index.filtered_search(query, k, |key| allowed.contains(&key))?
            }
        };

        Ok(matches
            .keys
            .iter()
            .zip(matches.distances.iter())
            .map(|(&id, &distance)| Hit { id, score: 1.0 - distance })
            .collect())
    }

    pub fn len(&self) -> usize {
        self.index.size()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const DIM: usize = 4;

    fn options() -> VectorOptions {
        VectorOptions { dim: DIM, ..Default::default() }
    }

    fn normalise(mut v: Vec<f32>) -> Vec<f32> {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt().max(f32::EPSILON);
        for x in v.iter_mut() {
            *x /= norm;
        }
        v
    }

    /// Three unit vectors: 1 points at +x, 2 at +y, 3 near +x.
    fn corpus() -> (Vec<u64>, Vec<f32>) {
        let rows = vec![
            (1u64, normalise(vec![1.0, 0.0, 0.0, 0.0])),
            (2u64, normalise(vec![0.0, 1.0, 0.0, 0.0])),
            (3u64, normalise(vec![0.9, 0.1, 0.0, 0.0])),
        ];
        let ids = rows.iter().map(|(id, _)| *id).collect();
        let vectors = rows.into_iter().flat_map(|(_, v)| v).collect();
        (ids, vectors)
    }

    fn built() -> (TempDir, VectorIndex) {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();
        let index = VectorIndex::open(options(), &path).unwrap();
        (dir, index)
    }

    fn ids_of(hits: &[Hit]) -> Vec<u64> {
        hits.iter().map(|h| h.id).collect()
    }

    #[test]
    fn finds_the_nearest_vector_first() {
        let (_d, index) = built();

        let hits = index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 3, None).unwrap();

        assert_eq!(ids_of(&hits)[0], 1);
    }

    #[test]
    fn orders_by_similarity_so_the_near_miss_beats_the_orthogonal_one() {
        let (_d, index) = built();

        let hits = index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 3, None).unwrap();

        assert_eq!(ids_of(&hits), vec![1, 3, 2]);
    }

    #[test]
    fn scores_a_perfect_match_at_one_and_an_orthogonal_vector_near_zero() {
        // The rest of the system reads this number as a cosine similarity and
        // shows it as a percentage, so the scale has to be right.
        let (_d, index) = built();

        let hits = index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 3, None).unwrap();

        let exact = hits.iter().find(|h| h.id == 1).unwrap();
        let orthogonal = hits.iter().find(|h| h.id == 2).unwrap();
        assert!((exact.score - 1.0).abs() < 1e-3, "got {}", exact.score);
        assert!(orthogonal.score.abs() < 1e-3, "got {}", orthogonal.score);
    }

    #[test]
    fn restricts_results_to_the_allowed_ids() {
        let (_d, index) = built();

        let hits = index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 3, Some(&[2, 3])).unwrap();

        assert!(!ids_of(&hits).contains(&1));
        assert_eq!(ids_of(&hits)[0], 3);
    }

    #[test]
    fn an_empty_allow_list_matches_nothing_rather_than_everything() {
        let (_d, index) = built();

        assert!(index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 3, Some(&[])).unwrap().is_empty());
    }

    #[test]
    fn returns_the_whole_corpus_when_k_exceeds_it() {
        let (_d, index) = built();

        let hits = index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 50, None).unwrap();

        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn returns_nothing_for_k_of_zero() {
        let (_d, index) = built();

        assert!(index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 0, None).unwrap().is_empty());
    }

    #[test]
    fn survives_being_written_by_one_handle_and_read_by_another() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("index.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();

        let reopened = VectorIndex::open(options(), &path).unwrap();

        assert_eq!(reopened.len(), 3);
        assert_eq!(ids_of(&reopened.search(&normalise(vec![0.0, 1.0, 0.0, 0.0]), 1, None).unwrap()), vec![2]);
    }

    #[test]
    fn two_readers_can_open_the_same_index_file_at_once() {
        // Several MCP server processes read one index; nothing may take a lock.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();

        let first = VectorIndex::open(options(), &path).unwrap();
        let second = VectorIndex::open(options(), &path).unwrap();

        assert_eq!(first.len(), second.len());
    }

    #[test]
    fn a_reader_on_one_generation_is_untouched_by_a_build_to_the_next() {
        // The MCP server maps generation g while the sync builds g+1 beside it.
        // Nothing is written into g, so the reader's graph stays intact until
        // it chooses to switch; a fresh open of g+1 sees the new corpus.
        let dir = TempDir::new().unwrap();
        let g0 = dir.path().join("index-v2.g0.usearch");
        let g1 = dir.path().join("index-v2.g1.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &g0).unwrap();
        let reader = VectorIndex::open(options(), &g0).unwrap();
        let query = normalise(vec![0.0, 1.0, 0.0, 0.0]);
        assert_eq!(ids_of(&reader.search(&query, 1, None).unwrap()), vec![2]);

        let count = 300usize;
        let new_ids: Vec<u64> = (1000..1000 + count as u64).collect();
        let mut new_vectors = Vec::with_capacity(count * DIM);
        for i in 0..count {
            let angle = i as f32 / count as f32;
            new_vectors.extend(normalise(vec![angle.cos(), angle.sin(), 0.0, 0.0]));
        }
        VectorIndex::build(options(), &new_ids, &new_vectors, &g1).unwrap();

        assert_eq!(reader.len(), 3);
        assert_eq!(ids_of(&reader.search(&query, 1, None).unwrap()), vec![2]);
        assert_eq!(VectorIndex::open(options(), &g1).unwrap().len(), count);
    }

    #[cfg(unix)]
    #[test]
    fn opening_a_missing_index_fails_without_closing_a_descriptor_it_never_owned() {
        // usearch's memory_mapped_file_t::close() runs `::close(file_descriptor_)`
        // even when open_if_not() failed, and the field is 0 then. So a view()
        // of a missing file closes fd 0: the MCP server's stdin, or whatever
        // LMDB was handed in a process whose stdin is already closed.
        use std::os::fd::AsRawFd;
        let dir = TempDir::new().unwrap();
        let devnull = std::fs::File::open("/dev/null").unwrap();
        // Point fd 0 at something we own, so the test does not depend on how
        // the harness set up stdin.
        assert_ne!(unsafe { libc::dup2(devnull.as_raw_fd(), 0) }, -1);

        let result = VectorIndex::open(options(), &dir.path().join("missing.usearch"));

        assert!(result.is_err());
        let still_open = unsafe { libc::fcntl(0, libc::F_GETFD) } != -1;
        assert!(still_open, "fd 0 was closed by opening a missing index");
    }

    #[test]
    fn an_empty_corpus_builds_and_answers_with_nothing() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        VectorIndex::build(options(), &[], &[], &path).unwrap();

        let index = VectorIndex::open(options(), &path).unwrap();

        assert!(index.is_empty());
        assert!(index.search(&normalise(vec![1.0, 0.0, 0.0, 0.0]), 5, None).unwrap().is_empty());
    }

    #[test]
    fn rejects_a_query_of_the_wrong_dimension_instead_of_returning_nonsense() {
        let (_d, index) = built();

        assert!(index.search(&[1.0, 0.0], 3, None).is_err());
    }

    #[test]
    fn rejects_a_build_whose_ids_and_vectors_disagree() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");

        let result = VectorIndex::build(options(), &[1, 2], &[1.0, 0.0, 0.0, 0.0], &path);

        assert!(result.is_err());
    }

    #[test]
    fn keeps_every_id_when_the_corpus_is_larger_than_one_thread_shard() {
        // The build fans out across threads with a strided split; an off-by-one
        // there would silently drop rows.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let count = 500usize;
        let ids: Vec<u64> = (0..count as u64).collect();
        let mut vectors = Vec::with_capacity(count * DIM);
        for i in 0..count {
            let angle = i as f32 / count as f32;
            vectors.extend(normalise(vec![angle.cos(), angle.sin(), 0.0, 0.0]));
        }
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();

        assert_eq!(VectorIndex::open(options(), &path).unwrap().len(), count);
    }
}
