/**
 * Attempt store — tool outcome ledger for tracking success/failure rates.
 *
 * Phase 2: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, RecordAttemptInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";

/** Escape LIKE meta-characters (%, _, \) so the value is treated literally. */
function escapeLikeValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function recordAttempt(db: GraphDb, input: RecordAttemptInput): number {
  const branchId = input.branchId ?? 0;
  const now = new Date().toISOString();
  const compositeId = `attempt:${input.scopeId}:${branchId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const mo: MemoryObject = {
    id: compositeId,
    kind: "attempt",
    content: `${input.toolName}: ${input.status}${input.inputSummary ? ` — ${input.inputSummary}` : ""}`,
    structured: {
      toolName: input.toolName,
      inputSummary: input.inputSummary ?? null,
      outputSummary: input.outputSummary ?? null,
      status: input.status,
      durationMs: input.durationMs ?? null,
      errorText: input.errorText ?? null,
    },
    provenance: {
      source_kind: "tool_result",
      source_id: compositeId,
      actor: "system",
      trust: 1.0,
    },
    confidence: 1.0,
    freshness: 1.0,
    provisional: false,
    status: "active",
    observed_at: now,
    scope_id: input.scopeId,
    influence_weight: "standard",
    created_at: now,
    updated_at: now,
  };

  const result = upsertMemoryObject(db, mo);

  logEvidence(db, {
    scopeId: input.scopeId,
    branchId: branchId || undefined,
    objectType: "attempt",
    objectId: result.moId,
    eventType: "record",
    payload: { toolName: input.toolName, status: input.status, durationMs: input.durationMs },
  });

  return result.moId;
}

export interface AttemptRow {
  id: number;
  scope_id: number;
  tool_name: string;
  input_summary: string | null;
  output_summary: string | null;
  status: string;
  duration_ms: number | null;
  error_text: string | null;
  created_at: string;
}

function moRowToAttemptRow(row: Record<string, unknown>): AttemptRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try { structured = JSON.parse(row.structured_json); } catch { /* empty */ }
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    tool_name: String(structured.toolName ?? ""),
    input_summary: structured.inputSummary != null ? String(structured.inputSummary) : null,
    output_summary: structured.outputSummary != null ? String(structured.outputSummary) : null,
    status: String(structured.status ?? ""),
    duration_ms: structured.durationMs != null ? Number(structured.durationMs) : null,
    error_text: structured.errorText != null ? String(structured.errorText) : null,
    created_at: String(row.created_at ?? ""),
  };
}

export function getAttemptHistory(
  db: GraphDb,
  scopeId: number,
  opts?: { toolName?: string; status?: string; limit?: number },
): AttemptRow[] {
  const limit = opts?.limit ?? 20;
  const where = ["scope_id = ?", "kind = 'attempt'"];
  const args: unknown[] = [scopeId];

  if (opts?.toolName) {
    where.push("structured_json LIKE ? ESCAPE '\\'");
    args.push(`%"toolName":"${escapeLikeValue(opts.toolName)}"%`);
  }
  if (opts?.status) {
    where.push("structured_json LIKE ? ESCAPE '\\'");
    args.push(`%"status":"${escapeLikeValue(opts.status)}"%`);
  }

  args.push(limit);
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(...args) as Record<string, unknown>[]).map(moRowToAttemptRow);
}

export interface ToolSuccessRate {
  toolName: string;
  total: number;
  successes: number;
  failures: number;
  rate: number;
}

export function getToolSuccessRate(
  db: GraphDb,
  scopeId: number,
  toolName: string,
  windowDays?: number,
): ToolSuccessRate {
  const where = ["scope_id = ?", "kind = 'attempt'", "structured_json LIKE ? ESCAPE '\\'"];
  const args: unknown[] = [scopeId, `%"toolName":"${escapeLikeValue(toolName)}"%`];

  if (windowDays != null) {
    where.push("created_at >= datetime('now', ?)");
    args.push(`-${windowDays} days`);
  }

  const rows = db.prepare(`
    SELECT structured_json FROM memory_objects
    WHERE ${where.join(" AND ")}
  `).all(...args) as Array<{ structured_json: string | null }>;

  let total = 0;
  let successes = 0;
  let failures = 0;

  for (const row of rows) {
    let s: Record<string, unknown> = {};
    try { if (row.structured_json) s = JSON.parse(row.structured_json); } catch { continue; }
    total++;
    if (s.status === "success") successes++;
    if (s.status === "failure") failures++;
  }

  return {
    toolName,
    total,
    successes,
    failures,
    rate: total > 0 ? successes / total : 0,
  };
}
