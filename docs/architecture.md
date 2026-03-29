# System Architecture

## Overview

ThreadClaw runs as two integrated components:

1. **ThreadClaw HTTP Server** -- Fastify-based REST API + TUI + CLI. Handles document ingestion, search, source adapters, and analytics. Uses `better-sqlite3` for the document store.

2. **Memory Engine Plugin** -- OpenClaw plugin providing DAG-based conversation memory, context assembly, and the Evidence OS. Uses `node:sqlite` DatabaseSync.

Both components can write to the shared evidence graph (consolidated into `threadclaw.db`) via WAL mode.

## Database Architecture

```
~/.threadclaw/data/
  memory.db             # Conversation memory (memory engine)
  threadclaw.db         # Document store + Evidence graph (consolidated)
```

### Evidence Graph (in threadclaw.db)

25 migrations. Core tables:

| Table | Purpose |
|-------|---------|
| memory_objects | Unified knowledge store -- all claims, decisions, entities, loops, attempts, procedures, invariants, deltas, conflicts, relations (15 kinds). Relations (entity-to-entity) stored here with full lifecycle |
| provenance_links | Cross-object relationships (derived_from, supports, contradicts, supersedes, mentioned_in, resolved_by) |
| evidence_log | Append-only audit trail |
| state_scopes | Scope containers |
| branch_scopes | Speculative branches |
| promotion_policies | Branch promotion rules |
| scope_sequences | Causal ordering counters |
| state_deltas | Change tracking |
| capabilities | Tool/service status registry |
| work_leases | Advisory coordination locks |
| _legacy_* (13 tables) | Renamed in v18, data migrated to memory_objects + provenance_links in v17 |

## Write Path

### Document Ingestion
1. Parse document (PDF, DOCX, etc.)
2. Chunk with semantic strategies
3. Deduplicate via cosine similarity
4. Embed chunks with dense vector model
5. Store in document DB
6. **If relations enabled**: Extract entities from chunks, store as MemoryObjects in evidence graph

### Conversation Processing
1. Memory engine compacts messages into summaries
2. **If relations enabled**: Semantic or fast extraction produces MemoryObjects (claims, decisions, entities, loops, etc.)
3. TruthEngine reconciles new MemoryObjects against existing knowledge (supersession, conflict detection, correction handling)
4. MemoryObjects written to `memory_objects` table via `mo-store.ts`
5. Cross-references written to `provenance_links` table
6. Store summaries in memory DB

### Context Assembly (every turn)
1. Assemble conversation context from DAG
2. **If awareness enabled**: Build awareness notes from entity graph (15ms, 3 queries)
3. **If relations enabled**: Compile evidence capsules via ROI governor (10ms)
4. Inject into system prompt addition

## Background Jobs

Currently none -- all processing is lazy (triggered by queries or compaction). Decay is applied on read, not on schedule. Decay functions include:
- **applyDecay**: Runbook staleness, anti-runbook confidence decay
- **decayRelations**: Relations stale after 180 days of inactivity

## Capability Warnings

When tools are unavailable or degraded (tracked in the `capabilities` table), capability warnings are surfaced in the system prompt so the agent knows which tools it cannot rely on.

## Module Structure

```
memory-engine/src/ontology/           -- Unified ontology (primary write path)
  types.ts            -- MemoryObject, MemoryKind (15 kinds), ProvenanceLink, RelevanceSignals
  mo-store.ts         -- Single CRUD entry point for memory_objects table
  canonical.ts        -- Per-kind canonical key generation
  writer.ts           -- Regex-based message understanding (fast mode)
  semantic-extractor.ts -- LLM-based message understanding (smart mode)
  truth.ts            -- TruthEngine: 6 reconciliation rules, correction guard, conflict creation
  reader.ts           -- Unified read layer, relevance-to-action ranking
  projector.ts        -- provenance_links writer
  correction.ts       -- Signal detection: correction, uncertainty, preference, temporal
  migration.ts        -- Backfill legacy join tables -> provenance_links (idempotent)
  index.ts            -- Barrel exports

memory-engine/src/relations/          -- Evidence OS stores + tools
  schema.ts           -- 25 migrations, all DDL
  types.ts            -- GraphDb interface, all type definitions
  evidence-log.ts     -- Append-only log, transactions, idempotency
  entity-extract.ts   -- Fast NER (3 regex strategies)
  graph-store.ts      -- Entity CRUD
  graph-connection.ts -- node:sqlite connection pool
  awareness.ts        -- Awareness note builder
  eval.ts             -- Awareness metrics ring buffer
  confidence.ts       -- Decay formula
  terms.ts            -- User terms loader
  claim-store.ts      -- Claim CRUD + evidence (reads _legacy_ or memory_objects)
  claim-extract.ts    -- Fast claim extraction (4 strategies)
  decision-store.ts   -- Decision CRUD + supersession
  loop-store.ts       -- Open loop tracking
  delta-store.ts      -- State change recording
  capability-store.ts -- Capability tracking
  invariant-store.ts  -- Constraint management
  context-compiler.ts -- ROI-governed capsule compilation
  attempt-store.ts    -- Tool outcome ledger
  runbook-store.ts    -- Success pattern learning
  anti-runbook-store.ts -- Failure pattern learning
  decay.ts            -- Lazy confidence decay
  lease-store.ts      -- Advisory coordination
  promotion.ts        -- Branch lifecycle + policy
  timeline.ts         -- Event timeline materialization
  snapshot.ts         -- Point-in-time state reconstruction
  relation-store.ts   -- Entity relationships
  deep-extract.ts     -- LLM-powered extraction
  synthesis.ts        -- Retrospective narrative
  tools.ts            -- 9 cc_* evidence tool factories (includes cc_synthesize)
  index.ts            -- Module exports
```

## Security Model

- All SQL queries use parameterized statements (no injection risk)
- Evidence log is append-only (immutable audit trail)
- Timing-safe API key authentication via SHA-256 hash comparison (`crypto.timingSafeEqual`)
- MCP path validation prevents directory traversal in ingest operations
- `isLocalRequest()` guard on destructive endpoints (/reset, /shutdown)
- File permissions: chmod 600 on Unix/macOS
- Deep extraction uses system/user message separation (prompt injection hardened)
- Branch isolation prevents cross-scope data leakage
- Leases are advisory (not hard locks)
- Rate limiting on all API routes

## Cross-Platform Service Management

- **Windows**: Task Scheduler XML tasks (no admin required)
- **Linux**: systemd --user units (no sudo required)
- **macOS**: launchd user agents
- All platforms use HTTP `/shutdown` endpoint for graceful stop
