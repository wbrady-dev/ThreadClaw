/**
 * Claim store — CRUD for structured claims with evidence tracking.
 *
 * Phase 3: All writes delegate to mo-store.ts (memory_objects table).
 * Reads query memory_objects directly. Legacy table writes removed.
 *
 * Function signatures are UNCHANGED — callers don't need to change.
 */

import type {
  GraphDb,
  UpsertClaimInput,
  UpsertClaimResult,
  AddClaimEvidenceInput,
  ClaimExtractionResult,
} from "./types.js";
import { logEvidence, withWriteTransaction } from "./evidence-log.js";
import { buildCanonicalKey as ontologyCanonicalKey, normalize } from "../ontology/canonical.js";
import { upsertMemoryObject, supersedeMemoryObject } from "../ontology/mo-store.js";
import type { MemoryObject } from "../ontology/types.js";
import { safeParseStructured, safeParseMetadata } from "../ontology/json-utils.js";
import { recordStateDelta } from "./delta-store.js";

// ---------------------------------------------------------------------------
// Canonical key — delegates to the RSMA ontology canonical.ts for ONE key system
// ---------------------------------------------------------------------------

/**
 * Build a canonical dedup key for a claim.
 * Delegates to the RSMA ontology so all key formats are consistent.
 * When topic is provided, it takes precedence over predicate (matching LLM behavior).
 * Output: "claim::subject::topic" or "claim::subject::predicate"
 */
export function buildCanonicalKey(subject: string, predicate: string, topic?: string): string {
  const key = ontologyCanonicalKey("claim", "", { subject, predicate, topic });
  // Fallback: if ontology returns undefined (both empty), use normalized direct format
  return key ?? `claim::${normalize(subject)}::${normalize(topic || predicate)}`;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export function upsertClaim(db: GraphDb, input: UpsertClaimInput): UpsertClaimResult {
  const branchId = input.branchId ?? 0;
  const confidence = input.confidence ?? 0.5;
  const trustScore = input.trustScore ?? 0.5;

  const compositeId = `claim:${input.scopeId}:${branchId}:${input.canonicalKey}`;

  const mo: MemoryObject = {
    id: compositeId,
    kind: "claim",
    content: `${input.subject} ${input.predicate} ${input.objectText ?? ""}`.trim(),
    structured: {
      subject: input.subject,
      predicate: input.predicate,
      objectText: input.objectText ?? null,
      objectJson: input.objectJson ?? null,
      valueType: input.valueType ?? "text",
    },
    canonical_key: input.canonicalKey,
    provenance: {
      source_kind: "extraction",
      source_id: compositeId,
      actor: "system",
      trust: trustScore,
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
    branchId: branchId || undefined,
    objectType: "claim",
    objectId: result.moId,
    eventType: result.isNew ? "create" : "update",
    actor: input.actor ?? "system",
    runId: input.runId,
    idempotencyKey: result.isNew ? `claim:create:${input.scopeId}:${branchId}:${input.canonicalKey}` : undefined,
  });

  // Link claim to matching entity via provenance_link predicate='about'
  try {
    const subjectNorm = normalize(input.subject);
    if (subjectNorm) {
      const matchingEntities = db.prepare(
        `SELECT composite_id FROM memory_objects
         WHERE kind = 'entity' AND status = 'active'
           AND json_extract(structured_json, '$.name') = ?
         LIMIT 3`,
      ).all(subjectNorm) as Array<{ composite_id: string }>;
      for (const ent of matchingEntities) {
        db.prepare(`
          INSERT OR IGNORE INTO provenance_links (subject_id, predicate, object_id, confidence, scope_id)
          VALUES (?, 'about', ?, ?, ?)
        `).run(compositeId, ent.composite_id, confidence, input.scopeId);
      }
    }
  } catch (err) { console.warn("[rsma] entity linking failed for claim:", err); }

  return { claimId: result.moId, isNew: result.isNew };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function addClaimEvidence(db: GraphDb, input: AddClaimEvidenceInput, opts?: { skipPropagation?: boolean }): number {
  const doWork = (): number => {
    // Look up the claim's scope_id and composite_id for consistent provenance format
    const claimRow = db.prepare(
      "SELECT scope_id, composite_id FROM memory_objects WHERE id = ?",
    ).get(input.claimId) as { scope_id: number; composite_id: string } | undefined;
    const scopeId = claimRow?.scope_id ?? 1;
    const subjectId = claimRow?.composite_id ?? `claim:${input.claimId}`;

    // Write ONLY to provenance_links (unified relationship table)
    db.prepare(`
      INSERT INTO provenance_links (subject_id, predicate, object_id, confidence, detail, scope_id, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_id, predicate, object_id) DO UPDATE SET
        confidence = MAX(provenance_links.confidence, excluded.confidence),
        detail = COALESCE(excluded.detail, provenance_links.detail)
    `).run(
      subjectId,
      input.evidenceRole === "contradict" ? "contradicts" : "supports",
      `${input.sourceType}:${input.sourceId}`,
      Math.min(1.0, Math.max(0.0, input.confidenceDelta ?? 0.1)),
      input.sourceDetail ?? null,
      scopeId,
      JSON.stringify({ evidence_role: input.evidenceRole, snippet_hash: input.snippetHash, confidence_delta: input.confidenceDelta }),
    );

    // Get the actual row ID
    const evidenceRow = db.prepare(
      "SELECT id FROM provenance_links WHERE subject_id = ? AND predicate = ? AND object_id = ?",
    ).get(
      subjectId,
      input.evidenceRole === "contradict" ? "contradicts" : "supports",
      `${input.sourceType}:${input.sourceId}`,
    ) as { id: number };
    const evidenceId = evidenceRow.id;

    logEvidence(db, {
      scopeId,
      objectType: "claim_evidence",
      objectId: evidenceId,
      eventType: "create",
      payload: { claimId: input.claimId, role: input.evidenceRole },
    });

    // Propagate evidence to claim confidence (skip when caller handles batch propagation)
    if (!opts?.skipPropagation) {
      const weight = Math.min(1.0, Math.max(0.0, input.confidenceDelta ?? 0.1));
      try {
        if (input.evidenceRole === "contradict") {
          // Reduce confidence — floor at 0.05 to prevent total erasure
          db.prepare(
            `UPDATE memory_objects SET
               confidence = MAX(0.05, confidence * (1.0 - ?)),
               updated_at = strftime('%Y-%m-%dT%H:%M:%f','now')
             WHERE id = ?`,
          ).run(weight, input.claimId);
        } else if (input.evidenceRole === "support") {
          // Boost with diminishing returns — harder to push past 0.9
          db.prepare(
            `UPDATE memory_objects SET
               confidence = MIN(1.0, confidence + ? * (1.0 - confidence) * 0.7),
               updated_at = strftime('%Y-%m-%dT%H:%M:%f','now')
             WHERE id = ?`,
          ).run(weight, input.claimId);
        }
      } catch (err) { console.warn("[rsma] belief propagation failed:", err); }
    }

    return evidenceId;
  };

  // Wrap in write transaction; if already inside one, run directly
  try {
    return withWriteTransaction(db, doWork);
  } catch (err) {
    if (err instanceof Error && err.message.includes("transaction")) {
      return doWork();
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

/**
 * Supersede a claim by marking the old one as superseded and linking to the new one.
 *
 * TRANSACTION SAFETY: This function performs multiple writes (supersedeMemoryObject + logEvidence).
 * All production callers (engine.ts reconciliation) already wrap in withWriteTransaction.
 * If calling from new code, ensure a surrounding transaction is active.
 */
export function supersedeClaim(db: GraphDb, claimId: number, supersededBy: number): void {
  // Find composite_ids and scope from moIds
  const oldRow = db.prepare("SELECT composite_id, scope_id FROM memory_objects WHERE id = ?").get(claimId) as { composite_id: string; scope_id: number } | undefined;
  const newRow = db.prepare("SELECT composite_id FROM memory_objects WHERE id = ?").get(supersededBy) as { composite_id: string } | undefined;

  if (oldRow && newRow) {
    supersedeMemoryObject(db, oldRow.composite_id, newRow.composite_id);
  }

  logEvidence(db, {
    scopeId: oldRow?.scope_id ?? 1,
    objectType: "claim",
    objectId: claimId,
    eventType: "supersede",
    payload: { supersededBy },
  });
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ClaimRow {
  id: number;
  scope_id: number;
  branch_id: number;
  subject: string;
  predicate: string;
  object_text: string | null;
  object_json: string | null;
  value_type: string;
  status: string;
  confidence: number;
  trust_score: number;
  source_authority: number;
  canonical_key: string;
  first_seen_at: string;
  last_seen_at: string;
  mention_count: number;
}

export function moRowToClaimRow(row: Record<string, unknown>): ClaimRow {
  let structured: Record<string, unknown> = {};
  if (row.structured_json != null && typeof row.structured_json === "string") {
    structured = safeParseStructured(row.structured_json);
  }
  return {
    id: Number(row.id),
    scope_id: Number(row.scope_id ?? 1),
    branch_id: Number(row.branch_id ?? 0),
    subject: String(structured.subject ?? ""),
    predicate: String(structured.predicate ?? ""),
    object_text: structured.objectText != null ? String(structured.objectText) : null,
    object_json: structured.objectJson != null ? String(structured.objectJson) : null,
    value_type: String(structured.valueType ?? "text"),
    status: String(row.status ?? "active"),
    confidence: Number(row.confidence ?? 0.5),
    trust_score: Number(row.trust_score ?? 0.5),
    source_authority: Number(row.source_authority ?? 0.5),
    canonical_key: String(row.canonical_key ?? ""),
    first_seen_at: String(row.first_observed_at ?? row.created_at ?? ""),
    last_seen_at: String(row.last_observed_at ?? row.updated_at ?? ""),
    mention_count: Number(structured.mentionCount ?? row.mention_count ?? 1),
  };
}

export function getActiveClaims(
  db: GraphDb,
  scopeId: number,
  branchId?: number,
  limit = 50,
): ClaimRow[] {
  if (branchId != null) {
    return (db.prepare(`
      SELECT * FROM memory_objects
      WHERE scope_id = ? AND (branch_id = 0 OR branch_id = ?) AND kind = 'claim' AND status = 'active'
      ORDER BY confidence DESC, last_observed_at DESC LIMIT ?
    `).all(scopeId, branchId, limit) as Record<string, unknown>[]).map(moRowToClaimRow);
  }
  return (db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND branch_id = 0 AND kind = 'claim' AND status = 'active'
    ORDER BY confidence DESC, last_observed_at DESC LIMIT ?
  `).all(scopeId, limit) as Record<string, unknown>[]).map(moRowToClaimRow);
}

export interface ClaimWithEvidence extends ClaimRow {
  evidence: Array<{
    id: number;
    source_type: string;
    source_id: string;
    evidence_role: string;
    observed_at: string;
    confidence_delta: number;
  }>;
}

export function getClaimsWithEvidence(
  db: GraphDb,
  scopeId: number,
  opts?: { subject?: string; branchId?: number; limit?: number },
): ClaimWithEvidence[] {
  const limit = opts?.limit ?? 20;
  const branchFilter = opts?.branchId != null
    ? "(branch_id = 0 OR branch_id = ?)"
    : "branch_id = 0";
  const branchArgs = opts?.branchId != null ? [opts.branchId] : [];

  let rows: Record<string, unknown>[];

  if (opts?.subject) {
    const subjectPattern = `%${opts.subject.toLowerCase().trim()}%`;
    rows = db.prepare(`
      SELECT * FROM memory_objects
      WHERE scope_id = ? AND ${branchFilter} AND kind = 'claim' AND status = 'active' AND content LIKE ?
      ORDER BY confidence DESC LIMIT ?
    `).all(scopeId, ...branchArgs, subjectPattern, limit) as Record<string, unknown>[];
  } else {
    rows = db.prepare(`
      SELECT * FROM memory_objects
      WHERE scope_id = ? AND ${branchFilter} AND kind = 'claim' AND status = 'active'
      ORDER BY confidence DESC LIMIT ?
    `).all(scopeId, ...branchArgs, limit) as Record<string, unknown>[];
  }

  const claims = rows.map(moRowToClaimRow);

  return claims.map((claim, idx) => {
    let evidence: ClaimWithEvidence["evidence"] = [];
    // Use composite_id from raw row for consistent provenance lookups
    const compositeId = String(rows[idx]?.composite_id ?? `claim:${claim.id}`);
    try {
      const evRows = db.prepare(`
        SELECT id, predicate, object_id, confidence, detail, metadata, created_at
        FROM provenance_links
        WHERE subject_id = ? AND predicate IN ('supports', 'contradicts')
        ORDER BY created_at DESC
      `).all(compositeId) as Array<Record<string, unknown>>;

      evidence = evRows.map((r) => {
        let meta: Record<string, unknown> = {};
        meta = safeParseMetadata(r.metadata);
        const objParts = String(r.object_id).split(":");
        return {
          id: Number(r.id),
          source_type: objParts[0] ?? "",
          source_id: objParts.slice(1).join(":"),
          evidence_role: r.predicate === "contradicts" ? "contradict" : String(meta.evidence_role ?? "support"),
          observed_at: String(r.created_at),
          confidence_delta: Number(meta.confidence_delta ?? r.confidence),
        };
      });
    } catch (err) { console.warn("[rsma] evidence query failed for claim", claim.id, err); }

    return { ...claim, evidence };
  });
}

// ---------------------------------------------------------------------------
// Batch store from extraction results
// ---------------------------------------------------------------------------

export function storeClaimExtractionResults(
  db: GraphDb,
  results: ClaimExtractionResult[],
  context: { scopeId: number; sourceType: string; sourceId: string; actor?: string; runId?: string },
): void {
  // Phase 1: Upsert all claims and record evidence links, but skip per-row
  // confidence propagation to avoid compounding within a batch.
  // Instead, accumulate deltas per claim and apply once at the end.
  const claimDeltas = new Map<number, { supports: number; contradicts: number }>();

  for (const r of results) {
    const { claimId } = upsertClaim(db, { ...r.claim, scopeId: context.scopeId, actor: context.actor, runId: context.runId });

    // Record evidence link in provenance_links + evidence_log, but skip
    // per-row confidence propagation — we batch-apply deltas below.
    addClaimEvidence(db, { ...r.evidence, claimId }, { skipPropagation: true });

    // Accumulate the delta
    const delta = Math.min(1.0, Math.max(0.0, r.evidence.confidenceDelta ?? 0.1));
    if (!claimDeltas.has(claimId)) {
      claimDeltas.set(claimId, { supports: 0, contradicts: 0 });
    }
    const acc = claimDeltas.get(claimId)!;
    if (r.evidence.evidenceRole === "contradict") {
      acc.contradicts += delta;
    } else {
      acc.supports += delta;
    }
  }

  // Phase 2: Apply a single aggregated confidence update per claim
  for (const [claimId, deltas] of claimDeltas) {
    try {
      if (deltas.contradicts > 0) {
        const weight = Math.min(1.0, deltas.contradicts);
        db.prepare(
          `UPDATE memory_objects SET
             confidence = MAX(0.05, confidence * (1.0 - ?)),
             updated_at = strftime('%Y-%m-%dT%H:%M:%f','now')
           WHERE id = ?`,
        ).run(weight, claimId);
      }
      if (deltas.supports > 0) {
        const weight = Math.min(1.0, deltas.supports);
        db.prepare(
          `UPDATE memory_objects SET
             confidence = MIN(1.0, confidence + ? * (1.0 - confidence) * 0.7),
             updated_at = strftime('%Y-%m-%dT%H:%M:%f','now')
           WHERE id = ?`,
        ).run(weight, claimId);
      }
    } catch (err) { console.warn("[rsma] batch belief propagation failed for claim", claimId, err); }
  }
}

// ---------------------------------------------------------------------------
// Claim history (includes superseded/retracted)
// ---------------------------------------------------------------------------

export interface ClaimHistoryEntry extends ClaimRow {
  evidence: ClaimWithEvidence["evidence"];
}

/**
 * Return ALL versions of a claim matching a canonical key (including superseded
 * and retracted), ordered by created_at DESC. Useful for auditing how a claim evolved.
 */
export function getClaimHistory(
  db: GraphDb,
  scopeId: number,
  canonicalKey: string,
  limit = 50,
): ClaimHistoryEntry[] {
  const rows = db.prepare(`
    SELECT * FROM memory_objects
    WHERE scope_id = ? AND kind = 'claim' AND canonical_key = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(scopeId, canonicalKey, limit) as Record<string, unknown>[];

  return rows.map((row) => {
    const claim = moRowToClaimRow(row);
    const compositeId = String(row.composite_id ?? `claim:${claim.id}`);
    let evidence: ClaimWithEvidence["evidence"] = [];
    try {
      const evRows = db.prepare(`
        SELECT id, predicate, object_id, confidence, detail, metadata, created_at
        FROM provenance_links
        WHERE subject_id = ? AND predicate IN ('supports', 'contradicts')
        ORDER BY created_at DESC
      `).all(compositeId) as Array<Record<string, unknown>>;

      evidence = evRows.map((r) => {
        const meta = safeParseMetadata(r.metadata);
        const objParts = String(r.object_id).split(":");
        return {
          id: Number(r.id),
          source_type: objParts[0] ?? "",
          source_id: objParts.slice(1).join(":"),
          evidence_role: r.predicate === "contradicts" ? "contradict" : String(meta.evidence_role ?? "support"),
          observed_at: String(r.created_at),
          confidence_delta: Number(meta.confidence_delta ?? r.confidence),
        };
      });
    } catch (err) { console.warn("[rsma] evidence query failed for claim history", claim.id, err); }

    return { ...claim, evidence };
  });
}

// ---------------------------------------------------------------------------
// Retract a claim
// ---------------------------------------------------------------------------

/**
 * Retract a claim: sets status='retracted', logs evidence with event_type='retract',
 * and records a state delta for the retraction.
 *
 * Wrapped in a write transaction for atomicity (UPDATE + logEvidence + recordStateDelta).
 */
export function retractClaim(db: GraphDb, claimId: number, reason: string): void {
  const doWork = (): void => {
    const row = db.prepare(
      "SELECT composite_id, scope_id, canonical_key, status, confidence FROM memory_objects WHERE id = ?",
    ).get(claimId) as { composite_id: string; scope_id: number; canonical_key: string; status: string; confidence: number } | undefined;

    if (!row) return;

    db.prepare(
      `UPDATE memory_objects SET status = 'retracted', updated_at = strftime('%Y-%m-%dT%H:%M:%f','now') WHERE id = ?`,
    ).run(claimId);

    logEvidence(db, {
      scopeId: row.scope_id,
      objectType: "claim",
      objectId: claimId,
      eventType: "retract",
      payload: { reason },
    });

    recordStateDelta(db, {
      scopeId: row.scope_id,
      deltaType: "claim_retracted",
      entityKey: row.canonical_key,
      summary: reason,
      oldValue: row.status,
      newValue: "retracted",
      confidence: row.confidence,
    });
  };

  try {
    withWriteTransaction(db, doWork);
  } catch (err) {
    if (err instanceof Error && err.message.includes("transaction")) {
      doWork();
      return;
    }
    throw err;
  }
}
