# API Reference

## HTTP Endpoints (ClawCore Server)

### Search & Query
- `POST /query` — Hybrid search with reranking
- `POST /search` — Simple search (no reranking)

### Ingestion
- `POST /ingest` — Ingest a file
- `POST /ingest/batch` — Batch ingest

### Collections
- `GET /collections` — List collections
- `POST /collections` — Create collection
- `DELETE /collections/:id` — Delete collection

### Analytics
- `GET /analytics` — Query performance summary
- `GET /analytics/recent?limit=N` — Recent queries
- `GET /analytics/awareness` — Awareness metrics
- `DELETE /analytics` — Clear analytics

### Documents
- `DELETE /documents/:id` — Delete document
- `GET /documents` — List documents

## Agent Tools API

All 22 `cc_*` tools are registered via the OpenClaw plugin API and available to agents during conversations. See [Tools Reference](tools.md) for parameters.

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
