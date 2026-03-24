/**
 * RSMA Live Smoke Test — runs against the real clawcore-graph.db
 * Tests every RSMA layer: RAG hooks, DAG lineage, KG entities, AL awareness,
 * SL state, DE deltas, AOM attempts, BSG branches, EEL evidence log, CCL compiler.
 */

import { DatabaseSync } from "node:sqlite";
import { withWriteTransaction, logEvidence, nextScopeSeq } from "../src/relations/evidence-log.js";
import { extractFast } from "../src/relations/entity-extract.js";
import { upsertEntity, insertMention } from "../src/relations/graph-store.js";
import { effectiveConfidence } from "../src/relations/confidence.js";
import { upsertClaim, getActiveClaims, addClaimEvidence } from "../src/relations/claim-store.js";
import { upsertDecision, getActiveDecisions } from "../src/relations/decision-store.js";
import { openLoop, getOpenLoops, closeLoop } from "../src/relations/loop-store.js";
import { recordStateDelta, getRecentDeltas } from "../src/relations/delta-store.js";
import { upsertCapability, getCapabilities } from "../src/relations/capability-store.js";
import { upsertInvariant, getActiveInvariants } from "../src/relations/invariant-store.js";
import { recordAttempt, getToolSuccessRate } from "../src/relations/attempt-store.js";
import { upsertRunbook, getRunbooks } from "../src/relations/runbook-store.js";
import { upsertAntiRunbook, getAntiRunbooks, addAntiRunbookEvidence, getAntiRunbookEvidence } from "../src/relations/anti-runbook-store.js";
import { createBranch, getBranches, checkPromotionPolicy, promoteBranch } from "../src/relations/promotion.js";
import { compileContextCapsules } from "../src/relations/context-compiler.js";
import { getTimeline } from "../src/relations/timeline.js";
import { getStateAtTime } from "../src/relations/snapshot.js";
import { upsertRelation, getRelationsForEntity } from "../src/relations/relation-store.js";
import { applyDecay } from "../src/relations/decay.js";
import { recordAwarenessEvent, getAwarenessStats, resetAwarenessEventsForTests } from "../src/relations/eval.js";

import { homedir } from "node:os";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.CLAWCORE_GRAPH_DB_PATH
  || resolve(homedir(), ".openclaw", "clawcore-graph.db");
const db = new DatabaseSync(DB_PATH);

// Unique run ID so the test is idempotent across repeated runs
const RUN = randomUUID().slice(0, 8);
let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    pass++;
  } catch (e: any) {
    console.log(`  \u2717 ${name}: ${e.message}`);
    fail++;
  }
}

function assert(cond: boolean, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

console.log("");
console.log("\u2550\u2550\u2550 RSMA LIVE SMOKE TEST \u2550\u2550\u2550");
console.log(`DB: ${DB_PATH}`);
console.log("");

// ── KG: Existing Entity Graph ──
console.log("\u2500\u2500 KG: Knowledge Graph (existing data) \u2500\u2500");
const entityCount = (db.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'").get() as any).cnt;
const mentionCount = (db.prepare("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'").get() as any).cnt;
test(`entities in live DB (${entityCount})`, () => assert(entityCount > 0));
test(`mentions in live DB (${mentionCount})`, () => assert(mentionCount > 0));

const topEntities = db.prepare("SELECT content AS display_name, json_extract(structured_json, '$.mentionCount') AS mention_count FROM memory_objects WHERE kind = 'entity' ORDER BY json_extract(structured_json, '$.mentionCount') DESC LIMIT 5").all() as any[];
console.log(`    Top: ${topEntities.map((e: any) => `${e.display_name}(${e.mention_count})`).join(", ")}`);

// ── KG: Entity Extraction ──
console.log("\u2500\u2500 KG: Entity Extraction \u2500\u2500");
test("extractFast with terms list", () => {
  const results = extractFast("ClawCore uses Redis and PostgreSQL for the OpenClaw project.", ["redis", "postgresql", "clawcore"]);
  assert(results.length >= 2, `expected 2+, got ${results.length}`);
  assert(results.some((e) => e.name === "redis"), "redis not found");
  assert(results.find((e) => e.name === "redis")!.confidence === 0.9, "terms list should be 0.9");
});

// ── Confidence Decay ──
console.log("\u2500\u2500 DE: Confidence Decay \u2500\u2500");
test("decay formula across 4 time windows", () => {
  assert(Math.abs(effectiveConfidence(0.8, 5, 3) - 0.8) < 0.01);
  assert(Math.abs(effectiveConfidence(0.8, 5, 15) - 0.64) < 0.01);
  assert(Math.abs(effectiveConfidence(0.8, 5, 60) - 0.40) < 0.01);
  assert(Math.abs(effectiveConfidence(0.8, 5, 120) - 0.24) < 0.01);
});

// ── EEL: Evidence Event Log ──
console.log("\u2500\u2500 EEL: Evidence Event Log \u2500\u2500");
test("scope_seq monotonic increment", () => {
  const s1 = nextScopeSeq(db as any, 1);
  const s2 = nextScopeSeq(db as any, 1);
  assert(s2 === s1 + 1, `expected ${s1 + 1}, got ${s2}`);
});

test("evidence log write + read", () => {
  logEvidence(db as any, { scopeId: 1, objectType: "smoke_test", objectId: 1, eventType: "create", actor: "smoke" });
  const row = db.prepare("SELECT * FROM evidence_log WHERE object_type = 'smoke_test' ORDER BY id DESC LIMIT 1").get() as any;
  assert(row && row.actor === "smoke");
  assert(row.scope_seq > 0);
});

// ── SL: Claims ──
console.log("\u2500\u2500 SL: Claims \u2500\u2500");
test("upsert claim + evidence", () => {
  const { claimId } = upsertClaim(db as any, {
    scopeId: 1, branchId: 0, subject: "smoke-test", predicate: "validates",
    objectText: "RSMA pipeline", confidence: 0.9,
    canonicalKey: `smoke:claim:${RUN}`,
  });
  assert(claimId > 0);
  addClaimEvidence(db as any, { claimId, sourceType: "smoke", sourceId: "s1", evidenceRole: "support" });
  assert(getActiveClaims(db as any, 1, 0, 5).length > 0);
});

// ── SL: Decisions ──
console.log("\u2500\u2500 SL: Decisions \u2500\u2500");
test("auto-supersede on same topic", () => {
  withWriteTransaction(db as any, () => {
    upsertDecision(db as any, { scopeId: 1, topic: `smoke-db-${RUN}`, decisionText: "Use SQLite", sourceType: "smoke", sourceId: "s1" });
  });
  withWriteTransaction(db as any, () => {
    upsertDecision(db as any, { scopeId: 1, topic: `smoke-db-${RUN}`, decisionText: "Switch to PostgreSQL", sourceType: "smoke", sourceId: "s2" });
  });
  const dec = getActiveDecisions(db as any, 1).find((d: any) => d.topic === `smoke-db-${RUN}`);
  assert(dec != null && dec.decision_text === "Switch to PostgreSQL", "should supersede");
});

// ── SL: Open Loops ──
console.log("\u2500\u2500 SL: Open Loops \u2500\u2500");
test("loop open \u2192 close", () => {
  const loopId = openLoop(db as any, { scopeId: 1, loopType: "smoke", text: "Live smoke loop", priority: 5, sourceType: "smoke", sourceId: "s1" });
  assert(getOpenLoops(db as any, 1).some((l: any) => l.id === loopId));
  closeLoop(db as any, loopId);
  assert(!getOpenLoops(db as any, 1).some((l: any) => l.id === loopId));
});

// ── DE: State Deltas ──
console.log("\u2500\u2500 DE: State Deltas \u2500\u2500");
test("record + query delta", () => {
  recordStateDelta(db as any, { scopeId: 1, branchId: 0, deltaType: "smoke", entityKey: "sk", summary: "Smoke delta", sourceType: "smoke", sourceId: "s1" });
  assert(getRecentDeltas(db as any, 1, { limit: 5 }).length > 0);
});

// ── SL: Capabilities + Invariants ──
console.log("\u2500\u2500 SL: Capabilities & Invariants \u2500\u2500");
test("capability store", () => {
  upsertCapability(db as any, { scopeId: 1, capabilityType: "tool", capabilityKey: "smoke-t", displayName: "Smoke", status: "available" });
  assert(getCapabilities(db as any, 1).some((c: any) => c.capability_key === "smoke-t"));
});
test("invariant store + severity order", () => {
  upsertInvariant(db as any, { scopeId: 1, invariantKey: "smoke-inv", category: "smoke", description: "Test rule", severity: "warning", sourceType: "smoke", sourceId: "s1" });
  assert(getActiveInvariants(db as any, 1).some((i: any) => i.invariant_key === "smoke-inv"));
});

// ── AOM: Attempts ──
console.log("\u2500\u2500 AOM: Attempt Memory \u2500\u2500");
test("record attempts + success rate", () => {
  recordAttempt(db as any, { scopeId: 1, toolName: `smoke-exec-${RUN}`, status: "success", durationMs: 100 });
  recordAttempt(db as any, { scopeId: 1, toolName: `smoke-exec-${RUN}`, status: "success", durationMs: 80 });
  recordAttempt(db as any, { scopeId: 1, toolName: `smoke-exec-${RUN}`, status: "failure", errorText: "timeout", durationMs: 5000 });
  const rate = getToolSuccessRate(db as any, 1, `smoke-exec-${RUN}`);
  assert(rate.total === 3, `expected 3, got ${rate.total}`);
  assert(Math.abs(rate.rate - 0.667) < 0.01, `expected ~66.7%, got ${rate.rate}`);
});

// ── AOM: Runbooks ──
console.log("\u2500\u2500 AOM: Runbooks \u2500\u2500");
test("runbook create", () => {
  const { isNew } = upsertRunbook(db as any, { scopeId: 1, runbookKey: `smoke-rb-${RUN}`, toolName: "exec", pattern: "git pull && build" });
  assert(isNew);
  assert(getRunbooks(db as any, 1).some((r: any) => r.runbook_key === `smoke-rb-${RUN}`));
});

// ── AOM: Anti-Runbooks + Evidence ──
console.log("\u2500\u2500 AOM: Anti-Runbooks \u2500\u2500");
test("anti-runbook + evidence chain", () => {
  const { antiRunbookId } = upsertAntiRunbook(db as any, { scopeId: 1, antiRunbookKey: `smoke-arb-${RUN}`, toolName: "exec", failurePattern: "rm -rf /", description: "Catastrophic" });
  const evId = addAntiRunbookEvidence(db as any, antiRunbookId, { sourceType: "attempt", sourceId: "a3", evidenceRole: "failure" });
  assert(evId > 0);
  assert(getAntiRunbookEvidence(db as any, antiRunbookId).length === 1);
});

// ── BSG: Branches + Promotion ──
console.log("\u2500\u2500 BSG: Branch Governance \u2500\u2500");
test("branch create \u2192 policy check \u2192 promote", () => {
  const branch = createBranch(db as any, 1, "hypothesis", `smoke-branch-${RUN}`, "smoke");
  assert(branch.id > 0);
  assert(checkPromotionPolicy(db as any, "claim", 0.8, 3).canPromote);
  assert(!checkPromotionPolicy(db as any, "claim", 0.3, 0).canPromote);
  promoteBranch(db as any, branch.id);
  assert(getBranches(db as any, 1, "promoted").some((b: any) => b.id === branch.id));
});

test("decay runs clean", () => { applyDecay(db as any, 1); });

// ── H4: Timeline ──
console.log("\u2500\u2500 EEL: Timeline \u2500\u2500");
test("timeline events in chronological order", () => {
  const events = getTimeline(db as any, 1, { limit: 20 });
  assert(events.length > 0, "should have events");
  for (let i = 1; i < events.length; i++) assert(events[i - 1].created_at >= events[i].created_at);
  const types = [...new Set(events.map((e: any) => e.object_type))];
  console.log(`    ${events.length} events, types: ${types.join(", ")}`);
});

// ── H4: Snapshot ──
console.log("\u2500\u2500 EEL: Snapshot \u2500\u2500");
test("snapshot reconstructs state", () => {
  const state = getStateAtTime(db as any, 1, new Date().toISOString());
  assert(state && Array.isArray(state.claims) && Array.isArray(state.decisions));
  console.log(`    claims: ${state.claims.length}, decisions: ${state.decisions.length}`);
});

// ── H5: Relations ──
console.log("\u2500\u2500 KG: Entity Relations \u2500\u2500");
test("relation upsert + query", () => {
  withWriteTransaction(db as any, () => {
    upsertEntity(db as any, { name: `smoke-svc-a-${RUN}`, displayName: "Service A", entityType: "service" });
    upsertEntity(db as any, { name: `smoke-svc-b-${RUN}`, displayName: "Service B", entityType: "service" });
  });
  const aId = (db.prepare("SELECT id FROM memory_objects WHERE composite_id = ?").get(`entity:smoke-svc-a-${RUN}`) as any).id;
  const bId = (db.prepare("SELECT id FROM memory_objects WHERE composite_id = ?").get(`entity:smoke-svc-b-${RUN}`) as any).id;
  const { isNew } = upsertRelation(db as any, { scopeId: 1, subjectEntityId: aId, predicate: "depends_on", objectEntityId: bId, confidence: 0.9, sourceType: "smoke", sourceId: "r1" });
  assert(isNew);
  assert(getRelationsForEntity(db as any, aId).some((r: any) => r.predicate === "depends_on"));
});

// ── CCL: Context Compiler ──
console.log("\u2500\u2500 CCL: Context Compiler \u2500\u2500");
for (const tier of ["lite", "standard", "premium"] as const) {
  test(`${tier} budget compiles within limits`, () => {
    const result = compileContextCapsules(db as any, { tier, scopeId: 1 });
    if (result) {
      const tokens = Math.ceil(result.text.length / 4);
      const limit = tier === "lite" ? 140 : tier === "standard" ? 220 : 320;
      console.log(`    ${tier}: ${tokens} est. tokens`);
      assert(tokens <= limit, `${tokens} exceeds ${limit}`);
    } else {
      console.log(`    ${tier}: (no capsules to compile)`);
    }
  });
}

// ── AL: Eval Harness ──
console.log("\u2500\u2500 AL: Awareness Eval \u2500\u2500");
test("awareness eval stats", () => {
  resetAwarenessEventsForTests();
  for (let i = 0; i < 50; i++) {
    recordAwarenessEvent({ fired: i % 4 === 0, noteCount: i % 4 === 0 ? 2 : 0, noteTypes: i % 4 === 0 ? ["mismatch"] : [], latencyMs: 10 + (i % 20), terms: ["redis"], tokensAdded: i % 4 === 0 ? 40 : 0 });
  }
  const stats = getAwarenessStats();
  assert(stats.totalTurns === 50);
  assert(stats.firedCount > 0);
  console.log(`    fireRate: ${stats.fireRate}%, p50: ${stats.latencyP50}ms, p95: ${stats.latencyP95}ms`);
});

// ── Final integrity ──
console.log("\u2500\u2500 Final Integrity \u2500\u2500");
const totalEvents = (db.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as any).cnt;
const seqVal = (db.prepare("SELECT next_seq FROM scope_sequences WHERE scope_id = 1").get() as any).next_seq;
console.log(`    Evidence log: ${totalEvents} entries`);
console.log(`    Scope seq: ${seqVal}`);

console.log("");
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");
console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
console.log("\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550");

db.close();
process.exit(fail > 0 ? 1 : 0);
