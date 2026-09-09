//! HNSW vector search over usearch. Replaces the vendored C++ faiss/tenann
//! addon: same algorithm and the same M / efConstruction / efSearch, but it
//! builds from crates.io with no CMake, no 821 MB vendor tree, and no external
//! OpenMP runtime to find at load time.
//!
//! Like `engine.rs`, this knows nothing about napi or LMDB so it can be tested
//! on its own.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

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

/// Distinguishes builds within one process; the pid distinguishes processes.
static BUILD_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A build older than this cannot still be running; its temp file is junk.
const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

/// `.index.hnsw.<pid>.<n>.tmp`, beside the index so the rename stays on one
/// filesystem. Hidden so a directory listing shows the index alone.
fn temp_file_name(file_name: &str) -> String {
    let n = BUILD_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(".{}.{}.{}.tmp", file_name, std::process::id(), n)
}

/// Remove temp files of earlier builds of this index that died mid-write. A
/// recent one may belong to another sync still writing, so age decides, not
/// name. Best effort: a failure here must not fail the build.
fn sweep_stale_temp_files(path: &Path, file_name: &str) {
    let Some(parent) = path.parent() else { return };
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    let prefix = format!(".{}.", file_name);
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with(&prefix) && name.ends_with(".tmp")) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > STALE_TEMP_AGE);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
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

        // usearch's save() truncates and rewrites the path in place, and view()
        // is an mmap of that same inode, so a reader mid-session (the MCP
        // server) would have its graph swapped out from under it and crash on
        // its next search. Write beside the target and rename over it instead:
        // the rename is atomic, and the reader's mapping keeps the old inode
        // alive until it reopens.
        //
        // This relies on POSIX semantics: rename replaces an open, mapped file
        // and the reader is unaffected. Windows refuses to replace a mapped file,
        // so a build there will need another scheme (versioned file names and
        // a pointer file, say) when that platform is added.
        let final_path = path.to_str().ok_or("index path is not valid UTF-8")?;
        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or("index path has no file name")?;
        sweep_stale_temp_files(path, file_name);
        let temp_path = path.with_file_name(temp_file_name(file_name));
        let temp_str = temp_path.to_str().ok_or("index path is not valid UTF-8")?;
        if let Err(error) = index.save(temp_str) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error.into());
        }
        if let Err(error) = std::fs::rename(&temp_path, final_path) {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error.into());
        }
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
    fn a_live_reader_survives_the_index_being_rebuilt_underneath_it() {
        // The MCP server views the file for a whole session while the
        // SessionStart sync rebuilds it. The reader keeps its old graph until
        // it reopens; it must never see a half-written or swapped-out file.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();
        let reader = VectorIndex::open(options(), &path).unwrap();
        let query = normalise(vec![0.0, 1.0, 0.0, 0.0]);
        assert_eq!(ids_of(&reader.search(&query, 1, None).unwrap()), vec![2]);

        let count = 300usize;
        let new_ids: Vec<u64> = (1000..1000 + count as u64).collect();
        let mut new_vectors = Vec::with_capacity(count * DIM);
        for i in 0..count {
            let angle = i as f32 / count as f32;
            new_vectors.extend(normalise(vec![angle.cos(), angle.sin(), 0.0, 0.0]));
        }
        VectorIndex::build(options(), &new_ids, &new_vectors, &path).unwrap();

        assert_eq!(reader.len(), 3);
        assert_eq!(ids_of(&reader.search(&query, 1, None).unwrap()), vec![2]);
        assert_eq!(VectorIndex::open(options(), &path).unwrap().len(), count);
    }

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
    fn a_build_sweeps_up_temp_files_left_by_a_killed_build_but_not_fresh_ones() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let stale = dir.path().join(".index.usearch.999999.0.tmp");
        let fresh = dir.path().join(".index.usearch.999998.0.tmp");
        let unrelated = dir.path().join(".other.usearch.999997.0.tmp");
        for p in [&stale, &fresh, &unrelated] {
            std::fs::write(p, b"partial").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&unrelated)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();

        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();

        assert!(!stale.exists(), "an hours-old temp file for this index is junk");
        assert!(fresh.exists(), "a fresh temp file may be another sync mid-write");
        assert!(unrelated.exists(), "only this index's temp files are ours to remove");
        assert_eq!(VectorIndex::open(options(), &path).unwrap().len(), 3);
    }

    #[test]
    fn a_build_leaves_no_temp_file_of_its_own_behind() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("index.usearch");
        let (ids, vectors) = corpus();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();
        VectorIndex::build(options(), &ids, &vectors, &path).unwrap();

        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["index.usearch".to_string()]);
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
