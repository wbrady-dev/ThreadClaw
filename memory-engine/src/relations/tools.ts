/**
 * cc_conflicts — agent tool for querying entity mismatches.
 *
 * Shows entities with possible context divergence across sources.
 * Framed as "possible mismatches" — not contradictions.
 */

import { Type } from "@sinclair/typebox";
import type { GraphDb } from "./types.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "../tools/common.js";
import { jsonResult } from "../tools/common.js";
import { escapeLike } from "../store/full-text-fallback.js";
import { getActiveClaims, getClaimsWithEvidence } from "./claim-store.js";
import { getActiveDecisions, getDecisionHistory } from "./decision-store.js";
import { getOpenLoops } from "./loop-store.js";
import { getAttemptHistory, getToolSuccessRate } from "./attempt-store.js";
import { getAntiRunbooks } from "./anti-runbook-store.js";
import { applyDecay } from "./decay.js";
import { getBranches, createBranch, promoteBranch, discardBranch, checkPromotionPolicy } from "./promotion.js";
import { getRunbooks, getRunbookWithEvidence } from "./runbook-store.js";
import { getAwarenessStats } from "./eval.js";
import { compileContextCapsules } from "./context-compiler.js";
import type { LcmContextEngine } from "../engine.js";


// ============================================================================
// Horizon 2 Tools
// ============================================================================

// ---------------------------------------------------------------------------

const CcClaimsSchema = Type.Object({
  subject: Type.Optional(
    Type.String({ description: "Filter by subject" }),
  ),
  scope_id: Type.Optional(
    Type.Number({ description: "Scope ID (default: 1 = global)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max claims to return (default: 20)", minimum: 1, maximum: 50 }),
  ),
});

export function createCcClaimsTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
}): AnyAgentTool {
  return {
    name: "cc_claims",
    label: "ClawCore Claims",
    description:
      "List claims with their supporting evidence. Claims are structured facts " +
      "extracted from tool results, user statements, and documents. " +
      "Filter by subject to focus on a specific entity or topic.",
    parameters: CcClaimsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const limit = typeof p.limit === "number" ? Math.min(50, Math.max(1, Math.trunc(p.limit))) : 20;
      const subject = typeof p.subject === "string" ? p.subject.trim() : undefined;

      try {
        const claims = getClaimsWithEvidence(input.graphDb, scopeId, { subject, limit });

        if (claims.length === 0) {
          return { content: [{ type: "text", text: "No claims found." }], details: { count: 0 } };
        }

        const lines: string[] = [`${claims.length} claim(s):\n`];
        for (const c of claims) {
          lines.push(`Claim: ${c.subject} ${c.predicate} = ${c.object_text ?? c.object_json ?? "(empty)"}`);
          lines.push(`  confidence=${c.confidence.toFixed(2)} trust=${c.trust_score.toFixed(2)} status=${c.status}`);
          if (c.evidence.length > 0) {
            lines.push(`  Evidence (${c.evidence.length}):`);
            for (const e of c.evidence.slice(0, 5)) {
              lines.push(`    [${e.evidence_role}] ${e.source_type}:${e.source_id} (${e.observed_at})`);
            }
          }
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: claims.length },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// cc_decisions — current and historical decisions
// ---------------------------------------------------------------------------

const CcDecisionsSchema = Type.Object({
  topic: Type.Optional(
    Type.String({ description: "Filter by topic (shows full history including superseded)" }),
  ),
  scope_id: Type.Optional(
    Type.Number({ description: "Scope ID (default: 1 = global)" }),
  ),
  include_superseded: Type.Optional(
    Type.Boolean({ description: "Include superseded decisions in output" }),
  ),
});

export function createCcDecisionsTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
}): AnyAgentTool {
  return {
    name: "cc_decisions",
    label: "ClawCore Decisions",
    description:
      "List active decisions. When a topic is specified, shows the full decision " +
      "history including superseded decisions. Decisions are automatically superseded " +
      "when a new decision on the same topic is recorded.",
    parameters: CcDecisionsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const topic = typeof p.topic === "string" ? p.topic.trim() : undefined;

      try {
        if (topic) {
          const history = getDecisionHistory(input.graphDb, scopeId, topic);
          if (history.length === 0) {
            return { content: [{ type: "text", text: `No decisions found for topic "${topic}".` }], details: { count: 0 } };
          }
          const lines: string[] = [`Decision history for "${topic}" (${history.length}):\n`];
          for (const d of history) {
            const marker = d.status === "active" ? "[ACTIVE]" : `[${d.status}]`;
            lines.push(`${marker} ${d.decision_text}`);
            lines.push(`  decided: ${d.decided_at}${d.superseded_by ? ` → superseded by #${d.superseded_by}` : ""}`);
            lines.push("");
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { count: history.length },
          };
        }

        const decisions = getActiveDecisions(input.graphDb, scopeId);
        if (decisions.length === 0) {
          return { content: [{ type: "text", text: "No active decisions." }], details: { count: 0 } };
        }
        const lines: string[] = [`${decisions.length} active decision(s):\n`];
        for (const d of decisions) {
          lines.push(`${d.topic}: ${d.decision_text}`);
          lines.push(`  decided: ${d.decided_at}`);
          lines.push("");
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: decisions.length },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}


// ---------------------------------------------------------------------------
// ============================================================================

// ---------------------------------------------------------------------------
// cc_loops — enhanced loop viewer
// ---------------------------------------------------------------------------

const CcLoopsSchema = Type.Object({
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1)" })),
  status: Type.Optional(Type.String({ description: "Filter: open, blocked, closed" })),
  limit: Type.Optional(Type.Number({ description: "Max loops (default: 20)", minimum: 1, maximum: 100 })),
});

export function createCcLoopsTool(input: { deps: LcmDependencies; graphDb: GraphDb }): AnyAgentTool {
  return {
    name: "cc_loops",
    label: "ClawCore Loops",
    description: "List open loops — tasks, questions, and dependencies being tracked.",
    parameters: CcLoopsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const status = typeof p.status === "string" ? p.status.trim() : undefined;
      const limit = typeof p.limit === "number" ? Math.min(100, Math.max(1, Math.trunc(p.limit))) : 20;
      try {
        const loops = getOpenLoops(input.graphDb, scopeId, undefined, limit, status);
        if (loops.length === 0) return { content: [{ type: "text", text: "No open loops." }], details: { count: 0 } };
        const lines: string[] = [`${loops.length} loop(s):\n`];
        for (const l of loops) {
          lines.push(`[${l.loop_type}:${l.status}] ${l.text} (priority=${l.priority})`);
          if (l.owner) lines.push(`  owner: ${l.owner}`);
          if (l.waiting_on) lines.push(`  waiting on: ${l.waiting_on}`);
          if (l.due_at) lines.push(`  due: ${l.due_at}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: loops.length } };
      } catch (err) { return jsonResult({ error: err instanceof Error ? err.message : String(err) }); }
    },
  };
}

// ---------------------------------------------------------------------------
// cc_attempts — tool outcome history
// ---------------------------------------------------------------------------

const CcAttemptsSchema = Type.Object({
  tool_name: Type.Optional(Type.String({ description: "Filter by tool name" })),
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1)" })),
  limit: Type.Optional(Type.Number({ description: "Max attempts (default: 20)", minimum: 1, maximum: 100 })),
});

export function createCcAttemptsTool(input: { deps: LcmDependencies; graphDb: GraphDb }): AnyAgentTool {
  return {
    name: "cc_attempts",
    label: "ClawCore Attempts",
    description: "Show tool outcome history with success rates.",
    parameters: CcAttemptsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const limit = typeof p.limit === "number" ? Math.min(100, Math.max(1, Math.trunc(p.limit))) : 20;
      const toolName = typeof p.tool_name === "string" ? p.tool_name.trim() : undefined;
      try {
        applyDecay(input.graphDb, scopeId);
        const attempts = getAttemptHistory(input.graphDb, scopeId, { toolName, limit });
        if (attempts.length === 0) return { content: [{ type: "text", text: "No attempts recorded." }], details: { count: 0 } };

        const lines: string[] = [];
        if (toolName) {
          const rate = getToolSuccessRate(input.graphDb, scopeId, toolName);
          lines.push(`${toolName}: ${(rate.rate * 100).toFixed(0)}% success (${rate.successes}/${rate.total})\n`);
        }
        lines.push(`${attempts.length} recent attempt(s):\n`);
        for (const a of attempts) {
          const dur = a.duration_ms != null ? ` ${a.duration_ms}ms` : "";
          lines.push(`[${a.status}] ${a.tool_name}${dur}`);
          if (a.error_text) lines.push(`  error: ${a.error_text}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: attempts.length } };
      } catch (err) { return jsonResult({ error: err instanceof Error ? err.message : String(err) }); }
    },
  };
}

// ---------------------------------------------------------------------------
// cc_branch — speculative branch management + promotion
// ---------------------------------------------------------------------------

const CcBranchSchema = Type.Object({
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1)" })),
  action: Type.Optional(Type.String({ description: "Action: list (default), create, discard, promote" })),
  branch_type: Type.Optional(Type.String({ description: "Branch type (for create)" })),
  branch_key: Type.Optional(Type.String({ description: "Branch key (for create)" })),
  branch_id: Type.Optional(Type.Number({ description: "Branch ID (for discard/promote)" })),
  status: Type.Optional(Type.String({ description: "Filter by status (for list)" })),
  object_type: Type.Optional(Type.String({ description: "Object type for promotion policy check" })),
  confidence: Type.Optional(Type.Number({ description: "Confidence level for promotion policy check" })),
  evidence_count: Type.Optional(Type.Number({ description: "Evidence count for promotion policy check" })),
  user_confirmed: Type.Optional(Type.Boolean({ description: "Whether user has confirmed promotion" })),
});

export function createCcBranchTool(input: { deps: LcmDependencies; graphDb: GraphDb }): AnyAgentTool {
  return {
    name: "cc_branch",
    label: "ClawCore Branches",
    description: "Manage speculative branches — create, list, discard, or promote branches for speculative memory.",
    parameters: CcBranchSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const action = typeof p.action === "string" ? p.action.trim() : "list";

      try {
        if (action === "create") {
          const branchType = typeof p.branch_type === "string" ? p.branch_type.trim() : "hypothesis";
          const branchKey = typeof p.branch_key === "string" ? p.branch_key.trim() : `branch-${Date.now()}`;
          const branch = createBranch(input.graphDb, scopeId, branchType, branchKey);
          return {
            content: [{ type: "text", text: `Branch created: #${branch.id} (${branchType}:${branchKey})` }],
            details: { branchId: branch.id },
          };
        }

        if (action === "discard") {
          const branchId = typeof p.branch_id === "number" ? Math.trunc(p.branch_id) : 0;
          if (!branchId) return jsonResult({ error: "branch_id required for discard" });
          discardBranch(input.graphDb, branchId);
          return { content: [{ type: "text", text: `Branch #${branchId} discarded.` }], details: { branchId } };
        }

        if (action === "promote") {
          const branchId = typeof p.branch_id === "number" ? Math.trunc(p.branch_id) : 0;
          if (!branchId) return jsonResult({ error: "branch_id required for promote" });
          const objectType = typeof p.object_type === "string" ? p.object_type.trim() : "claim";
          const confidence = typeof p.confidence === "number" ? p.confidence : 0.5;
          const evidenceCount = typeof p.evidence_count === "number" ? Math.trunc(p.evidence_count) : 1;
          const userConfirmed = typeof p.user_confirmed === "boolean" ? p.user_confirmed : false;
          const check = checkPromotionPolicy(input.graphDb, objectType, confidence, evidenceCount, userConfirmed);
          if (!check.canPromote) {
            return { content: [{ type: "text", text: `Promotion denied: ${check.reason}` }], details: { canPromote: false, reason: check.reason } };
          }
          promoteBranch(input.graphDb, branchId);
          return { content: [{ type: "text", text: `Branch #${branchId} promoted. ${check.reason}` }], details: { canPromote: true, branchId } };
        }

        // Default: list
        const status = typeof p.status === "string" ? p.status.trim() : undefined;
        const branches = getBranches(input.graphDb, scopeId, status);
        if (branches.length === 0) return { content: [{ type: "text", text: "No branches." }], details: { count: 0 } };
        const lines: string[] = [`${branches.length} branch(es):\n`];
        for (const b of branches) {
          lines.push(`#${b.id} [${b.status}] ${b.branch_type}:${b.branch_key}`);
          if (b.created_by_actor) lines.push(`  by: ${b.created_by_actor}`);
          if (b.promoted_at) lines.push(`  promoted: ${b.promoted_at}`);
          lines.push("");
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: { count: branches.length } };
      } catch (err) { return jsonResult({ error: err instanceof Error ? err.message : String(err) }); }
    },
  };
}

// ============================================================================
// Horizon 3-4: Procedural Memory Tools
// ============================================================================

// ---------------------------------------------------------------------------
// cc_procedures — unified success + failure patterns (replaces cc_runbooks + cc_antirunbooks)
// ---------------------------------------------------------------------------

const CcProceduresSchema = Type.Object({
  tool_name: Type.Optional(Type.String({ description: "Filter by tool name" })),
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1)" })),
  type: Type.Optional(Type.String({ description: "Filter by type: 'success' (runbooks), 'failure' (anti-runbooks), or 'all' (default)" })),
  runbook_id: Type.Optional(Type.Number({ description: "Get a specific runbook with full evidence chain" })),
});

export function createCcProceduresTool(input: { deps: LcmDependencies; graphDb: GraphDb }): AnyAgentTool {
  return {
    name: "cc_procedures",
    label: "ClawCore Procedures",
    description: "Show learned success patterns (runbooks) and failure patterns (anti-runbooks) from tool outcomes.",
    parameters: CcProceduresSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const toolName = typeof p.tool_name === "string" ? p.tool_name.trim() : undefined;
      const type = typeof p.type === "string" ? p.type.trim() : "all";
      const runbookId = typeof p.runbook_id === "number" ? Math.trunc(p.runbook_id) : undefined;

      try {
        // Detail view for specific runbook
        if (runbookId) {
          const rb = getRunbookWithEvidence(input.graphDb, runbookId);
          if (!rb) return { content: [{ type: "text", text: `Runbook #${runbookId} not found.` }], details: { found: false } };
          const lines: string[] = [
            `Runbook #${rb.id}: ${rb.tool_name}`,
            `  pattern: ${rb.pattern}`,
            `  success: ${rb.success_count} | failure: ${rb.failure_count} | confidence: ${rb.confidence.toFixed(2)}`,
            rb.description ? `  ${rb.description}` : "",
            `  Evidence (${rb.evidence.length}):`,
          ];
          for (const e of rb.evidence.slice(0, 10)) {
            lines.push(`    [${e.evidence_role}] ${e.source_type}:${e.source_id} (${e.recorded_at})`);
          }
          return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }], details: { found: true, runbookId: rb.id } };
        }

        applyDecay(input.graphDb, scopeId);
        const sections: string[] = [];

        // Success patterns (runbooks)
        if (type === "all" || type === "success") {
          const runbooks = getRunbooks(input.graphDb, scopeId, { toolName });
          if (runbooks.length > 0) {
            const lines: string[] = [`${runbooks.length} success pattern(s):\n`];
            for (const rb of runbooks) {
              const rate = (rb.success_count + rb.failure_count) > 0
                ? ((rb.success_count / (rb.success_count + rb.failure_count)) * 100).toFixed(0) : "N/A";
              lines.push(`[${rb.tool_name}] ${rb.pattern}`);
              lines.push(`  success rate: ${rate}% (${rb.success_count}/${rb.success_count + rb.failure_count}) | confidence: ${rb.confidence.toFixed(2)}`);
              lines.push("");
            }
            sections.push(lines.join("\n"));
          }
        }

        // Failure patterns (anti-runbooks)
        if (type === "all" || type === "failure") {
          const antiRbs = getAntiRunbooks(input.graphDb, scopeId, { toolName });
          if (antiRbs.length > 0) {
            const lines: string[] = [`${antiRbs.length} failure pattern(s) to AVOID:\n`];
            for (const ar of antiRbs) {
              lines.push(`[${ar.tool_name}] AVOID: ${ar.failure_pattern}`);
              if (ar.description) lines.push(`  ${ar.description}`);
              lines.push(`  failures: ${ar.failure_count} | confidence: ${ar.confidence.toFixed(2)}`);
              lines.push("");
            }
            sections.push(lines.join("\n"));
          }
        }

        if (sections.length === 0) return { content: [{ type: "text", text: "No procedures recorded." }], details: { count: 0 } };
        return { content: [{ type: "text", text: sections.join("\n") }], details: { type } };
      } catch (err) { return jsonResult({ error: err instanceof Error ? err.message : String(err) }); }
    },
  };
}

// ============================================================================


// ═══════════════════════════════════════════════════════════════════
// cc_diagnostics — internal RSMA health + observability
// ═══════════════════════════════════════════════════════════════════

const CcDiagnosticsSchema = Type.Object({
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1 = global)" })),
  verbose: Type.Optional(Type.Boolean({ description: "Include capsule text and recent events (default: false)" })),
});

export function createCcDiagnosticsTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
  lcm: LcmContextEngine;
}): AnyAgentTool {
  return {
    name: "cc_diagnostics",
    label: "ClawCore Diagnostics",
    description:
      "Show internal RSMA health: summary counts, claim counts, awareness stats, " +
      "context compiler output, recent evidence events, and compaction state. " +
      "Use this to verify what is actually working, not to answer user questions.",
    parameters: CcDiagnosticsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const verbose = typeof p.verbose === "boolean" ? p.verbose : false;

      try {
        const db = input.graphDb;
        const sections: string[] = [];

        // ── Memory Engine Stats ──
        let totalConversations = 0;
        let totalSummaries = 0;
        let totalMessages = 0;
        try {
          const convStore = input.lcm.getConversationStore();
          const sumStore = input.lcm.getSummaryStore();
          // Use the store's internal db to count — these are synchronous SQLite calls
          const storeDb = (convStore as any).db;
          if (storeDb) {
            totalConversations = (storeDb.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as any)?.cnt ?? 0;
            totalMessages = (storeDb.prepare("SELECT COUNT(*) as cnt FROM messages").get() as any)?.cnt ?? 0;
          }
          const sumDb = (sumStore as any).db;
          if (sumDb) {
            totalSummaries = (sumDb.prepare("SELECT COUNT(*) as cnt FROM summaries").get() as any)?.cnt ?? 0;
          }
        } catch {}

        sections.push(`[Memory Engine]
  Conversations: ${totalConversations}
  Messages: ${totalMessages}
  Summaries: ${totalSummaries}`);

        // ── Evidence Graph Stats ──
        const safe = (sql: string): number => {
          try { return (db.prepare(sql).get() as { cnt: number }).cnt; } catch { return -1; }
        };

        const entities = safe("SELECT COUNT(*) as cnt FROM entities");
        const mentions = safe("SELECT COUNT(*) as cnt FROM entity_mentions");
        const claims = safe("SELECT COUNT(*) as cnt FROM claims WHERE status = 'active'");
        const decisions = safe("SELECT COUNT(*) as cnt FROM decisions WHERE status = 'active'");
        const loops = safe("SELECT COUNT(*) as cnt FROM open_loops WHERE status IN ('open','blocked')");
        const attempts = safe("SELECT COUNT(*) as cnt FROM attempts");
        const rbooks = safe("SELECT COUNT(*) as cnt FROM runbooks WHERE status = 'active'");
        const arbooks = safe("SELECT COUNT(*) as cnt FROM anti_runbooks WHERE status = 'active'");
        const evEvents = safe("SELECT COUNT(*) as cnt FROM evidence_log");
        const rels = safe("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'relates_to'");
        const n = (v: number) => v >= 0 ? String(v) : "n/a";

        sections.push(`[Evidence Graph]
  Entities: ${n(entities)}  |  Mentions: ${n(mentions)}  |  Relations: ${n(rels)}
  Claims: ${n(claims)}  |  Decisions: ${n(decisions)}  |  Loops: ${n(loops)}
  Attempts: ${n(attempts)}  |  Runbooks: ${n(rbooks)}  |  Anti-Runbooks: ${n(arbooks)}
  Evidence Events: ${n(evEvents)}`);

        // ── Awareness Stats ──
        const aw = getAwarenessStats();
        sections.push(`[Awareness Layer]
  Turns: ${aw.totalTurns}  |  Fired: ${aw.firedCount} (${aw.fireRate}%)
  Latency: p50=${aw.latencyP50}ms  p95=${aw.latencyP95}ms
  Avg tokens when fired: ${aw.avgTokensWhenFired}
  Note types: ${Object.entries(aw.noteTypeBreakdown).map(([k, v]) => `${k}(${v})`).join(", ") || "none yet"}`);

        // ── Context Compiler ──
        const tier = input.deps.config.relationsContextTier ?? "standard";
        const compiled = compileContextCapsules(db, { tier, scopeId });
        const capsule = compiled?.text ?? null;
        const capTokens = compiled?.tokensUsed ?? 0;
        sections.push(`[Context Compiler]
  Tier: ${tier}  |  Capsule tokens: ${capTokens}  |  Capsules: ${compiled?.capsuleCount ?? 0}
  Producing capsules: ${capsule ? "yes" : "no (nothing scored above threshold)"}`);

        if (verbose && capsule) {
          sections.push(`[Capsule Content]\n${capsule}`);
        }

        // ── Recent Evidence Events ──
        if (verbose) {
          try {
            const recent = db.prepare(
              "SELECT object_type, event_type, actor, created_at FROM evidence_log ORDER BY id DESC LIMIT 15"
            ).all() as Array<{ object_type: string; event_type: string; actor: string; created_at: string }>;
            if (recent.length > 0) {
              sections.push(`[Recent Events (last ${recent.length})]\n` +
                recent.map(e => `  ${e.created_at} ${e.object_type}/${e.event_type} by ${e.actor || "system"}`).join("\n"));
            }
          } catch {}
        }

        // ── Archive Stats ──
        try {
          const { getArchiveStats } = await import("./archive.js");
          const { resolve } = await import("path");
          const { homedir } = await import("os");
          const archivePath = resolve(homedir(), ".clawcore", "data", "archive.db");
          const archiveStats = getArchiveStats(archivePath);
          if (archiveStats) {
            sections.push(`[Cold Archive]
  Claims: ${archiveStats.claims}  |  Decisions: ${archiveStats.decisions}
  Events: ${archiveStats.events}  |  Loops: ${archiveStats.loops}
  Last run: ${archiveStats.lastRun ?? "never"}`);
          }
        } catch {}

        // ── Config ──
        const c = input.deps.config;
        sections.push(`[Config]
  Relations: ${c.relationsEnabled}  |  Awareness: ${c.relationsAwarenessEnabled}
  Claims: ${c.relationsClaimExtractionEnabled}  |  Attempts: ${c.relationsAttemptTrackingEnabled}
  Deep extraction: ${c.relationsDeepExtractionEnabled}  |  Tier: ${c.relationsContextTier ?? "standard"}`);

        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          details: {
            entities, mentions, claims, decisions, loops, attempts,
            evidenceEvents: evEvents, totalSummaries, totalConversations, totalMessages,
            awarenessFireRate: aw.fireRate, capsuleTokens: capTokens,
          },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// cc_memory — unified smart memory tool
// ═══════════════════════════════════════════════════════════════════

const CcMemorySchema = Type.Object({
  query: Type.String({ description: "What to find or recall — a question, topic, name, or keyword" }),
  scope: Type.Optional(Type.String({ description: "Optional: 'all' to search across all conversations (default: current)" })),
});

/**
 * Unified memory tool — replaces the need for agents to choose between
 * cc_recall, cc_grep, cc_claims, cc_decisions, cc_relate, cc_state, etc.
 *
 * Routes internally based on query content:
 * 1. Check claims/decisions/state for structured facts
 * 2. Check relationships (claims with relational predicates)
 * 3. Search conversation history (grep)
 * 4. Return merged results with source labels
 */
export function createCcMemoryTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    name: "cc_memory",
    label: "ClawCore Memory",
    description:
      "Search ClawCore's memory for any fact, decision, relationship, or past conversation. " +
      "Automatically searches claims, decisions, relationships, and conversation history. " +
      "Just describe what you're looking for — the system routes to the right source.",
    parameters: CcMemorySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = typeof p.query === "string" ? p.query.trim() : "";
      const searchAll = p.scope === "all";

      if (!query) return jsonResult({ error: "query is required" });

      try {
        const db = input.graphDb;
        const sections: string[] = [];
        const sources: string[] = [];
        let tokenBudget = 600;

        const queryLower = query.toLowerCase();

        // ── 1. Search claims (structured facts) ──
        const claimTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
        if (claimTerms.length > 0) {
          const likeConditions = claimTerms.map(() => "(subject LIKE ? ESCAPE '\\' OR object_text LIKE ? ESCAPE '\\')").join(" OR ");
          const likeArgs = claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const claims = db.prepare(`
            SELECT subject, predicate, object_text, confidence
            FROM claims WHERE status = 'active' AND (${likeConditions})
            ORDER BY confidence DESC LIMIT 5
          `).all(...likeArgs) as Array<{
            subject: string; predicate: string; object_text: string | null; confidence: number;
          }>;

          if (claims.length > 0) {
            sources.push("claims");
            const lines: string[] = [];
            for (const c of claims) {
              const line = `• ${c.subject} ${c.predicate}: ${c.object_text ?? "(empty)"}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              sections.push("[Known Facts]\n" + lines.join("\n"));
            }
          }
        }

        // ── 2. Search decisions ──
        if (claimTerms.length > 0) {
          const decConditions = claimTerms.map(() => "(topic LIKE ? ESCAPE '\\' OR decision_text LIKE ? ESCAPE '\\')").join(" OR ");
          const decArgs = claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const decisions = db.prepare(`
            SELECT topic, decision_text, decided_at
            FROM decisions WHERE status = 'active' AND (${decConditions})
            ORDER BY decided_at DESC LIMIT 3
          `).all(...decArgs) as Array<{
            topic: string; decision_text: string; decided_at: string;
          }>;

          if (decisions.length > 0) {
            sources.push("decisions");
            const lines: string[] = [];
            for (const d of decisions) {
              const line = `• ${d.decision_text}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              sections.push("[Decisions]\n" + lines.join("\n"));
            }
          }
        }

        // ── 3. Search relationships (claims with relational predicates) ──
        if (claimTerms.length > 0) {
          const relConditions = claimTerms.map(() => "(subject LIKE ? ESCAPE '\\' OR object_text LIKE ? ESCAPE '\\')").join(" OR ");
          const relArgs = claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const rels = db.prepare(`
            SELECT subject, predicate, object_text
            FROM claims WHERE status = 'active'
              AND predicate NOT IN ('is', 'states')
              AND (${relConditions})
            ORDER BY confidence DESC LIMIT 5
          `).all(...relArgs) as Array<{
            subject: string; predicate: string; object_text: string | null;
          }>;

          if (rels.length > 0) {
            sources.push("relationships");
            const lines: string[] = [];
            for (const r of rels) {
              const line = `• ${r.subject} —[${r.predicate}]→ ${r.object_text ?? ""}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              sections.push("[Relationships]\n" + lines.join("\n"));
            }
          }
        }

        // ── 4. Search conversation history (grep) ──
        if (tokenBudget > 100) {
          try {
            const retrieval = input.lcm.getRetrieval();

            // Resolve conversation scope
            const { resolveLcmConversationScope } = await import("../tools/lcm-conversation-scope.js");
            const scope = await resolveLcmConversationScope({
              lcm: input.lcm,
              params: searchAll ? { allConversations: true } : {},
              sessionId: input.sessionId,
              sessionKey: input.sessionKey,
              agentId: input.agentId,
              deps: input.deps,
            });

            const grepResult = await retrieval.grep({
              query,
              mode: "full_text",
              scope: "both",
              conversationId: scope.conversationId,
              conversationIds: scope.conversationIds,
            });

            // Summaries first
            if (grepResult.summaries.length > 0) {
              sources.push("summaries");
              const lines: string[] = [];
              for (const s of grepResult.summaries.slice(0, 3)) {
                const snippet = s.snippet ?? "(no snippet)";
                const line = `• ${snippet}`;
                const cost = Math.ceil(line.length / 4);
                if (tokenBudget - cost < 0) break;
                tokenBudget -= cost;
                lines.push(line);
              }
              if (lines.length > 0) {
                sections.push("[From Summaries]\n" + lines.join("\n"));
              }
            }

            // Messages if budget remains
            if (grepResult.messages.length > 0 && tokenBudget > 50) {
              sources.push("messages");
              const lines: string[] = [];
              for (const m of grepResult.messages.slice(0, 3)) {
                const snippet = m.snippet ?? "(no snippet)";
                const line = `• ${snippet}`;
                const cost = Math.ceil(line.length / 4);
                if (tokenBudget - cost < 0) break;
                tokenBudget -= cost;
                lines.push(line);
              }
              if (lines.length > 0) {
                sections.push("[From Conversation]\n" + lines.join("\n"));
              }
            }
          } catch {
            // Conversation search failed — still return evidence results
          }
        }

        // ── Result ──
        // ── 5. If nothing found anywhere, try RAG document search as final fallback ──
        if (sections.length === 0 && tokenBudget > 100) {
          try {
            const ragPort = process.env.CLAWCORE_PORT ?? "18800";
            const ragResult = await fetch(`http://127.0.0.1:${ragPort}/query`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query, collection: "all", mode: "brief", topK: 3 }),
              signal: AbortSignal.timeout(5000),
            });
            if (ragResult.ok) {
              const ragData = await ragResult.json() as { context?: string; sources?: Array<{ source: string }> };
              const ragText = (ragData.context ?? "").trim();
              if (ragText && ragText !== "No relevant documents found.") {
                sources.push("documents");
                sections.push("[From Documents]\n" + ragText.substring(0, tokenBudget * 4));
              }
            }
          } catch {
            // RAG unavailable — non-fatal
          }
        }

        if (sections.length === 0) {
          const hint = !searchAll ? "\nNo results found. Do you want me to look in other active conversations?" : "";
          return jsonResult({
            answer: "Nothing found in memory or documents for this query." + hint,
            mode: "no_results",
            searched: ["claims", "decisions", "relationships", "messages", "documents"],
          });
        }

        return {
          content: [{ type: "text", text: sections.join("\n\n") }],
          details: {
            mode: "cc_memory",
            sources,
            sectionsReturned: sections.length,
          },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
