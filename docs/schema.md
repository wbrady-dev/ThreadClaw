# Schema Reference

All evidence tables live in `graph.db` (`~/.clawcore/data/graph.db`). 21 tables across 6 migrations.

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
Per-object-type rules for promoting branch data to shared scope. Seeded with defaults for all 10 object types.

### scope_sequences
Monotonic counter per scope for causal ordering.

## Horizon 1: Entity Awareness (Migration v1)

### entities
Named concepts with mention tracking.

| Column | Type | Description |
|--------|------|-------------|
| name | TEXT UNIQUE | Lowercased canonical name |
| display_name | TEXT | Original-cased display name |
| mention_count | INTEGER | Total mentions across sources |
| first_seen_at, last_seen_at | TEXT | Temporal range |

### entity_mentions
Where and when each entity was mentioned, with co-occurring terms.

## Horizon 2: Stateful Evidence (Migration v2)

### claims
Structured facts with confidence, trust, and evidence chains.

| Column | Type | Description |
|--------|------|-------------|
| scope_id, branch_id | INTEGER | Scope + branch (0=shared) |
| subject, predicate | TEXT | The claim structure |
| object_text, object_json | TEXT | Claim value |
| confidence, trust_score, source_authority | REAL | Scoring |
| canonical_key | TEXT | Dedup key (UNIQUE per scope+branch) |
| superseded_by | INTEGER FK | Points to replacing claim |

### claim_evidence
Evidence supporting or contradicting claims. Links claims to sources.

### decisions
Active choices with automatic supersession. Topic-based dedup.

### open_loops
Pending tasks, questions, dependencies. Priority-ordered.

### state_deltas
Record of what changed, old value, new value.

### capabilities
Known tools/services with status tracking.

### invariants
Durable constraints with severity ordering.

## Horizon 3: Multi-Agent Durability (Migrations v3-v4)

### attempts
Tool execution outcome ledger. Tracks success/failure/timeout with duration.

### runbooks
Learned success patterns with success/failure counts and confidence.

### anti_runbooks
Learned failure patterns. Confidence increases with each failure, decays over time.

### work_leases
Advisory coordination for resource access. Leases expire automatically.

## Horizon 4: Procedural Memory (Migration v5)

### runbook_evidence
Links attempts to runbooks, creating an evidence chain for learned patterns.

## Horizon 5: Deep Extraction (Migration v6)

### entity_relations
Entity-to-entity relationships (subject -> predicate -> object) with confidence scoring.

## Key Constraints

- All tables reference `state_scopes(id)` with `ON DELETE CASCADE`
- `branch_id=0` is the sentinel for shared scope (avoids NULL uniqueness traps)
- `evidence_log.idempotency_key` has UNIQUE constraint for race-safe dedup
- Claims, capabilities, invariants use UNIQUE constraints on scope + key
