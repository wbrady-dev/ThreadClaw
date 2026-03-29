# Replay & Rebuild

## Evidence Log as Source of Truth

The `evidence_log` table is an append-only record of every mutation to the evidence store. This enables full state reconstruction from the log alone.

## Timeline Reconstruction

```typescript
import { getTimeline } from "./relations/timeline.js";

// Get last 100 events
const events = getTimeline(db, scopeId, { limit: 100 });

// Filter by type
const claimEvents = getTimeline(db, scopeId, { objectType: "claim" });

// Time-range query
const recent = getTimeline(db, scopeId, {
  since: "2026-03-01T00:00:00.000",
  before: "2026-03-18T00:00:00.000",
});
```

## Point-in-Time Snapshots

```typescript
import { getStateAtTime } from "./relations/snapshot.js";

// What did the state look like at noon on March 15?
const snapshot = getStateAtTime(db, 1, "2026-03-15T12:00:00.000");
// Returns: { claims, decisions, openLoops, invariants, evidenceCount }
```

Historical accuracy:
- **Claims/invariants** (kind='claim', kind='invariant' in memory_objects): Uses `updated_at > timestamp` to include items that were later superseded
- **Decisions** (kind='decision'): Subquery checks when superseding decision was created
- **Loops** (kind='loop'): Uses temporal fields for range-based reconstruction

## Disaster Recovery

### Full Rebuild
```bash
# Delete document store + evidence graph (consolidated)
rm ~/.threadclaw/data/threadclaw.db

# Restart -- migrations re-create empty schema (memory_objects + provenance_links)
# Then re-ingest documents to rebuild entity graph:
threadclaw relations backfill --collection default
```

### Selective Rebuild
The evidence log itself is not rebuildable (it IS the source). But the memory_objects and provenance_links tables can theoretically be reconstructed from the log by replaying events.

## Database Backup

```bash
# Simple file copy (ensure no active writers)
cp ~/.threadclaw/data/threadclaw.db ~/.threadclaw/data/threadclaw.db.bak
cp ~/.threadclaw/data/memory.db ~/.threadclaw/data/memory.db.bak
```

WAL mode may create `-wal` and `-shm` files — include these in backups for consistency.
