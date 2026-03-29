# ThreadClaw RSMA — Technical Reference

Complete technical documentation for ThreadClaw's **RSMA (Reconciled Semantic Memory Architecture)** — a multi-layer agent architecture that combines retrieval, summary lineage, knowledge graphs, awareness, evidence-backed state, delta tracking, attempt memory, branch governance, and low-token context compilation.

> `RSMA = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

Covers architecture, query pipeline, ingestion, storage, evidence store, source adapters, OpenClaw integration, and configuration.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                         ThreadClaw                       │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ CLI/TUI  │  │ HTTP API │  │   MCP    │  │ Watcher  │  │
│  │ threadclaw │  │  :18800  │  │  stdio   │  │ chokidar  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │             │             │             │        │
│       └─────────────┴──────┬──────┴─────────────┘        │
│                            │                             │
│  ┌─────────────────────────┴──────────────────────────┐  │
│  │            Query Pipeline                          │  │
│  │  validate → cache → expand → retrieve → gate →     │  │
│  │  rerank → dedup → highlight → brief/titles/full    │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
│  ┌─────────────────────────┴──────────────────────────┐  │
│  │            Ingestion Pipeline                      │  │
│  │  parse → chunk → embed → semantic dedup → store    │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
│  ┌─────────────────────────┴──────────────────────────┐  │
│  │      Source Adapters (polling + realtime)          │  │
│  │  Local │ Obsidian │ Google Drive │ Notion │ Apple  │  │
│  └────────────────────────────────────────────────────┘  │
│                            │                             │
│  ┌─────────────────────────┴──────────────────────────┐  │
│  │      Storage Layer (SQLite + sqlite-vec)           │  │
│  │  collections │ documents │ chunks │ vectors │ FTS5 │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
                             │
          ┌─────────────────┴───────────────────┐
          │     Model Server (Python)           │
          │           :8012                     │
          │  embed │ rerank │ OCR │ NER         │
          │  threaded │ float16 │ warmup        │
          └─────────────────────────────────────┘
```

ThreadClaw runs as two processes:
1. **Node.js** — query pipeline, ingestion, HTTP API, CLI/TUI, file watcher, source adapters
2. **Python** — embedding model, reranking model, optional Docling parser (threaded Flask, float16 inference, model warmup)

---

## Query Pipeline

Every search follows this exact sequence:

### Step 1: Input Validation
- Empty queries rejected instantly (0ms, 0 tokens)
- Queries over 2000 characters truncated
- Whitespace normalized

### Step 2: Cache Check
- 50-entry LRU cache with 5-minute TTL
- Key: `query|collection|options_hash`
- Cache hit = instant return, zero cost
- Cache invalidated automatically on collection deletion

### Step 3: Query Expansion (optional)
When `QUERY_EXPANSION_ENABLED=true`, three techniques run in parallel:

| Technique | What It Does | Output |
|-----------|-------------|--------|
| **Decomposition** | Breaks query into 2-4 sub-queries | More focused retrieval |
| **HyDE** | Generates hypothetical answer paragraph | Embeds as "passage" for better match |
| **Multi-Query** | Creates 3 alternative phrasings | Captures different angles |

Query + HyDE embeddings run in parallel via `Promise.all()`. Costs ~1500 tokens per query (3 LLM calls).

### Step 4: Hybrid Retrieval

**Dense Vector Search** — embeds query, searches sqlite-vec for nearest neighbors (L2 distance). Retrieves at 2x topK. Collection filtering via batch IN-clause query.

**BM25 Sparse Search** — keyword matching via FTS5 on original query only (expansion variants handled by vector search). Each term quoted to prevent FTS5 operator interpretation.

**Reciprocal Rank Fusion (RRF):**
```
score(chunk) = Σ 1/(k + rank + 1)  across retrieval methods  (k=60)
```
Both lists capped to equal length (max 100) before fusion to prevent volume bias. Chunks appearing in both vector and keyword results get boosted scores.

### Step 5: Similarity Gate
Results with L2 distance > 1.05 filtered out (NVIDIA 3072-dim normalized: strong hits ~0.85-1.0, weak ~1.05-1.12, misses ~1.15+). Prevents returning irrelevant content on vague queries. Falls back to original list if all results fail the gate.

### Step 6: Smart Reranking
Cross-encoder re-scores top candidates with contextPrefix included in input. Skipped when:
- Top result has distance < 0.8 (very confident), AND
- Second result is 2x further away (clear winner)

Reranker receives chunk text prefixed with heading chain (same context as embeddings). Input truncated: query 200 words, documents 512 words. Invalid reranker indices filtered out.

**Graceful degradation:** reranker failure → original order preserved. 30-second timeout.

### Step 7: Single-Source Dedup
In brief mode: keeps only the best chunk per source document. Prevents one large document from dominating output.

### Step 8: Output Modes

| Mode | Flag | Tokens | Use Case |
|------|------|--------|----------|
| **Brief** | `--brief` | ~200 | Default for agents. Sentence extraction + highlighting. |
| **Titles** | `--titles` | ~30 | Exploration. "What docs do I have?" |
| **Full** | `--full` | ~1500 | User wants actual content. |

**Brief extraction:**
1. Split chunks into sentences
2. Score: `(normalizedRelevance × 0.7 + termScore × 0.3) × positionBoost × lengthPenalty`
3. Diversity cap: max 3 sentences per source document
4. Select within token budget, re-order for readability
5. Generate highlighted version with matched terms in **bold**
6. Append source citations

### Step 9: Confidence Score
Based on score spread, rank-1/rank-2 separation, and chunk count. Range 0-1. Below 0.3 flagged as `lowConfidence`.

### Step 10: Analytics Recording
Every non-cached query recorded to in-memory ring buffer (500 entries). Tracks: strategy, latency, confidence, vector/BM25 hits, best distance, reranking status.

### Query Result
```typescript
{
  context: string;           // formatted output
  highlighted?: string;      // brief mode: terms in **bold**
  sources: SourceInfo[];     // per-source metadata
  queryInfo: {
    strategy: string;        // "dense+hybrid+rerank+brief"
    subQueries?: string[];   // expansion variants
    candidatesEvaluated: number;
    chunksReturned: number;
    tokensUsed: number;
    elapsedMs: number;
    collections: string[];
    confidence: number;
    cached?: boolean;
    lowConfidence?: boolean;
    retrieval?: {            // diagnostics
      vectorHits: number;
      vectorGated: number;   // filtered by distance threshold
      bm25Hits: number;
      bestDistance: number;
      reranked: boolean;
    };
  }
}
```

---

## Ingestion Pipeline

### Flow
```
file → validate → parse → chunk → embed → semantic dedup → store → checkpoint
```

### Supported Formats

| Format | Parser | Notes |
|--------|--------|-------|
| PDF | pdfjs-dist + Docling | Layout-aware, OCR |
| DOCX | mammoth + Docling | Preserves structure |
| PPTX | Custom + Docling | Slides → markdown |
| HTML | Readability + Docling | Cleans boilerplate |
| Markdown | Native | Heading-aware chunking |
| CSV/TSV | csv-parse | Row/column structure |
| JSON/JSONL | Native | Structured extraction |
| Email (.eml) | mailparser | Headers + body + attachments |
| Code | Regex-based | Function-boundary chunking |
| Plain text | Direct read | Prose chunking |

### Incremental Indexing
1. xxhash64 hash of content + file modification time
2. Same hash → skip (0 cost)
3. Hash changed → delete old version, re-ingest
4. Force mode (`--force`) always re-ingests, cleans up old version first
5. File-level locking prevents concurrent ingestion

### Semantic Deduplication
After embedding, two dedup passes run:
1. **Intra-batch** — cosine similarity between new chunks (threshold 0.95). Catches near-identical paragraphs within the same document.
2. **Cross-collection** — nearest neighbor search against existing vectors via sqlite-vec. Catches re-ingesting similar content from different source files.

Duplicate chunks are silently filtered before storage. The ingest result reports `duplicatesSkipped` count.

### Chunking Strategies

| Document Type | Strategy | Boundary |
|---------------|----------|----------|
| Markdown (with headings) | chunkMarkdown | `#` headings |
| HTML (with headings) | chunkHtml | `<h1>`-`<h6>` |
| Code (with functions) | chunkCode | Function/class definitions |
| CSV | chunkTable | Row groups |
| PDF, plain text | chunkProse | Paragraph boundaries |

**Post-processing:**
1. Minimum size enforcement — chunks below `CHUNK_MIN_TOKENS` merged with previous
2. **Overlap** — last ~20% of previous chunk prepended (prevents context loss at boundaries)
3. **Context prefix** — heading chain preserved for embedding and reranking context
4. Position numbering — sequential 0, 1, 2, ...
5. Parent-child linking — each chunk linked to previous for context enrichment

### WAL Checkpoint
After ingesting documents with 50+ chunks, an explicit WAL checkpoint runs to prevent unbounded WAL file growth. Also checkpoints on database close.

### Auto-Tagging
- File type (pdf, markdown, code)
- Parent/grandparent directory names
- Manual tags via `--tags` flag

---

## Semantic Extraction Pipeline

Every message processed by ThreadClaw passes through the RSMA extraction pipeline. The pipeline has two modes, controlled by `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE`:

### Smart Mode (default)
LLM-based semantic extraction. A single structured LLM call classifies the message and extracts all memory-relevant objects in one pass. The LLM understands natural language without magic prefixes:
- "We're going with Postgres" is understood as a decision
- "Actually no, use MySQL" is understood as a correction + decision
- "I think it's port 8080" is understood as an uncertain claim
- "Need to rotate the API key" is understood as a task

Uses the same model as deep extraction (`THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL`). Falls back to regex extraction if the LLM call fails.

### Fast Mode
Regex-only extraction. No LLM calls. <5ms per message. Detects:
- Correction signals ("actually", "scratch that", "not anymore")
- Uncertainty signals ("I think", "maybe", "for now")
- Preference signals ("I prefer", "never suggest")
- Temporal signals ("by Friday", "starting next Monday")
- Structured claims ("Remember:", heading+bullets, YAML frontmatter, tool results)
- Decisions ("We decided...", "Going with...")
- Entities (capitalized names, quoted terms, terms list)

Fast mode is the default when deep extraction is not enabled.

### Reconciliation
After extraction, the **TruthEngine** reconciles candidate MemoryObjects against existing knowledge using 6 rules:
1. **Higher confidence supersedes** — new belief with higher confidence replaces old
2. **Same confidence, newer wins** — tie-breaking by recency
3. **Lower confidence adds evidence** — weaker claims support but don't replace
4. **Value contradiction creates Conflict** — contradictory values produce first-class Conflict objects
5. **Correction signal auto-supersedes** — "actually..." triggers supersession with a 5-point guard (canonical key match, same scope, same kind family, minimum confidence 0.3, auditable reason trace)
6. **Provisional objects don't supersede firm beliefs** — "I think..." doesn't override established facts

All extracted objects are unified as `MemoryObject` instances with 13 kinds (event, chunk, message, summary, claim, decision, entity, loop, attempt, procedure, invariant, delta, conflict). All knowledge is stored in the `memory_objects` table with a uniform metadata envelope (composite_id, kind, canonical_key, content, structured_json, scope_id, branch_id, status, confidence, trust_score, influence_weight, source provenance, timestamps). Cross-object relationships are stored in the `provenance_links` table with typed predicates (derived_from, supports, contradicts, supersedes, mentioned_in, relates_to, resolved_by). Together, these two tables replace 15+ legacy tables.

### Extraction Quality Filters

Multiple layers prevent junk from entering the knowledge graph:
1. **Code block stripping** — ````...```` blocks replaced with `[code block removed]` before LLM extraction
2. **LLM prompt rules** — explicit instructions to not extract from code blocks or programming constructs
3. **Confidence floor** — extracted events with confidence < 0.35 are silently rejected
4. **Post-extraction junk filters** — reject message metadata, file paths, bare URLs, low-confidence noise, and transient debugging context

### Memory Object Storage

The `mo-store.ts` module provides unified CRUD for `memory_objects`:
- **Upsert** — keyed by composite_id; on update, confidence is blended (70% new + 30% old)
- **Supersession** — marks old object as superseded, links to replacement
- **Status updates** — active, superseded, retracted, stale, needs_confirmation
- **Dynamic queries** — filter by kinds, scope, branch, statuses, keyword; ORDER BY updated_at DESC

---

## Smart Context Injection

The context compiler (`context-compiler.ts`) accepts an optional `queryContext` field in `ContextCompilerConfig`. During `assemble()`, the engine extracts the last user message text and passes it as `queryContext` to `compileContextCapsules()`.

### How It Works

1. The user's message is lowercased, stripped of punctuation, and split into words (minimum 3 characters).
2. For each capsule candidate, `queryRelevance(queryWords, capsuleText)` computes keyword overlap:
   ```
   overlap = matchingWords / totalQueryWords    // 0..1
   relevance = 0.2 + 0.8 * overlap             // 0.2..1.0
   ```
3. Each capsule's `score` is multiplied by this relevance factor, and `scorePerToken` is recalculated.
4. The ROI governor then fills the budget greedily by `scorePerToken`, so query-relevant capsules are prioritized.

The 0.2 floor ensures that unrelated but high-value capsules (e.g., strict invariants, anti-runbooks) are demoted but never completely excluded.

**Config:** No separate config key — active whenever `queryContext` is provided. The engine always passes the last user message.

**Key functions:** `queryRelevance()` in `memory-engine/src/relations/context-compiler.ts`, called from `compileContextCapsules()`. Query text extracted in `engine.ts` `assemble()` method.

---

## Epistemic Labels

Claims and decisions in the context injection are tagged with epistemic labels to signal reliability.

### Label Assignment (`epistemicLabel()`)

| Label | Condition | Meaning |
|-------|-----------|---------|
| `[FIRM]` | `confidence >= 0.9` AND composite_id not in contested set | High-confidence, uncontested |
| `[CONTESTED]` | composite_id appears in an active Conflict object's `objectIdA` or `objectIdB` | Involved in an unresolved contradiction |
| `[PROVISIONAL]` | `confidence < 0.5` | Low-confidence or newly extracted |
| *(none)* | Everything else (0.5 <= confidence < 0.9, not contested) | Normal confidence |

### Contested Set Construction

On each compilation pass, the compiler first scans all `kind='conflict'` rows from `memory_objects`. For each conflict, it parses `structured_json` and adds both `objectIdA` and `objectIdB` to a `contestedIds: Set<string>`. This set is then passed to `claimCapsules()` and `decisionCapsules()` to tag contested items.

### Output Format

Labels are appended to capsule text:
```
[claim] staging database: PostgreSQL [FIRM]
[decision] API framework: Express.js [CONTESTED]
[claim] deployment target: maybe Kubernetes [PROVISIONAL]
```

**Key function:** `epistemicLabel()` in `memory-engine/src/relations/context-compiler.ts`.

---

## Session Briefing

A one-line summary injected on the first turn of a new conversation session.

### Trigger

In `engine.ts` `assemble()`, the engine tracks `_lastSessionId` and `_lastSessionTimestamp`. When `params.sessionId !== this._lastSessionId`, a new session is detected. If `_lastSessionTimestamp` exists (not the very first session), `buildSessionBriefing()` is called.

### Query

```sql
SELECT kind, status, COUNT(*) as cnt FROM memory_objects
WHERE scope_id = ? AND updated_at > ?
GROUP BY kind, status
```

### Counted Categories

| Kind | Status | Label in briefing |
|------|--------|-------------------|
| decision | active | "N new decisions" |
| decision | superseded | "N superseded" |
| conflict | any | "N conflicts" |
| claim | active | "N new claims" |
| claim | superseded | "N claims superseded" |
| claim | needs_confirmation | "N flagged for review" |
| invariant | active | "N new invariants" |

### Output

```
[Session Briefing] Since last session (4h ago): 2 new decisions, 1 claim superseded, 1 conflict.
```

Time formatting: `<1h` shows minutes, `1-23h` shows hours, `24h+` shows days.

Returns `null` (no injection) if total count is 0.

**Key file:** `memory-engine/src/relations/session-briefing.ts` (`buildSessionBriefing()`).

---

## Invariant Enforcement

Strict invariants are enforced at write time during RSMA reconciliation, before memory objects are stored.

### Write-Time Check

In `engine.ts`, inside the write transaction for reconciled actions:

1. For every `insert` action (except `kind='invariant'` and `kind='conflict'`), `checkStrictInvariants()` is called.
2. It receives the graph DB, scope ID, the object's `content` string, and its `structured` JSON.
3. If violations are found:
   - The object's `status` is changed from `active` to `needs_confirmation`
   - An `invariant_violation` event is logged to `evidence_log` with the violation details and truncated content

### How `checkStrictInvariants()` Works

1. **Cache refresh** (30-second TTL): loads all active invariants with `enforcement_mode = 'strict'` from `memory_objects`.
2. **Forbidden term extraction**: parses each invariant's description using `NEGATION_RE` — a regex matching patterns like "never use X", "do not use X", "must not X", "avoid X", "prohibited X". Also generates stem variants (e.g., "MongoDB" also checks "mongo").
3. **Content normalization**: concatenates `content`, `objectText`, `subject`, `decisionText`, and `object` fields. Applies NFKD normalization and strips zero-width/control characters.
4. **Matching**: checks if any forbidden term appears in the normalized text. One match per invariant is sufficient.

### Config

No separate config key — active whenever relations are enabled and strict invariants exist in the database.

**Key file:** `memory-engine/src/relations/invariant-check.ts` (`checkStrictInvariants()`, `extractForbiddenTerms()`).

---

## Deep Document Extraction

Optional LLM-powered claim extraction from ingested documents. Extracts structured factual claims (subject/predicate/object) — not just entities — from document text.

### Trigger

Enabled via `THREADCLAW_DEEP_INGEST_ENABLED=true` (default: `false`). When enabled, `extractDeepFromDocument()` runs asynchronously after standard entity extraction during document ingestion. Non-blocking: errors are caught and logged.

### Pipeline

1. **Semaphore**: maximum `MAX_CONCURRENT_DEEP = 2` concurrent extractions. Additional calls wait in a polling loop.
2. **Chunk selection**: first `MAX_CHUNKS_PER_DOC = 10` chunks, skipping chunks with fewer than 50 characters.
3. **LLM call**: sends each chunk (truncated to 4000 chars) to the chat completions endpoint with:
   - System prompt: `DEEP_EXTRACT_SYSTEM` — instructs the LLM to extract factual claims as a JSON array
   - Temperature: 0.1
   - Max tokens: 1000
   - Model: `DEEP_EXTRACT_MODEL` env var (falls back to "default")
   - 60-second timeout per chunk
4. **Parse**: extracts the first JSON array from the response. Each claim must have `subject`, `predicate`, and `objectText`.
5. **Store**: claims are stored via `storeClaimExtractionResults()` with:
   - Confidence capped at 0.4 (document-extracted claims don't override conversational knowledge)
   - Trust score: 0.4
   - Source type: `document_extraction`
   - Max 20 claims per chunk
6. **Throttle**: 200ms delay between chunks.

### Config

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_DEEP_INGEST_ENABLED` | `false` | Enable deep document extraction |
| `DEEP_EXTRACT_MODEL` | `"default"` | LLM model for extraction |

**Key file:** `src/relations/ingest-hook.ts` (`extractDeepFromDocument()`). Called from `src/ingest/pipeline.ts`.

---

## Storage Layer

SQLite with sqlite-vec for vectors and FTS5 for full-text search. Two databases in `~/.threadclaw/data/`:
- `threadclaw.db` — Document store (RAG: collections, documents, chunks, vectors) + Evidence graph (consolidated), unified under the **One True Ontology**: `memory_objects` (all knowledge kinds) + `provenance_links` (all relationships). Legacy tables renamed to `_legacy_*` by migration v18.
- `memory.db` — Conversation memory (DAG summaries, context items, messages)

Note: Previous versions used a separate `graph.db`. This was consolidated into `threadclaw.db` — existing installations auto-migrate on startup.

### Schema
- **collections** — named groups (id, name, description)
- **documents** — files (id, collection_id, source_path, content_hash, file_mtime)
- **chunks** — segments (id, document_id, text, context_prefix, position, parent_id)
- **chunk_vectors** — embeddings (chunk_id, float[N] via sqlite-vec)
- **chunk_fts** — FTS5 index (auto-synced via triggers)
- **metadata_index** — key-value pairs for filtering

WAL mode enabled. Foreign keys enforced. Busy timeout 5000ms. Auto-checkpoint every 1000 pages. Migrations run once at server startup (not per request).

---

## Source Adapters

### Architecture
Source adapters follow the `SourceAdapter` interface with registry-based lifecycle management:
- **Realtime** — chokidar file watching (local, Obsidian)
- **Polling** — periodic sync (Google Drive, Notion, Apple Notes)

Registry reads `.env` configuration, starts/stops adapters. Hot-reload via `POST /sources/reload`.

### Google Drive
- OAuth2 via googleapis npm (no CLI dependency)
- Local HTTP callback on port 18801 for consent flow
- Auto-exports Docs/Sheets/Slides to Markdown/CSV/text
- Folder browser in TUI Sources screen
- Credentials at `~/.threadclaw/credentials/gdrive-tokens.json`

### Notion
- @notionhq/client + REST API
- Block-to-Markdown converter (19 block types, 4 text annotations)
- Database browser in TUI Sources screen
- Rate limiting: 350ms between API calls

### Apple Notes
- macOS only (AppleScript via osascript)
- Folder browser in TUI
- HTML body export

---

## Model Server

Python Flask app on port 8012 (threaded mode for concurrent requests).

### Startup
- Models loaded eagerly on start
- Warmup inference to trigger CUDA kernel compilation
- Float16 enabled on CUDA for ~30% speedup, 50% less VRAM

### POST /v1/embeddings (OpenAI-compatible)
```json
{ "model": "nvidia/omni-embed-nemotron-3b", "input": ["text1", "text2"] }
→ { "data": [{ "embedding": [...], "index": 0 }], "usage": { "total_tokens": 42 } }
```
Batch size: 64. Normalization enabled. NVIDIA models auto-prefixed with `"passage: "` / `"query: "`.

### POST /rerank
```json
{ "query": "search terms", "documents": ["doc1", "doc2"], "top_k": 5 }
→ { "results": [{ "index": 0, "score": 0.95, "text": "doc1" }] }
```
Batch size: 64. Inputs truncated (query: 200 words, doc: 512 words). Float16 inference.

### POST /parse (Docling)
```json
{ "path": "/path/to/file.pdf" }
→ { "markdown": "...", "metadata": { "title": "...", "page_count": 5 } }
```
GPU memory released after each parse.

### POST /ner (Entity Extraction)
```json
{ "texts": ["Alice works at OpenAI in San Francisco"] }
→ { "results": [{ "entities": [
    { "text": "Alice", "label": "PERSON", "start": 0, "end": 5 },
    { "text": "OpenAI", "label": "ORG", "start": 15, "end": 21 },
    { "text": "San Francisco", "label": "GPE", "start": 25, "end": 38 }
  ]}]}
```
Powered by spaCy `en_core_web_sm`. Auto-installed during setup. Falls back to regex extraction if unavailable.

### Model Tiers

| Tier | Embedding | Reranking | VRAM | Dims |
|------|-----------|-----------|------|------|
| Lite | all-MiniLM-L12-v2 | MiniLM Rerank (Small) | ~2 GB | 384 |
| Standard | bge-large-en-v1.5 | bge-reranker-large | ~3 GB | 1024 |
| Premium | Nemotron Embed 3B | bge-reranker-v2-gemma | ~11 GB | 3072 |

---

## Memory Engine

DAG-based lossless conversation context, forked from lossless-claw. Surface rebranded (plugin ID `threadclaw-memory`). Internal filenames kept as `lcm-*.ts` for upstream compatibility.

12 agent tools registered: 4 core (`cc_grep`, `cc_describe`, `cc_expand`, `cc_recall`) + 8 evidence (`cc_memory`, `cc_claims`, `cc_decisions`, `cc_loops`, `cc_attempts`, `cc_branch`, `cc_procedures`, `cc_diagnostics`).

Extraction mode is transparent to tools — the same 12 tools work regardless of whether smart or fast extraction is active. The extraction mode only affects how incoming messages are processed into MemoryObjects.

Evidence tools (`cc_diagnostics`, `cc_memory`) now query `memory_objects` and `provenance_links` directly instead of legacy tables. The diagnostic tool counts entities, claims, decisions, loops, attempts, runbooks, and anti-runbooks all from `memory_objects` with kind-based filtering.

Integrates as an OpenClaw plugin:
- `plugins.slots.contextEngine = "threadclaw-memory"`
- `plugins.slots.memory = "none"` (disables built-in memory-core)

---

## OpenClaw Integration

### What It Does
1. Installs skill definitions to `~/.openclaw/workspace/skills/threadclaw-knowledge/` and `threadclaw-evidence/`
2. Loads memory-engine plugin from `~/.openclaw/services/threadclaw/memory-engine`
3. Disables built-in `memory-core` and `memorySearch` (prevents duplicate searches)
4. Configuration is validated during install via `applyOpenClawIntegration()` and can be verified with `threadclaw status`

### Uninstall Reversal
The TUI uninstall screen reverts all OpenClaw changes:
- Removes knowledge skill
- Clears `contextEngine` slot
- Re-enables `memory-core`
- Removes plugin entries and install records

---

## Security

- **API bound to localhost** (`127.0.0.1`) by default. Set `THREADCLAW_HOST=0.0.0.0` to expose.
- **Localhost-only endpoints** — `/shutdown`, `/reset`, `/reindex`, `/reindex/stale`, `/sources/reload`, `/graph/*`, `/analytics/diagnostics` restricted to `127.0.0.1`/`::1` via shared `isLocalRequest` guard.
- **Rate limiting** — 300 requests/minute per IP (configurable via `RATE_LIMIT_MAX`). `/health` exempt.
- **Path validation** — ingest endpoint blocks `.env`, credentials, `.git`, SSH keys. Error responses do not disclose file paths.
- **Input validation** — collection names trimmed and capped at 100 chars, text ingest capped at 10MB, LIKE wildcards escaped in search queries, query `top_k`/`token_budget` clamped with NaN guards, all 16 numeric config values range-validated.
- **Transaction safety** — all delete operations (document, collection, vector cleanup) wrapped in atomic transactions.
- **HuggingFace tokens** — passed via environment variable, never in shell commands.
- **File permissions** — databases chmod 600, staging 700 on Unix.
- **Sensitive data** — error text redacted for password/key/token/secret patterns. API key resolution uses auth-profiles, not hardcoded values.

---

## Token Tracking

File-backed counter at `~/.threadclaw/token-counts.json`. Tracks tokens across 4 categories:
- **Ingest** — total tokens in ingested chunks
- **Embed** — tokens sent to embedding model
- **Rerank** — tokens sent to reranker (query + candidates)
- **Query Expansion** — tokens in generated query variants

Writes buffered in memory, flushed every 5 seconds. Flushed on shutdown. Displayed in TUI main menu.

---

## CLI Reference

```
threadclaw                           Launch interactive TUI
threadclaw query "question" [opts]   Search knowledge base
threadclaw search "terms" [opts]     Simple search (no reranking)
threadclaw ingest <path> [opts]      Ingest file or folder
threadclaw collections [list|create|delete|stats]
threadclaw delete [--source|--id]    Delete documents
threadclaw status                    System health
threadclaw serve                     Run services in terminal
threadclaw watch                     Start file watcher
```

### Query Options
```
-c, --collection <name>   Collection ("all" for everything)
-k, --top-k <number>      Results count (default: 10)
--brief                    ~200 tokens (default)
--titles                   ~30 tokens
--full                     ~1500 tokens
--no-rerank                Skip reranking
--no-bm25                  Skip keyword search
--expand                   Force query expansion
-b, --budget <tokens>      Token budget
--json                     JSON output
```

### Ingest Options
```
-c, --collection <name>   Target collection
-t, --tags <tags>          Comma-separated tags
-r, --recursive            Recurse into folders
-f, --force                Force re-ingest (deletes old version first)
```

---

## HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /health | Service health check |
| GET | /stats | System statistics + token usage |
| POST | /query | Search knowledge base |
| POST | /search | Simple search (no reranking) |
| POST | /ingest | Ingest file by path |
| POST | /ingest/text | Ingest raw text (10MB limit) |
| GET | /documents | List documents (optional collection filter) |
| DELETE | /documents/:id | Delete document + vectors + graph data |
| GET | /collections | List collections |
| POST | /collections | Create collection (name max 100 chars) |
| DELETE | /collections/:id | Delete collection + invalidate cache |
| GET | /collections/:id/stats | Collection statistics |
| POST | /reindex | Re-ingest all documents (localhost only) |
| POST | /reindex/stale | Re-ingest only modified documents (localhost only) |
| GET | /analytics | Query performance summary |
| GET | /analytics/recent | Recent queries with details |
| DELETE | /analytics | Clear analytics |
| GET | /sources | Source adapter status |
| POST | /sources/reload | Hot-reload source configuration (localhost only) |
| POST | /reset | Clear knowledge base (localhost only) |
| POST | /shutdown | Graceful shutdown (localhost only) |
| GET | /graph/entities | Entity graph browser (localhost only) |

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_PORT` | 18800 | HTTP API port |
| `THREADCLAW_HOST` | 127.0.0.1 | Bind address (0.0.0.0 for network) |
| `THREADCLAW_DATA_DIR` | ~/.threadclaw/data | Data directory |
| `EMBEDDING_URL` | http://127.0.0.1:8012/v1 | Embedding endpoint |
| `EMBEDDING_MODEL` | BAAI/bge-large-en-v1.5 | Model ID |
| `EMBEDDING_DIMENSIONS` | 1024 | Vector dimensions |
| `EMBEDDING_API_KEY` | | Optional cloud API key |
| `RERANKER_URL` | http://127.0.0.1:8012 | Reranking endpoint |
| `RERANKER_API_KEY` | | Optional cloud API key |
| `QUERY_EXPANSION_ENABLED` | false | Enable LLM expansion |
| `QUERY_EXPANSION_URL` | http://127.0.0.1:1234/v1 | Chat LLM endpoint |
| `QUERY_EXPANSION_MODEL` | | Chat model ID |
| `WATCH_PATHS` | | Auto-watch dirs (path\|collection,...) |
| `WATCH_DEBOUNCE_MS` | 3000 | File change debounce |
| `DEFAULT_COLLECTION` | default | Default collection |
| `CHUNK_MIN_TOKENS` | 100 | Min chunk size |
| `CHUNK_MAX_TOKENS` | 1024 | Max chunk size |
| `CHUNK_TARGET_TOKENS` | 512 | Target chunk size |
| `QUERY_TOP_K` | 10 | Default result count |
| `QUERY_TOKEN_BUDGET` | 4000 | Default output budget |
| `RATE_LIMIT_MAX` | 300 | Requests per window |
| `RATE_LIMIT_WINDOW` | 60000 | Window size in ms |
| `RATE_LIMIT_ENABLED` | true | Enable rate limiting |
| `GDRIVE_ENABLED` | false | Enable Google Drive adapter |
| `GDRIVE_CLIENT_ID` | | Google OAuth client ID |
| `GDRIVE_CLIENT_SECRET` | | Google OAuth client secret |
| `GDRIVE_SYNC_INTERVAL` | 300 | Sync interval in seconds |
| `NOTION_ENABLED` | false | Enable Notion adapter |
| `OBSIDIAN_ENABLED` | false | Enable Obsidian adapter |
| `APPLE_NOTES_ENABLED` | false | Enable Apple Notes (macOS) |
| `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE` | smart | Extraction mode: `smart` (LLM) or `fast` (regex-only, <5ms) |
| `THREADCLAW_DEEP_INGEST_ENABLED` | false | Enable LLM-powered claim extraction from ingested documents |
| `DEEP_EXTRACT_MODEL` | default | LLM model ID for deep document extraction |

---

## Error Handling

```
ThreadClawError (base)
├── ParseError — file parsing failed
├── EmbeddingError — embedding server unavailable (retries 3x with backoff)
├── StorageError — database error
├── CollectionNotFoundError — collection not found
└── ServiceUnavailableError — service down
```

### Resilience
- **Embedding** — 3 retries, exponential backoff, 30s timeout, adaptive batch halving on failure (32→16→8→4→1)
- **Reranker** — 30s timeout, invalid indices filtered, fallback to original order
- **Watcher** — per-file error isolation, queue capped at 1000 entries, single circuit breaker retry timer (no setTimeout leak), `queueMicrotask` for drain continuation (no stack overflow)
- **Ingestion** — file-level locking, transactional storage (doc + chunks + vectors atomic), all delete operations in transactions
- **Query expansion** — optional, queries work without it
- **Database** — WAL mode, 5s busy timeout, foreign key enforcement, `:memory:` guard, auto-checkpoint, explicit checkpoint on close
- **Memory engine** — fail-safe assembly (returns live messages on any failure), session operation queuing (FIFO serialization), 120s AbortSignal timeout on LLM calls, 60s timeout on file summarization
- **Evidence extraction** — non-blocking (try/catch per extraction phase), fire-and-forget LLM deep extraction, error text redacted for secrets
- **Token tracker** — buffered writes (5s), flushed on shutdown
- **Cache** — invalidated on collection deletion, safe iteration during cleanup
- **Config** — all 16 numeric values range-clamped (NaN/negative/absurd rejected with safe defaults)
