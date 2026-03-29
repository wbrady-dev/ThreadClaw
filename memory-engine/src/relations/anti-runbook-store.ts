/**
 * Anti-runbook store — learned failure patterns to avoid repeating mistakes.
 *
 * Phase 3: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 * Anti-runbooks are kind='procedure' with isNegative=true in structured_json.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, UpsertAntiRunbookInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";
import { safeParseStructured, safeParseMetadata, escapeLikeValue } from "../ontology/json-utils.js";

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
    const parsed = safeParseStructured(existingRow.structured_json);
    existingFailureCount = Number(parsed.failureCount ?? 0);
    existingConfidence = existingRow.confidence;
  }

  const newFailureCount = (input.failureCount ?? 1);
  const totalFailureCount = existingRow ? existingFailureCount + newFailureCount : newFailureCount;

  // Confidence formula: base 0.3 + logistic growth toward 1.0 as failures accumulate.
  // Uses totalFailureCount alone (not coupled with existingConfidence) so confidence
  // increases monotonically with failure count regardless of prior value.
  // Half-life = 3: at 3 failures confidence = 0.65, at 10 = 0.84, at 30 = 0.93.
  const confidence = existingRow
    ? Math.min(1.0, 0.3 + 0.7 * (totalFailureCount / (totalFailureCount + 3)))
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

export function moRowToAntiRunbookRow(row: Record<string, unknown>): AntiRunbookRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    structured = safeParseStructured(row.structured_json);
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
  // Look up composite_id from memory_objects for consistent provenance subject_id
  const moRow = db.prepare(
    "SELECT composite_id FROM memory_objects WHERE id = ?",
  ).get(antiRunbookId) as { composite_id: string } | undefined;
  const subjectId = moRow?.composite_id ?? `antirunbook:${antiRunbookId}`;
  const objectId = input.attemptId ? `attempt:${input.attemptId}` : `${input.sourceType}:${input.sourceId}`;

  // Write ONLY to provenance_links
  db.prepare(`
    INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    subjectId,
    "supports",
    objectId,
    1.0,
    input.evidenceRole ?? "failure",
    1,
    JSON.stringify({ source_type: input.sourceType, source_id: input.sourceId, attempt_id: input.attemptId }),
  );

  const evidenceRow = db.prepare(
    "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = 'supports' AND object_id = ?",
  ).get(subjectId, objectId) as { id: number } | undefined;
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
    // Look up composite_id for consistent provenance subject_id
    const moRow = db.prepare(
      "SELECT composite_id FROM memory_objects WHERE id = ?",
    ).get(antiRunbookId) as { composite_id: string } | undefined;
    const subjectId = moRow?.composite_id ?? `antirunbook:${antiRunbookId}`;

    const rows = db.prepare(`
      SELECT id, object_id, detail, metadata, created_at
      FROM provenance_links WHERE subject_id = ? AND predicate = 'supports'
      ORDER BY created_at DESC
    `).all(subjectId) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      let meta: Record<string, unknown> = {};
      meta = safeParseMetadata(r.metadata);
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

/**
 * Infer an anti-runbook from consecutive failed attempts for a tool.
 * If minFailures consecutive failures exist (most recent N attempts are all failures),
 * creates/updates an anti-runbook with the failure pattern.
 */
export function inferAntiRunbookFromAttempts(
  db: GraphDb,
  scopeId: number,
  toolName: string,
  opts?: { minFailures?: number },
): { antiRunbookId: number; inferred: boolean } | null {
  const minFailures = opts?.minFailures ?? 3;

  // Query the N most recent attempts (any status) to check for consecutive failures
  const recentAttempts = db.prepare(`
    SELECT id, composite_id, structured_json FROM memory_objects
    WHERE scope_id = ? AND kind = 'attempt' AND status = 'active'
      AND structured_json LIKE ? ESCAPE '\\'
    ORDER BY created_at DESC LIMIT ?
  `).all(scopeId, `%"toolName":"${escapeLikeValue(toolName)}"%`, minFailures) as Array<{
    id: number;
    composite_id: string;
    structured_json: string | null;
  }>;

  if (recentAttempts.length < minFailures) return null;

  // All N most recent must be failures (consecutive check)
  const allFailures = recentAttempts.every((a) => {
    const parsed = safeParseStructured(a.structured_json);
    return parsed.status === "failure";
  });
  if (!allFailures) return null;

  // Build failure pattern from error texts
  const errorTexts = recentAttempts
    .map((a) => {
      const parsed = safeParseStructured(a.structured_json);
      return String(parsed.errorText ?? parsed.outputSummary ?? "");
    })
    .filter((t) => t.length > 0);
  const failurePattern = errorTexts.length > 0 ? errorTexts[0] : `${toolName} repeated failure`;
  const antiRunbookKey = `auto:${toolName}:${failurePattern.slice(0, 50).toLowerCase().replace(/\s+/g, "-")}`;

  const { antiRunbookId, isNew } = upsertAntiRunbook(db, {
    scopeId,
    antiRunbookKey,
    toolName,
    failurePattern,
    description: `Auto-inferred from ${recentAttempts.length} consecutive failures`,
    failureCount: recentAttempts.length,
    confidence: 0.6,
  });

  // Link attempts as evidence
  for (const a of recentAttempts) {
    addAntiRunbookEvidence(db, antiRunbookId, {
      attemptId: a.id,
      sourceType: "attempt",
      sourceId: a.composite_id ?? String(a.id),
      evidenceRole: "failure",
    });
  }

  return { antiRunbookId, inferred: isNew };
}
