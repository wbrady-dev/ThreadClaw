/**
 * Runbook store — learned success patterns from tool outcomes.
 */

import type { GraphDb, UpsertRunbookInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";

export function upsertRunbook(
  db: GraphDb,
  input: UpsertRunbookInput,
): { runbookId: number; isNew: boolean } {
  const existing = db.prepare(
    "SELECT id FROM runbooks WHERE scope_id = ? AND runbook_key = ?",
  ).get(input.scopeId, input.runbookKey) as { id: number } | undefined;

  db.prepare(`
    INSERT INTO runbooks
      (scope_id, runbook_key, tool_name, pattern, description, success_count, failure_count, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, runbook_key) DO UPDATE SET
      success_count = runbooks.success_count + excluded.success_count,
      failure_count = runbooks.failure_count + excluded.failure_count,
      confidence = MAX(runbooks.confidence, excluded.confidence),
      description = COALESCE(excluded.description, runbooks.description),
      updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
  `).run(
    input.scopeId, input.runbookKey, input.toolName, input.pattern,
    input.description ?? null,
    input.successCount ?? 0, input.failureCount ?? 0,
    input.confidence ?? 0.5,
  );

  const row = db.prepare(
    "SELECT id FROM runbooks WHERE scope_id = ? AND runbook_key = ?",
  ).get(input.scopeId, input.runbookKey) as { id: number };

  const isNew = !existing;

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "runbook",
    objectId: row.id,
    eventType: isNew ? "create" : "update",
  });

  return { runbookId: row.id, isNew };
}

export function demoteRunbook(db: GraphDb, runbookId: number): void {
  db.prepare(`
    UPDATE runbooks SET
      confidence = confidence * 0.5,
      status = CASE WHEN confidence * 0.5 < 0.2 THEN 'under_review' ELSE status END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE id = ?
  `).run(runbookId);

  const row = db.prepare(
    "SELECT scope_id FROM runbooks WHERE id = ?",
  ).get(runbookId) as { scope_id: number } | undefined;

  logEvidence(db, {
    scopeId: row?.scope_id,
    objectType: "runbook",
    objectId: runbookId,
    eventType: "demote",
  });
}

export interface RunbookRow {
  id: number;
  scope_id: number;
  runbook_key: string;
  tool_name: string;
  pattern: string;
  description: string | null;
  success_count: number;
  failure_count: number;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export function getRunbooks(
  db: GraphDb,
  scopeId: number,
  opts?: { toolName?: string; status?: string; limit?: number },
): RunbookRow[] {
  const limit = opts?.limit ?? 20;
  const where = ["scope_id = ?"];
  const args: unknown[] = [scopeId];

  if (opts?.toolName) {
    where.push("tool_name = ?");
    args.push(opts.toolName);
  }
  where.push(`status = ?`);
  args.push(opts?.status ?? "active");

  args.push(limit);
  return db.prepare(`
    SELECT * FROM runbooks
    WHERE ${where.join(" AND ")}
    ORDER BY confidence DESC, updated_at DESC LIMIT ?
  `).all(...args) as RunbookRow[];
}

export function getRunbooksForTool(db: GraphDb, scopeId: number, toolName: string): RunbookRow[] {
  return getRunbooks(db, scopeId, { toolName });
}

// ---------------------------------------------------------------------------
// Runbook evidence (Horizon 4)
// ---------------------------------------------------------------------------

export interface AddRunbookEvidenceInput {
  runbookId: number;
  attemptId?: number;
  sourceType: string;
  sourceId: string;
  evidenceRole?: string;
}

export function addRunbookEvidence(db: GraphDb, input: AddRunbookEvidenceInput): number {
  const result = db.prepare(`
    INSERT INTO runbook_evidence (runbook_id, attempt_id, source_type, source_id, evidence_role)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.runbookId, input.attemptId ?? null,
    input.sourceType, input.sourceId,
    input.evidenceRole ?? "success",
  );

  const evidenceId = Number(result.lastInsertRowid);

  const parentRow = db.prepare(
    "SELECT scope_id FROM runbooks WHERE id = ?",
  ).get(input.runbookId) as { scope_id: number } | undefined;

  logEvidence(db, {
    scopeId: parentRow?.scope_id,
    objectType: "runbook_evidence",
    objectId: evidenceId,
    eventType: "create",
    payload: { runbookId: input.runbookId, attemptId: input.attemptId },
  });

  return evidenceId;
}

export interface RunbookWithEvidence extends RunbookRow {
  evidence: Array<{
    id: number;
    attempt_id: number | null;
    source_type: string;
    source_id: string;
    evidence_role: string;
    recorded_at: string;
  }>;
}

export function getRunbookWithEvidence(db: GraphDb, runbookId: number): RunbookWithEvidence | null {
  const runbook = db.prepare("SELECT * FROM runbooks WHERE id = ?").get(runbookId) as RunbookRow | undefined;
  if (!runbook) return null;

  const evidence = db.prepare(`
    SELECT id, attempt_id, source_type, source_id, evidence_role, recorded_at
    FROM runbook_evidence WHERE runbook_id = ? ORDER BY recorded_at DESC
  `).all(runbookId) as RunbookWithEvidence["evidence"];

  return { ...runbook, evidence };
}

/**
 * Infer a runbook from consecutive successful attempts for a tool.
 * If minSuccesses consecutive successes exist, creates/updates a runbook.
 */
export function inferRunbookFromAttempts(
  db: GraphDb,
  scopeId: number,
  toolName: string,
  minSuccesses = 3,
): { runbookId: number; inferred: boolean } | null {
  const successes = db.prepare(`
    SELECT id, input_summary FROM attempts
    WHERE scope_id = ? AND tool_name = ? AND status = 'success'
    ORDER BY created_at DESC LIMIT ?
  `).all(scopeId, toolName, minSuccesses) as Array<{ id: number; input_summary: string | null }>;

  if (successes.length < minSuccesses) return null;

  // Build pattern from common input summaries
  const patterns = successes
    .map((s) => s.input_summary ?? "")
    .filter((p) => p.length > 0);
  const pattern = patterns.length > 0 ? patterns[0] : `${toolName} (auto-inferred)`;
  const runbookKey = `auto:${toolName}:${pattern.slice(0, 50).toLowerCase().replace(/\s+/g, "-")}`;

  const { runbookId, isNew } = upsertRunbook(db, {
    scopeId,
    runbookKey,
    toolName,
    pattern,
    description: `Auto-inferred from ${successes.length} consecutive successes`,
    successCount: successes.length,
    confidence: 0.6,
  });

  // Link attempts as evidence
  for (const s of successes) {
    addRunbookEvidence(db, {
      runbookId,
      attemptId: s.id,
      sourceType: "attempt",
      sourceId: String(s.id),
    });
  }

  return { runbookId, inferred: isNew };
}
