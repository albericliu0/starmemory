# starmemory

Search your past Claude Code and Codex conversations from inside either tool.

starmemory indexes every transcript both harnesses write to disk into one
local store, and exposes two MCP tools: `search` (hybrid: BM25 over Tantivy
plus HNSW vectors over usearch, fused by reciprocal rank) and `read` (the full
transcript). It keeps its own gzip copy of each transcript so search results
still open after Claude Code's 30-day cleanup, writes a short summary beside
each conversation once it has gone quiet, and forgets conversations older than
a configurable TTL.

Everything runs on your machine. Nothing leaves it except the summary
requests, which go through your own Claude Code or Codex login.

## Requirements

- Node 22 or newer on the machine.
- One of: macOS on Apple Silicon (`darwin-arm64`), Linux x64 or arm64
  (`linux-x64`, `linux-arm64`, including WSL), Windows x64 (`win32-x64`).
  The native index engine is a prebuilt binary; darwin-arm64 ships in the
  plugin, the others are fetched from the matching GitHub release on first run
  and verified against its `SHA256SUMS`.
- About 700 MB of disk for dependencies and the bilingual embedding model
  (jina-embeddings-v2-base-zh), installed on first run.

## Install in Claude Code

```
claude plugin marketplace add albericliu0/starmemory
claude plugin install starmemory
```

Restart Claude Code (a running session keeps the MCP server it started with).
The first start installs dependencies and downloads the model; the first
`search` after that takes a minute while the model loads, then it is fast.

Check it is connected with `/mcp`. Then ask Claude something like "what did we
decide about the index rebuild last week" and it will call `search`.

To update later:

```
claude plugin update starmemory
```

## Install in Codex

```
codex plugin marketplace add albericliu0/starmemory
```

Start Codex, open `/plugins`, and install `starmemory`. Then enable plugin
hooks and trust ours:

```
codex features enable plugin_hooks
```

Open `/hooks` in Codex, select the starmemory `SessionStart` hook and press
`t` to trust it. Codex does not run a plugin's hooks until you have. Without
this, the MCP tools work but nothing new gets indexed.

Codex conversations are summarised through `codex app-server`, which needs
codex-cli 0.130.0 or newer.

## What happens when

- **Session start** (and `--resume`, `/clear`, and after a compaction): a
  background sync copies new transcript lines into the archive, embeds and
  indexes them, summarises up to ten conversations that have been quiet for
  two hours, and deletes conversations past the TTL. It runs detached, so the
  session does not wait for it. Its log is `~/.config/starmemory/sync.log`.
- **`search`**: hybrid by default; `mode: "text"` or `"vector"` for one side
  only; an array of 2-5 concepts for AND matching; filters for project,
  session, harness and date range. Each hit shows the conversation's summary
  when one exists.
- **`read`**: the transcript at a given path, optionally a line range.

Data lives under `~/.config/starmemory`: `store.mdb` (LMDB, the source of
truth), `index-v*.g*.hnsw` (vector index, rebuilt from the store),
`text-v*/` (Tantivy), `archive/<harness>/<project>/` (gzipped transcripts and
their `-summary.txt`).

## Configuration

All optional, all environment variables read by the plugin's processes.

| Variable | Default | Meaning |
|---|---|---|
| `STARMEMORY_TTL_DAYS` | `180` | Conversations quiet for longer are deleted everywhere. `0` disables. |
| `STARMEMORY_SUMMARY_LIMIT` | `10` | Summaries written per sync. `0` disables summaries. |
| `STARMEMORY_SUMMARY_MODEL` | `haiku` | Model for Claude Code conversation summaries (`sonnet` is the fallback). |
| `STARMEMORY_DB_PATH`, `STARMEMORY_INDEX_PATH`, `STARMEMORY_TEXT_INDEX_PATH`, `STARMEMORY_ARCHIVE_PATH`, `STARMEMORY_LOG_PATH` | under `~/.config/starmemory` | Where things live. |
| `STARMEMORY_CODEX_BIN` | `codex` | The Codex binary used for summaries. |
| `STARMEMORY_ADDON_BASE_URL` | GitHub releases | Where to fetch the native addon from. Must be https. |

## Build from source

Needed only on a platform without a prebuilt binary, or to hack on it.
Requires a Rust toolchain.

```
npm install
npm run build        # cargo build --release, then tsc
npm test             # cargo test, then vitest
```

`npm run build:native` writes `native/starmemory_native.<platform>-<arch>.node`
for the machine it runs on. `npm run package` stages an installable copy under
`build-pkg/` from the committed tree.

## Status

Verified on macOS (daily use) and, through CI, on Linux x64 and arm64. Windows
x64 builds and passes the test suite in CI; two things still need a hand on a
real Windows install: whether Claude Code there can start the plugin through
`cli/run-node.cmd` (the manifests name the POSIX `sh` shim), and a full
session with the hook. The Codex integration is exercised against a fake
`app-server` in tests and has not yet been run inside a real Codex session.

Design notes live outside the repo, in Chinese; ask if you want them.
