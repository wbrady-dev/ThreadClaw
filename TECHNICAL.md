# ClawCore CRAM — Technical Reference

Complete technical documentation for ClawCore's **CRAM Architecture** — a multi-layer agent architecture that combines retrieval, summary lineage, knowledge graphs, awareness, evidence-backed state, delta tracking, attempt memory, branch governance, and low-token context compilation.

> `CRAM = RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL`

Covers architecture, query pipeline, ingestion, storage, evidence store, source adapters, OpenClaw integration, and configuration.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                         ClawCore                         │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ CLI/TUI  │  │ HTTP API │  │   MCP    │  │ Watcher  │  │
│  │ clawcore │  │  :18800  │  │  stdio   │  │ chokidar │  │
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

ClawCore runs as two processes:
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
1. SHA256 hash of content + file modification time
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

## Storage Layer

SQLite with sqlite-vec for vectors and FTS5 for full-text search. Single file: `clawcore.db`.

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
- Credentials at `~/.clawcore/credentials/gdrive-tokens.json`

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

DAG-based lossless conversation context, forked from lossless-claw. Surface rebranded (plugin ID `clawcore-memory`, tools `cc_grep`/`cc_recall`/`cc_describe`/`cc_expand`). Internal filenames kept as `lcm-*.ts` for upstream compatibility.

Integrates as an OpenClaw plugin:
- `plugins.slots.contextEngine = "clawcore-memory"`
- `plugins.slots.memory = "none"` (disables built-in memory-core)

---

## OpenClaw Integration

### What It Does
1. Installs `SKILL.md` knowledge skill to `~/.openclaw/workspace/skills/knowledge/`
2. Loads memory-engine plugin from `~/.openclaw/services/clawcore/memory-engine`
3. Disables built-in `memory-core` and `memorySearch` (prevents duplicate searches)
4. Configuration is validated during install via `applyOpenClawIntegration()` and can be verified with `clawcore status`

### Uninstall Reversal
The TUI uninstall screen reverts all OpenClaw changes:
- Removes knowledge skill
- Clears `contextEngine` slot
- Re-enables `memory-core`
- Removes plugin entries and install records

---

## Security

- **API bound to localhost** (`127.0.0.1`) by default. Set `CLAWCORE_HOST=0.0.0.0` to expose.
- **Rate limiting** — 300 requests/minute per IP (configurable via `RATE_LIMIT_MAX`). `/health` exempt.
- **Path validation** — ingest endpoint blocks `.env`, credentials, `.git`, SSH keys.
- **HuggingFace tokens** — passed via environment variable, never in shell commands.
- **File permissions** — databases chmod 600, staging 700 on Unix.

---

## Token Tracking

File-backed counter at `~/.clawcore/token-counts.json`. Tracks tokens across 4 categories:
- **Ingest** — total tokens in ingested chunks
- **Embed** — tokens sent to embedding model
- **Rerank** — tokens sent to reranker (query + candidates)
- **Query Expansion** — tokens in generated query variants

Writes buffered in memory, flushed every 5 seconds. Flushed on shutdown. Displayed in TUI main menu.

---

## CLI Reference

```
clawcore                           Launch interactive TUI
clawcore query "question" [opts]   Search knowledge base
clawcore search "terms" [opts]     Simple search (no reranking)
clawcore ingest <path> [opts]      Ingest file or folder
clawcore collections [list|create|delete|stats]
clawcore delete [--source|--id]    Delete documents
clawcore status                    System health
clawcore serve                     Run services in terminal
clawcore watch                     Start file watcher
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
| POST | /ingest/text | Ingest raw text |
| GET | /collections | List collections |
| POST | /collections | Create collection |
| DELETE | /collections/:id | Delete collection + invalidate cache |
| GET | /collections/:id/stats | Collection statistics |
| POST | /reindex | Re-ingest all documents with current settings |
| POST | /reindex/stale | Re-ingest only modified documents |
| GET | /analytics | Query performance summary |
| GET | /analytics/recent | Recent queries with details |
| DELETE | /analytics | Clear analytics |
| GET | /sources | Source adapter status |
| POST | /sources/reload | Hot-reload source configuration |
| POST | /ner | Extract named entities (spaCy) |

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAWCORE_PORT` | 18800 | HTTP API port |
| `CLAWCORE_HOST` | 127.0.0.1 | Bind address (0.0.0.0 for network) |
| `CLAWCORE_DATA_DIR` | ./data | Data directory |
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

---

## Error Handling

```
ClawCoreError (base)
├── ParseError — file parsing failed
├── EmbeddingError — embedding server unavailable (retries 3x with backoff)
├── StorageError — database error
├── CollectionNotFoundError — collection not found
└── ServiceUnavailableError — service down
```

### Resilience
- **Embedding** — 3 retries, exponential backoff, 30s timeout, adaptive batch halving on failure (32→16→8→4→1)
- **Reranker** — 30s timeout, invalid indices filtered, fallback to original order
- **Watcher** — per-file error isolation, continues monitoring
- **Ingestion** — file-level locking, transactional storage (doc + chunks + vectors atomic)
- **Query expansion** — optional, queries work without it
- **Database** — WAL mode, 5s busy timeout, auto-checkpoint, explicit checkpoint on close
- **Token tracker** — buffered writes (5s), flushed on shutdown
- **Cache** — invalidated on collection deletion, safe iteration during cleanup
