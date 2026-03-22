import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { runGraphMigrations } from "../src/relations/schema.js";
import { compileContextCapsules } from "../src/relations/context-compiler.js";
import { upsertClaim } from "../src/relations/claim-store.js";
import { upsertDecision } from "../src/relations/decision-store.js";
import { openLoop } from "../src/relations/loop-store.js";
import { recordStateDelta } from "../src/relations/delta-store.js";
import { upsertInvariant } from "../src/relations/invariant-store.js";
import { upsertCapability, getCapabilities } from "../src/relations/capability-store.js";
import { getRecentDeltas } from "../src/relations/delta-store.js";
import { getActiveInvariants } from "../src/relations/invariant-store.js";
import type { GraphDb } from "../src/relations/types.js";

function createDb(): GraphDb {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runGraphMigrations(db as unknown as GraphDb);
  return db as unknown as GraphDb;
}

// ============================================================================
// Context Compiler
// ============================================================================

describe("H2 Context Compiler", () => {
  let db: GraphDb;
  beforeEach(() => { db = createDb(); });

  it("returns null when no evidence exists", () => {
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).toBeNull();
  });

  it("compiles claims into capsules", () => {
    upsertClaim(db, {
      scopeId: 1, subject: "api", predicate: "status",
      objectText: "healthy", canonicalKey: "api::status", confidence: 0.8,
    });
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("[ClawCore Evidence]");
    expect(result!.text).toContain("[claim]");
    expect(result!.text).toContain("api");
    expect(result!.capsuleTypes.claim).toBe(1);
  });

  it("compiles decisions into capsules", () => {
    upsertDecision(db, { scopeId: 1, topic: "database", decisionText: "Use PostgreSQL" });
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("[decision]");
    expect(result!.capsuleTypes.decision).toBe(1);
  });

  it("compiles open loops into capsules", () => {
    openLoop(db, { scopeId: 1, text: "Deploy to staging", priority: 5 });
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("[loop]");
  });

  it("compiles invariants into capsules", () => {
    upsertInvariant(db, {
      scopeId: 1, invariantKey: "no-force-push",
      description: "Never force push to main", severity: "critical",
    });
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("[invariant:critical]");
  });

  it("enforces lite budget (110 tokens)", () => {
    // Add lots of data to exceed budget
    for (let i = 0; i < 20; i++) {
      upsertClaim(db, {
        scopeId: 1, subject: `entity${i}`, predicate: "has",
        objectText: `A moderately long value for testing budget enforcement number ${i}`,
        canonicalKey: `entity${i}::has`, confidence: 0.7,
      });
    }
    const result = compileContextCapsules(db, { tier: "lite", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.tokensUsed).toBeLessThanOrEqual(110);
    expect(result!.budgetTotal).toBe(110);
  });

  it("enforces standard budget (190 tokens)", () => {
    for (let i = 0; i < 20; i++) {
      upsertClaim(db, {
        scopeId: 1, subject: `entity${i}`, predicate: "has",
        objectText: `A moderately long value for testing budget enforcement number ${i}`,
        canonicalKey: `entity${i}::has`, confidence: 0.7,
      });
    }
    const result = compileContextCapsules(db, { tier: "standard", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.tokensUsed).toBeLessThanOrEqual(190);
    expect(result!.budgetTotal).toBe(190);
  });

  it("enforces premium budget (280 tokens)", () => {
    for (let i = 0; i < 20; i++) {
      upsertClaim(db, {
        scopeId: 1, subject: `entity${i}`, predicate: "has",
        objectText: `A moderately long value for testing budget enforcement number ${i}`,
        canonicalKey: `entity${i}::has`, confidence: 0.7,
      });
    }
    const result = compileContextCapsules(db, { tier: "premium", scopeId: 1 });
    expect(result).not.toBeNull();
    expect(result!.tokensUsed).toBeLessThanOrEqual(280);
    expect(result!.budgetTotal).toBe(280);
  });

  it("ranks by score-per-token (highest first)", () => {
    // High-confidence short claim should rank above low-confidence long claim
    upsertClaim(db, {
      scopeId: 1, subject: "api", predicate: "ok",
      objectText: "yes", canonicalKey: "api::ok", confidence: 0.95, trustScore: 1.0,
    });
    upsertClaim(db, {
      scopeId: 1, subject: "some very long entity name that takes many tokens", predicate: "has a very long predicate",
      objectText: "and a very long value that will cost lots of tokens in the budget",
      canonicalKey: "long::long", confidence: 0.3, trustScore: 0.2,
    });
    const result = compileContextCapsules(db, { tier: "lite", scopeId: 1 });
    expect(result).not.toBeNull();
    // The short high-confidence claim should be included
    expect(result!.text).toContain("api");
  });

  it("orders output deterministically (invariant > decision > claim > loop > delta)", () => {
    upsertClaim(db, { scopeId: 1, subject: "x", predicate: "is", objectText: "y", canonicalKey: "x::is", confidence: 0.8 });
    upsertDecision(db, { scopeId: 1, topic: "test", decisionText: "do it" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "rule1", description: "A rule", severity: "warning" });
    openLoop(db, { scopeId: 1, text: "Task 1", priority: 5 });
    recordStateDelta(db, { scopeId: 1, deltaType: "change", entityKey: "k", oldValue: "a", newValue: "b" });

    const result = compileContextCapsules(db, { tier: "premium", scopeId: 1 });
    expect(result).not.toBeNull();
    const lines = result!.text.split("\n").filter((l) => l.startsWith("["));
    // Extract capsule types from lines (skip [ClawCore Evidence] header)
    const types = lines
      .map((l) => {
        if (l.startsWith("[invariant")) return "invariant";
        if (l.startsWith("[decision")) return "decision";
        if (l.startsWith("[claim")) return "claim";
        if (l.startsWith("[loop")) return "loop";
        if (l.startsWith("[delta")) return "delta";
        return null;
      })
      .filter((t): t is NonNullable<typeof t> => t !== null);
    // Verify ordering: invariant(0) ≤ decision(1) ≤ claim(2) ≤ loop(3) ≤ delta(4)
    const orderMap: Record<string, number> = { invariant: 0, decision: 1, claim: 2, loop: 3, delta: 4 };
    expect(types.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < types.length; i++) {
      expect(orderMap[types[i]!]).toBeGreaterThanOrEqual(orderMap[types[i - 1]!]);
    }
  });
});

// ============================================================================
// Remaining Tools (smoke tests)
// ============================================================================

describe("H2 cc_delta tool", () => {
  it("returns empty when no deltas", () => {
    const db = createDb();
    // Just verify getRecentDeltas returns empty
    const deltas = getRecentDeltas(db, 1);
    expect(deltas.length).toBe(0);
  });

  it("returns deltas after recording", () => {
    const db = createDb();
    recordStateDelta(db, {
      scopeId: 1, deltaType: "config", entityKey: "timeout",
      oldValue: "30", newValue: "60",
    });
    const deltas = getRecentDeltas(db, 1);
    expect(deltas.length).toBe(1);
    expect(deltas[0].entity_key).toBe("timeout");
  });
});

describe("H2 cc_capabilities tool", () => {
  it("returns capabilities after upserting", () => {
    const db = createDb();
    upsertCapability(db, {
      scopeId: 1, capabilityType: "service", capabilityKey: "redis",
      displayName: "Redis Cache", status: "available",
    });
    const caps = getCapabilities(db, 1);
    expect(caps.length).toBe(1);
    expect(caps[0].display_name).toBe("Redis Cache");
  });

  it("filters by type", () => {
    const db = createDb();
    upsertCapability(db, { scopeId: 1, capabilityType: "tool", capabilityKey: "git", status: "available" });
    upsertCapability(db, { scopeId: 1, capabilityType: "service", capabilityKey: "redis", status: "available" });
    const tools = getCapabilities(db, 1, { type: "tool" });
    expect(tools.length).toBe(1);
    expect(tools[0].capability_key).toBe("git");
  });
});

describe("H2 cc_invariants tool", () => {
  it("returns invariants ordered by severity", () => {
    const db = createDb();
    upsertInvariant(db, { scopeId: 1, invariantKey: "info", description: "Info rule", severity: "info" });
    upsertInvariant(db, { scopeId: 1, invariantKey: "crit", description: "Critical rule", severity: "critical" });
    const invariants = getActiveInvariants(db, 1);
    expect(invariants[0].severity).toBe("critical");
    expect(invariants[1].severity).toBe("info");
  });
});
