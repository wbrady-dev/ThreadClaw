# System Architecture

## Overview

ClawCore runs as two integrated components:

1. **ClawCore HTTP Server** — Fastify-based REST API + TUI + CLI. Handles document ingestion, search, source adapters, and analytics. Uses `better-sqlite3` for the document store.

2. **Memory Engine Plugin** — OpenClaw plugin providing DAG-based conversation memory, context assembly, and the Evidence OS. Uses `node:sqlite` DatabaseSync.

Both components can write to the shared evidence graph database (`graph.db`) via WAL mode.

## Database Architecture

```
~/.clawcore/data/
  memory.db             # Conversation memory (memory engine)
  graph.db              # Evidence graph (shared by both processes)
  clawcore.db           # Document store (RAG, main ClawCore)
```

### Evidence Graph (graph.db)

21 tables across 6 migrations:

| Migration | Tables | Purpose |
|-----------|--------|---------|
| v1 | evidence_log, scope_sequences, state_scopes, branch_scopes, promotion_policies, entities, entity_mentions | Infrastructure + Entity Awareness |
| v2 | claims, claim_evidence, decisions, open_loops, state_deltas, capabilities, invariants | Stateful Evidence |
| v3 | attempts, runbooks, anti_runbooks | Multi-Agent Durability |
| v4 | work_leases | Lease Coordination |
| v5 | runbook_evidence | Procedural Memory |
| v6 | entity_relations | Deep Extraction |

## Write Path

### Document Ingestion
1. Parse document (PDF, DOCX, etc.)
2. Chunk with semantic strategies
3. Deduplicate via cosine similarity
4. Embed chunks with dense vector model
5. Store in document DB
6. **If relations enabled**: Extract entities from chunks, store in evidence graph

### Conversation Compaction
1. Memory engine compacts messages into summaries
2. **If relations enabled**: Extract entities from message content
3. **If claim extraction enabled**: Extract claims from structured signals
4. Store summaries in memory DB

### Context Assembly (every turn)
1. Assemble conversation context from DAG
2. **If awareness enabled**: Build awareness notes from entity graph (15ms, 3 queries)
3. **If relations enabled**: Compile evidence capsules via ROI governor (10ms)
4. Inject into system prompt addition

## Background Jobs

Currently none — all processing is lazy (triggered by queries or compaction). Decay is applied on read, not on schedule.

## Module Structure

```
memory-engine/src/relations/
  schema.ts           # 6 migrations, all DDL
  types.ts            # GraphDb interface, all type definitions
  evidence-log.ts     # Append-only log, transactions, idempotency
  entity-extract.ts   # Fast NER (3 regex strategies)
  graph-store.ts      # Entity CRUD
  graph-connection.ts # node:sqlite connection pool
  awareness.ts        # Awareness note builder
  eval.ts             # Awareness metrics ring buffer
  confidence.ts       # Decay formula
  terms.ts            # User terms loader
  claim-store.ts      # Claim CRUD + evidence
  claim-extract.ts    # Fast claim extraction (4 strategies)
  decision-store.ts   # Decision CRUD + supersession
  loop-store.ts       # Open loop tracking
  delta-store.ts      # State change recording
  capability-store.ts # Capability tracking
  invariant-store.ts  # Constraint management
  context-compiler.ts # ROI-governed capsule compilation
  attempt-store.ts    # Tool outcome ledger
  runbook-store.ts    # Success pattern learning
  anti-runbook-store.ts # Failure pattern learning
  decay.ts            # Lazy confidence decay
  lease-store.ts      # Advisory coordination
  promotion.ts        # Branch lifecycle + policy
  timeline.ts         # Event timeline materialization
  snapshot.ts         # Point-in-time state reconstruction
  relation-store.ts   # Entity relationships
  deep-extract.ts     # LLM-powered extraction
  synthesis.ts        # Retrospective narrative
  tools.ts            # All 22 cc_* tool factories
  index.ts            # Module exports
```

## Security Model

- All SQL queries use parameterized statements (no injection risk)
- Evidence log is append-only (immutable audit trail)
- File permissions: chmod 600 on Unix/macOS
- Deep extraction uses system/user message separation (prompt injection hardened)
- Branch isolation prevents cross-scope data leakage
- Leases are advisory (not hard locks)
