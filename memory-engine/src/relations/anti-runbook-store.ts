/**
 * Anti-runbook store — learned failure patterns to avoid repeating mistakes.
 */

import type { GraphDb, UpsertAntiRunbookInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";

export function upsertAntiRunbook(
  db: GraphDb,
  input: UpsertAntiRunbookInput,
): { antiRunbookId: number; isNew: boolean } {
  const existing = db.prepare(
    "SELECT id FROM anti_runbooks WHERE scope_id = ? AND anti_runbook_key = ?",
  ).get(input.scopeId, input.antiRunbookKey) as { id: number } | undefined;

  db.prepare(`
    INSERT INTO anti_runbooks
      (scope_id, anti_runbook_key, tool_name, failure_pattern, description, failure_count, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, anti_runbook_key) DO UPDATE SET
      failure_count = anti_runbooks.failure_count + COALESCE(excluded.failure_count, 1),
      confidence = MIN(1.0, 0.3 + 0.7 * (1.0 - 1.0 / (1.0 + (anti_runbooks.failure_count + COALESCE(excluded.failure_count, 1)) * 0.5))),
      description = COALESCE(excluded.description, anti_runbooks.description),
      updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
  `).run(
    input.scopeId, input.antiRunbookKey, input.toolName, input.failurePattern,
    input.description ?? null,
    input.failureCount ?? 1, input.confidence ?? 0.5,
  );

  const row = db.prepare(
    "SELECT id FROM anti_runbooks WHERE scope_id = ? AND anti_runbook_key = ?",
  ).get(input.scopeId, input.antiRunbookKey) as { id: number };

  const isNew = !existing;

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "anti_runbook",
    objectId: row.id,
    eventType: isNew ? "create" : "update",
  });

  return { antiRunbookId: row.id, isNew };
}

export interface AntiRunbookRow {
  id: number;
  scope_id: number;
  anti_runbook_key: string;
  tool_name: string;
  failure_pattern: string;
  description: string | null;
  failure_count: number;
  confidence: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export function getAntiRunbooks(
  db: GraphDb,
  scopeId: number,
  opts?: { toolName?: string; status?: string; limit?: number },
): AntiRunbookRow[] {
  const limit = opts?.limit ?? 20;
  const where = ["scope_id = ?"];
  const args: unknown[] = [scopeId];

  if (opts?.toolName) {
    where.push("tool_name = ?");
    args.push(opts.toolName);
  }
  where.push("status = ?");
  args.push(opts?.status ?? "active");

  args.push(limit);
  return db.prepare(`
    SELECT * FROM anti_runbooks
    WHERE ${where.join(" AND ")}
    ORDER BY confidence DESC, failure_count DESC LIMIT ?
  `).all(...args) as AntiRunbookRow[];
}

export function getAntiRunbooksForTool(db: GraphDb, scopeId: number, toolName: string): AntiRunbookRow[] {
  return getAntiRunbooks(db, scopeId, { toolName });
}

export function addAntiRunbookEvidence(
  db: GraphDb,
  antiRunbookId: number,
  input: { attemptId?: number; sourceType: string; sourceId: string; evidenceRole?: string },
): number {
  const result = db.prepare(`
    INSERT INTO anti_runbook_evidence
      (anti_runbook_id, attempt_id, source_type, source_id, evidence_role)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    antiRunbookId, input.attemptId ?? null,
    input.sourceType, input.sourceId,
    input.evidenceRole ?? "failure",
  );

  const parentRow = db.prepare(
    "SELECT scope_id FROM anti_runbooks WHERE id = ?",
  ).get(antiRunbookId) as { scope_id: number } | undefined;

  logEvidence(db, {
    scopeId: parentRow?.scope_id,
    objectType: "anti_runbook_evidence",
    objectId: Number(result.lastInsertRowid),
    eventType: "create",
    payload: { antiRunbookId },
  });

  // RSMA: also write to provenance_links
  try {
    db.prepare(`
      INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      `procedure:${antiRunbookId}`,
      "supports",
      input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`,
      1.0,
      input.evidenceRole ?? "failure",
      parentRow?.scope_id ?? 1,
      JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId, attempt_id: input.attemptId }),
    );
  } catch { /* non-fatal */ }

  return Number(result.lastInsertRowid);
}

export interface AntiRunbookEvidenceRow {
  id: number;
  anti_runbook_id: number;
  attempt_id: number | null;
  source_type: string;
  source_id: string;
  evidence_role: string;
  recorded_at: string;
}

export function getAntiRunbookEvidence(
  db: GraphDb,
  antiRunbookId: number,
): AntiRunbookEvidenceRow[] {
  // Read from provenance_links, fallback to legacy
  try {
    const rows = db.prepare(`
      SELECT id, object_id, detail, metadata, created_at
      FROM provenance_links WHERE subject_id = ? AND predicate = 'supports'
      ORDER BY created_at DESC
    `).all(`procedure:${antiRunbookId}`) as Array<Record<string, unknown>>;

    if (rows.length > 0) {
      return rows.map((r) => {
        const meta = r.metadata ? JSON.parse(String(r.metadata)) : {};
        return {
          id: Number(r.id),
          anti_runbook_id: antiRunbookId,
          attempt_id: meta.attempt_id ?? null,
          source_type: meta.source_type ?? "",
          source_id: meta.source_id ?? "",
          evidence_role: String(r.detail ?? "failure"),
          recorded_at: String(r.created_at),
        };
      });
    }
  } catch { /* fall through */ }

  return db.prepare(
    "SELECT * FROM anti_runbook_evidence WHERE anti_runbook_id = ? ORDER BY recorded_at DESC",
  ).all(antiRunbookId) as AntiRunbookEvidenceRow[];
}
