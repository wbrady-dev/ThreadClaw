# Contributor Guide

## Project Structure

```
threadclaw/
  src/              # Main ThreadClaw (HTTP server, CLI, TUI, ingest, query)
  memory-engine/    # Memory engine plugin (conversation memory + Evidence OS)
    src/
      ontology/     # Unified ontology (MemoryObject, mo-store, TruthEngine, extraction)
      relations/    # Evidence OS stores, schema, tools
      store/        # Conversation/summary stores
      db/           # Config, connection, migration
      tools/        # Memory engine tools (cc_grep, cc_describe, etc.)
    test/           # All tests (858 tests)
  docs/             # Documentation
```

## Development Setup

```bash
git clone https://github.com/wbrady-dev/ThreadClaw.git
cd threadclaw && npm install
cd memory-engine && npm install
```

## Adding a New Knowledge Kind

All knowledge is stored as MemoryObjects in the unified `memory_objects` table. To add a new kind:

1. **Types** (`ontology/types.ts`): Add the new kind to `MemoryKind` union type
2. **Structured interface** (`ontology/types.ts`): Add a `Structured*` interface for the kind's JSON payload
3. **Canonical key** (`ontology/canonical.ts`): Add a canonical key strategy for dedup
4. **Extraction** (`ontology/writer.ts` or `semantic-extractor.ts`): Add extraction logic for fast and/or smart mode
5. **Tools** (`relations/tools.ts`): Add tool factory function if agent needs direct access
6. **Registration** (`memory-engine/index.ts`): Register tool in plugin
7. **Config** (`config.ts`): Add config fields if needed
8. **Tests**: Write tests with `:memory:` SQLite using `runGraphMigrations()`

The `mo-store.ts` CRUD layer handles all kinds uniformly -- no new store module is needed.

## Key Patterns

- **SELECT-before-UPSERT**: For reliable `isNew` detection within transactions
- **logEvidence()**: Every mutation must log to the evidence log
- **withWriteTransaction()**: Wrap multi-step mutations for atomicity
- **Non-fatal try/catch**: Evidence operations never break core functionality
- **GraphDb interface**: Abstracts over both `node:sqlite` and `better-sqlite3`

## Running Tests

```bash
cd memory-engine
npx vitest run              # All tests
npx vitest run test/relations.test.ts  # Specific file
npx vitest --reporter=verbose  # Verbose output
```

## Style Rules

- TypeScript strict mode
- No `any` types in public APIs (internal `as unknown as GraphDb` casts are acceptable for SQLite type bridging)
- All SQL parameterized (no string interpolation)
- ORDER BY always includes `id DESC` tiebreaker for deterministic results
- Config defaults are always `false` for new features (opt-in)
