# ThreadClaw — Stateful Evidence Engine

**Persistent, evidence-backed memory for AI agents.**

![tests](https://img.shields.io/badge/tests-947%20passing-brightgreen)
![build](https://img.shields.io/github/actions/workflow/status/wbrady-dev/ThreadClaw/ci.yml?branch=main&label=build)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-22%2B-green)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey)

---

**ThreadClaw** brings a knowledge and memory backbone to [OpenClaw](https://openclaw.ai), built on the **RSMA (Reconciled Semantic Memory Architecture)** — a multi-layer agent architecture that combines retrieval, summary lineage, knowledge graphs, awareness, evidence-backed state, delta tracking, attempt memory, branch governance, and low-token context compilation. It gives your AI agent persistent, inspectable, evidence-backed memory.

### Evidence OS

ThreadClaw's Evidence OS extracts structured knowledge from conversations, documents, and tool results — then surfaces it at the right time via an ROI-governed context compiler.

- **Entity Awareness** — Extracts entities from text, detects mismatches across sources, surfaces contextual notes
- **Claims & Decisions** — Tracks factual claims with evidence chains, manages decision history with automatic supersession
- **Entity Relations** — Extracts relationships between people, things, and concepts ("Cassidy works for Sam")
- **Open Loops** — Tracks pending tasks, questions, and dependencies with priority ordering
- **Invariants & Capabilities** — Stores durable constraints and tracks available tools/services
- **Attempt Ledger** — Records tool outcomes, calculates success rates per tool
- **Runbooks & Anti-Runbooks** — Learns success patterns and failure patterns from tool history
- **Branch Promotion** — Speculative memory with policy-validated promotion to shared scope
- **Timeline & Snapshots** — Event timeline materialization and point-in-time state reconstruction
- **Semantic Extraction** — Two modes: **Smart** (LLM-based, understands natural language without magic prefixes) and **Fast** (regex-only, no LLM, <5ms). Configurable via `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart|fast`
- **Extraction Quality Filters** — Multi-layer junk rejection: code block stripping, LLM prompt rules, post-extraction filters (rejects message metadata, file paths, URLs, low-confidence noise, transient debugging context)
- **Typed Structured Interfaces** — `StructuredClaim`, `StructuredDecision`, `StructuredLoop`, `StructuredEntity` — compile-time type safety prevents field-name mismatches between extraction and storage
- **Unified Ontology** — `memory_objects` + `provenance_links` replace 15+ legacy tables. Single `MemoryObject` type with 13 kinds, unified CRUD via mo-store.ts (upsert with weighted confidence blending), 19 migrations (v1-v19) including full legacy data copy and table rename
- **TruthEngine** — Reconciles new knowledge against existing beliefs: supersession, conflict creation, confidence blending, value contradiction detection (Jaccard + containment), correction guards, and provisional handling
- **Context Compiler** — ROI-scored capsule compilation with configurable token budgets (110-280 tokens)
- **12 Agent Tools** — `cc_grep`, `cc_describe`, `cc_expand`, `cc_recall`, `cc_claims`, `cc_decisions`, `cc_loops`, `cc_attempts`, `cc_branch`, `cc_procedures`, `cc_diagnostics`, `cc_memory`

### RSMA Architecture

> `RSMA = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

**R**etrieval-Augmented Generation, **D**irected **A**cyclic **G**raph summary lineage, **K**nowledge **G**raphs, **A**wareness **L**ayer, **S**tate **L**ayer, **D**elta tracking / **D**eep **E**xtraction, **A**ttempt/**O**utcome **M**emory, **B**ranch/**S**cope **G**overnance, **E**vidence **E**vent **L**og, **C**ontext **C**ompilation **L**ayer.

## Features

- **Hybrid Search** — dense vector + BM25 keyword matching fused via Reciprocal Rank Fusion
- **Cross-Encoder Reranking** — re-scores results with a cross-encoder for precision
- **Smart Rerank Skip** — bypasses reranking when the top result is already a clear winner; graceful BM25-only fallback when embedding server is down
- **Token-Efficient Output** — `--brief` (~200 tokens), `--titles` (~30 tokens), `--full` (~1500 tokens)
- **Search Highlighting** — matched query terms in bold for brief mode
- **Query Cache** — 50-entry LRU, 5-minute TTL, SHA-256 keys (includes model name). Repeat queries cost zero tokens
- **Query Expansion** — optional HyDE + decomposition + multi-query via local LLM
- **Query Analytics** — track search quality, latency, confidence; zero-result queries recorded for improvement
- **Semantic Deduplication** — near-duplicate chunks detected via cosine similarity during ingest; multi-embedding duplicates deduplicated before RRF
- **Incremental Re-indexing** — re-chunk and re-embed documents when settings change
- **20+ File Formats** — PDF, DOCX, PPTX (with data descriptor support), HTML, Markdown, CSV, JSON, Email (multi-recipient), Code, EPUB, and more
- **Incremental Indexing** — detects unchanged files by content hash, never re-processes
- **Auto-Ingestion** — file watcher monitors directories with chokidar `awaitWriteFinish` debouncing
- **Named Entity Recognition** — spaCy NER extracts people, organizations, locations, dates from ingested content
- **Source Adapters** — Google Drive, Notion, Apple Notes, Obsidian, local files — with removal detection and parallel startup
- **Collections** — organize documents into named collections with concurrent-safe creation
- **Interactive TUI** — terminal UI for configuration, status, service management, reset, and uninstall
- **CLI** — full command-line interface with path validation for scripting and automation
- **HTTP API** — REST endpoints with timing-safe API key auth, rate limiting, and isLocalRequest guards
- **MCP Server** — Model Context Protocol with path validation for native tool access from AI agents
- **Memory Engine** — DAG-based lossless conversation context with singleton engine caching per database
- **OpenClaw Integration** — one-command setup as knowledge skill + memory engine
- **Cross-Platform** — Windows (Task Scheduler), macOS (launchd), Linux (systemd --user, no sudo)
- **Local-First** — all models run on your hardware. No data leaves your machine.

## Documentation

**Getting Started:**
[Install](docs/install.md) | [Quick Start](docs/quickstart.md) | [Configuration](docs/configuration.md) | [Migration](docs/migration.md)

**Reference:**
[Tools (12)](docs/tools.md) | [Schema](docs/schema.md) | [API](docs/api.md) | [FAQ](docs/faq.md)

**Concepts:**
[Core Concepts](docs/concepts.md) | [Architecture](docs/architecture.md) | [Scopes & Branches](docs/scopes-and-branches.md) | [Promotion Policies](docs/promotion-policies.md)

**Advanced:**
[Runbooks & Anti-Runbooks](docs/runbooks-and-negative-memory.md) | [Invariants](docs/invariants.md) | [Capabilities](docs/capability-registry.md) | [Evaluation](docs/evaluation.md)

**Operations:**
[Security & Privacy](docs/security-and-privacy.md) | [Performance](docs/performance.md) | [Observability](docs/observability.md) | [Replay & Rebuild](docs/replay-and-rebuild.md) | [Troubleshooting](docs/troubleshooting.md)

**Contributing:**
[Contributor Guide](docs/contributor-guide.md) | [Testing](docs/testing.md) | [Release Process](docs/release-process.md)

## Quick Start

### Windows (Command Prompt)

```cmd
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd ThreadClaw
install.bat
```

### Windows (PowerShell)

```powershell
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd ThreadClaw
.\install.bat
```

### Linux / Mac

```bash
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd ThreadClaw
chmod +x install.sh
./install.sh
```

The installer will:
1. Check prerequisites (Node.js 22+, Python 3.10+, GPU, disk space)
2. Let you choose a model tier (Lite ~2GB, Standard ~4GB, Premium ~12GB VRAM)
3. Install dependencies, download models, OCR, audio transcription, and NER
4. Detect and connect Obsidian vaults
5. Optionally integrate with OpenClaw

After install, open a **new terminal** and run `threadclaw` to launch the TUI.

## Model Tiers

| Tier | Embedding | Reranking | VRAM | Quality |
|------|-----------|-----------|------|---------|
| **Lite** | all-MiniLM-L12-v2 | MiniLM Rerank (Small) | ~2 GB | Good |
| **Standard** | bge-large-en-v1.5 | bge-reranker-large | ~3 GB | Great |
| **Premium** | Nemotron Embed 3B | bge-reranker-v2-gemma | ~11 GB | Best |
| **Custom** | Any HuggingFace model | Any cross-encoder | Varies | Varies |

All models run locally. Cloud providers (OpenAI, Cohere, Voyage AI, Google) also supported.

## Databases

ThreadClaw uses three SQLite databases, each with a distinct purpose:

| Database | Path | Purpose |
|----------|------|---------|
| **threadclaw.db** | `~/.threadclaw/data/threadclaw.db` | RAG knowledge base: documents, chunks, vectors, metadata |
| **graph.db** | `~/.threadclaw/data/graph.db` | Evidence OS: claims, decisions, loops, entities, relations, provenance |
| **memory.db** | `~/.threadclaw/data/memory.db` | Conversation memory: messages, summaries, context items |

### Reset Options (TUI)

| Option | threadclaw.db | graph.db | memory.db |
|--------|:-----------:|:--------:|:---------:|
| **Reset KB only** | Cleared | Preserved | Preserved |
| **Reset KB + Evidence OS** | Cleared | Cleared | Preserved |
| **FULL WIPE** | Cleared | Cleared | Cleared |

The Full Wipe requires typing "DELETE EVERYTHING" to confirm and shows a detailed summary of what was deleted (document counts, message counts, etc.).

## Usage

### CLI

```bash
# Search
threadclaw query "what is VLSM?" --collection networking --brief

# Ingest a file
threadclaw ingest ./research-paper.pdf --collection research

# Ingest a folder recursively
threadclaw ingest ./documents/ -r --collection docs

# Simple search (no reranking, faster)
threadclaw search "subnet mask" --collection networking

# List collections
threadclaw collections list

# System health check
threadclaw doctor

# System status
threadclaw status

# Start model + API servers
threadclaw serve

# Launch interactive TUI
threadclaw
```

### Output Modes

| Mode | Flag | Tokens | Use Case |
|------|------|--------|----------|
| Brief | `--brief` | ~200 | Default. Best for agents. Includes highlighting. |
| Titles | `--titles` | ~30 | Exploration. "What docs do I have?" |
| Full | `--full` | ~1500 | Read the actual content. |

## Source Adapters

| Source | Type | Setup |
|--------|------|-------|
| **Local Files** | Realtime (chokidar) | WATCH_PATHS in .env |
| **Obsidian** | Realtime | Auto-detected during install |
| **Google Drive** | Polling | OAuth flow in TUI Sources screen |
| **OneDrive** | Polling | OAuth or local sync folder (in development) |
| **Notion** | Polling | API key in TUI Sources screen |
| **Apple Notes** | Polling | macOS only, AppleScript |

Configure from `Sources` in the TUI. All indexing runs locally. Cloud adapters detect file removals and clean up the local knowledge base automatically.

## OpenClaw Integration

ThreadClaw integrates with OpenClaw as both a **knowledge skill** and **memory engine**:

1. **Knowledge Engine** — agents search your documents via `threadclaw query`
2. **Memory Engine** — DAG-based conversation context (replaces built-in memory-core)

The installer handles this automatically, or run manually:

```bash
python server/integrate_openclaw.py ~/.openclaw ./threadclaw nvidia/llama-nv-embed-reasoning-3b
```

## HTTP API

```
GET  /health                — Service health check (exempt from auth)
GET  /stats                 — System statistics (includes token usage)
POST /query                 — Search knowledge base (max 2000 chars)
POST /search                — Simple search (no reranking)
POST /ingest                — Ingest file by path (path validation enforced)
POST /ingest/text           — Ingest raw text
GET  /collections           — List collections
POST /collections           — Create collection
DELETE /collections/:id     — Delete collection (invalidates cache)
GET  /collections/:id/stats — Collection statistics
GET  /documents             — List documents in a collection
DELETE /documents/:id       — Delete document (cascades to chunks, vectors, graph)
POST /reset                 — Reset knowledge base (localhost only, options: clearGraph, clearMemory)
POST /reindex               — Re-ingest all documents (localhost only)
POST /reindex/stale         — Re-ingest only modified documents (localhost only)
GET  /analytics             — Query performance summary
GET  /analytics/recent      — Recent queries with full details
GET  /analytics/diagnostics — Full RSMA health and Evidence OS stats (localhost only)
DELETE /analytics           — Clear analytics data
GET  /sources               — Source adapter status
POST /sources/reload        — Hot-reload source configuration (localhost only)
POST /shutdown              — Graceful shutdown: flushes tokens, stops sources, closes DB (localhost only)
```

Default port: 18800 (localhost only; set `THREADCLAW_HOST=0.0.0.0` to expose).

Rate limited: 300 requests/minute per IP (configurable via `RATE_LIMIT_MAX`).

Authentication: set `THREADCLAW_API_KEY` to require `Authorization: Bearer <key>` on all endpoints (timing-safe comparison).

## Architecture

```
                    ThreadClaw (Node.js :18800)
                    +-------------------------------+
  threadclaw query -> |  Query Pipeline             |
  HTTP POST      -> |  cache -> expand ->           |
  MCP tool       -> |  embed -> search ->           |
                    |  dedup -> gate -> rerank ->   |
                    |  pack -> highlight ->         |
                    |  brief/titles/full            |
                    +---------------+---------------+
                                    |
                    +---------------+---------------+
                    |  3 SQLite Databases            |
                    |  threadclaw.db: vectors + FTS5 |
                    |  graph.db: Evidence OS         |
                    |  memory.db: conversations      |
                    +---------------+---------------+
                                    |
                    +---------------+---------------+
                    |  Model Server (Python :8012)   |
                    |  embed | rerank | OCR | NER    |
                    |  float16 | warmup | Waitress   |
                    +-------------------------------+
```

## Security

- **API Key Auth** — timing-safe SHA-256 comparison via `crypto.timingSafeEqual`
- **Path Validation** — blocks ingestion of `.env`, `.ssh/`, `.git/`, credentials, private keys (both API and CLI)
- **MCP Path Validation** — same path blocklist enforced for MCP tool calls
- **Localhost Guards** — destructive operations (`/reset`, `/shutdown`, `/reindex`) restricted to localhost
- **Rate Limiting** — sliding window per IP with configurable limits
- **Python Path Blocklist** — segment-aware matching mirrors the Node.js validation
- **OAuth Security** — localhost-only callback servers, CSRF state validation

## Testing

**947 tests** across **43 test files**, running on every push via GitHub Actions CI.

```bash
# Run all tests
npm test                    # 89 src tests (API, parsers, chunker, CLI)
cd memory-engine && npm test # 858 memory-engine tests
```

### Test Suite Breakdown

| Suite | Tests | What it covers |
|-------|-------|---------------|
| **RSMA Stress** | 37 | 1000 entities, 500 claims, 300 attempts, performance benchmarks |
| **RSMA Truth** | 31 | TruthEngine: supersession, conflict, correction, reconciliation |
| **RSMA Reader** | 37 | Unified memory_objects queries, scoring, ranking, all 8 kinds |
| **RSMA Golden Corpus** | 41 | Extraction quality baselines, known-good extraction patterns |
| **RSMA Failure Injection** | 44 | Concurrent stress, corrupt data, edge cases, recovery |
| **RSMA Corrections** | 47 | Correction detection, is_correction_of, confidence adjustment |
| **Relations H2** | 34 | Claims, decisions, loops, invariants CRUD + supersession chains |
| **Relations H3** | 24 | Runbooks, anti-runbooks, decay, context compiler capsules |
| **Relations H3 Promotion** | 25 | Branch promotion, canonical key collision, auto-supersession |
| **Relations H4** | 16 | Evidence chains, provenance links, evidence retrieval |
| **Relations H5** | 13 | Entity relations, deep extraction, relation graph |
| **Relations Core** | 46 | Entity CRUD, mentions, awareness, scope isolation, re-extraction |
| **Engine** | 54 | Bootstrap, ingest, compaction, assembly, token budgets |
| **Expansion Auth** | 50 | Grants, depth enforcement, token caps, revocation, expiry |
| **Data Shapes** | 6 | Field name contracts between extraction and storage |
| **Relations Integration** | 8 | Full pipeline: extraction → entity_relations table |
| **Security Hardening** | 14 | Path validation, model server discovery, file permissions |
| **API Routes** | 89 | All HTTP endpoints, auth, rate limiting, validation |

## Requirements

- **Node.js** 22+
- **Python** 3.10+
- **GPU** recommended (NVIDIA CUDA 12+, AMD ROCm, Apple MPS), CPU mode available
- **Disk** ~15-20GB for models and data

## Credits

- **Memory Engine** based on [lossless-claw](https://github.com/nicobailon/lossless-claw) by [Martian Engineering](https://github.com/nicobailon) / [Voltropy](https://x.com/Voltropy) (MIT License). DAG-based lossless conversation memory with incremental compaction.
- **ThreadClaw** created by Wesley Brady for [OpenClaw](https://openclaw.ai).

## License

MIT
