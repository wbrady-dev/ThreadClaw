/**
 * Anti-runbook store — learned failure patterns to avoid repeating mistakes.
 *
 * Phase 2: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 * Anti-runbooks are kind='procedure' with isNegative=true in structured_json.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, UpsertAntiRunbookInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";

/** Escape LIKE meta-characters (%, _, \) so the value is treated literally. */
function escapeLikeValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function upsertAntiRunbook(
  db: GraphDb,
  input: UpsertAntiRunbookInput,
): { antiRunbookId: number; isNew: boolean } {
  const compositeId = `antirunbook:${input.scopeId}:${input.antiRunbookKey}`;

  // Check for existing to accumulate failure_count
  let existingFailureCount = 0;
  let existingConfidence = 0.5;
  const existingRow = db.prepare(
    "SELECT structured_json, confidence FROM memory_objects WHERE composite_id = ?",
  ).get(compositeId) as { structured_json: string | null; confidence: number } | undefined;
  if (existingRow) {
    try {
      const parsed = existingRow.structured_json ? JSON.parse(existingRow.structured_json) : {};
      existingFailureCount = Number(parsed.failureCount ?? 0);
      existingConfidence = existingRow.confidence;
    } catch { /* empty */ }
  }

  const newFailureCount = (input.failureCount ?? 1);
  const totalFailureCount = existingRow ? existingFailureCount + newFailureCount : newFailureCount;

  // Logistic confidence increment: 0.3 + 0.7*(1 - 1/(1 + totalFailureCount * existingConfidence))
  const confidence = existingRow
    ? Math.min(1.0, 0.3 + 0.7 * (1 - 1 / (1 + totalFailureCount * existingConfidence)))
    : (input.confidence ?? 0.5);

  const mo: MemoryObject = {
    id: compositeId,
    kind: "procedure",
    content: input.description ?? `${input.toolName}: ${input.failurePattern}`,
    structured: {
      isNegative: true,
      toolName: input.toolName,
      key: input.antiRunbookKey,
      failurePattern: input.failurePattern,
      description: input.description ?? null,
      failureCount: totalFailureCount,
    },
    canonical_key: `proc::${input.toolName.toLowerCase().trim()}::${input.antiRunbookKey.toLowerCase().trim()}`,
    provenance: {
      source_kind: "inference",
      source_id: compositeId,
      actor: "system",
      trust: 0.5,
    },
    confidence,
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
    objectType: "anti_runbook",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
  });

  return { antiRunbookId: result.moId, isNew: result.isNew };
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

function moRowToAntiRunbookRow(row: Record<string, unknown>): AntiRunbookRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try { structured = JSON.parse(row.structured_json); } catch { /* empty */ }
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    anti_runbook_key: String(structured.key ?? ""),
    tool_name: String(structured.toolName ?? ""),
    failure_pattern: String(structured.failurePattern ?? ""),
    description: structured.description != null ? String(structured.description) : null,
    failure_count: Number(structured.failureCount ?? 0),
    confidence: Number(row.confidence ?? 0.5),
    status: String(row.status ?? "active"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function getAntiRunbooks(
  db: GraphDb,
  scopeId: number,
  opts?: { toolName?: string; status?: string; limit?: number },
): AntiRunbookRow[] {
  const limit = opts?.limit ?? 20;
  const where = ["scope_id = ?", "kind = 'procedure'"];
  const args: unknown[] = [scopeId];

  if (opts?.toolName) {
    where.push("structured_json LIKE ? ESCAPE '\\'");
    args.push(`%"toolName":"${escapeLikeValue(opts.toolName)}"%`);
  }

  // isNegative=true for anti-runbooks
  where.push("structured_json LIKE '%\"isNegative\":true%'");

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
  `).all(...args) as Record<string, unknown>[]).map(moRowToAntiRunbookRow);
}

export function getAntiRunbooksForTool(db: GraphDb, scopeId: number, toolName: string): AntiRunbookRow[] {
  return getAntiRunbooks(db, scopeId, { toolName });
}

export function addAntiRunbookEvidence(
  db: GraphDb,
  antiRunbookId: number,
  input: { attemptId?: number; sourceType: string; sourceId: string; evidenceRole?: string },
): number {
  // Write ONLY to provenance_links
  db.prepare(`
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    `antirunbook:${antiRunbookId}`,
    "supports",
    input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`,
    1.0,
    input.evidenceRole ?? "failure",
    1,
    JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId, attempt_id: input.attemptId }),
  );

  const evidenceRow = db.prepare(
    "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = 'supports' AND object_id = ?",
  ).get(
    `antirunbook:${antiRunbookId}`,
    input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`,
  ) as { id: number } | undefined;
  const evidenceId = evidenceRow?.id ?? 0;

  const parentRow = db.prepare(
    "SELECT scope_id FROM memory_objects WHERE id = ?",
  ).get(antiRunbookId) as { scope_id: number } | undefined;

  logEvidence(db, {
    scopeId: parentRow?.scope_id,
    objectType: "anti_runbook_evidence",
    objectId: evidenceId,
    eventType: "create",
    payload: { antiRunbookId },
  });

  return evidenceId;
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
  try {
    const rows = db.prepare(`
      SELECT id, object_id, detail, metadata, created_at
      FROM provenance_links WHERE subject_id = ? AND predicate = 'supports'
      ORDER BY created_at DESC
    `).all(`antirunbook:${antiRunbookId}`) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      let meta: Record<string, unknown> = {};
      try { if (r.metadata) meta = JSON.parse(String(r.metadata)); } catch { /* malformed */ }
      const rawAttemptId = meta.attempt_id;
      return {
        id: Number(r.id),
        anti_runbook_id: antiRunbookId,
        attempt_id: typeof rawAttemptId === "number" && Number.isFinite(rawAttemptId) ? rawAttemptId : null,
        source_type: String(meta.source_type ?? ""),
        source_id: String(meta.source_id ?? ""),
        evidence_role: String(r.detail ?? "failure"),
        recorded_at: String(r.created_at),
      };
    });
  } catch { /* empty */ }

  return [];
}
