# Promotion Policies

Promotion policies define how tentative branch evidence becomes shared truth. Each object type has its own policy, seeded in the database on first migration.

## Policy Structure

| Field | Description |
|-------|-------------|
| `min_confidence` | Minimum confidence for any promotion |
| `requires_user_confirm` | 1 = user must confirm (unless auto-promote threshold met) |
| `auto_promote_above_confidence` | Skip user confirm if confidence exceeds this |
| `requires_evidence_count` | Minimum supporting evidence rows |
| `max_age_hours` | Auto-discard branches older than this (NULL = never) |

## Default Policies

| Object Type | Min Confidence | User Confirm | Auto-Promote At | Min Evidence | Expiry |
|------------|---------------|-------------|----------------|-------------|--------|
| entity | 0.3 | No | - | 1 | Never |
| mention | 0.0 | No | - | 1 | Never |
| claim | 0.6 | No | - | 2 | 7 days |
| decision | 0.5 | Yes | 0.7 | 1 | Never |
| loop | 0.3 | No | - | 1 | 3 days |
| attempt | 0.0 | No | - | 1 | Never |
| runbook | 0.5 | No | - | 2 | Never |
| anti_runbook | 0.5 | No | - | 2 | Never |
| invariant | 0.7 | Yes | 0.9 | 1 | Never |
| capability | 0.0 | No | - | 1 | Never |

## Promotion Logic

```
canPromote IF:
  confidence >= min_confidence
  AND evidence_count >= requires_evidence_count
  AND (requires_user_confirm == 0
       OR user_confirmed == true
       OR confidence >= auto_promote_above_confidence)
```

## Examples

**Claim promotion**: Needs confidence >= 0.6 AND 2+ evidence rows. No user confirmation needed.

**Decision promotion**: Needs confidence >= 0.5 AND either user confirmation OR confidence >= 0.7 (auto-promote at high confidence).

**Invariant promotion**: Needs confidence >= 0.7 AND either user confirmation OR confidence >= 0.9. Most conservative policy — invariants affect all future actions.

## Supersession Participation

The following kinds participate in truth reconciliation supersession via `SUPERSESSION_KINDS`: claim, decision, loop, invariant, procedure, relation, entity, capability.

Entity and capability were added in v0.3.3. This means that when a newer entity or capability object shares the same canonical key as an existing one, the TruthEngine will supersede the older object rather than creating a duplicate.

## Customization

Policies are stored in the `promotion_policies` table. You can UPDATE them directly:
```sql
UPDATE promotion_policies SET min_confidence = 0.8 WHERE object_type = 'claim';
```
