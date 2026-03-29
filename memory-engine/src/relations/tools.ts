/**
 * cc_conflicts — agent tool for querying entity mismatches.
 *
 * Shows entities with possible context divergence across sources.
 * Framed as "possible mismatches" — not contradictions.
 */

import { Type } from "@sinclair/typebox";
import type { GraphDb, UpdateLoopInput } from "./types.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "../tools/common.js";
import { jsonResult } from "../tools/common.js";
import { escapeLike } from "../store/full-text-fallback.js";
import { getClaimsWithEvidence } from "./claim-store.js";
import { getActiveDecisions, getDecisionHistory } from "./decision-store.js";
import { getOpenLoops, closeLoop, updateLoop } from "./loop-store.js";
import { getAttemptHistory, getToolSuccessRate } from "./attempt-store.js";
import { getAntiRunbooks } from "./anti-runbook-store.js";
import { applyDecay } from "./decay.js";
import { getBranches, createBranch, promoteBranch, discardBranch, checkPromotionPolicy } from "./promotion.js";
import { getRunbooks, getRunbookWithEvidence } from "./runbook-store.js";
import { getAwarenessStats } from "./eval.js";
import { compileContextCapsules } from "./context-compiler.js";
import { getRelationGraph } from "./relation-store.js";
import { synthesizeScope } from "./synthesis.js";
import { safeParseStructured } from "../ontology/json-utils.js";
import { updateMemoryObjectStatus } from "../ontology/mo-store.js";
import type { LcmContextEngine } from "../engine.js";
import type { LcmConfig } from "../db/config.js";
import { getLcmDbFeatures } from "../db/features.js";
import { sanitizeFts5Query } from "../store/fts5-sanitize.js";
import type { DatabaseSync } from "node:sqlite";

/**
 * Build an FTS5 MATCH clause for memory_objects content search.
 * Returns null if FTS5 is unavailable or the query can't be sanitized.
 * Caller should fall back to LIKE when this returns null.
 */
function buildFtsClause(db: GraphDb, searchTerms: string[]): { clause: string; args: unknown[] } | null {
  try {
    const features = getLcmDbFeatures(db as unknown as DatabaseSync);
    if (!features.fts5Available) return null;
    const ftsQuery = sanitizeFts5Query(searchTerms.join(" "));
    if (!ftsQuery) return null;
    return {
      clause: "id IN (SELECT rowid FROM memory_objects_fts WHERE memory_objects_fts MATCH ?)",
      args: [ftsQuery],
    };
  } catch { return null; }
}


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
    label: "ThreadClaw Claims",
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
});

export function createCcDecisionsTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
}): AnyAgentTool {
  return {
    name: "cc_decisions",
    label: "ThreadClaw Decisions",
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
    label: "ThreadClaw Loops",
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
// cc_manage_loop — close, update, or change loop status/priority
// ---------------------------------------------------------------------------

const CcManageLoopSchema = Type.Object({
  action: Type.String({ description: "Action: close, update" }),
  loop_id: Type.Number({ description: "Loop ID (numeric) to close or update" }),
  priority: Type.Optional(Type.Number({ description: "New priority (0-10)" })),
  owner: Type.Optional(Type.String({ description: "New owner" })),
  waiting_on: Type.Optional(Type.String({ description: "What/who this loop is waiting on" })),
  status: Type.Optional(Type.String({ description: "Loop status: open, blocked, closed, stale" })),
});

export function createCcManageLoopTool(input: { deps: LcmDependencies; graphDb: GraphDb }): AnyAgentTool {
  return {
    name: "cc_manage_loop",
    label: "ThreadClaw Manage Loop",
    description:
      "Close or update an open loop. Use action='close' to mark a loop done, " +
      "or action='update' to change priority, owner, waiting_on, or status.",
    parameters: CcManageLoopSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action.trim() : "";
      const loopId = typeof p.loop_id === "number" ? Math.trunc(p.loop_id) : 0;

      if (!loopId) return jsonResult({ error: "loop_id is required" });

      try {
        if (action === "close") {
          closeLoop(input.graphDb, loopId);
          return {
            content: [{ type: "text", text: `Loop #${loopId} closed.` }],
            details: { loopId, action: "close" },
          };
        }

        if (action === "update") {
          const updateInput: UpdateLoopInput = { loopId };
          if (typeof p.priority === "number") updateInput.priority = Math.min(10, Math.max(0, Math.trunc(p.priority)));
          if (typeof p.waiting_on === "string") updateInput.waitingOn = p.waiting_on.trim();
          if (typeof p.status === "string") updateInput.status = p.status.trim() as UpdateLoopInput["status"];
          if (typeof p.owner === "string") updateInput.owner = p.owner.trim();

          updateLoop(input.graphDb, updateInput);

          const { loopId: _id, ...changedFields } = updateInput;
          const changed = Object.keys(changedFields);
          return {
            content: [{ type: "text", text: `Loop #${loopId} updated: ${changed.join(", ")}.` }],
            details: { loopId, action: "update", changed },
          };
        }

        return jsonResult({ error: `Unknown action "${action}". Use "close" or "update".` });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
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
    label: "ThreadClaw Attempts",
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
  action: Type.Optional(Type.String({ description: "Action: list (default), create, discard, promote, view" })),
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
    label: "ThreadClaw Branches",
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

        if (action === "view") {
          const branchId = typeof p.branch_id === "number" ? Math.trunc(p.branch_id) : 0;
          if (!branchId) return jsonResult({ error: "branch_id required for view" });
          const rows = input.graphDb.prepare(
            "SELECT id, composite_id, kind, content, confidence FROM memory_objects WHERE branch_id = ? AND status = 'active' ORDER BY kind, updated_at DESC",
          ).all(branchId) as Array<{ id: number; composite_id: string; kind: string; content: string; confidence: number }>;
          if (rows.length === 0) {
            return { content: [{ type: "text", text: `Branch #${branchId} has no active objects.` }], details: { branchId, count: 0 } };
          }
          // Group by kind
          const grouped: Record<string, typeof rows> = {};
          for (const r of rows) {
            (grouped[r.kind] ??= []).push(r);
          }
          const lines: string[] = [`Branch #${branchId}: ${rows.length} active object(s)\n`];
          for (const [kind, items] of Object.entries(grouped)) {
            lines.push(`── ${kind} (${items.length}) ──`);
            for (const item of items.slice(0, 20)) {
              lines.push(`  [${item.composite_id}] conf=${item.confidence.toFixed(2)}: ${item.content.substring(0, 100)}`);
            }
            lines.push("");
          }
          return { content: [{ type: "text", text: lines.join("\n") }], details: { branchId, count: rows.length, kinds: Object.keys(grouped) } };
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
    label: "ThreadClaw Procedures",
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
    label: "ThreadClaw Diagnostics",
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
          // Use the store's public getDb() accessor for stat queries
          const storeDb = convStore.getDb();
          if (storeDb) {
            totalConversations = (storeDb.prepare("SELECT COUNT(*) as cnt FROM conversations").get() as { cnt: number })?.cnt ?? 0;
            totalMessages = (storeDb.prepare("SELECT COUNT(*) as cnt FROM messages").get() as { cnt: number })?.cnt ?? 0;
          }
          const sumDb = sumStore.getDb();
          if (sumDb) {
            totalSummaries = (sumDb.prepare("SELECT COUNT(*) as cnt FROM summaries").get() as { cnt: number })?.cnt ?? 0;
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

        const entities = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity' AND status = 'active'");
        const mentions = safe("SELECT COUNT(*) as cnt FROM provenance_links WHERE predicate = 'mentioned_in'");
        const claims = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'claim' AND status = 'active'");
        const decisions = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'decision' AND status = 'active'");
        const loops = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'loop' AND status IN ('active','blocked')");
        const attempts = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'attempt'");
        const rbooks = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'procedure' AND status = 'active' AND (json_extract(structured_json, '$.isNegative') IS NULL OR json_extract(structured_json, '$.isNegative') = 0)");
        const arbooks = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'procedure' AND status = 'active' AND json_extract(structured_json, '$.isNegative') = 1");
        const evEvents = safe("SELECT COUNT(*) as cnt FROM evidence_log");
        const rels = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'relation' AND status = 'active'");
        const invariants = safe("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'invariant' AND status = 'active'");
        const n = (v: number) => v >= 0 ? String(v) : "n/a";

        sections.push(`[Evidence Graph]
  Entities: ${n(entities)}  |  Mentions: ${n(mentions)}  |  Relations: ${n(rels)}
  Claims: ${n(claims)}  |  Decisions: ${n(decisions)}  |  Loops: ${n(loops)}
  Invariants: ${n(invariants)}  |  Attempts: ${n(attempts)}
  Runbooks: ${n(rbooks)}  |  Anti-Runbooks: ${n(arbooks)}
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
          const archivePath = resolve(homedir(), ".threadclaw", "data", "archive.db");
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
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1 = global)" })),
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
    label: "ThreadClaw Memory",
    description:
      "Search ThreadClaw's memory for any fact, entity, relationship, decision, or past conversation. " +
      "Automatically searches claims, entities, entity-to-entity relations, decisions, and conversation history. " +
      "Just describe what you're looking for — the system routes to the right source.",
    parameters: CcMemorySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const query = typeof p.query === "string" ? p.query.trim() : "";
      const searchAll = p.scope === "all";
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;

      if (!query) return jsonResult({ error: "query is required" });

      try {
        const db = input.graphDb;
        const sections: string[] = [];
        const sources: string[] = [];
        let tokenBudget = 900;

        const queryLower = query.toLowerCase();

        // ── 1. Search claims (structured facts) ──
        const claimTerms = queryLower.split(/\s+/).filter((t) => t.length > 2);
        if (claimTerms.length > 0) {
          const fts = buildFtsClause(db, claimTerms);
          const searchClause = fts
            ? fts.clause
            : claimTerms.map(() => "(content LIKE ? ESCAPE '\\' OR structured_json LIKE ? ESCAPE '\\')").join(" OR ");
          const searchArgs = fts
            ? fts.args
            : claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const claims = db.prepare(`
            SELECT json_extract(structured_json, '$.subject') as subject,
                   json_extract(structured_json, '$.predicate') as predicate,
                   json_extract(structured_json, '$.objectText') as object_text,
                   confidence
            FROM memory_objects WHERE kind = 'claim' AND status = 'active' AND (${searchClause})
            ORDER BY confidence DESC LIMIT 5
          `).all(...searchArgs) as Array<{
            subject: string; predicate: string; object_text: string | null; confidence: number;
          }>;

          if (claims.length > 0) {
            const lines: string[] = [];
            for (const c of claims) {
              const line = `• ${c.subject} ${c.predicate}: ${c.object_text ?? "(empty)"}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              const header = "[Resolved Facts — current state]\n";
              tokenBudget -= Math.ceil(header.length / 4);
              sources.push("claims");
              sections.push(header + lines.join("\n"));
            }
          }
        }

        // ── 2. Search decisions ──
        if (claimTerms.length > 0) {
          const fts2 = buildFtsClause(db, claimTerms);
          const decClause = fts2
            ? fts2.clause
            : claimTerms.map(() => "(content LIKE ? ESCAPE '\\' OR structured_json LIKE ? ESCAPE '\\')").join(" OR ");
          const decArgs = fts2
            ? fts2.args
            : claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const decisions = db.prepare(`
            SELECT json_extract(structured_json, '$.topic') as topic,
                   COALESCE(json_extract(structured_json, '$.decisionText'), content) as decision_text,
                   created_at as decided_at
            FROM memory_objects WHERE kind = 'decision' AND status = 'active' AND (${decClause})
            ORDER BY created_at DESC LIMIT 3
          `).all(...decArgs) as Array<{
            topic: string; decision_text: string; decided_at: string;
          }>;

          if (decisions.length > 0) {
            const lines: string[] = [];
            for (const d of decisions) {
              const line = `• ${d.decision_text}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              const header = "[Active Decisions]\n";
              tokenBudget -= Math.ceil(header.length / 4);
              sources.push("decisions");
              sections.push(header + lines.join("\n"));
            }
          }
        }

        // ── 3. Search entities ──
        if (claimTerms.length > 0) {
          const fts3 = buildFtsClause(db, claimTerms);
          const entClause = fts3
            ? fts3.clause
            : claimTerms.map(() => "(content LIKE ? ESCAPE '\\' OR structured_json LIKE ? ESCAPE '\\')").join(" OR ");
          const entArgs = fts3
            ? fts3.args
            : claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const entities = db.prepare(`
            SELECT id, canonical_key,
                   COALESCE(json_extract(structured_json, '$.displayName'), json_extract(structured_json, '$.name'), canonical_key) as name,
                   json_extract(structured_json, '$.type') as entity_type
            FROM memory_objects WHERE kind = 'entity' AND status = 'active'
              AND (${entClause})
            ORDER BY confidence DESC LIMIT 5
          `).all(...entArgs) as Array<{
            id: number; canonical_key: string; name: string; entity_type: string | null;
          }>;

          if (entities.length > 0) {
            const lines: string[] = [];
            for (const e of entities) {
              const typeLabel = e.entity_type ? ` (${e.entity_type})` : "";
              const line = `• ${e.name}${typeLabel}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              const header = "[Entities]\n";
              tokenBudget -= Math.ceil(header.length / 4);
              sources.push("entities");
              sections.push(header + lines.join("\n"));
            }
          }
        }

        // ── 3b. Search entity-to-entity relations (provenance_links) ──
        {
          try {
            const allRels = getRelationGraph(db, scopeId, { limit: 30 });

            if (allRels.length > 0) {
              // Score relations: those matching query terms sort first, rest follow
              const scored = allRels.map((r) => {
                const text = `${r.subject_name} ${r.predicate} ${r.object_name}`.toLowerCase();
                const matchCount = claimTerms.filter((t) => text.includes(t)).length;
                return { rel: r, score: matchCount };
              });
              scored.sort((a, b) => b.score - a.score || b.rel.confidence - a.rel.confidence);

              const lines: string[] = [];
              for (const { rel: r } of scored.slice(0, 12)) {
                const line = `• ${r.subject_name} —[${r.predicate}]→ ${r.object_name} (conf=${r.confidence.toFixed(2)})`;
                const cost = Math.ceil(line.length / 4);
                if (tokenBudget - cost < 0) break;
                tokenBudget -= cost;
                lines.push(line);
              }
              if (lines.length > 0) {
                const header = "[Relations — entity connections]\n";
                tokenBudget -= Math.ceil(header.length / 4);
                sources.push("relations");
                sections.push(header + lines.join("\n"));
              }
            }
          } catch { /* relation graph lookup non-fatal */ }

          // Also keep claim-based relational predicates as a supplementary source
          const fts4 = buildFtsClause(db, claimTerms);
          const relClause = fts4
            ? fts4.clause
            : claimTerms.map(() => "(content LIKE ? ESCAPE '\\' OR structured_json LIKE ? ESCAPE '\\')").join(" OR ");
          const relArgs = fts4
            ? fts4.args
            : claimTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

          const claimRels = db.prepare(`
            SELECT json_extract(structured_json, '$.subject') as subject,
                   json_extract(structured_json, '$.predicate') as predicate,
                   json_extract(structured_json, '$.objectText') as object_text
            FROM memory_objects WHERE kind = 'claim' AND status = 'active'
              AND json_extract(structured_json, '$.predicate') NOT IN ('is', 'states')
              AND (${relClause})
            ORDER BY confidence DESC LIMIT 5
          `).all(...relArgs) as Array<{
            subject: string; predicate: string; object_text: string | null;
          }>;

          if (claimRels.length > 0 && !sources.includes("relations")) {
            const lines: string[] = [];
            for (const r of claimRels) {
              const line = `• ${r.subject} —[${r.predicate}]→ ${r.object_text ?? ""}`;
              const cost = Math.ceil(line.length / 4);
              if (tokenBudget - cost < 0) break;
              tokenBudget -= cost;
              lines.push(line);
            }
            if (lines.length > 0) {
              const header = "[Relationships — from claims]\n";
              tokenBudget -= Math.ceil(header.length / 4);
              sources.push("relationships");
              sections.push(header + lines.join("\n"));
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
                const header = "[Conversation History — may contain outdated info]\n";
                tokenBudget -= Math.ceil(header.length / 4);
                sources.push("summaries");
                sections.push(header + lines.join("\n"));
              }
            }

            // Messages if budget remains
            if (grepResult.messages.length > 0 && tokenBudget > 50) {
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
                const header = "[Conversation History — may contain outdated info]\n";
                tokenBudget -= Math.ceil(header.length / 4);
                sources.push("messages");
                sections.push(header + lines.join("\n"));
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
            const ragPort = process.env.THREADCLAW_PORT ?? "18800";
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
                const header = "[From Documents]\n";
                const maxChars = Math.max(100, tokenBudget * 4);
                tokenBudget -= Math.ceil(header.length / 4);
                sources.push("documents");
                sections.push(header + ragText.substring(0, maxChars));
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
            searched: ["claims", "decisions", "entities", "relations", "relationships", "messages", "documents"],
          });
        }

        // Add guidance preamble when mixing resolved facts with conversation history
        const hasResolved = sources.some((s) => s === "claims" || s === "decisions" || s === "relationships" || s === "relations" || s === "entities");
        const hasHistory = sources.some((s) => s === "summaries" || s === "messages");
        let preamble = "";
        if (hasResolved && hasHistory) {
          preamble = "Note: Resolved Facts/Entities/Relations/Decisions are the authoritative current state. Conversation History shows what was discussed — it may contain outdated or superseded information.\n\n";
        }

        return {
          content: [{ type: "text", text: preamble + sections.join("\n\n") }],
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

// ═══════════════════════════════════════════════════════════════════
// cc_state — aggregated state view for a subject
// ═══════════════════════════════════════════════════════════════════

const CcStateSchema = Type.Object({
  subject: Type.String({ description: "Subject or keyword to look up (entity name, topic, etc.)" }),
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1 = global)" })),
});

export function createCcStateTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
}): AnyAgentTool {
  return {
    name: "cc_state",
    label: "ThreadClaw State",
    description:
      "Get the complete current state for a subject — aggregates all claims, decisions, " +
      "relations, invariants, loops, and conflicts into one view. Use this when you need " +
      "a full picture of everything ThreadClaw knows about a topic or entity.",
    parameters: CcStateSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const subject = typeof p.subject === "string" ? p.subject.trim() : "";
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;

      if (!subject) return jsonResult({ error: "subject is required" });

      try {
        const db = input.graphDb;
        const searchTerms = subject.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

        // Build search clause — FTS5 or LIKE fallback
        const fts = buildFtsClause(db, searchTerms);
        const searchClause = fts
          ? fts.clause
          : searchTerms.map(() => "(content LIKE ? ESCAPE '\\' OR structured_json LIKE ? ESCAPE '\\')").join(" OR ");
        const searchArgs = fts
          ? fts.args
          : searchTerms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);

        // Query all active memory objects matching subject across all kinds
        const rows = db.prepare(`
          SELECT id, kind, content, confidence, status, created_at, structured_json
          FROM memory_objects
          WHERE scope_id = ? AND branch_id = 0 AND status = 'active'
            AND (${searchClause})
          ORDER BY kind, confidence DESC
          LIMIT 100
        `).all(scopeId, ...searchArgs) as Array<{
          id: number; kind: string; content: string; confidence: number;
          status: string; created_at: string; structured_json: string | null;
        }>;

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No state found for "${subject}".` }], details: { count: 0 } };
        }

        // Group by kind
        const groups: Record<string, typeof rows> = {};
        for (const r of rows) {
          (groups[r.kind] ??= []).push(r);
        }

        const sections: string[] = [`State for "${subject}" (${rows.length} objects):\n`];

        // Render each kind
        const kindOrder = ["claim", "decision", "invariant", "conflict", "loop", "relation", "procedure", "entity"];
        for (const kind of kindOrder) {
          const items = groups[kind];
          if (!items || items.length === 0) continue;

          sections.push(`── ${kind.toUpperCase()}S (${items.length}) ──`);
          for (const item of items.slice(0, 15)) {
            const s = safeParseStructured(item.structured_json);

            switch (kind) {
              case "claim":
                sections.push(`  [claim] ${s.subject ?? "?"} ${s.predicate ?? "?"}: ${s.objectText ?? item.content} (conf=${item.confidence.toFixed(2)})`);
                break;
              case "decision":
                sections.push(`  [decision] ${s.topic ?? "?"}: ${s.decisionText ?? item.content}`);
                break;
              case "invariant":
                sections.push(`  [invariant:${s.severity ?? "?"}] ${s.description ?? item.content}`);
                break;
              case "conflict": {
                const sideA = s.objectIdA ?? "?";
                const sideB = s.objectIdB ?? "?";
                sections.push(`  [conflict] ${sideA} vs ${sideB} (${item.status}): ${item.content}`);
                break;
              }
              case "loop":
                sections.push(`  [loop:${s.loopType ?? "?"}] ${s.text ?? item.content} (priority=${s.priority ?? 0})`);
                break;
              case "relation":
                sections.push(`  [relation] ${s.subject_name ?? s.subjectName ?? "?"} ${s.predicate ?? "?"} ${s.object_name ?? s.objectName ?? "?"}`);
                break;
              case "procedure": {
                const isNeg = s.isNegative === true || s.isNegative === "true";
                const label = isNeg ? "anti-runbook" : "runbook";
                sections.push(`  [${label}] ${s.toolName ?? "?"}: ${s.failurePattern ?? s.pattern ?? item.content}`);
                break;
              }
              case "entity":
                sections.push(`  [entity] ${s.displayName ?? s.name ?? item.content} (${s.type ?? "unknown"})`);
                break;
              default:
                sections.push(`  [${kind}] ${item.content}`);
            }
          }
          if (items.length > 15) {
            sections.push(`  ... and ${items.length - 15} more`);
          }
          sections.push("");
        }

        // Any remaining kinds not in kindOrder
        for (const [kind, items] of Object.entries(groups)) {
          if (kindOrder.includes(kind)) continue;
          sections.push(`── ${kind.toUpperCase()}S (${items.length}) ──`);
          for (const item of items.slice(0, 10)) {
            sections.push(`  [${kind}] ${item.content}`);
          }
          sections.push("");
        }

        return {
          content: [{ type: "text", text: sections.join("\n") }],
          details: { count: rows.length, kinds: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])) },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// cc_synthesize — on-demand retrospective scope synthesis
// ═══════════════════════════════════════════════════════════════════

const CcSynthesizeSchema = Type.Object({
  scope_id: Type.Optional(Type.Number({ description: "Scope ID (default: 1 = global)" })),
});

export function createCcSynthesizeTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
  config: LcmConfig;
}): AnyAgentTool {
  return {
    name: "cc_synthesize",
    label: "ThreadClaw Synthesis",
    description:
      "Generate a retrospective synthesis of the current evidence state — claims, decisions, " +
      "relations, loops, and invariants — into a coherent narrative summary. " +
      "Requires LLM access (deep extraction must be enabled). Use sparingly — this is an LLM call.",
    parameters: CcSynthesizeSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;

      if (!input.config.relationsDeepExtractionEnabled) {
        return {
          content: [{ type: "text", text: "Synthesis requires deep extraction to be enabled (relationsDeepExtractionEnabled). Configure an extraction model first." }],
          details: { error: "deep_extraction_disabled" },
        };
      }

      try {
        const result = await synthesizeScope(input.graphDb, scopeId, input.deps, input.config);
        if (!result) {
          return {
            content: [{ type: "text", text: "No evidence found to synthesize for this scope." }],
            details: { empty: true },
          };
        }
        return {
          content: [{ type: "text", text: result }],
          details: { scopeId, synthesized: true },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// cc_conflicts — view and resolve TruthEngine conflicts
// ═══════════════════════════════════════════════════════════════════

const CcConflictsSchema = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("list"), Type.Literal("resolve")], {
      description: "Action: 'list' (default) or 'resolve'",
    }),
  ),
  scope_id: Type.Optional(
    Type.Number({ description: "Scope ID (default: 1 = global)" }),
  ),
  conflict_id: Type.Optional(
    Type.String({ description: "Composite ID of the conflict to resolve (required for resolve)" }),
  ),
  winner_id: Type.Optional(
    Type.String({ description: "Composite ID of the winning side (required for resolve)" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Max conflicts to return (default: 20)", minimum: 1, maximum: 100 }),
  ),
});

export function createCcConflictsTool(input: {
  deps: LcmDependencies;
  graphDb: GraphDb;
}): AnyAgentTool {
  return {
    name: "cc_conflicts",
    label: "ThreadClaw Conflicts",
    description:
      "List active TruthEngine conflicts or resolve them. Conflicts are created when " +
      "two memory objects with the same canonical key have contradictory values. " +
      "Use action='resolve' with conflict_id and winner_id to pick a winner.",
    parameters: CcConflictsSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action : "list";
      const scopeId = typeof p.scope_id === "number" ? Math.trunc(p.scope_id) : 1;
      const limit = typeof p.limit === "number" ? Math.min(100, Math.max(1, Math.trunc(p.limit))) : 20;

      try {
        if (action === "resolve") {
          const conflictId = typeof p.conflict_id === "string" ? p.conflict_id.trim() : "";
          const winnerId = typeof p.winner_id === "string" ? p.winner_id.trim() : "";
          if (!conflictId || !winnerId) {
            return jsonResult({ error: "resolve requires both conflict_id and winner_id" });
          }

          // Load the conflict to find both sides
          const conflictRow = input.graphDb.prepare(
            "SELECT composite_id, structured_json FROM memory_objects WHERE composite_id = ? AND kind = 'conflict'",
          ).get(conflictId) as { composite_id: string; structured_json: string | null } | undefined;

          if (!conflictRow) {
            return jsonResult({ error: `Conflict not found: ${conflictId}` });
          }

          let structured: Record<string, unknown> = {};
          if (conflictRow.structured_json) {
            try { structured = JSON.parse(conflictRow.structured_json); } catch { /* ignore */ }
          }

          const objectIdA = String(structured.objectIdA ?? "");
          const objectIdB = String(structured.objectIdB ?? "");
          const loserId = winnerId === objectIdA ? objectIdB : objectIdA;

          if (winnerId !== objectIdA && winnerId !== objectIdB) {
            return jsonResult({ error: `winner_id must be one of: ${objectIdA}, ${objectIdB}` });
          }

          // Mark conflict as resolved
          updateMemoryObjectStatus(input.graphDb, conflictId, "retracted");
          // Mark loser as superseded
          updateMemoryObjectStatus(input.graphDb, loserId, "superseded");

          return {
            content: [{ type: "text", text: `Conflict resolved. Winner: ${winnerId}, loser ${loserId} marked superseded.` }],
            details: { conflictId, winnerId, loserId, resolved: true },
          };
        }

        // Default: list active conflicts
        const rows = input.graphDb.prepare(`
          SELECT composite_id, content, structured_json, confidence, status, created_at
          FROM memory_objects
          WHERE kind = 'conflict'
            AND status IN ('active', 'needs_confirmation')
            AND scope_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `).all(scopeId, limit) as Array<Record<string, unknown>>;

        if (rows.length === 0) {
          return { content: [{ type: "text", text: "No active conflicts." }], details: { count: 0 } };
        }

        const lines: string[] = [`${rows.length} active conflict(s):\n`];
        for (const row of rows) {
          const id = String(row.composite_id ?? "");
          const content = String(row.content ?? "");
          const status = String(row.status ?? "active");
          const created = String(row.created_at ?? "");

          let structured: Record<string, unknown> = {};
          if (typeof row.structured_json === "string") {
            try { structured = JSON.parse(row.structured_json); } catch { /* ignore */ }
          }

          const idA = String(structured.objectIdA ?? "?");
          const idB = String(structured.objectIdB ?? "?");
          const conf = Number(row.confidence ?? 0);

          lines.push(`[${status}] ${content}`);
          lines.push(`  id: ${id}`);
          lines.push(`  sides: A=${idA}  B=${idB}`);
          lines.push(`  confidence: ${conf.toFixed(2)}  created: ${created}`);

          // Fetch confidence for each side
          for (const sideId of [idA, idB]) {
            if (sideId === "?") continue;
            const sideRow = input.graphDb.prepare(
              "SELECT content, confidence, status FROM memory_objects WHERE composite_id = ? LIMIT 1",
            ).get(sideId) as { content: string; confidence: number; status: string } | undefined;
            if (sideRow) {
              const snippet = String(sideRow.content ?? "").substring(0, 80);
              lines.push(`    ${sideId}: conf=${Number(sideRow.confidence).toFixed(2)} status=${sideRow.status} "${snippet}"`);
            }
          }
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: rows.length },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// cc_timeline — subject-centric memory evolution
// ═══════════════════════════════════════════════════════════════════

const CcTimelineSchema = Type.Object({
  subject: Type.String({ description: "Entity or subject name to trace" }),
  from: Type.Optional(Type.String({ description: "Start date (YYYY-MM-DD)" })),
  to: Type.Optional(Type.String({ description: "End date (YYYY-MM-DD)" })),
  kind: Type.Optional(Type.String({ description: "Filter by kind (claim, decision, loop, entity)" })),
});

export function createCcTimelineTool(): AnyAgentTool {
  const port = process.env.THREADCLAW_PORT ?? "18800";

  return {
    name: "cc_timeline",
    label: "ThreadClaw Timeline",
    description: "Show how knowledge about a subject evolved over time — supersessions, corrections, confidence changes.",
    parameters: CcTimelineSchema,
    async execute(_toolCallId, rawParams) {
      const input = rawParams as { subject: string; from?: string; to?: string; kind?: string };
      try {
        const params = new URLSearchParams({ subject: input.subject, limit: "30" });
        if (input.from) params.set("from", input.from);
        if (input.to) params.set("to", input.to);
        if (input.kind) params.set("kind", input.kind);

        const res = await fetch(`http://127.0.0.1:${port}/graph/timeline?${params}`, {
          signal: AbortSignal.timeout(10000),
        });

        if (!res.ok) {
          return jsonResult({ error: `Timeline API returned ${res.status}` });
        }

        const data = await res.json() as {
          events: Array<{ kind: string; content: string; confidence: number; status: string; created_at: string; updated_at: string; composite_id: string }>;
          supersessions: Array<{ subject_id: string; object_id: string; created_at: string }>;
        };

        if (!data.events?.length) {
          return { content: [{ type: "text", text: `No timeline events found for "${input.subject}".` }] };
        }

        const supersededIds = new Set(data.supersessions?.map((s) => s.object_id) ?? []);

        const lines: string[] = [`Timeline for "${input.subject}" (${data.events.length} events):\n`];
        for (const evt of data.events) {
          const superseded = supersededIds.has(evt.composite_id) ? " [SUPERSEDED]" : "";
          const conf = ((evt.confidence ?? 0) * 100).toFixed(0);
          lines.push(`[${evt.updated_at?.slice(0, 10)}] ${evt.kind} (${conf}% confidence)${superseded}`);
          lines.push(`  ${(evt.content ?? "").slice(0, 120)}`);
          lines.push("");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: data.events.length, supersessions: data.supersessions?.length ?? 0 },
        };
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}
