/**
 * Decision store — CRUD for decisions with automatic supersession.
 *
 * Phase 2: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type { GraphDb, UpsertDecisionInput, UpsertDecisionResult } from "./types.js";
import { logEvidence } from "./evidence-log.js";
import { upsertMemoryObject, supersedeMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject, MemoryStatus } from "../ontology/types.js";

// ---------------------------------------------------------------------------
// Upsert (auto-supersede existing active decision on same topic)
// ---------------------------------------------------------------------------

export function upsertDecision(db: GraphDb, input: UpsertDecisionInput): UpsertDecisionResult {
  const branchId = input.branchId ?? 0;
  const topic = input.topic.toLowerCase().trim().replace(/\s+/g, " ");
  const canonicalKey = `decision::${topic}`;

  // Check for existing active decision on same topic
  const existing = db.prepare(`
    SELECT id, composite_id FROM memory_objects
    WHERE scope_id = ? AND branch_id = ? AND canonical_key = ? AND kind = 'decision' AND status = 'active'
    ORDER BY updated_at DESC LIMIT 1
  `).get(input.scopeId, branchId, canonicalKey) as { id: number; composite_id: string } | undefined;

  // Build a unique composite_id for the new decision
  const now = new Date().toISOString();
  const compositeId = `decision:${input.scopeId}:${branchId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}:${canonicalKey}`;

  const mo: MemoryObject = {
    id: compositeId,
    kind: "decision",
    content: input.decisionText,
    structured: {
      topic,
      decisionText: input.decisionText,
    },
    canonical_key: canonicalKey,
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
    observed_at: now,
    scope_id: input.scopeId,
    influence_weight: "standard",
    created_at: now,
    updated_at: now,
  };

  const result = upsertMemoryObject(db, mo, { skipCanonicalDedup: true });

  // Auto-supersede the old decision if one existed
  if (existing) {
    supersedeMemoryObject(db, existing.composite_id, compositeId);
  }

  logEvidence(db, {
    scopeId: input.scopeId,
    branchId: branchId || undefined,
    objectType: "decision",
    objectId: result.moId,
    eventType: "create",
    payload: { topic, supersedes: existing?.id },
  });

  return { decisionId: result.moId, isNew: !existing };
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

export function supersedeDecision(db: GraphDb, decisionId: number, supersededBy: number): void {
  const oldRow = db.prepare("SELECT composite_id, scope_id, branch_id FROM memory_objects WHERE id = ?").get(decisionId) as { composite_id: string; scope_id: number; branch_id: number | null } | undefined;
  const newRow = db.prepare("SELECT composite_id FROM memory_objects WHERE id = ?").get(supersededBy) as { composite_id: string } | undefined;

  if (oldRow && newRow) {
    supersedeMemoryObject(db, oldRow.composite_id, newRow.composite_id);
  }

  logEvidence(db, {
    scopeId: oldRow?.scope_id,
    branchId: oldRow?.branch_id ?? undefined,
    objectType: "decision",
    objectId: decisionId,
    eventType: "supersede",
    payload: { supersededBy },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface DecisionRow {
  id: number;
  scope_id: number;
  branch_id: number;
  topic: string;
  decision_text: string;
  status: string;
  decided_at: string;
  superseded_by: number | null;
  source_type: string | null;
  source_id: string | null;
  source_detail: string | null;
}

export function moRowToDecisionRow(row: Record<string, unknown>): DecisionRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    try { structured = JSON.parse(row.structured_json); } catch { /* empty */ }
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    branch_id: Number(row.branch_id ?? 0),
    topic: String(structured.topic ?? ""),
    decision_text: String(structured.decisionText ?? row.content ?? ""),
    status: String(row.status ?? "active"),
    decided_at: String(row.created_at ?? ""),
    superseded_by: row.superseded_by != null ? Number(row.superseded_by) : null,
    source_type: row.source_kind != null ? String(row.source_kind) : null,
    source_id: row.source_id != null ? String(row.source_id) : null,
    source_detail: row.source_detail != null ? String(row.source_detail) : null,
  };
}

export function getActiveDecisions(
  db: GraphDb,
  scopeId: number,
  branchId?: number,
  limit = 50,
): DecisionRow[] {
  if (branchId != null) {
    return (db.prepare(`
      SELECT * FROM memory_objects
      WHERE scope_id = ? AND (branch_id = 0 OR branch_id = ?) AND kind = 'decision' AND status = 'active'
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(scopeId, branchId, limit) as Record<string, unknown>[]).map(moRowToDecisionRow);
  }
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND branch_id = 0 AND kind = 'decision' AND status = 'active'
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(scopeId, limit) as Record<string, unknown>[]).map(moRowToDecisionRow);
}

export function getDecisionHistory(
  db: GraphDb,
  scopeId: number,
  topic: string,
  limit = 20,
): DecisionRow[] {
  const normalizedTopic = topic.toLowerCase().trim().replace(/\s+/g, " ");
  const canonicalKey = `decision::${normalizedTopic}`;
  // First try exact canonical_key match (preferred)
  const byCanonical = (db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND kind = 'decision' AND canonical_key = ?
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(scopeId, canonicalKey, limit) as Record<string, unknown>[]).map(moRowToDecisionRow);
  if (byCanonical.length > 0) return byCanonical;

  // Fallback: canonical_key LIKE, content LIKE, or structured_json LIKE
  const topicPattern = `%${normalizedTopic}%`;
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND kind = 'decision'
      AND (canonical_key LIKE ? OR content LIKE ? OR structured_json LIKE ?)
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(scopeId, `decision::%${normalizedTopic}%`, topicPattern, topicPattern, limit) as Record<string, unknown>[]).map(moRowToDecisionRow);
}
