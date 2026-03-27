# 🦞 ThreadClaw — Stateful Evidence Engine

**Persistent, evidence-backed memory for AI agents.**

![tests](https://img.shields.io/badge/tests-947%20passing-brightgreen) <!-- 858 memory-engine + 89 src -->
![build](https://img.shields.io/github/actions/workflow/status/wbrady-dev/ThreadClaw/ci.yml?branch=main&label=build)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-22%2B-green)
![platform](https://img.shields.io/badge/platform-windows%20%7C%20linux%20%7C%20macos-lightgrey)

---

## What Is ThreadClaw?

ThreadClaw gives your AI agent **real memory** — not just conversation history, but structured knowledge that persists, self-corrects, and improves over time.

Without ThreadClaw, your AI forgets everything between conversations. With ThreadClaw, it remembers your projects, your decisions, your preferences, and your documents — and it knows which facts are current vs outdated.

ThreadClaw works standalone or as a plugin for [OpenClaw](https://openclaw.ai).

---

## OpenClaw vs OpenClaw + ThreadClaw

Without ThreadClaw, your agent only knows what's in the current conversation. With ThreadClaw, it has persistent memory across sessions — documents, decisions, corrections, and context that builds over time.

**Scenario:** You told your agent two weeks ago that your team switched from PostgreSQL to SQLite for staging. Today you ask:

> *"What database does staging use?"*

| OpenClaw alone | OpenClaw + ThreadClaw |
|---|---|
| *"I don't have that information. What database does staging use?"* | *"Staging uses SQLite. You switched from PostgreSQL on March 10."* |

It asks you to repeat yourself because it doesn't remember. ThreadClaw remembered the conversation, extracted the fact, and superseded the old one automatically.

**Scenario:** Over several conversations you said "we're using Valkey for caching", then later "actually no, switch to Redis", then "final answer: Redis." Today you ask:

> *"What's our caching setup?"*

| OpenClaw alone | OpenClaw + ThreadClaw |
|---|---|
| *"Could you tell me about your caching setup?"* | *"You're using Redis for caching. This was finalized after initially considering Valkey."* |

ThreadClaw tracked the full correction chain — Valkey → Redis — and knows which answer is current. It also indexed your architecture docs so it can pull supporting context if needed.

---

## How It Works

ThreadClaw has three layers that work together:

### Layer 1: RAG (Retrieval-Augmented Generation)
**What it does:** Indexes your files and lets the AI search them.

You point ThreadClaw at folders, Obsidian vaults, Google Drive, or Notion — it reads your documents, breaks them into searchable chunks, and lets your AI find relevant information when answering questions.

- Supports 20+ file formats (PDF, DOCX, PPTX, HTML, Markdown, CSV, JSON, code files, EPUB, email)
- Hybrid search: combines keyword matching with semantic understanding
- Watches your folders for changes and re-indexes automatically

### Layer 2: Conversation Memory (DAG)
**What it does:** Remembers what was said across conversations.

Instead of forgetting everything when a conversation ends, ThreadClaw stores the full conversation history in a structured format. It can summarize old conversations and recall relevant context.

- Lossless storage — nothing is lost
- Smart summarization — old conversations are condensed but searchable
- Cross-conversation recall — the AI can reference things from weeks ago

### Layer 3: Evidence OS (Knowledge Engine)
**What it does:** Extracts and manages structured knowledge automatically.

This is the key differentiator. Evidence OS listens to your conversations and automatically extracts:

| What | Example | Why it matters |
|------|---------|---------------|
| **Facts** | "staging uses SQLite" | Remembers project details without you writing docs |
| **Decisions** | "we're going with Redis" | Tracks what was decided and why |
| **Corrections** | "actually, not MySQL — use Postgres" | Supersedes old facts automatically |
| **Relationships** | "Cassidy is my wife", "Bob manages auth" | Understands your world (full relation lifecycle with decay) |
| **Preferences** | "I prefer short replies" | Personalizes responses |
| **Tasks** | "need to rotate the API key by Friday" | Tracks open items |
| **Negations** | "Nina does NOT report to Alex" | Correctly handles "not" statements |

**How extraction works:**

You just talk naturally. No special commands or prefixes needed.

- **Smart mode** (default): Uses an LLM to understand your messages. Catches nuance, corrections, sarcasm, and mixed intent. Includes LLM-powered invariant extraction.
- **Fast mode**: Regex-only, no LLM needed. Under 5ms per message. Good for high-volume or offline use. Regex fallback for invariant detection.

**How conflicts are resolved:**

When you say something that contradicts what was previously known, the **TruthEngine** kicks in:

1. Detects the contradiction (e.g., "staging uses SQLite" vs old "staging uses PostgreSQL")
2. Supersedes the old claim — marks it inactive, not deleted
3. Records the change as a delta (old value → new value)
4. Updates the evidence chain so you can always trace back

**How it surfaces knowledge:**

The **Context Compiler** scores every piece of knowledge by relevance, confidence, and freshness — then assembles the most important facts into a compact injection for the AI's context window. It stays within a configurable token budget (110-280 tokens) so it never overwhelms the conversation.

The output is clearly labeled:
- **[Resolved Facts — current state]** — authoritative, these are what the AI should treat as true
- **[Active Decisions]** — choices that were made and are still in effect
- **[Relationships]** — connections between people, projects, and things
- **[Conversation History — may contain outdated info]** — raw context, useful but may include superseded information

---

## What You DON'T Need to Do

- **No manual tagging.** ThreadClaw extracts facts automatically.
- **No special syntax.** Just talk normally — "we decided to use Redis", not "Decision: Redis".
- **No data entry.** Your conversations become your knowledge base.
- **No cloud.** Everything runs locally on your machine. Nothing leaves your hardware.
- **No maintenance.** Old facts get superseded automatically. Stale data decays over time.

---

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
6. Create all databases and register the `threadclaw` command globally

After install, open a **new terminal** and run `threadclaw` to launch the TUI.

---

## Model Tiers

| Tier | Embedding | Reranking | VRAM | Quality |
|------|-----------|-----------|------|---------|
| **Lite** | all-MiniLM-L12-v2 | MiniLM Rerank (Small) | ~2 GB | Good |
| **Standard** | bge-large-en-v1.5 | bge-reranker-large | ~3 GB | Great |
| **Premium** | Nemotron Embed 3B | bge-reranker-v2-gemma | ~11 GB | Best |
| **Custom** | Any HuggingFace model | Any cross-encoder | Varies | Varies |

All models run locally. Cloud providers (OpenAI, Cohere, Voyage AI, Google) also supported.

---

## Evidence OS — Deep Dive

Evidence OS is the intelligence layer that makes ThreadClaw more than a search engine. Here's what each component does:

### Entity Awareness
Extracts named entities (people, projects, tools, services) from text and tracks them. When you mention "Project Orion" and later say "Orion", it knows they're the same thing. Includes **proactive awareness** — when no specific matches are found, top relevant entities are surfaced automatically.

### Claims & Decisions
Every fact you state becomes a **claim** with a confidence score and evidence chain. Every choice you make becomes a **decision**. When facts change, old claims are superseded — not deleted — so you always have history.

### TruthEngine
The reconciliation engine that decides what happens when new information conflicts with existing knowledge:
- **Supersession** — new fact replaces old fact (same subject, same topic, different value). Entity, capability, and relation kinds all participate in supersession.
- **Conflict creation** — contradictory facts from different sources are flagged
- **Confidence blending** — repeated confirmations increase confidence
- **Correction guards** — explicit corrections ("actually, not X — use Y") get priority
- **Belief propagation** — contradict/support provenance links automatically adjust confidence on linked claims

### Canonical Key System
How ThreadClaw knows two facts are about the same thing. Uses LLM-generated **topic labels** (not hardcoded rules) to group related claims:
- "staging uses PostgreSQL" and "staging runs on Postgres" → same topic: **database**
- "Nina reports to Alex" and "Nina works under Alex" → same topic: **manager**

When two claims share the same subject + topic, the newer one supersedes the old one.

### Context Compiler (ROI Governor)
Not everything in memory is worth surfacing. The context compiler scores every piece of knowledge by:
- **Relevance** — how useful is this right now?
- **Confidence** — how certain is this fact?
- **Freshness** — how recent is this?
- **Token cost** — how many tokens does it consume?

It fills a budget greedily: highest value-per-token first. Default budgets: Lite (110 tokens), Standard (190 tokens), Premium (280 tokens).

### Extraction Quality Filters
Not everything said should become a fact. ThreadClaw filters out:
- Code blocks, file paths, URLs
- Message metadata ("Wesley sent a message at 2:51 PM")
- Sarcasm and jokes ("the printer runs on magic")
- Hypotheticals ("what if we used MongoDB?")
- Explicitly marked non-facts ("example only", "don't store this", "I'm not sure any of this is true")
- Error messages and stack traces

### Attempt Ledger & Runbooks
Tracks what tools succeeded and failed. If a tool fails repeatedly with the same pattern, ThreadClaw creates an **anti-runbook** — a warning that says "don't try this approach, it failed 3 times already." Conversely, after 3+ consecutive successes, a **runbook** is auto-inferred and surfaced as a capsule in CCL. This prevents the AI from repeating known mistakes and reinforces proven patterns.

### Open Loops
Tracks things that need follow-up: pending tasks, unanswered questions, things you said you'd do "by Friday." These surface in the context injection with priority ordering.

### Branch Promotion
Speculative memory for exploratory conversations. Facts stay in a "branch" until validated, then get promoted to the shared scope. Prevents test data or brainstorming from polluting your main knowledge base.

---

## RSMA Architecture

ThreadClaw is built on **RSMA (Reconciled Semantic Memory Architecture)** — a ten-layer system:

> `RSMA = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

| Layer | Full Name | What It Does |
|-------|-----------|-------------|
| **RAG** | Retrieval-Augmented Generation | Searches your documents with hybrid vector + keyword matching |
| **DAG** | Directed Acyclic Graph | Lossless conversation memory with smart summarization |
| **KG** | Knowledge Graph | Structured entity-relationship tracking |
| **AL** | Awareness Layer | Entity extraction, mismatch detection, contextual notes |
| **SL** | State Layer | Claims, decisions, invariants — current state of the world |
| **DE** | Delta / Deep Extraction | Tracks changes over time, LLM-powered extraction |
| **AOM** | Attempt/Outcome Memory | Tool success/failure tracking, anti-runbooks |
| **BSG** | Branch/Scope Governance | Speculative branches, promotion policies |
| **EEL** | Evidence Event Log | Append-only audit trail of every knowledge change |
| **CCL** | Context Compilation Layer | ROI-scored capsule injection within token budgets |

---

## Features

### Search & Retrieval
- **Hybrid Search** — dense vector + BM25 keyword matching fused via Reciprocal Rank Fusion
- **Cross-Encoder Reranking** — re-scores results with a cross-encoder for precision
- **Smart Rerank Skip** — bypasses reranking when the top result is already a clear winner
- **Token-Efficient Output** — `--brief` (~200 tokens), `--titles` (~30 tokens), `--full` (~1500 tokens)
- **Search Highlighting** — matched query terms in bold
- **Query Cache** — 50-entry LRU with 5-minute TTL. Repeat queries cost zero tokens
- **Query Expansion** — optional HyDE + decomposition + multi-query via local LLM
- **Semantic Deduplication** — near-duplicate chunks detected during ingest

### Document Ingestion
- **20+ File Formats** — PDF, DOCX, PPTX, HTML, Markdown, CSV, JSON, Email, Code, EPUB, and more
- **Incremental Indexing** — detects unchanged files by content hash, never re-processes
- **Auto-Ingestion** — file watcher monitors directories for new/changed files
- **Named Entity Recognition** — spaCy NER extracts people, organizations, locations, dates
- **Incremental Re-indexing** — re-chunk and re-embed documents when settings change

### Source Adapters

| Source | Type | Setup |
|--------|------|-------|
| **Local Files** | Realtime (chokidar) | WATCH_PATHS in .env |
| **Obsidian** | Realtime | Auto-detected during install |
| **Google Drive** | Polling | OAuth flow in TUI Sources screen |
| **OneDrive** | Polling | OAuth or local sync folder (in development) |
| **Notion** | Polling | API key in TUI Sources screen |
| **Apple Notes** | Polling | macOS only, AppleScript |

### Integration
- **Interactive TUI** — terminal UI for configuration, status, service management, reset, and uninstall
- **CLI** — full command-line interface with path validation for scripting
- **HTTP API** — REST endpoints with timing-safe API key auth and rate limiting
- **MCP Server** — Model Context Protocol for native tool access from AI agents
- **OpenClaw Plugin** — one-command setup as knowledge skill + memory engine
- **Cross-Platform** — Windows (Task Scheduler), macOS (launchd), Linux (systemd --user)
- **Local-First** — all models run on your hardware. No data leaves your machine.

### Agent Tools (12)

| Tool | What it does |
|------|-------------|
| `cc_memory` | Unified smart search — finds facts, decisions, relationships, and conversation history |
| `cc_grep` | Full-text search across conversation memory |
| `cc_describe` | Describe the current knowledge state |
| `cc_expand` | Deep-dive into a topic with recursive expansion |
| `cc_recall` | Recall a specific conversation or summary |
| `cc_claims` | Query structured claims (facts) |
| `cc_decisions` | Query active decisions |
| `cc_loops` | Query open tasks and follow-ups |
| `cc_attempts` | Query tool success/failure history |
| `cc_branch` | Manage speculative branches |
| `cc_procedures` | Query runbooks and anti-runbooks |
| `cc_diagnostics` | RSMA health check and Evidence OS stats |

---

## Databases

ThreadClaw uses three SQLite databases:

| Database | Path | Purpose |
|----------|------|---------|
| **threadclaw.db** | `~/.threadclaw/data/threadclaw.db` | RAG: documents, chunks, vectors, search metadata |
| **graph.db** | `~/.threadclaw/data/graph.db` | Evidence OS: claims, decisions, loops, entities, relations |
| **memory.db** | `~/.threadclaw/data/memory.db` | Conversations: messages, summaries, context items |

### Reset Options (TUI)

| Option | threadclaw.db | graph.db | memory.db |
|--------|:-----------:|:--------:|:---------:|
| **Reset KB only** | Cleared | Preserved | Preserved |
| **Reset KB + Evidence OS** | Cleared | Cleared | Preserved |
| **FULL WIPE** | Cleared | Cleared | Cleared |

The Full Wipe requires typing "DELETE EVERYTHING" to confirm.

---

## Usage

### CLI

```bash
# Search your knowledge base
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

---

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

---

## Architecture

```
                    ThreadClaw (Node.js :18800)
                    +-------------------------------+
 threadclaw query-> |  Query Pipeline               |  
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

---

## Security

- **API Key Auth** — timing-safe SHA-256 comparison via `crypto.timingSafeEqual`
- **Path Validation** — blocks ingestion of `.env`, `.ssh/`, `.git/`, credentials, private keys (both API and CLI)
- **MCP Path Validation** — same path blocklist enforced for MCP tool calls
- **Localhost Guards** — destructive operations (`/reset`, `/shutdown`, `/reindex`) restricted to localhost
- **Rate Limiting** — sliding window per IP with configurable limits
- **Python Path Blocklist** — segment-aware matching mirrors the Node.js validation
- **OAuth Security** — localhost-only callback servers, CSRF state validation

---

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

---

## Documentation

**Getting Started:**
[Install](docs/install.md) | [Quick Start](docs/quickstart.md) | [Configuration](docs/configuration.md) | [Migration](docs/migration.md)

**Reference:**
[Tools (13)](docs/tools.md) | [Schema](docs/schema.md) | [API](docs/api.md) | [FAQ](docs/faq.md)

**Concepts:**
[Core Concepts](docs/concepts.md) | [Architecture](docs/architecture.md) | [Scopes & Branches](docs/scopes-and-branches.md) | [Promotion Policies](docs/promotion-policies.md)

**Advanced:**
[Runbooks & Anti-Runbooks](docs/runbooks-and-negative-memory.md) | [Invariants](docs/invariants.md) | [Capabilities](docs/capability-registry.md) | [Evaluation](docs/evaluation.md)

**Operations:**
[Security & Privacy](docs/security-and-privacy.md) | [Performance](docs/performance.md) | [Observability](docs/observability.md) | [Replay & Rebuild](docs/replay-and-rebuild.md) | [Troubleshooting](docs/troubleshooting.md)

**Contributing:**
[Contributor Guide](docs/contributor-guide.md) | [Testing](docs/testing.md) | [Release Process](docs/release-process.md)

---

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
