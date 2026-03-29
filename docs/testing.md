# Testing

## Test Framework

Vitest with in-memory SQLite databases for isolation. No external dependencies needed.

## Test Suites

### ThreadClaw (src/) -- 103 tests

| File | Tests | Coverage |
|------|-------|----------|
| routes.test.ts | 28 | API route tests (health, collections, query, ingest, analytics, rate limiting) |
| parsers.test.ts | 39 | File parser tests (plaintext, markdown, CSV, JSON, code) + registry |
| chunker.test.ts | 14 | Chunking strategy tests (prose, markdown, merging, context prefix) |
| cli.test.ts | 8 | CLI command structure, subcommand registration, version/help output |

### Memory Engine (memory-engine/) -- 866 tests (44 test files)

| File | Tests | Coverage |
|------|-------|----------|
| engine.test.ts | 54 | Core LCM engine, compaction, token budgets |
| expansion-auth.test.ts | 50 | Expansion auth, orchestrator, token caps |
| rsma-stress.test.ts | 49 | RSMA stress/load scenarios |
| relations.test.ts | 46 | H1: entities, extraction, evidence log, graph store, awareness, eval |
| lcm-integration.test.ts | 46 | LCM integration: compaction, durable parts |
| rsma-failure-injection.test.ts | 45 | RSMA failure injection resilience |
| relations-h2.test.ts | 34 | H2: claims, decisions, loops, deltas, capabilities, invariants |
| summarize.test.ts | 30 | Summarization, legacy params |
| relations-h3-promotion.test.ts | 25 | H3: leases, promotion policies, branch lifecycle |
| relations-h3.test.ts | 24 | H3: attempts, runbooks, anti-runbooks, decay |
| assembler-blocks.test.ts | 24 | Assembler block handling |
| relations-h4.test.ts | 16 | H4: runbook evidence, timeline, snapshots |
| relations-h2-compiler.test.ts | 15 | H2: context compiler, ROI governor, budget tiers |
| security-hardening.test.ts | 14 | Security regression guards (v0.2.1) |
| relations-h5.test.ts | 13 | H5: entity relations, deep extraction (mocked LLM) |
| fts5-sanitize.test.ts | 13 | FTS5 query sanitization |
| + other test files | ~380 | Config, tools, expand, migration, fallback, ontology, mo-store, truth engine, etc. |

### Combined Total: 89 + 858 = **947 tests**

## Writing Tests

### Standard Pattern

```typescript
import { DatabaseSync } from "node:sqlite";

function createDb(): GraphDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runGraphMigrations(db as unknown as GraphDb);
  return db as unknown as GraphDb;
}
```

### Mocking LLM Calls

For deep extraction tests, mock `deps.complete()`:
```typescript
const deps = {
  config: makeConfig({ relationsDeepExtractionEnabled: true }),
  complete: async () => ({ content: JSON.stringify([...]) }),
  resolveModel: () => ({ provider: "test", model: "test" }),
} as any;
```

### Testing Evidence Logging

Verify mutations create evidence log entries:
```typescript
const events = db.prepare(
  "SELECT * FROM evidence_log WHERE object_type = 'claim'"
).all();
expect(events.length).toBeGreaterThan(0);
```

### Testing mo-store (Unified CRUD)

```typescript
import { upsertMemoryObject, getMemoryObject, queryMemoryObjects } from "../src/ontology/mo-store.js";

const { moId, isNew } = upsertMemoryObject(db, {
  id: "claim:test-1",
  kind: "claim",
  content: "Redis is a cache",
  confidence: 0.8,
  // ...
});
expect(isNew).toBe(true);

const obj = getMemoryObject(db, "claim:test-1");
expect(obj?.kind).toBe("claim");
```

### Testing Semantic Extraction (Smart Mode)

Mock the `CompleteFn` to simulate LLM responses:
```typescript
import { semanticExtract, type CompleteFn } from "../src/ontology/semantic-extractor.js";

const mockComplete: CompleteFn = async () => ({
  content: JSON.stringify({
    events: [{
      type: "decision",
      content: "Use Postgres for staging",
      subject: "staging database",
      predicate: "technology",
      value: "Postgres",
      confidence: 0.9,
    }],
  }),
});

const result = await semanticExtract(
  "We're going with Postgres for staging",
  "msg:001",
  "user",
  { complete: mockComplete, model: "test-model" },
);
expect(result.objects.length).toBeGreaterThan(0);
expect(result.objects.some(o => o.kind === "decision")).toBe(true);
```

### Testing the TruthEngine

```typescript
import { reconcile } from "../src/ontology/truth.js";

// Provide a real or mocked GraphDb and test reconciliation rules:
const result = reconcile(db, [candidateObject], { isCorrection: true, correctionSignal: "actually" });
expect(result.stats.supersessions).toBe(1);
```

### Testing the MemoryReader

```typescript
import { readMemoryObjects } from "../src/ontology/reader.js";

const objects = readMemoryObjects(db, { kinds: ["claim"], keyword: "postgres" });
// Returns MemoryObject[] sorted by relevance-to-action ranking
```

## Running

```bash
# ThreadClaw src tests (89)
cd threadclaw && npx vitest run

# Memory engine tests (858)
cd memory-engine && npx vitest run

# Verbose output
npx vitest run --reporter=verbose

# Watch mode
npx vitest watch

# Type check only
npx tsc --noEmit
```
