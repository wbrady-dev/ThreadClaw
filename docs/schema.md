# Schema Reference

All evidence tables live in `threadclaw.db` (`~/.threadclaw/data/threadclaw.db`, consolidated with the document store). 25 migrations.

## Core Tables (Current)

### memory_objects (Migration v16)

The unified knowledge store. All structured knowledge (claims, decisions, entities, loops, attempts, procedures, invariants, deltas, conflicts) lives here as rows with a `kind` discriminator.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| composite_id | TEXT UNIQUE | Namespaced ID (e.g. `claim:42`, `decision:7`) |
| kind | TEXT | claim, decision, entity, loop, attempt, procedure, invariant, delta, conflict, capability, runbook, relation, event, chunk, message |
| canonical_key | TEXT | Dedup/supersession key (per-kind strategies) |
| content | TEXT | Human-readable text |
| structured_json | TEXT | Machine-readable JSON payload (StructuredClaim, StructuredDecision, etc.) |
| scope_id | INTEGER | Scope reference (default 1 = global) |
| branch_id | INTEGER | Branch reference (0 = shared) |
| status | TEXT | active, superseded, retracted, stale, needs_confirmation |
| confidence | REAL | 0.0-1.0 |
| trust_score | REAL | 0.0-1.0 from source trust hierarchy |
| influence_weight | TEXT | critical, high, standard, low |
| superseded_by | INTEGER | Points to replacing memory object |
| source_kind | TEXT | document, message, tool_result, user_explicit, extraction, compaction, inference |
| source_id | TEXT | Source identifier |
| source_detail | TEXT | Additional source context |
| source_authority | REAL | Source trust score |
| first_observed_at | TEXT | First observation timestamp |
| last_observed_at | TEXT | Most recent observation timestamp |
| observed_at | TEXT | When the system learned this (ISO 8601) |
| created_at | TEXT | Row creation timestamp |
| updated_at | TEXT | Last update timestamp |

Indexes: `kind+status+scope_id`, `canonical_key+scope_id`, `composite_id` (UNIQUE), `scope_id+branch_id+kind`, `source_kind+source_id`, `updated_at DESC`.

### provenance_links (Migration v10-v11)

Cross-object relationships. Replaces 7 legacy join tables (entity_mentions, claim_evidence, entity_relations, runbook_evidence, anti_runbook_evidence, and implicit linkage).

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| subject_id | TEXT | Source MemoryObject ID |
| predicate | TEXT | derived_from, supports, contradicts, supersedes, mentioned_in, resolved_by |
| object_id | TEXT | Target MemoryObject ID |
| confidence | REAL | 0.0-1.0 |
| detail | TEXT | Additional context for the link |
| scope_id | INTEGER | Scope (default 1) |
| metadata | TEXT | Optional JSON metadata |
| created_at | TEXT | Millisecond ISO timestamp |

Constraint: `UNIQUE(subject_id, predicate, object_id)`. Predicate is CHECK-constrained to the 6 valid values.

**Note:** Relations (entity-to-entity relationships) were moved from `provenance_links` (predicate='relates_to') to `memory_objects` (kind='relation') in migration v25. Relations now have full lifecycle support (supersession, evidence chains, decay, archival) as first-class MemoryObjects.

## Infrastructure (Migration v1)

### evidence_log
Append-only audit trail. Every mutation gets a row here.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PK | Auto-increment |
| scope_id | INTEGER | Scope reference (NULL for global) |
| branch_id | INTEGER | Branch reference (NULL for shared) |
| object_type | TEXT | entity, claim, decision, etc. |
| object_id | INTEGER | PK of affected row |
| event_type | TEXT | create, update, supersede, delete, etc. |
| actor | TEXT | Who made the change |
| run_id | TEXT | Execution run identifier |
| idempotency_key | TEXT UNIQUE | Prevents duplicate processing |
| payload_json | TEXT | Operation details |
| scope_seq | INTEGER | Scope-local sequence number |
| created_at | TEXT | Millisecond ISO timestamp |

### state_scopes
Scope containers (project, workspace, conversation).

### branch_scopes
Speculative memory branches with lifecycle (active, promoted, discarded).

### promotion_policies
Per-object-type rules for promoting branch data to shared scope. Seeded with defaults for all object types.

### scope_sequences
Monotonic counter per scope for causal ordering.

## Other Active Tables

### state_deltas (Migration v2)
Record of what changed, old value, new value.

### capabilities (Migration v2)
Known tools/services with status tracking.

### work_leases (Migration v4)
Advisory coordination for resource access. Leases expire automatically.

## Legacy Tables (Migration v18 -- renamed)

The following tables were renamed to `_legacy_*` in migration v18. They are retained as a safety net and will be dropped in a future migration. All data has been migrated into `memory_objects` and `provenance_links` (migration v17).

- `_legacy_claims` (was `claims`)
- `_legacy_claim_evidence` (was `claim_evidence`)
- `_legacy_decisions` (was `decisions`)
- `_legacy_open_loops` (was `open_loops`)
- `_legacy_entities` (was `entities`)
- `_legacy_entity_mentions` (was `entity_mentions`)
- `_legacy_entity_relations` (was `entity_relations`)
- `_legacy_attempts` (was `attempts`)
- `_legacy_runbooks` (was `runbooks`)
- `_legacy_anti_runbooks` (was `anti_runbooks`)
- `_legacy_runbook_evidence` (was `runbook_evidence`)
- `_legacy_anti_runbook_evidence` (was `anti_runbook_evidence`)
- `_legacy_invariants` (was `invariants`)

## Migration History

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
| v10 | provenance_links table (unified, replaces legacy join tables) |
| v11 | provenance_links: add scope_id + metadata columns, composite indexes |
| v12 | Prefix existing claim canonical keys with "claim::" |
| v13 | UNIQUE index on entity_mentions for dedup |
| v14 | Cleanup orphaned open_loops rows |
| v15 | Add canonical_key to decisions |
| v16 | memory_objects table (unified ontology) |
| v17 | Copy all legacy data into memory_objects + provenance_links |
| v18 | Rename legacy tables to _legacy_* |
| v19 | UNIQUE constraint on composite_id, updated_at index |
| v25 | Backfill relations from provenance_links (predicate='relates_to') to memory_objects (kind='relation') |

## Key Constraints

- `branch_id=0` is the sentinel for shared scope (avoids NULL uniqueness traps)
- `evidence_log.idempotency_key` has UNIQUE constraint for race-safe dedup
- `memory_objects.composite_id` has UNIQUE constraint (enforced in v19)
- `provenance_links` has UNIQUE constraint on `(subject_id, predicate, object_id)`
- `provenance_links.predicate` is CHECK-constrained to 6 valid values (relates_to removed in v25)
