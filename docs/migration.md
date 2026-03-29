# Migration Guide

## Upgrading from RSMA-Only Setup

If you were using ThreadClaw before the Evidence OS, upgrading is automatic:

1. Update to the latest version
2. Evidence graph DB is created on first startup (new file, doesn't affect existing data)
3. All 19 schema migrations run idempotently
4. Existing RSMA functionality (search, ingest, memory) is unaffected

## The One True Ontology Migration (v16-v19)

The biggest schema change: 13 legacy tables were replaced by `memory_objects` + `provenance_links`.

### What Happened

1. **v16**: Created `memory_objects` table with unified schema
2. **v17**: Copied all data from legacy tables (claims, decisions, entities, open_loops, attempts, runbooks, anti_runbooks, invariants) into `memory_objects`, and migrated join tables (entity_mentions, claim_evidence, entity_relations, runbook_evidence, anti_runbook_evidence) into `provenance_links`
3. **v18**: Renamed all legacy tables to `_legacy_*` (safety net)
4. **v19**: Added UNIQUE constraint on `composite_id`, added `updated_at DESC` index

### Legacy Tables (renamed in v18)

These tables are renamed to `_legacy_*` and retained as a safety net. They will be dropped in a future migration:

- `_legacy_claims`, `_legacy_claim_evidence`
- `_legacy_decisions`
- `_legacy_open_loops`
- `_legacy_entities`, `_legacy_entity_mentions`, `_legacy_entity_relations`
- `_legacy_attempts`
- `_legacy_runbooks`, `_legacy_runbook_evidence`
- `_legacy_anti_runbooks`, `_legacy_anti_runbook_evidence`
- `_legacy_invariants`

### No Dual-Write Bridge

The engine.ts bridge that previously wrote to both legacy tables and memory_objects has been removed. All writes now go exclusively through `mo-store.ts`.

## Enabling Evidence Features

Evidence OS features are **all opt-in**. Enable progressively:

### Phase 1: Entity Awareness
```bash
THREADCLAW_MEMORY_RELATIONS_ENABLED=true
THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED=true
```

### Phase 2: Claims & Context Compilation
```bash
THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED=true
THREADCLAW_MEMORY_RELATIONS_CONTEXT_TIER=standard
```

### Phase 3: Attempt Tracking
```bash
THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED=true
```

### Phase 4: Deep Extraction (Optional)
```bash
THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=true
THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL=claude-sonnet-4-20250514
THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER=anthropic
```

### Phase 5: Extraction Mode (Optional)
```bash
# Smart: LLM-based semantic extraction (default when deep extraction is enabled)
# Understands natural language without magic prefixes.
THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart

# Fast: Regex-only, no LLM calls, <5ms (default when no model configured)
THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=fast
```

Smart mode uses the same model as deep extraction -- no extra model to configure. If deep extraction is enabled and extraction mode is not explicitly set, smart mode is used automatically.

## Schema Migrations

Migrations are tracked in `_evidence_migrations` table and run idempotently:

| Version | What Changed |
|---------|-------------|
| v1 | Infrastructure + entities + entity_mentions |
| v2 | Claims, claim_evidence, decisions, open_loops, state_deltas, capabilities, invariants |
| v3 | Attempts, runbooks, anti_runbooks |
| v4 | work_leases |
| v5 | runbook_evidence |
| v6 | entity_relations |
| v7 | anti_runbook_evidence |
| v8-v9 | Indexes and constraints |
| v10 | provenance_links table |
| v11 | provenance_links: scope_id + metadata columns |
| v12 | Canonical key prefix alignment |
| v13 | entity_mentions UNIQUE index |
| v14 | Orphaned open_loops cleanup |
| v15 | decisions canonical_key column |
| v16 | memory_objects table (unified ontology) |
| v17 | Data migration: legacy tables -> memory_objects + provenance_links |
| v18 | Legacy tables renamed to _legacy_* |
| v19 | UNIQUE constraint on composite_id, updated_at index |

## Provenance Links Migration

The `ontology/migration.ts` module provides `migrateToProvenanceLinks()` for backfilling provenance_links from legacy join tables. It tries both `_legacy_*` and original table names, and uses INSERT OR IGNORE for idempotent re-runs.

## Renamed Concepts

| Old Name | New Name |
|----------|----------|
| lossless-claw | threadclaw-memory |
| LCM | ThreadClaw Memory Engine |
| RSMA | ThreadClaw (broader scope) |
| runbooks + anti_runbooks | procedures (kind='procedure' in memory_objects) |
| entity_mentions | provenance_links (predicate='mentioned_in') |
| entity_relations | provenance_links (predicate='relates_to') |
| claim_evidence | provenance_links (predicate='supports' or 'contradicts') |

## Rollback

```bash
# Disable all evidence features (keeps RSMA working)
THREADCLAW_MEMORY_RELATIONS_ENABLED=false

# Remove document store + evidence data (consolidated)
rm ~/.threadclaw/data/threadclaw.db
```

No schema downgrade is needed -- disabling the feature flag stops all evidence operations.
