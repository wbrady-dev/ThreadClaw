/**
 * Evidence log: append-only audit trail, idempotency protocol,
 * scope-local sequence ordering, and transactional write helpers.
 */

import type { GraphDb, EvidenceEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Transaction helpers
// ---------------------------------------------------------------------------

/**
 * Execute `fn` inside a BEGIN IMMEDIATE transaction.
 * IMMEDIATE acquires the write lock upfront to prevent deadlocks
 * when multiple processes share the graph DB.
 */
export function withWriteTransaction<T>(db: GraphDb, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/**
 * Check if an error is a UNIQUE constraint violation on idempotency_key.
 */
export function isIdempotencyConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.includes("UNIQUE constraint failed") &&
    err.message.includes("idempotency_key")
  );
}

/**
 * Execute `fn` inside a write transaction with optional idempotency.
 *
 * WARNING: This calls withWriteTransaction() internally, which issues
 * BEGIN IMMEDIATE. Callers MUST NOT already be inside a transaction —
 * SQLite does not support nested transactions and will throw
 * "cannot start a transaction within a transaction". If you need
 * idempotency inside an existing transaction, check the idempotency
 * key manually before calling your write logic.
 */
export function writeWithIdempotency<T>(
  db: GraphDb,
  idempotencyKey: string | undefined,
  fn: () => T,
): T | null {
  if (!idempotencyKey) {
    return withWriteTransaction(db, fn);
  }

  try {
    return withWriteTransaction(db, fn);
  } catch (err) {
    if (isIdempotencyConflict(err)) {
      return null; // already processed — mutation was rolled back
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Scope-local sequence
// ---------------------------------------------------------------------------

/**
 * Increment and return the next scope-local sequence number.
 * Creates the counter row if it doesn't exist.
 *
 * Uses a single atomic INSERT ... ON CONFLICT ... RETURNING statement
 * so that the read and write happen in one step, making it race-safe
 * even without an explicit surrounding write transaction.
 *
 * NOTE: Callers that need the returned sequence to be consistent with
 * other writes (e.g. logEvidence inserting into evidence_log) should
 * still wrap the full operation in a write transaction.
 */
export function nextScopeSeq(db: GraphDb, scopeId: number): number {
  const row = db.prepare(`
    INSERT INTO scope_sequences (scope_id, next_seq) VALUES (?, 2)
    ON CONFLICT(scope_id) DO UPDATE SET next_seq = next_seq + 1
    RETURNING next_seq - 1 AS seq
  `).get(scopeId) as { seq: number } | undefined;

  // Fallback for SQLite builds without RETURNING support (< 3.35.0)
  if (!row) {
    const fallback = db.prepare(
      "SELECT next_seq - 1 AS seq FROM scope_sequences WHERE scope_id = ?",
    ).get(scopeId) as { seq: number };
    return fallback.seq;
  }
  return row.seq;
}

// ---------------------------------------------------------------------------
// Evidence log writer
// ---------------------------------------------------------------------------

/**
 * Append an event to the evidence log.
 * Every mutation to the evidence store should call this after the actual write.
 * If scoped, also increments the scope-local sequence counter.
 */
export function logEvidence(db: GraphDb, event: EvidenceEvent): void {
  const seq = event.scopeId != null ? nextScopeSeq(db, event.scopeId) : null;

  db.prepare(`
    INSERT INTO evidence_log
        (scope_id, branch_id, object_type, object_id, event_type,
         actor, run_id, idempotency_key, payload_json, scope_seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.scopeId ?? null,
    event.branchId ?? null,
    event.objectType,
    event.objectId,
    event.eventType,
    event.actor ?? "system",
    event.runId ?? null,
    event.idempotencyKey ?? null,
    event.payload ? JSON.stringify(event.payload) : null,
    seq,
  );
}
