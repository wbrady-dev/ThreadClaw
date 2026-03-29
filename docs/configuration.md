# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and customize.

## Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_PORT` | `18800` | HTTP API port |
| `THREADCLAW_HOST` | `127.0.0.1` | HTTP API bind address |
| `THREADCLAW_API_KEY` | `` | API key for authentication (timing-safe comparison). When set, all endpoints except /health require `Authorization: Bearer <key>` |
| `THREADCLAW_DATA_DIR` | `~/.threadclaw/data/` | Path to all ThreadClaw databases |

## Embedding

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_URL` | `http://127.0.0.1:8012/v1` | Embedding model endpoint |
| `EMBEDDING_MODEL` | `BAAI/bge-large-en-v1.5` | Embedding model name |
| `EMBEDDING_DIMENSIONS` | `1024` | Vector dimensions |
| `EMBEDDING_API_KEY` | `` | API key for cloud embedding providers |
| `EMBEDDING_SIMILARITY_THRESHOLD` | `1.05` | Max L2 distance for vector matches. Lower = stricter. 0.95 = high-precision, 1.15 = high-recall |
| `EMBEDDING_PREFIX_MODE` | `auto` | Prefix handling: `auto` (detect from model), `always`, `never`. Models like E5/Nemotron need query:/passage: prefixes |
| `EMBEDDING_BATCH_SIZE` | `32` | Texts per embedding request during ingestion. Higher = faster, more memory |

## Reranking

| Variable | Default | Description |
|----------|---------|-------------|
| `RERANKER_URL` | `http://127.0.0.1:8012` | Reranking model endpoint |
| `RERANKER_MODEL` | `` | Reranking model name (for cloud providers) |
| `RERANKER_API_KEY` | `` | API key for cloud reranking providers |
| `RERANK_SCORE_THRESHOLD` | `0.0` | Min reranker score to keep a result. 0.0 = keep all, 0.1-0.3 = filter weak matches |
| `RERANK_TOP_K` | `20` | How many candidates to send to the cross-encoder. Higher = better recall, slower |
| `RERANK_SMART_SKIP` | `true` | Auto-skip reranking when top result clearly dominates (saves 50-200ms) |
| `RERANK_DISABLED` | `false` | Disable cross-encoder entirely. Faster but less accurate |

## Query Expansion

| Variable | Default | Description |
|----------|---------|-------------|
| `QUERY_EXPANSION_ENABLED` | `false` | Enable LLM-powered query expansion (HyDE + decomposition) |
| `QUERY_EXPANSION_URL` | `http://127.0.0.1:1234/v1` | Expansion LLM endpoint |
| `QUERY_EXPANSION_MODEL` | `` | Model name for expansion |
| `QUERY_EXPANSION_API_KEY` | `` | API key for cloud expansion providers |

## Search Defaults

| Variable | Default | Description |
|----------|---------|-------------|
| `DEFAULT_COLLECTION` | `default` | Default collection for queries |
| `CHUNK_MIN_TOKENS` | `100` | Minimum chunk size (tokens) |
| `CHUNK_MAX_TOKENS` | `1024` | Maximum chunk size (tokens) |
| `CHUNK_TARGET_TOKENS` | `512` | Target chunk size (tokens) |
| `QUERY_TOP_K` | `10` | Default result count |
| `QUERY_TOKEN_BUDGET` | `4000` | Token budget per query |

## Evidence Graph (Relations)

### Main ThreadClaw Process

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_RELATIONS_ENABLED` | `false` | Enable entity extraction in ingest pipeline |
| `THREADCLAW_RELATIONS_GRAPH_DB_PATH` | `~/.threadclaw/data/threadclaw.db` | Graph database path (consolidated into threadclaw.db) |

### Memory Engine Plugin

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_ENABLED` | `false` | Enable evidence graph in memory engine |
| `THREADCLAW_MEMORY_RELATIONS_GRAPH_DB_PATH` | `~/.threadclaw/data/threadclaw.db` | Graph database path (consolidated into threadclaw.db) |
| `THREADCLAW_MEMORY_RELATIONS_MIN_MENTIONS` | `2` | Min mentions before entity surfaced |
| `THREADCLAW_MEMORY_RELATIONS_STALE_DAYS` | `30` | Days before entity is stale |

### Awareness

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED` | `false` | Inject awareness notes into system prompt |
| `THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_NOTES` | `3` | Max awareness notes per turn |
| `THREADCLAW_MEMORY_RELATIONS_AWARENESS_MAX_TOKENS` | `100` | Token budget for awareness notes |
| `THREADCLAW_MEMORY_RELATIONS_AWARENESS_DOC_SURFACING` | `false` | Enable unseen-document surfacing |

### Claims & Evidence (Horizon 2)

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED` | `false` | Extract claims from compacted messages |
| `THREADCLAW_MEMORY_RELATIONS_USER_CLAIM_EXTRACTION_ENABLED` | `false` | Extract claims from "Remember:" statements |
| `THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER` | `standard` | Context compiler budget: `lite` (110), `standard` (190), `premium` (280) |

### Durability (Horizon 3)

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED` | `false` | Track tool attempt outcomes |
| `THREADCLAW_MEMORY_RELATIONS_DECAY_INTERVAL_DAYS` | `90` | Days before anti-runbook confidence decay |

### Deep Extraction (Horizon 5)

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED` | `false` | Enable LLM-powered deep extraction. When enabled, invariant extraction is automatic (LLM-primary with regex fallback). |
| `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL` | `` | Model for deep extraction (falls back to summary model) |
| `THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER` | `` | Provider for deep extraction |
| `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE` | `smart` | Extraction mode: `smart` (LLM-based semantic extraction) or `fast` (regex-only, no LLM, <5ms). Smart mode uses the same model as deep extraction. |

### Awareness

| Variable | Default | Description |
|----------|---------|-------------|
| `THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED` | `false` | Enable awareness notes injection. When enabled, includes proactive awareness (top entities surfaced when no specific matches found). |

Note: `THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED` also appears in the main Awareness section above. The setting controls both reactive awareness (mismatches, staleness, connections) and proactive awareness (top entities when no matches).

### Extraction Quality Filters

These are built-in (not configurable) quality controls applied during extraction:

- **Code block stripping**: Fenced code blocks (```) are removed before extraction to prevent code from being misinterpreted as facts
- **Junk claim rejection**: Claims about message metadata (sender, timestamp, attachment), file paths, URLs, and generic predicates (states, user_i) are automatically filtered
- **Confidence floor**: Claims with confidence < 0.35 are rejected
- **Event cap**: Maximum 15 events extracted per message (prevents runaway extraction)
- **Error demotion**: Claims from low-quality patterns are demoted or filtered

## Source Adapters

| Variable | Default | Description |
|----------|---------|-------------|
| `OBSIDIAN_ENABLED` | `false` | Auto-ingest Obsidian vault |
| `OBSIDIAN_VAULT_PATH` | `` | Path to vault |
| `GDRIVE_ENABLED` | `false` | Google Drive sync |
| `WATCH_PATHS` | `` | Auto-watch directories (path\|collection format) |

## Advanced Configuration

For additional settings beyond the core options above, see `.env.advanced.example`. It covers:

- **Source adapters** -- Obsidian, Google Drive, OneDrive, Notion, Apple Notes (OAuth setup, sync intervals, folder filters, max file sizes)
- **Evidence OS** -- Relations graph, memory engine extraction mode, awareness tuning, claim extraction, attempt tracking, decay intervals
- **Memory engine tuning** -- Compaction interval/threshold, max context tokens, decay settings, summary model/provider
- **Deep extraction** -- LLM-powered extraction model, provider, API key, base URL override
- **Audio transcription** -- Whisper model selection
- **Model server** -- Python model server URL, Docling device, trust_remote_code

Copy only the settings you need from `.env.advanced.example` into your `.env` file.

## CLI Commands

| Command | Description |
|---------|-------------|
| `threadclaw doctor` | Diagnose installation health: versions, data, integration, services, skills, compatibility |
| `threadclaw upgrade` | Safe transactional upgrade: backup → migrate → validate → manifest |
| `threadclaw integrate --check` | Read-only check for OpenClaw integration drift |
| `threadclaw integrate --apply` | Re-apply the managed integration block |

## Rollback

```bash
# Disable awareness only
THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED=false

# Disable entire evidence engine
THREADCLAW_MEMORY_RELATIONS_ENABLED=false

# Delete all evidence data (now consolidated in threadclaw.db)
# Use the TUI reset (KB + Evidence) or API reset instead:
# curl -X POST http://127.0.0.1:18800/reset -d '{"clearGraph": true}'
```
