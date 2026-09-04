//! The LMDB store, in Rust -- design doc §03 "谁用什么语言" and §17 item 3.
//!
//! Everything that writes to disk lives here, in one runtime, so the write order
//! and the crash story have exactly one home. The transactional cursor in
//! `insert` is the point: two sync processes that start together used to both
//! read cursor 0, both embed the same rows, and both insert them. Measured: 230
//! rows for 132 exchanges. Here the cursor is read and advanced inside the same
//! write transaction as the inserts, and LMDB serialises write transactions
//! across processes, so the second one sees the advanced cursor and skips.

use std::ops::Bound;
use std::path::Path;

use heed::byteorder::BigEndian;
use heed::types::{Bytes, Str, Unit, U64};
use heed::{Database, Env, EnvOpenOptions};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

/// Sparse virtual reservation; LMDB grows the file on demand up to this.
const MAP_SIZE: usize = 4 * 1024 * 1024 * 1024;

type IdKey = U64<BigEndian>;

/// One exchange to insert. `json` is the record as the TypeScript side
/// serialises it, minus `id`; the store assigns the id and writes it in.
#[derive(Debug, Clone)]
pub struct Row {
    pub json: String,
    pub project: String,
    pub session_id: Option<String>,
    pub timestamp: String,
    /// Last transcript line this exchange spans; what the per-file cursor tracks.
    pub line_end: u64,
    pub is_sidechain: bool,
    /// Ignored for sidechain rows: they get no vector and so never enter the graph.
    pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Default, PartialEq)]
pub struct InsertOutcome {
    pub ids: Vec<u64>,
    /// Rows at or below the cursor when the transaction began. Another process
    /// already stored them; this is the race being closed, not an error.
    pub skipped: usize,
}

#[derive(Debug, Default, Clone)]
pub struct IdFilter {
    pub project: Option<String>,
    pub session_id: Option<String>,
    pub after: Option<String>,
    pub before: Option<String>,
}

pub struct Store {
    env: Env,
    exchanges: Database<IdKey, Str>,
    vectors: Database<IdKey, Bytes>,
    idx_project: Database<Bytes, Unit>,
    idx_session: Database<Bytes, Unit>,
    idx_time: Database<Bytes, Unit>,
    meta: Database<Str, Str>,
}

/// Secondary-index key: `<text>\0<id BE>`. The NUL keeps "proj" from matching
/// "proj2" on a prefix scan; the big-endian id keeps ids ordered within a text.
fn idx_key(text: &str, id: u64) -> Vec<u8> {
    let mut k = Vec::with_capacity(text.len() + 9);
    k.extend_from_slice(text.as_bytes());
    k.push(0);
    k.extend_from_slice(&id.to_be_bytes());
    k
}

fn idx_prefix(text: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(text.len() + 1);
    k.extend_from_slice(text.as_bytes());
    k.push(0);
    k
}

fn id_of(key: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&key[key.len() - 8..]);
    u64::from_be_bytes(b)
}

fn f32s_to_bytes(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

fn bytes_to_f32s(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if path.is_file() {
            return Err(format!(
                "{} is a file from the old lmdb-js layout; delete it and run sync again",
                path.display()
            )
            .into());
        }
        std::fs::create_dir_all(path)?;
        // SAFETY: heed marks open unsafe because a memory-mapped file must not be
        // truncated or written by anything but LMDB while mapped. Nothing else
        // touches this directory.
        let env = unsafe { EnvOpenOptions::new().map_size(MAP_SIZE).max_dbs(8).open(path)? };
        let mut wtxn = env.write_txn()?;
        let exchanges = env.create_database(&mut wtxn, Some("exchanges"))?;
        let vectors = env.create_database(&mut wtxn, Some("vectors"))?;
        let idx_project = env.create_database(&mut wtxn, Some("idx_project"))?;
        let idx_session = env.create_database(&mut wtxn, Some("idx_session"))?;
        let idx_time = env.create_database(&mut wtxn, Some("idx_time"))?;
        let meta = env.create_database(&mut wtxn, Some("meta"))?;
        wtxn.commit()?;
        Ok(Self { env, exchanges, vectors, idx_project, idx_session, idx_time, meta })
    }

    /// Insert rows, assigning ids. With `cursor_key`, rows whose `line_end` is at
    /// or below the stored cursor are skipped and the cursor is advanced -- all
    /// inside one write transaction, which is what makes concurrent syncs safe.
    pub fn insert(&self, rows: &[Row], cursor_key: Option<&str>) -> Result<InsertOutcome> {
        let mut wtxn = self.env.write_txn()?;

        let cursor: u64 = match cursor_key {
            Some(k) => self.meta.get(&wtxn, k)?.and_then(|v| v.parse().ok()).unwrap_or(0),
            None => 0,
        };
        let mut next = self.exchanges.last(&wtxn)?.map(|(id, _)| id + 1).unwrap_or(0);

        let mut out = InsertOutcome::default();
        let mut max_line_end = cursor;
        for row in rows {
            if cursor_key.is_some() && row.line_end <= cursor {
                out.skipped += 1;
                continue;
            }
            let id = next;
            next += 1;

            let mut value: serde_json::Value = serde_json::from_str(&row.json)?;
            value["id"] = serde_json::Value::from(id);
            self.exchanges.put(&mut wtxn, &id, &value.to_string())?;

            if let (false, Some(embedding)) = (row.is_sidechain, &row.embedding) {
                self.vectors.put(&mut wtxn, &id, &f32s_to_bytes(embedding))?;
            }
            self.idx_project.put(&mut wtxn, &idx_key(&row.project, id), &())?;
            if let Some(session) = &row.session_id {
                self.idx_session.put(&mut wtxn, &idx_key(session, id), &())?;
            }
            if !row.timestamp.is_empty() {
                self.idx_time.put(&mut wtxn, &idx_key(&row.timestamp, id), &())?;
            }
            max_line_end = max_line_end.max(row.line_end);
            out.ids.push(id);
        }

        if let (Some(k), false) = (cursor_key, out.ids.is_empty()) {
            self.meta.put(&mut wtxn, k, &max_line_end.to_string())?;
        }
        wtxn.commit()?;
        Ok(out)
    }

    pub fn get(&self, id: u64) -> Result<Option<String>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.exchanges.get(&rtxn, &id)?.map(str::to_owned))
    }

    /// The stored bytes as floats, whatever their length. Callers compare the
    /// length against the current dimension; a mismatch means a stale model.
    pub fn get_vector(&self, id: u64) -> Result<Option<Vec<f32>>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.vectors.get(&rtxn, &id)?.map(bytes_to_f32s))
    }

    pub fn put_vector(&self, id: u64, vector: &[f32]) -> Result<()> {
        let mut wtxn = self.env.write_txn()?;
        self.vectors.put(&mut wtxn, &id, &f32s_to_bytes(vector))?;
        wtxn.commit()?;
        Ok(())
    }

    /// Every vector of exactly `dim` floats, as (ids, flat data) ready for a graph
    /// rebuild. Rows of another length belong to a previous model and are skipped.
    pub fn all_vectors(&self, dim: usize) -> Result<(Vec<u64>, Vec<f32>)> {
        let rtxn = self.env.read_txn()?;
        let mut ids = Vec::new();
        let mut flat = Vec::new();
        for item in self.vectors.iter(&rtxn)? {
            let (id, bytes) = item?;
            if bytes.len() == dim * 4 {
                ids.push(id);
                flat.extend(bytes_to_f32s(bytes));
            }
        }
        Ok((ids, flat))
    }

    /// Ids matching every clause, from the secondary indexes alone. `None` means
    /// no filter was asked for, so callers can tell that from "matched nothing".
    pub fn filter_ids(&self, f: &IdFilter) -> Result<Option<Vec<u64>>> {
        if f.project.is_none() && f.session_id.is_none() && f.after.is_none() && f.before.is_none() {
            return Ok(None);
        }
        let rtxn = self.env.read_txn()?;
        let mut sets: Vec<std::collections::BTreeSet<u64>> = Vec::new();

        if let Some(p) = &f.project {
            let mut s = std::collections::BTreeSet::new();
            for item in self.idx_project.prefix_iter(&rtxn, &idx_prefix(p))? {
                s.insert(id_of(item?.0));
            }
            sets.push(s);
        }
        if let Some(sid) = &f.session_id {
            let mut s = std::collections::BTreeSet::new();
            for item in self.idx_session.prefix_iter(&rtxn, &idx_prefix(sid))? {
                s.insert(id_of(item?.0));
            }
            sets.push(s);
        }
        if f.after.is_some() || f.before.is_some() {
            // Keys are `<iso>\0<id>`. ISO 8601 sorts chronologically as bytes, and
            // the bound below the NUL / above 0xFF makes both ends inclusive.
            let lo: Vec<u8> = f.after.as_ref().map(|a| a.as_bytes().to_vec()).unwrap_or_default();
            let hi: Vec<u8> = f.before.as_ref().map(|b| {
                let mut k = b.as_bytes().to_vec();
                k.push(0xFF);
                k
            }).unwrap_or_default();
            let start: Bound<&[u8]> = if f.after.is_some() { Bound::Included(&lo) } else { Bound::Unbounded };
            let end: Bound<&[u8]> = if f.before.is_some() { Bound::Included(&hi) } else { Bound::Unbounded };
            let mut s = std::collections::BTreeSet::new();
            for item in self.idx_time.range(&rtxn, &(start, end))? {
                s.insert(id_of(item?.0));
            }
            sets.push(s);
        }

        let mut iter = sets.into_iter();
        let mut acc = iter.next().unwrap_or_default();
        for s in iter {
            acc = acc.intersection(&s).copied().collect();
        }
        Ok(Some(acc.into_iter().collect()))
    }

    /// Every exchange with id >= `from`, in id order. How the text index catches
    /// up from its cursor (design doc §09).
    pub fn exchanges_from(&self, from: u64) -> Result<Vec<String>> {
        let rtxn = self.env.read_txn()?;
        let mut out = Vec::new();
        for item in self.exchanges.range(&rtxn, &(from..))? {
            out.push(item?.1.to_owned());
        }
        Ok(out)
    }

    pub fn next_id(&self) -> Result<u64> {
        let rtxn = self.env.read_txn()?;
        Ok(self.exchanges.last(&rtxn)?.map(|(id, _)| id + 1).unwrap_or(0))
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        let rtxn = self.env.read_txn()?;
        Ok(self.meta.get(&rtxn, key)?.map(str::to_owned))
    }

    pub fn meta_put(&self, key: &str, value: &str) -> Result<()> {
        let mut wtxn = self.env.write_txn()?;
        self.meta.put(&mut wtxn, key, value)?;
        wtxn.commit()?;
        Ok(())
    }

    pub fn meta_remove(&self, key: &str) -> Result<bool> {
        let mut wtxn = self.env.write_txn()?;
        let removed = self.meta.delete(&mut wtxn, key)?;
        wtxn.commit()?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn row(line_end: u64) -> Row {
        Row {
            json: r#"{"project":"proj-a","userMessage":"q","assistantMessage":"a"}"#.into(),
            project: "proj-a".into(),
            session_id: Some("sess-1".into()),
            timestamp: "2026-03-01T10:00:00.000Z".into(),
            line_end,
            is_sidechain: false,
            embedding: Some(vec![1.0, 0.0, 0.0, 0.0]),
        }
    }

    fn open() -> (TempDir, Store) {
        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("store.mdb")).unwrap();
        (dir, store)
    }

    #[test]
    fn assigns_sequential_ids_from_zero_and_writes_the_id_into_the_record() {
        let (_d, store) = open();

        let out = store.insert(&[row(1), row(2)], None).unwrap();

        assert_eq!(out.ids, vec![0, 1]);
        let json: serde_json::Value = serde_json::from_str(&store.get(1).unwrap().unwrap()).unwrap();
        assert_eq!(json["id"], 1);
        assert_eq!(json["userMessage"], "q");
        assert_eq!(store.next_id().unwrap(), 2);
    }

    #[test]
    fn stores_the_vector_for_an_ordinary_row_and_none_for_a_subagent_row() {
        let (_d, store) = open();
        let side = Row { is_sidechain: true, ..row(1) };

        let out = store.insert(&[row(1), side], None).unwrap();

        assert_eq!(store.get_vector(out.ids[0]).unwrap(), Some(vec![1.0, 0.0, 0.0, 0.0]));
        assert_eq!(store.get_vector(out.ids[1]).unwrap(), None);
        assert!(store.get(out.ids[1]).unwrap().is_some(), "the exchange itself is kept");
    }

    #[test]
    fn all_vectors_skips_rows_of_another_dimension() {
        let (_d, store) = open();
        let out = store.insert(&[row(1), row(2)], None).unwrap();
        store.put_vector(out.ids[1], &[0.5, 0.5]).unwrap(); // a stale 2-dim vector

        let (ids, flat) = store.all_vectors(4).unwrap();

        assert_eq!(ids, vec![out.ids[0]]);
        assert_eq!(flat.len(), 4);
    }

    #[test]
    fn filter_none_means_no_restriction_and_no_match_means_empty() {
        let (_d, store) = open();
        store.insert(&[row(1)], None).unwrap();

        assert_eq!(store.filter_ids(&IdFilter::default()).unwrap(), None);
        let f = IdFilter { project: Some("nope".into()), ..Default::default() };
        assert_eq!(store.filter_ids(&f).unwrap(), Some(vec![]));
    }

    #[test]
    fn filters_by_project_without_prefix_confusion() {
        let (_d, store) = open();
        let a = store.insert(&[Row { project: "proj".into(), ..row(1) }], None).unwrap().ids[0];
        store.insert(&[Row { project: "proj2".into(), ..row(2) }], None).unwrap();

        let f = IdFilter { project: Some("proj".into()), ..Default::default() };
        assert_eq!(store.filter_ids(&f).unwrap(), Some(vec![a]));
    }

    #[test]
    fn filters_by_time_range_inclusively_and_intersects_with_project() {
        let (_d, store) = open();
        let r = |ts: &str, p: &str, le: u64| Row { timestamp: ts.into(), project: p.into(), ..row(le) };
        store.insert(&[r("2026-01-01T00:00:00.000Z", "a", 1)], None).unwrap();
        let mid = store.insert(&[r("2026-03-01T00:00:00.000Z", "a", 2)], None).unwrap().ids[0];
        let late_b = store.insert(&[r("2026-06-01T00:00:00.000Z", "b", 3)], None).unwrap().ids[0];
        let late_a = store.insert(&[r("2026-06-01T00:00:00.000Z", "a", 4)], None).unwrap().ids[0];

        let f = IdFilter { after: Some("2026-03-01T00:00:00.000Z".into()), ..Default::default() };
        assert_eq!(store.filter_ids(&f).unwrap(), Some(vec![mid, late_b, late_a]));

        let f = IdFilter {
            after: Some("2026-02-01T00:00:00.000Z".into()),
            before: Some("2026-06-01T00:00:00.000Z".into()),
            project: Some("a".into()),
            ..Default::default()
        };
        assert_eq!(store.filter_ids(&f).unwrap(), Some(vec![mid, late_a]));
    }

    #[test]
    fn exchanges_from_walks_forward_in_id_order() {
        let (_d, store) = open();
        store.insert(&[row(1), row(2), row(3)], None).unwrap();

        let rows = store.exchanges_from(1).unwrap();

        let ids: Vec<u64> = rows.iter().map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["id"].as_u64().unwrap()).collect();
        assert_eq!(ids, vec![1, 2]);
        assert!(store.exchanges_from(3).unwrap().is_empty());
    }

    #[test]
    fn meta_round_trips_and_removes() {
        let (_d, store) = open();

        store.meta_put("k", "42").unwrap();
        assert_eq!(store.meta_get("k").unwrap().as_deref(), Some("42"));
        assert!(store.meta_remove("k").unwrap());
        assert_eq!(store.meta_get("k").unwrap(), None);
        assert!(!store.meta_remove("k").unwrap());
    }

    // There is deliberately no "two handles on one path" test here: LMDB allows
    // one environment per process per path (heed returns EnvAlreadyOpened), so
    // that scenario can only be exercised with two real processes. The CLI race
    // test in the TypeScript suite does exactly that.
    #[test]
    fn a_replayed_batch_is_skipped_by_the_cursor_instead_of_duplicated() {
        // The race that produced 230 rows for 132 exchanges: two syncs both read
        // the old cursor, both embed, both insert. Now the check happens inside
        // the write transaction, so the second insert sees the advanced cursor.
        let (_d, store) = open();
        let key = "synced_line_end:/tmp/a.jsonl";

        let first = store.insert(&[row(10), row(20)], Some(key)).unwrap();
        let second = store.insert(&[row(10), row(20), row(30)], Some(key)).unwrap();

        assert_eq!(first.ids.len(), 2);
        assert_eq!(second.skipped, 2, "the overlap is skipped, not re-inserted");
        assert_eq!(second.ids.len(), 1);
        assert_eq!(store.next_id().unwrap(), 3);
        assert_eq!(store.meta_get(key).unwrap().as_deref(), Some("30"));
    }

    #[test]
    fn a_batch_entirely_below_the_cursor_leaves_the_cursor_alone() {
        let (_d, store) = open();
        let key = "synced_line_end:/tmp/a.jsonl";
        store.insert(&[row(50)], Some(key)).unwrap();

        let out = store.insert(&[row(10)], Some(key)).unwrap();

        assert_eq!(out, InsertOutcome { ids: vec![], skipped: 1 });
        assert_eq!(store.meta_get(key).unwrap().as_deref(), Some("50"));
    }

    #[test]
    fn data_survives_reopening() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("store.mdb");
        let id = { Store::open(&path).unwrap().insert(&[row(1)], None).unwrap().ids[0] };

        let reopened = Store::open(&path).unwrap();

        assert!(reopened.get(id).unwrap().is_some());
        assert_eq!(reopened.get_vector(id).unwrap(), Some(vec![1.0, 0.0, 0.0, 0.0]));
    }

    #[test]
    fn refuses_a_path_that_is_a_file_from_the_old_layout() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("store.mdb");
        std::fs::write(&path, b"old lmdb-js file").unwrap();

        assert!(Store::open(&path).is_err());
    }
}
