# Changelog

All notable changes to ThreadClaw are documented here.

## [0.3.3] — 2026-03-25

### Relation Lifecycle
- **Relations as memory_objects** — relations moved to `memory_objects` (kind='relation') with full lifecycle: creation, supersession, confidence decay
- **decayRelations** — stale relations decay after 180 days, matching existing claim/procedure decay patterns
- **Entity and capability in SUPERSESSION_KINDS** — entity and capability kinds now participate in truth reconciliation supersession

### New Tool: cc_synthesize
- **Cross-cutting analysis** — new agent tool that synthesizes insights across multiple knowledge types (claims, decisions, entities, relations)
- 9 agent tools total: cc_claims, cc_decisions, cc_loops, cc_attempts, cc_branch, cc_procedures, cc_diagnostics, cc_memory, cc_synthesize

### LLM-Primary Invariant Extraction
- **LLM-powered invariant extraction** — invariants extracted via structured LLM call when deep extraction model is available
- **Regex fallback** — regex-based invariant detection as fallback when LLM unavailable

### Evidence Belief Propagation
- **Contradict/support propagation** — provenance links (contradicts, supports) now propagate confidence changes to linked claims automatically
- Contradictions lower target confidence; supporting evidence raises it

### Runbook Auto-Inference
- **CCL runbook capsules** — runbooks auto-inferred in the Context Compilation Layer after 3+ consecutive tool successes
- Capsules surface proven success patterns without manual runbook creation

### Proactive Awareness
- **Top entities on no-match** — when awareness finds no specific mismatches, stale references, or connections, it proactively surfaces top relevant entities to maintain contextual grounding

### Capability Warnings
- **Unavailable/degraded warnings** — capabilities with unavailable or degraded status are now surfaced as warnings in the agent's system prompt

### Audit
- **50-agent audit** with 49+ fixes across the full codebase
- **858 tests passing** in memory-engine

## [0.3.2] — 2026-03-23

### One True Ontology Migration
- **`memory_objects` table** (migration v16) — unified storage for all knowledge kinds, replacing 15+ legacy tables. Schema: composite_id, kind, canonical_key, content, structured_json, scope_id, branch_id, status, confidence, trust_score, influence_weight, source_kind, source_id, source_detail, source_authority, timestamps
- **Legacy data migration** (v17) — copies all existing claims, decisions, entities, loops, attempts, runbooks, anti-runbooks, invariants, entity_mentions, entity_relations, claim_evidence, runbook/anti-runbook evidence into memory_objects + provenance_links
- **Legacy table rename** (v18) — 13 legacy tables renamed to `_legacy_*` as safety net
- **UNIQUE composite_id** (v19) — enforces uniqueness, adds updated_at index for reader ORDER BY
- **mo-store.ts** — unified CRUD layer for memory_objects (upsert with weighted confidence blending: 70% new + 30% old, supersession, status updates, dynamic query builder)
- **cc_diagnostics** — now queries memory_objects instead of legacy tables for all counts
- **cc_memory** — unified smart search queries memory_objects directly for claims, decisions, and relationships

### Extraction Quality
- **Code block stripping** — strips ```...``` blocks before LLM extraction to prevent code-as-facts
- **Confidence floor** — rejects extracted events with confidence < 0.35
- **Junk filters** — post-extraction filters reject message metadata, file paths, URLs, low-confidence noise
- **LLM prompt rules** — explicit instructions to not extract from code blocks or programming constructs

### Security & Operations
- **Full wipe reset** — clean database reset path
- **Timing-safe auth** — API key comparison via `crypto.timingSafeEqual`
- **MCP path validation** — validates file paths in MCP server requests

### Testing
- **858 memory-engine tests** across the full test suite
- **89 src tests** for ThreadClaw core
- **19 graph database migrations** (v1-v19)

### Documentation
- Updated all skill files, root docs, and memory-engine docs to reflect unified ontology

## [0.3.1] — 2026-03-22

### RSMA Unified Ontology
- **MemoryObject type** — single unified type for all 13 knowledge kinds: event, chunk, message, summary, claim, decision, entity, loop, attempt, procedure, invariant, delta, conflict
- **provenance_links table** — replaces 7 legacy join tables (entity_mentions, claim_evidence, entity_relations, runbook_evidence, anti_runbook_evidence, summary linkage, conflict linkage) with a single typed-predicate table (derived_from, supports, contradicts, supersedes, mentioned_in, relates_to, resolved_by)
- **TruthEngine** — 6 reconciliation rules: confidence-based supersession, recency tie-breaking, evidence accumulation, value contradiction -> first-class Conflict objects, correction-triggered supersession with 5-point guard, provisional gating
- **Canonical keys** — per-kind dedup/supersession keys (claim::subject::predicate, decision::topic, entity::name, loop::hash, proc::tool::key, inv::key, conflict::hash)
- **MemoryReader** — unified read layer across graph.db with relevance-to-action ranking using task-mode weights (coding, planning, troubleshooting, recall, default)
- **StoreProjector** — dual-write to legacy tables + provenance_links; provenance link insertion for supersession, conflict, mention, evidence, derivation, and resolution
- **Historical data migration** — idempotent backfill from legacy join tables into provenance_links (INSERT OR IGNORE)

### Semantic Extraction
- **Smart mode** (default) — single structured LLM call extracts all memory events from a message. Understands natural language without magic prefixes ("We're going with Postgres" → decision, "Actually no" → correction). Uses same model as deep extraction.
- **Fast mode** — regex-only extraction, no LLM calls, <5ms. Fallback when no model configured.
- **Config**: `THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart|fast`
- **Signal detection** — correction, uncertainty, preference, and temporal signals detected via regex in both modes. Smart mode merges regex signals with LLM output.
- **Automatic fallback** — smart mode falls back to fast (regex) if LLM call fails or returns unparseable output

## [0.3.0] — 2026-03-20

### TUI Overhaul
- **Ink is now the primary TUI** — React-based terminal UI with live-updating status, auto-refresh, and module-level caching to prevent indicator flashing
- **Terminal capability detection** — probes Unicode, ANSI, raw mode, PowerShell version; ASCII fallback for limited terminals
- **Task system** — pub/sub for service action progress on home screen (start/stop/restart with live spinner)
- **Streamed commands** — subprocess output with line-by-line rendering (`shell: false`)
- **Service lifecycle** — orchestrated start/stop/restart with port-wait + log tailing
- **Watch paths tree** — lazy-loading directory browser with drives as roots, excluded internal dirs, saved paths at top
- **Ink sub-screens** — Status & Health, Services, Sources, Configure all rendered as Ink components
- **Legacy fallback** — non-TTY and limited terminals fall back to raw ANSI menu system
- **SIGINT safety** — raw mode cleanup on Ctrl+C in both Ink and legacy menu paths

### RSMA Fixes
- **Evidence Event Log** — fixed 6 missing `scope_id` in `logEvidence` calls (anti-runbook-store, runbook-store, lease-store, graph-store)
- **Decay audit trail** — `decayAntiRunbooks()` and `decayRunbooks()` now log evidence events
- **Source adapter sync state** — all 3 polling adapters (gdrive, notion, apple-notes) properly transition idle→syncing→idle

### Architecture
- **Port constants** — centralized `getApiPort()`, `getModelPort()`, `getApiBaseUrl()`, `getModelBaseUrl()` in platform.ts; replaced 90 hardcoded port references across 20+ files
- **Removed 3 unused dependencies** — `ink-select-input`, `ink-spinner`, `pdf-parse`
- **Removed dead code** — 5 `if (false)` blocks (~150 lines) from configure.ts
- **Rate limit** — default raised from 60 to 300 req/min to accommodate TUI polling

### Entity Extraction
- **spaCy NER** — `POST /ner` endpoint on model server extracts PERSON, ORG, GPE, DATE, EVENT, PRODUCT entities
- **Hybrid extraction** — NER results (confidence 0.8) merged with regex extraction (0.5-0.9); highest confidence wins per entity name
- **Graceful fallback** — regex-only extraction when spaCy unavailable
- **Auto-installed** — spaCy + `en_core_web_sm` model downloaded during setup

### Install
- **Recommended mode** now includes OCR (Tesseract), audio transcription (Whisper base), and NER (spaCy) — previously optional
- **Verification step** confirms NER model loaded after install

### Evidence OS Improvements
- **Awareness cache invalidation** — cache refreshes immediately on entity mutations instead of waiting up to 30s TTL
- **Token estimation** — type-aware heuristic (code ~3 chars/token, prose ~4) replaces flat `length/4` approximation

### Tests
- **89 new tests** — API routes (28), parsers (39), chunking (14), CLI (8)
- **Total: 1,197 tests** across 66 files (643 ThreadClaw + 554 memory-engine)

### Bug Fixes
- **`isPortOpen` netstat bug** — was checking entire output not per-line; TIME_WAIT sockets caused false positives preventing service starts
- **Service status flickering** — replaced unreliable HTTP health checks with TCP port connect (`isPortReachable`)
- **Stdin freeze on sub-menus** — 60ms delay after Ink unmount lets async cleanup finish before next render
- **Uninstall timeout** — increased from 8s to 20s/30s for API/model server shutdown

### Documentation
- Fixed diagram alignment in README.md and TECHNICAL.md (verified pixel-perfect with Python width checker)
- Fixed stale config values: `RATE_LIMIT_MAX` 60→300, `GDRIVE_SYNC_INTERVAL` 20min→300s
- Fixed `guardOpenClawConfig()` claim — corrected to actual behavior
- Documented `watch_paths` table as reserved for future DB-backed config
- Added CHANGELOG.md with full release history

## [0.2.1] — 2026-03-19

### Security Hardening

#### Command Injection (Critical)
- Replaced all `execSync(string)` with `execFileSync(command, args[])` across 22 files
- Zero template-literal `execSync` calls remain in the codebase
- Parsers (image, audio, epub), CLI commands, TUI screens, service management, source adapters all hardened
- Audio parser: Whisper model validated against allowlist, unique temp dir per call
- ePub parser: replaced shell `unzip`/`Expand-Archive` with `adm-zip` in-memory parsing (no shell, no temp files, no zip-slip)
- ePub parser: reads OPF `<spine>` for correct reading order, falls back to filename sort
- Deleted dead `runCommand(cmd)` utility that accepted arbitrary shell strings

#### Binary Dedup (Correctness)
- Fixed `contentHash(absPath + Date.now())` producing unstable hashes for binary files
- Added `contentHashBytes(Uint8Array)` using xxhash-wasm `h64Raw` for deterministic binary hashing
- Re-ingesting the same PDF now correctly deduplicates

#### Query DoS Prevention
- Clamped `top_k` (max 100) and `token_budget` (max 50000) at both API route and pipeline layers
- Logs warning when clamping occurs

#### Network Binding
- Python model server (`rerank-server.py`) changed from `0.0.0.0` to `127.0.0.1`
- Distribution `server.py` also fixed
- Env override available via `MODEL_SERVER_HOST`

#### Additional Fixes
- Temp file naming: `Date.now()` replaced with `randomUUID()` to prevent collisions
- Removed internal path exposure from analytics API error responses
- Replaced `console.error` with structured `logger.warn` in ingest routes
- Watcher `unhandledRejection` listener: module-level singleton guard prevents accumulation

#### Tests
- Added `security-hardening.test.ts` with 14 regression tests
- 554/554 tests passing

## [0.2.0] — 2026-03-19

### Sidecar Architecture
- Data consolidation to `~/.threadclaw/data/`
- Manifest versioning and lock-protected transactional upgrades
- `threadclaw doctor` / `threadclaw upgrade` / `threadclaw integrate` CLI commands
- Managed OpenClaw integration with check-only startup validation
- Backup validation, post-upgrade smoke test, PID-aware stale lock, backup retention

### Search Tuning
- Configurable rerank threshold, top-K, smart skip
- Similarity gate, prefix mode, embed batch size
- Ingest-time claim+decision extraction (no `/compact` required)

### Memory Engine
- `cc_recall` lightweight mode with evidence fallback (summaries→claims→decisions→messages)
- FTS5 OR fallback for long queries
- LIKE partial match for claim/decision search
- Cold structured archive (hot/cold/RAG tiers, copy-then-delete safety, auto-trigger at 5000 events)
- `cc_diagnostics` observability tool + `/analytics/diagnostics` HTTP endpoint
- "Has more" truncation indicator with agent-guided follow-up

## [0.1.0] — 2026-03-18

### Initial Release — RSMA Architecture
- **10 RSMA layers**: RAG + DAG + KG + AL + SL + DE + AOM + BSG + EEL + CCL
- **22 agent tools** (later consolidated to 12 tools in v0.3.0): cc_grep, cc_recall, cc_describe, cc_expand, cc_conflicts, cc_state, cc_claims, cc_decisions, cc_delta, cc_capabilities, cc_invariants, cc_loops, cc_attempts, cc_antirunbooks, cc_branch, cc_promote, cc_runbooks, cc_timeline, cc_relate, cc_ask, cc_diagnostics, cc_memory
- **Query pipeline**: validate → cache → expand → retrieve → gate → rerank → dedup → highlight → brief/titles/full
- **Ingestion pipeline**: 24 file formats, semantic chunking, embedding, dedup, atomic storage
- **6 source adapters**: Local (chokidar), Obsidian, Google Drive, Notion, OneDrive, Apple Notes
- **Storage**: SQLite + sqlite-vec + FTS5, WAL mode, auto-checkpoint
- **Model server**: Python Flask, embed + rerank + Docling/OCR, float16, threaded
- **HTTP API**: 16 endpoints with rate limiting and path validation
- **MCP server**: Model Context Protocol for native tool access
- **OpenClaw integration**: knowledge skill + memory engine plugin
- **Cross-platform**: Windows, macOS, Linux
- 540 tests passing
