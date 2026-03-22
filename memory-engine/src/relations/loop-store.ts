/**
 * Open loop store — tracking tasks, questions, and dependencies.
 */

import type { GraphDb, OpenLoopInput, UpdateLoopInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

export function openLoop(db: GraphDb, input: OpenLoopInput): number {
  const branchId = input.branchId ?? 0;

  const result = db.prepare(`
    INSERT INTO open_loops
      (scope_id, branch_id, loop_type, text, priority, owner, due_at, waiting_on,
       source_type, source_id, source_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.scopeId, branchId, input.loopType ?? "task", input.text,
    input.priority ?? 0, input.owner ?? null,
    input.dueAt ?? null, input.waitingOn ?? null,
    input.sourceType ?? null, input.sourceId ?? null, input.sourceDetail ?? null,
  );

  const loopId = Number(result.lastInsertRowid);

  logEvidence(db, {
    scopeId: input.scopeId,
    branchId: branchId || undefined,
    objectType: "open_loop",
    objectId: loopId,
    eventType: "open",
  });

  return loopId;
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

export function closeLoop(db: GraphDb, loopId: number): void {
  const loop = db.prepare("SELECT scope_id, branch_id FROM open_loops WHERE id = ?").get(loopId) as { scope_id: number; branch_id: number | null } | undefined;

  db.prepare(
    "UPDATE open_loops SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
  ).run(loopId);

  logEvidence(db, {
    scopeId: loop?.scope_id,
    branchId: loop?.branch_id ?? undefined,
    objectType: "open_loop",
    objectId: loopId,
    eventType: "close",
  });
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export function updateLoop(db: GraphDb, input: UpdateLoopInput): void {
  const sets: string[] = [];
  const args: unknown[] = [];

  if (input.status != null) {
    sets.push("status = ?");
    args.push(input.status);
    if (input.status === "closed") {
      sets.push("closed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')");
    }
  }
  if (input.priority != null) {
    sets.push("priority = ?");
    args.push(input.priority);
  }
  if (input.waitingOn !== undefined) {
    sets.push("waiting_on = ?");
    args.push(input.waitingOn);
  }

  if (sets.length === 0) return;

  const loop = db.prepare("SELECT scope_id, branch_id FROM open_loops WHERE id = ?").get(input.loopId) as { scope_id: number; branch_id: number | null } | undefined;

  args.push(input.loopId);
  db.prepare(`UPDATE open_loops SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  logEvidence(db, {
    scopeId: loop?.scope_id,
    branchId: loop?.branch_id ?? undefined,
    objectType: "open_loop",
    objectId: input.loopId,
    eventType: "update",
    payload: { status: input.status, priority: input.priority },
  });
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LoopRow {
  id: number;
  scope_id: number;
  branch_id: number;
  loop_type: string;
  text: string;
  status: string;
  priority: number;
  owner: string | null;
  due_at: string | null;
  waiting_on: string | null;
  opened_at: string;
  closed_at: string | null;
}

export function getOpenLoops(
  db: GraphDb,
  scopeId: number,
  branchId?: number,
  limit = 50,
  statusFilter?: string,
): LoopRow[] {
  // Determine status clause based on filter
  const statusClause = statusFilter === "all"
    ? "1=1"
    : statusFilter
      ? `status = '${statusFilter.replace(/'/g, "''")}'`
      : "status IN ('open', 'blocked')";

  if (branchId != null) {
    return db.prepare(`
      SELECT * FROM open_loops
      WHERE scope_id = ? AND (branch_id = 0 OR branch_id = ?) AND ${statusClause}
      ORDER BY priority DESC, opened_at ASC LIMIT ?
    `).all(scopeId, branchId, limit) as LoopRow[];
  }
  return db.prepare(`
    SELECT * FROM open_loops
    WHERE scope_id = ? AND branch_id = 0 AND ${statusClause}
    ORDER BY priority DESC, opened_at ASC LIMIT ?
  `).all(scopeId, limit) as LoopRow[];
}
