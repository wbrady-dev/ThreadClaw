# API Reference

## HTTP Endpoints (ThreadClaw Server)

### Health & Lifecycle
- `GET /health` -- Health check (always accessible, bypasses API key auth)
- `POST /shutdown` -- Graceful shutdown (localhost only via `isLocalRequest` guard)

### Search & Query
- `POST /query` -- Hybrid search with reranking
- `POST /search` -- Simple search (no reranking)

### Ingestion
- `POST /ingest` -- Ingest a file
- `POST /ingest/batch` -- Batch ingest

### Collections
- `GET /collections` -- List collections
- `POST /collections` -- Create collection
- `DELETE /collections/:id` -- Delete collection

### Documents
- `GET /documents` -- List documents
- `DELETE /documents/:id` -- Delete document and its chunks

### Analytics & Diagnostics
- `GET /analytics` -- Query performance summary
- `GET /analytics/recent?limit=N` -- Recent queries
- `GET /analytics/awareness` -- Awareness metrics
- `DELETE /analytics` -- Clear analytics
- `GET /diagnostics` -- Full RSMA health (JSON): memory stats, evidence counts, awareness metrics, compiler state

### Sources

- `GET /sources` -- List all configured source adapters with status (localhost only)
  - Returns: `{ sources: [{ id, name, type, enabled, status, collections }] }`
- `POST /sources/reload` -- Hot-reload source configuration (localhost only). Stops all adapters, re-reads `.env`, restarts enabled ones.
  - Returns: `{ status: "ok", message: "Sources reloaded" }`

### Graph

All graph endpoints are localhost-only (`isLocalRequest` guard).

- `GET /graph/entities` -- List entities sorted by mention count (descending)
  - Query params: `limit` (default 50, max 200), `offset` (default 0), `search` (optional, case-insensitive name filter)
  - Returns: `{ entities: [{ id, name, display_name, entity_type, mention_count, first_seen_at, last_seen_at }], total, limit, offset }`
- `GET /graph/entities/:id` -- Entity detail with up to 50 recent mentions
  - Returns: `{ entity: { ... }, mentions: [{ id, source_ref, source_detail, context_terms, actor, created_at }] }`
- `GET /graph/terms` -- Read the user-defined entity terms list (from `~/.threadclaw/relations-terms.json`)
  - Returns: `{ terms: string[] }`
- `PUT /graph/terms` -- Update the user-defined entity terms list
  - Body: `{ terms: string[] }` (max 500 terms, each max 100 chars, alphanumeric/spaces/punctuation only)
  - Returns: `{ terms: string[], count: number }`

### Reindex
- `POST /reindex` -- Reindex all documents in a collection

### Reset
- `POST /reset` -- Knowledge base reset (localhost only via `isLocalRequest` guard)
  - Body: `{ clearGraph?: boolean, clearMemory?: boolean }`
  - `clearGraph=true` (default): Clears all evidence graph tables
  - `clearMemory=true`: Clears conversation memory (messages, summaries, context items)
  - Returns stats on what was cleared

### Authentication
- When `THREADCLAW_API_KEY` is set, all endpoints except `/health` require `Authorization: Bearer <key>`
- Comparison uses timing-safe SHA-256 hash comparison (`crypto.timingSafeEqual`) to prevent timing attacks

## Agent Tools API

All 12 `cc_*` tools are registered via the OpenClaw plugin API and available to agents during conversations. See [Tools Reference](tools.md) for parameters.

### Tool Response Format

```typescript
{
  content: [{ type: "text", text: "formatted output" }],
  details: { count: number, ... }  // structured metadata
}
```

### Error Response

```typescript
{
  content: [{ type: "text", text: '{"error": "message"}' }],
  details: { error: "message" }
}
```

## Internal APIs

### Evidence Log

```typescript
logEvidence(db, {
  scopeId: number,
  branchId?: number,
  objectType: string,
  objectId: number,
  eventType: string,
  actor?: string,
  runId?: string,
  idempotencyKey?: string,
  payload?: Record<string, unknown>,
});
```

### mo-store (Unified CRUD)

```typescript
import { upsertMemoryObject, getMemoryObject, queryMemoryObjects } from "./ontology/mo-store.js";

// Write
const { moId, isNew } = upsertMemoryObject(db, memoryObject);

// Read single
const obj = getMemoryObject(db, "claim:42");

// Query multiple
const objects = queryMemoryObjects(db, {
  kinds: ["claim", "decision"],
  statuses: ["active"],
  keyword: "postgres",
  limit: 20,
});
```

### Context Compiler

```typescript
compileContextCapsules(db, {
  tier: "lite" | "standard" | "premium",
  scopeId: number,
  maxClaims?: number,
  maxDecisions?: number,
  maxLoops?: number,
  maxDeltas?: number,
  maxInvariants?: number,
}): CompilerResult | null;
```
