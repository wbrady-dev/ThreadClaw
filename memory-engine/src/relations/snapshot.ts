/**
 * Snapshot queries — point-in-time state inspection.
 *
 * Queries existing tables with timestamp filters to reconstruct
 * what the state looked like at a given moment. Uses evidence_log
 * supersession events to determine which items were still active.
 */

import type { GraphDb } from "./types.js";
import type { ClaimRow } from "./claim-store.js";
import type { DecisionRow } from "./decision-store.js";
import type { LoopRow } from "./loop-store.js";
import type { InvariantRow } from "./invariant-store.js";

export interface StateSnapshot {
  timestamp: string;
  scopeId: number;
  claims: ClaimRow[];
  decisions: DecisionRow[];
  openLoops: LoopRow[];
  invariants: InvariantRow[];
  evidenceCount: number;
}

/**
 * Get a frozen view of the evidence state at a point in time.
 *
 * For each object type, queries items that existed at the timestamp
 * and were not yet superseded/closed/discarded at that time.
 */
export function getStateAtTime(
  db: GraphDb,
  scopeId: number,
  timestamp: string,
): StateSnapshot {
  // Claims active at timestamp: created before T, and either:
  // - still active now (status='active'), OR
  // - status changed AFTER T (updated_at > T), meaning it was still active at T
  //   regardless of current status (superseded, retracted, stale)
  const claims = db.prepare(`
    SELECT * FROM claims
    WHERE scope_id = ? AND created_at <= ?
      AND (status = 'active' OR updated_at > ?)
    ORDER BY confidence DESC
    LIMIT 50
  `).all(scopeId, timestamp, timestamp) as ClaimRow[];

  // Decisions active at timestamp: decided before T, and either still active
  // or superseded by a decision created AFTER T
  const decisions = db.prepare(`
    SELECT d.* FROM decisions d
    WHERE d.scope_id = ? AND d.decided_at <= ?
      AND (d.status = 'active'
           OR (d.superseded_by IS NOT NULL
               AND (SELECT created_at FROM decisions WHERE id = d.superseded_by) > ?))
    ORDER BY d.decided_at DESC
    LIMIT 50
  `).all(scopeId, timestamp, timestamp) as DecisionRow[];

  // Loops that were open at timestamp (already historically correct)
  const openLoops = db.prepare(`
    SELECT * FROM open_loops
    WHERE scope_id = ? AND opened_at <= ? AND (closed_at IS NULL OR closed_at > ?)
    ORDER BY priority DESC
    LIMIT 50
  `).all(scopeId, timestamp, timestamp) as LoopRow[];

  // Invariants active at timestamp: exclude revoked regardless of updated_at
  const invariants = db.prepare(`
    SELECT * FROM invariants
    WHERE scope_id = ? AND created_at <= ?
      AND (status = 'active'
           OR (status != 'revoked' AND updated_at > ?))
    ORDER BY severity DESC
    LIMIT 50
  `).all(scopeId, timestamp, timestamp) as InvariantRow[];

  // Evidence count up to timestamp
  const countRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM evidence_log
    WHERE (scope_id = ? OR scope_id IS NULL) AND created_at <= ?
  `).get(scopeId, timestamp) as { cnt: number };

  return {
    timestamp,
    scopeId,
    claims,
    decisions,
    openLoops,
    invariants,
    evidenceCount: countRow.cnt,
  };
}

/**
 * Get evidence log entries up to a timestamp.
 */
export function getEvidenceAtTime(
  db: GraphDb,
  scopeId: number,
  timestamp: string,
  limit = 50,
): Array<{
  id: number;
  object_type: string;
  object_id: number;
  event_type: string;
  actor: string | null;
  created_at: string;
}> {
  return db.prepare(`
    SELECT id, object_type, object_id, event_type, actor, created_at
    FROM evidence_log
    WHERE (scope_id = ? OR scope_id IS NULL) AND created_at <= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(scopeId, timestamp, limit) as Array<{
    id: number;
    object_type: string;
    object_id: number;
    event_type: string;
    actor: string | null;
    created_at: string;
  }>;
}
