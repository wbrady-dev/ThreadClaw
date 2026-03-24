/**
 * Runbook store — learned success patterns from tool outcomes.
 *
 * Phase 2: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 * Runbooks are kind='procedure' with isNegative=false in structured_json.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, UpsertRunbookInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";

/** Escape LIKE meta-characters (%, _, \) so the value is treated literally. */
function escapeLikeValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function upsertRunbook(
  db: GraphDb,
  input: UpsertRunbookInput,
): { runbookId: number; isNew: boolean } {
  const compositeId = `procedure:${input.scopeId}:${input.runbookKey}`;

  const mo: MemoryObject = {
    id: compositeId,
    kind: "procedure",
    content: input.description ?? `${input.toolName}: ${input.pattern}`,
    structured: {
      isNegative: false,
      toolName: input.toolName,
      key: input.runbookKey,
      pattern: input.pattern,
      description: input.description ?? null,
      successCount: input.successCount ?? 0,
      failureCount: input.failureCount ?? 0,
    },
    canonical_key: `proc::${input.toolName.toLowerCase().trim()}::${input.runbookKey.toLowerCase().trim()}`,
    provenance: {
      source_kind: "inference",
      source_id: compositeId,
      actor: "system",
      trust: 0.5,
    },
    confidence: input.confidence ?? 0.5,
    freshness: 1.0,
    provisional: false,
    status: "active",
    observed_at: new Date().toISOString(),
    scope_id: input.scopeId,
    influence_weight: "standard",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = upsertMemoryObject(db, mo);

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "runbook",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
  });

  return { runbookId: result.moId, isNew: result.isNew };
}

export function demoteRunbook(db: GraphDb, runbookId: number): void {
  const row = db.prepare(
    "SELECT composite_id, scope_id, confidence FROM memory_objects WHERE id = ? AND kind = 'procedure'",
  ).get(runbookId) as { composite_id: string; scope_id: number; confidence: number } | undefined;

  if (row) {
    const newConf = row.confidence * 0.5;
    const newStatus = newConf < 0.2 ? "needs_confirmation" : "active";
    db.prepare(`
      UPDATE memory_objects SET
        confidence = ?,
        status = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
      WHERE id = ?
    `).run(newConf, newStatus, runbookId);
  }

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

function moRowToRunbookRow(row: Record<string, unknown>): RunbookRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try { structured = JSON.parse(row.structured_json); } catch { /* empty */ }
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    runbook_key: String(structured.key ?? ""),
    tool_name: String(structured.toolName ?? ""),
    pattern: String(structured.pattern ?? ""),
    description: structured.description != null ? String(structured.description) : null,
    success_count: Number(structured.successCount ?? 0),
    failure_count: Number(structured.failureCount ?? 0),
    confidence: Number(row.confidence ?? 0.5),
    status: String(row.status ?? "active"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function getRunbooks(
  db: GraphDb,
  scopeId: number,
  opts?: { toolName?: string; status?: string; limit?: number },
): RunbookRow[] {
  const limit = opts?.limit ?? 20;
  const where = ["scope_id = ?", "kind = 'procedure'"];
  const args: unknown[] = [scopeId];

  if (opts?.toolName) {
    where.push("structured_json LIKE ? ESCAPE '\\'");
    args.push(`%"toolName":"${escapeLikeValue(opts.toolName)}"%`);
  }

  // isNegative=false for runbooks
  where.push("structured_json LIKE '%\"isNegative\":false%'");

  // Map status: active → active, under_review → needs_confirmation
  const status = opts?.status ?? "active";
  if (status === "under_review") {
    where.push("status = 'needs_confirmation'");
  } else {
    where.push("status = ?");
    args.push(status);
  }

  args.push(limit);
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE ${where.join(" AND ")}
    ORDER BY confidence DESC, updated_at DESC LIMIT ?
  `).all(...args) as Record<string, unknown>[]).map(moRowToRunbookRow);
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
  // Write ONLY to provenance_links
  const result = db.prepare(`
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `procedure:${input.runbookId}`,
    "supports",
    input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`,
    1.0,
    input.evidenceRole ?? "success",
    1,
    JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId, attempt_id: input.attemptId }),
  );

  const evidenceRow = db.prepare(
    "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = 'supports' AND object_id = ?",
  ).get(
    `procedure:${input.runbookId}`,
    input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`,
  ) as { id: number } | undefined;
  const evidenceId = evidenceRow?.id ?? 0;

  const parentRow = db.prepare(
    "SELECT scope_id FROM memory_objects WHERE id = ?",
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
  const row = db.prepare("SELECT * FROM memory_objects WHERE id = ? AND kind = 'procedure'").get(runbookId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const runbook = moRowToRunbookRow(row);

  // Read from provenance_links
  let evidence: RunbookWithEvidence["evidence"] = [];
  try {
    const rows = db.prepare(`
      SELECT id, object_id, detail, metadata, created_at
      FROM provenance_links WHERE subject_id = ? AND predicate = 'supports'
      ORDER BY created_at DESC
    `).all(`procedure:${runbookId}`) as Array<Record<string, unknown>>;

    evidence = rows.map((r) => {
      let meta: Record<string, unknown> = {};
      try { if (r.metadata) meta = JSON.parse(String(r.metadata)); } catch { /* malformed */ }
      const rawAttemptId = meta.attempt_id ?? (String(r.object_id).startsWith("attempt:") ? Number(String(r.object_id).split(":")[1]) : null);
      const attemptId = typeof rawAttemptId === "number" && Number.isFinite(rawAttemptId) ? rawAttemptId : null;
      return {
        id: Number(r.id),
        attempt_id: attemptId,
        source_type: String(meta.source_type ?? ""),
        source_id: String(meta.source_id ?? ""),
        evidence_role: String(r.detail ?? "success"),
        recorded_at: String(r.created_at),
      };
    });
  } catch { /* empty evidence */ }

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
  // Query attempts from memory_objects
  const successes = db.prepare(`
    SELECT id, structured_json FROM memory_objects
    WHERE scope_id = ? AND kind = 'attempt' AND status = 'active'
      AND structured_json LIKE ? ESCAPE '\\'
      AND structured_json LIKE '%"status":"success"%'
    ORDER BY created_at DESC LIMIT ?
  `).all(scopeId, `%"toolName":"${escapeLikeValue(toolName)}"%`, minSuccesses) as Array<{ id: number; structured_json: string | null }>;

  if (successes.length < minSuccesses) return null;

  // Build pattern from common input summaries
  const patterns = successes
    .map((s) => {
      try {
        const parsed = s.structured_json ? JSON.parse(s.structured_json) : {};
        return String(parsed.inputSummary ?? "");
      } catch { return ""; }
    })
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
