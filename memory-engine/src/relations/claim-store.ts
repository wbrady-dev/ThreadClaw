/**
 * Claim store — CRUD for structured claims with evidence tracking.
 *
 * IMPORTANT: upsertClaim() and storeClaimExtractionResults() use a
 * SELECT-before-UPSERT pattern for isNew detection. These must be
 * called inside a write transaction (withWriteTransaction) for atomicity.
 * The primary caller (compaction.ts) already wraps in withWriteTransaction.
 */

import type {
  GraphDb,
  UpsertClaimInput,
  UpsertClaimResult,
  AddClaimEvidenceInput,
  ClaimExtractionResult,
} from "./types.js";
import { logEvidence } from "./evidence-log.js";

// ---------------------------------------------------------------------------
// Canonical key
// ---------------------------------------------------------------------------

/** Normalize subject + predicate into a canonical dedup key. */
export function buildCanonicalKey(subject: string, predicate: string): string {
  const s = subject.toLowerCase().trim().replace(/\s+/g, " ");
  const p = predicate.toLowerCase().trim().replace(/\s+/g, " ");
  return `${s}::${p}`;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export function upsertClaim(db: GraphDb, input: UpsertClaimInput): UpsertClaimResult {
  const branchId = input.branchId ?? 0;
  const confidence = input.confidence ?? 0.5;
  const trustScore = input.trustScore ?? 0.5;
  const sourceAuthority = input.sourceAuthority ?? 0.5;

  // Check existence before upsert for reliable isNew detection
  const existing = db.prepare(
    "SELECT id FROM claims WHERE scope_id = ? AND branch_id = ? AND canonical_key = ?",
  ).get(input.scopeId, branchId, input.canonicalKey) as { id: number } | undefined;

  db.prepare(`
    INSERT INTO claims
      (scope_id, branch_id, subject, predicate, object_text, object_json,
       value_type, confidence, trust_score, source_authority, canonical_key, extraction_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, branch_id, canonical_key) DO UPDATE SET
      confidence = (claims.confidence + excluded.confidence) / 2.0,
      trust_score = (claims.trust_score + excluded.trust_score) / 2.0,
      source_authority = (claims.source_authority + excluded.source_authority) / 2.0,
      object_text = COALESCE(excluded.object_text, claims.object_text),
      object_json = COALESCE(excluded.object_json, claims.object_json),
      last_seen_at = strftime('%Y-%m-%dT%H:%M:%f', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
  `).run(
    input.scopeId, branchId, input.subject, input.predicate,
    input.objectText ?? null, input.objectJson ?? null,
    input.valueType ?? "text", confidence, trustScore, sourceAuthority,
    input.canonicalKey, input.extractionVersion ?? 1,
  );

  const row = db.prepare(
    "SELECT id FROM claims WHERE scope_id = ? AND branch_id = ? AND canonical_key = ?",
  ).get(input.scopeId, branchId, input.canonicalKey) as { id: number } | undefined;

  if (!row) {
    throw new Error(`upsertClaim: claim not found after UPSERT for key "${input.canonicalKey}"`);
  }

  const isNew = !existing;

  logEvidence(db, {
    scopeId: input.scopeId,
    branchId: branchId || undefined,
    objectType: "claim",
    objectId: row.id,
    eventType: isNew ? "create" : "update",
    // Only use idempotency key on create to prevent duplicate first-inserts.
    // Updates are allowed to log multiple times (each observation is valid).
    idempotencyKey: isNew ? `claim:create:${input.scopeId}:${branchId}:${input.canonicalKey}` : undefined,
  });

  return { claimId: row.id, isNew };
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function addClaimEvidence(db: GraphDb, input: AddClaimEvidenceInput): number {
  const claim = db.prepare("SELECT scope_id, branch_id FROM claims WHERE id = ?").get(input.claimId) as { scope_id: number; branch_id: number | null } | undefined;

  const result = db.prepare(`
    INSERT INTO claim_evidence
      (claim_id, source_type, source_id, source_detail, evidence_role, snippet_hash, confidence_delta)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(claim_id, source_type, source_id, evidence_role) DO UPDATE SET
      observed_at = strftime('%Y-%m-%dT%H:%M:%f', 'now'),
      confidence_delta = MAX(claim_evidence.confidence_delta, excluded.confidence_delta),
      source_detail = COALESCE(excluded.source_detail, claim_evidence.source_detail)
  `).run(
    input.claimId, input.sourceType, input.sourceId,
    input.sourceDetail ?? null, input.evidenceRole,
    input.snippetHash ?? null, input.confidenceDelta ?? 0,
  );

  const evidenceId = Number(result.lastInsertRowid);

  logEvidence(db, {
    scopeId: claim?.scope_id,
    branchId: claim?.branch_id ?? undefined,
    objectType: "claim_evidence",
    objectId: evidenceId,
    eventType: "create",
    payload: { claimId: input.claimId, role: input.evidenceRole },
  });

  return evidenceId;
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

export function supersedeClaim(db: GraphDb, claimId: number, supersededBy: number): void {
  const claim = db.prepare("SELECT scope_id, branch_id FROM claims WHERE id = ?").get(claimId) as { scope_id: number; branch_id: number | null } | undefined;

  db.prepare(
    "UPDATE claims SET status = 'superseded', superseded_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE id = ?",
  ).run(supersededBy, claimId);

  logEvidence(db, {
    scopeId: claim?.scope_id,
    branchId: claim?.branch_id ?? undefined,
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
}

export function getActiveClaims(
  db: GraphDb,
  scopeId: number,
  branchId?: number,
  limit = 50,
): ClaimRow[] {
  if (branchId != null) {
    return db.prepare(`
      SELECT * FROM claims
      WHERE scope_id = ? AND (branch_id = 0 OR branch_id = ?) AND status = 'active'
      ORDER BY confidence DESC, last_seen_at DESC LIMIT ?
    `).all(scopeId, branchId, limit) as ClaimRow[];
  }
  return db.prepare(`
    SELECT * FROM claims
    WHERE scope_id = ? AND branch_id = 0 AND status = 'active'
    ORDER BY confidence DESC, last_seen_at DESC LIMIT ?
  `).all(scopeId, limit) as ClaimRow[];
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
  let claims: ClaimRow[];

  if (opts?.subject) {
    const subjectPattern = `%${opts.subject.toLowerCase().trim()}%`;
    claims = db.prepare(`
      SELECT * FROM claims
      WHERE scope_id = ? AND ${branchFilter} AND status = 'active' AND subject LIKE ?
      ORDER BY confidence DESC LIMIT ?
    `).all(scopeId, ...branchArgs, subjectPattern, limit) as ClaimRow[];
  } else {
    claims = db.prepare(`
      SELECT * FROM claims
      WHERE scope_id = ? AND ${branchFilter} AND status = 'active'
      ORDER BY confidence DESC LIMIT ?
    `).all(scopeId, ...branchArgs, limit) as ClaimRow[];
  }

  return claims.map((claim) => {
    const evidence = db.prepare(`
      SELECT id, source_type, source_id, evidence_role, observed_at, confidence_delta
      FROM claim_evidence WHERE claim_id = ? ORDER BY observed_at DESC
    `).all(claim.id) as ClaimWithEvidence["evidence"];
    return { ...claim, evidence };
  });
}

// ---------------------------------------------------------------------------
// Batch store from extraction results
// ---------------------------------------------------------------------------

export function storeClaimExtractionResults(
  db: GraphDb,
  results: ClaimExtractionResult[],
  context: { scopeId: number; sourceType: string; sourceId: string; actor?: string },
): void {
  for (const r of results) {
    const { claimId } = upsertClaim(db, { ...r.claim, scopeId: context.scopeId });
    addClaimEvidence(db, { ...r.evidence, claimId });
  }
}
