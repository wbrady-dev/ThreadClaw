/**
 * Invariant store — durable constraints and contract memory.
 *
 * Phase 2: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, UpsertInvariantInput } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject, MemoryStatus } from "../ontology/types.js";

export function upsertInvariant(
  db: GraphDb,
  input: UpsertInvariantInput,
): { invariantId: number; isNew: boolean } {
  const compositeId = `invariant:${input.scopeId}:${input.invariantKey}`;

  // Validate severity and enforcement to known values — LLM may return unexpected strings
  const validSeverities = new Set(["critical", "error", "warning", "info"]);
  const severity = validSeverities.has(input.severity ?? "") ? input.severity! : "warning";
  const validEnforcement = new Set(["strict", "advisory"]);
  const enforcementMode = validEnforcement.has(input.enforcementMode ?? "") ? input.enforcementMode! : "advisory";

  const mo: MemoryObject = {
    id: compositeId,
    kind: "invariant",
    content: input.description,
    structured: {
      key: input.invariantKey,
      category: input.category ?? null,
      description: input.description,
      severity,
      enforcementMode,
    },
    canonical_key: `inv::${input.invariantKey.toLowerCase().trim()}`,
    provenance: {
      source_kind: "extraction",
      source_id: input.sourceId ?? "",
      source_detail: input.sourceDetail ?? undefined,
      actor: "system",
      trust: 0.5,
    },
    confidence: 0.5,
    freshness: 1.0,
    provisional: false,
    status: (input.status ?? "active") as MemoryStatus,
    observed_at: new Date().toISOString(),
    scope_id: input.scopeId,
    influence_weight: "standard",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const result = upsertMemoryObject(db, mo);

  logEvidence(db, {
    scopeId: input.scopeId,
    objectType: "invariant",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
  });

  return { invariantId: result.moId, isNew: result.isNew };
}

export interface InvariantRow {
  id: number;
  scope_id: number;
  invariant_key: string;
  category: string | null;
  description: string;
  severity: string;
  enforcement_mode: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export function moRowToInvariantRow(row: Record<string, unknown>): InvariantRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try { structured = JSON.parse(row.structured_json); } catch { /* empty */ }
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    invariant_key: String(structured.key ?? ""),
    category: structured.category != null ? String(structured.category) : null,
    description: String(structured.description ?? row.content ?? ""),
    severity: String(structured.severity ?? "warning"),
    enforcement_mode: String(structured.enforcementMode ?? "advisory"),
    status: String(row.status ?? "active"),
    created_at: String(row.created_at ?? ""),
    updated_at: String(row.updated_at ?? ""),
  };
}

export function getActiveInvariants(
  db: GraphDb,
  scopeId: number,
  limit = 50,
): InvariantRow[] {
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND kind = 'invariant' AND status = 'active'
    ORDER BY CASE json_extract(structured_json, '$.severity')
      WHEN 'critical' THEN 0 WHEN 'error' THEN 1 WHEN 'warning' THEN 2 WHEN 'info' THEN 3 ELSE 4
    END ASC, updated_at DESC
    LIMIT ?
  `).all(scopeId, limit) as Record<string, unknown>[]).map(moRowToInvariantRow);
}
