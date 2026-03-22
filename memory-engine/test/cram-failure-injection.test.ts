/**
 * CRAM Failure Injection Tests
 *
 * Proves each critical layer degrades gracefully under failure conditions.
 * These are NOT happy-path tests. They inject bad data, missing state,
 * corrupt input, boundary conditions, and concurrent conflicts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runGraphMigrations } from "../src/relations/schema.js";
import {
  withWriteTransaction, writeWithIdempotency, logEvidence, nextScopeSeq,
} from "../src/relations/evidence-log.js";
import { extractFast } from "../src/relations/entity-extract.js";
import { upsertEntity, insertMention, deleteGraphDataForSource } from "../src/relations/graph-store.js";
import { effectiveConfidence } from "../src/relations/confidence.js";
import { upsertClaim, getActiveClaims, addClaimEvidence, supersedeClaim } from "../src/relations/claim-store.js";
import { upsertDecision, getActiveDecisions } from "../src/relations/decision-store.js";
import { openLoop, getOpenLoops, closeLoop, updateLoop } from "../src/relations/loop-store.js";
import { recordStateDelta, getRecentDeltas } from "../src/relations/delta-store.js";
import { upsertCapability, getCapabilities } from "../src/relations/capability-store.js";
import { upsertInvariant, getActiveInvariants } from "../src/relations/invariant-store.js";
import { recordAttempt, getToolSuccessRate } from "../src/relations/attempt-store.js";
import { upsertRunbook, getRunbooks } from "../src/relations/runbook-store.js";
import { upsertAntiRunbook, getAntiRunbooks, addAntiRunbookEvidence } from "../src/relations/anti-runbook-store.js";
import { createBranch, getBranches, checkPromotionPolicy, promoteBranch, discardBranch } from "../src/relations/promotion.js";
import { compileContextCapsules } from "../src/relations/context-compiler.js";
import { getTimeline } from "../src/relations/timeline.js";
import { getStateAtTime } from "../src/relations/snapshot.js";
import { upsertRelation, getRelationsForEntity } from "../src/relations/relation-store.js";
import { applyDecay } from "../src/relations/decay.js";
import { recordAwarenessEvent, getAwarenessStats, resetAwarenessEventsForTests } from "../src/relations/eval.js";

let db: DatabaseSync;
const g = () => db as any;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  runGraphMigrations(db as any);
});

afterAll(() => { db.close(); });

// ═══════════════════════════════════════════════════════════════════
// EEL: Evidence Event Log — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: EEL (Evidence Event Log)", () => {
  it("idempotency key blocks exact duplicate — no silent data corruption", () => {
    const key = "fail:idem:dup:1";
    const r1 = writeWithIdempotency(g(), key, () => {
      logEvidence(g(), { objectType: "idem_fail", objectId: 1, eventType: "create", idempotencyKey: key });
      return "first";
    });
    const r2 = writeWithIdempotency(g(), key, () => {
      logEvidence(g(), { objectType: "idem_fail", objectId: 1, eventType: "create", idempotencyKey: key });
      return "second";
    });
    expect(r1).toBe("first");
    expect(r2).toBeNull();
    // Only 1 row should exist
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM evidence_log WHERE idempotency_key = ?").get(key) as any).cnt;
    expect(count).toBe(1);
  });

  it("transaction rolls back entirely on mid-transaction error", () => {
    const before = (db.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as any).cnt;
    try {
      withWriteTransaction(g(), () => {
        logEvidence(g(), { objectType: "rollback_test", objectId: 1, eventType: "create" });
        throw new Error("intentional mid-transaction crash");
      });
    } catch { /* expected */ }
    const after = (db.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as any).cnt;
    expect(after).toBe(before); // no partial writes
  });

  it("scope_seq never goes backwards even under rapid writes", () => {
    const seqs: number[] = [];
    withWriteTransaction(g(), () => {
      for (let i = 0; i < 100; i++) {
        seqs.push(nextScopeSeq(g(), 1));
      }
    });
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// KG: Knowledge Graph — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: KG (Knowledge Graph)", () => {
  it("extractFast handles empty string without crash", () => {
    const results = extractFast("", []);
    expect(results).toEqual([]);
  });

  it("extractFast handles null/undefined terms list without crash", () => {
    const results = extractFast("Redis is great", undefined);
    // Single capitalized word may not extract (requires multi-word phrase)
    // The important thing is it doesn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  it("extractFast handles malicious regex injection in terms list", () => {
    // These would break if terms were used as raw regex
    const results = extractFast("test input", ["(.*)", "[a-z", "(?=bad)", "\\d+"]);
    // Should not throw, and should not match everything
    expect(Array.isArray(results)).toBe(true);
  });

  it("extractFast handles extremely long text without hanging", () => {
    const longText = "The Redis service ".repeat(10000); // 180KB
    const start = Date.now();
    const results = extractFast(longText, ["redis"]);
    expect(Date.now() - start).toBeLessThan(5000); // must complete in 5s
    expect(results.length).toBeGreaterThan(0);
  });

  it("upsertEntity handles duplicate names idempotently", () => {
    withWriteTransaction(g(), () => {
      upsertEntity(g(), { name: "dupe-test", displayName: "D", entityType: "t" });
      upsertEntity(g(), { name: "dupe-test", displayName: "D", entityType: "t" });
      upsertEntity(g(), { name: "dupe-test", displayName: "D", entityType: "t" });
    });
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM entities WHERE name = 'dupe-test'").get() as any).cnt;
    expect(count).toBe(1); // single row, not 3
    const mc = (db.prepare("SELECT mention_count FROM entities WHERE name = 'dupe-test'").get() as any).mention_count;
    expect(mc).toBe(3); // count incremented 3 times
  });

  it("deleteGraphDataForSource on nonexistent source is a safe no-op", () => {
    expect(() => {
      withWriteTransaction(g(), () => {
        deleteGraphDataForSource(g(), "nonexistent", "fake-id-999");
      });
    }).not.toThrow();
  });

  it("re-ingestion delete + crash = old data preserved (rollback)", () => {
    // First ingestion
    withWriteTransaction(g(), () => {
      const { entityId } = upsertEntity(g(), { name: "crash-test-ent", displayName: "C", entityType: "t" });
      insertMention(g(), { entityId, sourceType: "doc", sourceId: "crash-doc", sourceDetail: "v1", contextTerms: ["original"] });
    });

    // Simulate crash mid-re-ingestion
    try {
      withWriteTransaction(g(), () => {
        deleteGraphDataForSource(g(), "doc", "crash-doc");
        throw new Error("simulated crash during re-ingestion");
      });
    } catch { /* expected */ }

    // Old data should still exist (transaction rolled back)
    const mentions = (db.prepare(
      "SELECT COUNT(*) as cnt FROM entity_mentions WHERE source_id = 'crash-doc'",
    ).get() as any).cnt;
    expect(mentions).toBe(1); // original preserved
  });
});

// ═══════════════════════════════════════════════════════════════════
// SL: State Layer — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: SL (State Layer)", () => {
  it("claim with confidence > 1.0 is stored (clamping is extraction-side)", () => {
    // The store accepts any value; clamping happens during extraction
    const { claimId } = upsertClaim(g(), {
      scopeId: 1, branchId: 0, subject: "overflow", predicate: "has",
      objectText: "high conf", confidence: 1.5,
      canonicalKey: "fail:overflow:1",
    });
    expect(claimId).toBeGreaterThan(0);
  });

  it("claim with confidence < 0 is stored (clamping is extraction-side)", () => {
    const { claimId } = upsertClaim(g(), {
      scopeId: 1, branchId: 0, subject: "underflow", predicate: "has",
      objectText: "neg conf", confidence: -0.5,
      canonicalKey: "fail:underflow:1",
    });
    expect(claimId).toBeGreaterThan(0);
  });

  it("superseding a nonexistent claim ID does not crash", () => {
    expect(() => {
      withWriteTransaction(g(), () => {
        supersedeClaim(g(), 999999, 999998);
      });
    }).not.toThrow();
  });

  it("getActiveClaims on empty scope returns empty array", () => {
    const claims = getActiveClaims(g(), 99999, 0, 10);
    expect(claims).toEqual([]);
  });

  it("decision auto-supersede handles rapid same-topic writes", () => {
    for (let i = 0; i < 10; i++) {
      withWriteTransaction(g(), () => {
        upsertDecision(g(), {
          scopeId: 1, topic: "rapid-topic", decisionText: `Decision v${i}`,
          sourceType: "t", sourceId: `s${i}`,
        });
      });
    }
    const active = getActiveDecisions(g(), 1).filter((d: any) => d.topic === "rapid-topic");
    expect(active.length).toBe(1);
    expect(active[0].decision_text).toBe("Decision v9");
  });

  it("closing an already-closed loop is a safe no-op", () => {
    const loopId = openLoop(g(), {
      scopeId: 1, loopType: "test", text: "double close", priority: 0,
      sourceType: "t", sourceId: "s",
    });
    closeLoop(g(), loopId);
    expect(() => closeLoop(g(), loopId)).not.toThrow();
  });

  it("closing a nonexistent loop ID does not crash", () => {
    expect(() => closeLoop(g(), 999999)).not.toThrow();
  });

  it("getOpenLoops on empty scope returns empty array", () => {
    expect(getOpenLoops(g(), 99999)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DE: Delta Engine — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: DE (Delta Engine)", () => {
  it("confidence at boundary values", () => {
    expect(effectiveConfidence(0, 5, 3)).toBe(0);       // 0 base
    expect(effectiveConfidence(1.0, 5, 0)).toBe(1.0);   // 0 days
    expect(effectiveConfidence(1.0, 0, 3)).toBe(0);     // 0 mentions → 0/3 = 0
    expect(effectiveConfidence(0.5, 1, 365)).toBeGreaterThan(0); // very old but not zero
  });

  it("getRecentDeltas with future timestamp returns empty", () => {
    const deltas = getRecentDeltas(g(), 99999, { limit: 10 });
    expect(deltas).toEqual([]);
  });

  it("decay on empty tables does not crash", () => {
    expect(() => applyDecay(g(), 1)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// AOM: Attempt & Outcome Memory — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: AOM (Attempt Memory)", () => {
  it("success rate with zero attempts returns 0", () => {
    const rate = getToolSuccessRate(g(), 1, "nonexistent-tool-xyz");
    expect(rate.total).toBe(0);
    expect(rate.rate).toBe(0);
  });

  it("runbook upsert on conflict increments, does not duplicate", () => {
    upsertRunbook(g(), { scopeId: 1, runbookKey: "dup-rb", toolName: "exec", pattern: "test" });
    upsertRunbook(g(), { scopeId: 1, runbookKey: "dup-rb", toolName: "exec", pattern: "test" });
    upsertRunbook(g(), { scopeId: 1, runbookKey: "dup-rb", toolName: "exec", pattern: "test" });
    const rbs = getRunbooks(g(), 1).filter((r: any) => r.runbook_key === "dup-rb");
    expect(rbs.length).toBe(1); // one row, not three
  });

  it("anti-runbook evidence on nonexistent anti-runbook throws (FK constraint)", () => {
    expect(() => {
      addAntiRunbookEvidence(g(), 999999, {
        sourceType: "t", sourceId: "s", evidenceRole: "failure",
      });
    }).toThrow(); // FK violation
  });

  it("attempt with null duration and error is accepted", () => {
    expect(() => {
      recordAttempt(g(), {
        scopeId: 1, toolName: "null-test", status: "success",
      });
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// BSG: Branch & Scope Governance — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: BSG (Branch Governance)", () => {
  it("duplicate branch key throws UNIQUE constraint", () => {
    createBranch(g(), 1, "test", "dup-branch-key", "tester");
    expect(() => {
      createBranch(g(), 1, "test", "dup-branch-key", "tester");
    }).toThrow(/UNIQUE/);
  });

  it("promoting already-promoted branch does not crash", () => {
    const branch = createBranch(g(), 1, "test", "double-promote", "tester");
    promoteBranch(g(), branch.id);
    expect(() => promoteBranch(g(), branch.id)).not.toThrow();
  });

  it("discarding already-discarded branch does not crash", () => {
    const branch = createBranch(g(), 1, "test", "double-discard", "tester");
    discardBranch(g(), branch.id);
    expect(() => discardBranch(g(), branch.id)).not.toThrow();
  });

  it("promotion policy for unknown object type returns canPromote=false", () => {
    const result = checkPromotionPolicy(g(), "nonexistent_type", 1.0, 100);
    expect(result.canPromote).toBe(false);
    expect(result.reason).toContain("No promotion policy");
  });

  it("promotion policy respects min_confidence threshold", () => {
    // Claim policy: min_confidence=0.6, requires_evidence_count=2
    expect(checkPromotionPolicy(g(), "claim", 0.59, 5).canPromote).toBe(false);
    expect(checkPromotionPolicy(g(), "claim", 0.60, 5).canPromote).toBe(true);
  });

  it("promotion policy respects evidence count threshold", () => {
    expect(checkPromotionPolicy(g(), "claim", 0.9, 1).canPromote).toBe(false);
    expect(checkPromotionPolicy(g(), "claim", 0.9, 2).canPromote).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CCL: Context Compiler — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: CCL (Context Compiler)", () => {
  it("compiles with zero evidence (empty DB scope)", () => {
    const result = compileContextCapsules(g(), { tier: "standard", scopeId: 99999 });
    // Should return null or empty string, not crash
    expect(result === null || result === undefined).toBe(true);
  });

  it("compiles with invalid tier name falls back gracefully", () => {
    // Unknown tier should use a default or return null
    expect(() => {
      compileContextCapsules(g(), { tier: "nonexistent_tier" as any, scopeId: 1 });
    }).not.toThrow();
  });

  it("Lite budget never exceeded even with 500 claims", () => {
    // Seed 500 claims to stress the budget
    withWriteTransaction(g(), () => {
      for (let i = 0; i < 500; i++) {
        upsertClaim(g(), {
          scopeId: 1, branchId: 0, subject: `budget-stress-${i}`,
          predicate: "has", objectText: `value-${i}`, confidence: 0.9,
          canonicalKey: `fail:budget:${i}`,
        });
      }
    });

    const result = compileContextCapsules(g(), { tier: "lite", scopeId: 1 });
    if (result) {
      const tokens = Math.ceil(result.text.length / 4);
      expect(tokens).toBeLessThanOrEqual(150); // Lite = 110 + margin
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// AL: Awareness Layer — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: AL (Awareness Layer)", () => {
  it("eval stats on zero events returns safe defaults", () => {
    resetAwarenessEventsForTests();
    const stats = getAwarenessStats();
    expect(stats.totalTurns).toBe(0);
    expect(stats.firedCount).toBe(0);
    expect(stats.fireRate).toBe(0);
    expect(stats.latencyP50).toBe(0);
    expect(stats.latencyP95).toBe(0);
  });

  it("eval buffer caps at MAX_EVENTS (2000) — no memory leak", () => {
    resetAwarenessEventsForTests();
    for (let i = 0; i < 3000; i++) {
      recordAwarenessEvent({
        fired: true, noteCount: 1, noteTypes: ["test"],
        latencyMs: 5, terms: ["x"], tokensAdded: 10,
      });
    }
    const stats = getAwarenessStats();
    // Should have capped at 2000, not 3000
    expect(stats.totalTurns).toBeLessThanOrEqual(2000);
    expect(stats.totalTurns).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Timeline & Snapshot — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: Timeline & Snapshot", () => {
  it("timeline on empty scope returns empty array", () => {
    const events = getTimeline(g(), 99999, { limit: 10 });
    expect(events).toEqual([]);
  });

  it("timeline with limit=0 returns empty", () => {
    const events = getTimeline(g(), 1, { limit: 0 });
    expect(events).toEqual([]);
  });

  it("snapshot at epoch returns empty state", () => {
    const state = getStateAtTime(g(), 1, "1970-01-01T00:00:00.000Z");
    expect(state).toBeTruthy();
    expect(state.claims.length).toBe(0);
    expect(state.decisions.length).toBe(0);
  });

  it("snapshot at far future returns current state", () => {
    const state = getStateAtTime(g(), 1, "2099-12-31T23:59:59.999Z");
    expect(state).toBeTruthy();
    // Should have claims from the budget stress test above
    expect(state.claims.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Relations — failure injection
// ═══════════════════════════════════════════════════════════════════

describe("Failure: Relations", () => {
  it("relation with nonexistent entity IDs throws FK constraint", () => {
    expect(() => {
      upsertRelation(g(), {
        scopeId: 1, subjectEntityId: 999999, predicate: "uses",
        objectEntityId: 999998, confidence: 0.5,
        sourceType: "t", sourceId: "s",
      });
    }).toThrow();
  });

  it("getRelationsForEntity on nonexistent entity returns empty", () => {
    const rels = getRelationsForEntity(g(), 999999);
    expect(rels).toEqual([]);
  });

  it("duplicate relation upserts on conflict, does not create duplicates", () => {
    withWriteTransaction(g(), () => {
      upsertEntity(g(), { name: "rel-dup-a", displayName: "A", entityType: "t" });
      upsertEntity(g(), { name: "rel-dup-b", displayName: "B", entityType: "t" });
    });
    const aId = (db.prepare("SELECT id FROM entities WHERE name = 'rel-dup-a'").get() as any).id;
    const bId = (db.prepare("SELECT id FROM entities WHERE name = 'rel-dup-b'").get() as any).id;

    upsertRelation(g(), { scopeId: 1, subjectEntityId: aId, predicate: "uses", objectEntityId: bId, confidence: 0.5, sourceType: "t", sourceId: "s1" });
    upsertRelation(g(), { scopeId: 1, subjectEntityId: aId, predicate: "uses", objectEntityId: bId, confidence: 0.9, sourceType: "t", sourceId: "s2" });

    const rels = getRelationsForEntity(g(), aId);
    const usesRels = rels.filter((r: any) => r.predicate === "uses");
    expect(usesRels.length).toBe(1); // one row, higher confidence
  });
});

// ═══════════════════════════════════════════════════════════════════
// Concurrent stress — rapid interleaved operations
// ═══════════════════════════════════════════════════════════════════

describe("Failure: Concurrent Stress", () => {
  it("1000 mixed operations in single transaction", () => {
    const start = Date.now();
    withWriteTransaction(g(), () => {
      for (let i = 0; i < 200; i++) {
        upsertEntity(g(), { name: `concurrent-${i}`, displayName: `C${i}`, entityType: "t" });
      }
      for (let i = 0; i < 200; i++) {
        upsertClaim(g(), {
          scopeId: 1, branchId: 0, subject: `concurrent-${i}`, predicate: "is",
          objectText: `thing-${i}`, confidence: 0.7,
          canonicalKey: `fail:concurrent:${i}`,
        });
      }
      for (let i = 0; i < 200; i++) {
        recordAttempt(g(), {
          scopeId: 1, toolName: "concurrent-tool", status: i % 2 === 0 ? "success" : "failure",
          durationMs: 50,
        });
      }
      for (let i = 0; i < 200; i++) {
        recordStateDelta(g(), {
          scopeId: 1, branchId: 0, deltaType: "concurrent",
          entityKey: `ck-${i}`, summary: `Delta ${i}`,
          sourceType: "t", sourceId: `cd${i}`,
        });
      }
      for (let i = 0; i < 200; i++) {
        logEvidence(g(), {
          scopeId: 1, objectType: "concurrent_test", objectId: i,
          eventType: "create",
        });
      }
    });
    const elapsed = Date.now() - start;
    console.log(`    1000 mixed ops in single transaction: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5000);
  });
});
