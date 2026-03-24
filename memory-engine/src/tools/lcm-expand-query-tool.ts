import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { LcmContextEngine } from "../engine.js";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  normalizeSummaryIds,
  resolveRequesterConversationScopeId,
} from "./lcm-expand-tool.delegation.js";
import {
  clearDelegatedExpansionContext,
  evaluateExpansionRecursionGuard,
  recordExpansionDelegationTelemetry,
  resolveExpansionRequestId,
  resolveNextExpansionDepth,
  stampDelegatedExpansionContext,
} from "./lcm-expansion-recursion-guard.js";

const DELEGATED_WAIT_TIMEOUT_MS = 120_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ANSWER_TOKENS = 2_000;

const LcmExpandQuerySchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx). Required when query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query used to find summaries via grep before expansion. Required when summaryIds is not provided.",
    }),
  ),
  prompt: Type.String({
    description: "Question to answer using expanded context.",
  }),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope expansion to. If omitted, uses the current session conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to allow cross-conversation lookup for this agent. Ignored when conversationId is provided.",
    }),
  ),
  crossAgent: Type.Optional(
    Type.Boolean({
      description:
        "When combined with allConversations=true, searches across all agents. Use sparingly.",
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      description: `Maximum answer tokens to target (default: ${DEFAULT_MAX_ANSWER_TOKENS}).`,
      minimum: 1,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description:
        "Expansion retrieval token budget across all delegated cc_expand calls for this query.",
      minimum: 1,
    }),
  ),
});

type ExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

type SummaryCandidate = {
  summaryId: string;
  conversationId: number;
};

/**
 * Build the sub-agent task message for delegated expansion and prompt answering.
 */
function buildDelegatedExpandQueryTask(params: {
  summaryIds: string[];
  conversationId: number;
  query?: string;
  prompt: string;
  maxTokens: number;
  tokenCap: number;
  requestId: string;
  expansionDepth: number;
  originSessionKey: string;
}) {
  const seedSummaryIds = params.summaryIds.length > 0 ? params.summaryIds.join(", ") : "(none)";
  return [
    "You are an autonomous ThreadClaw Memory retrieval navigator. Plan and execute retrieval before answering.",
    "",
    "Available tools: cc_describe, cc_expand, cc_grep",
    `Conversation scope: ${params.conversationId}`,
    `Expansion token budget (total across this run): ${params.tokenCap}`,
    `Seed summary IDs: ${seedSummaryIds}`,
    params.query ? `Routing query: ${params.query}` : undefined,
    "",
    "Strategy:",
    "1. Start with `cc_describe` on seed summaries to inspect subtree manifests and branch costs.",
    "2. If additional candidates are needed, use `cc_grep` scoped to summaries.",
    "3. Select branches that fit remaining budget; prefer high-signal paths first.",
    "4. Call `cc_expand` selectively (do not expand everything blindly).",
    "5. Keep includeMessages=false by default; use includeMessages=true only for specific leaf evidence.",
    `6. Stay within ${params.tokenCap} total expansion tokens across all cc_expand calls.`,
    "",
    "User prompt to answer:",
    params.prompt,
    "",
    "Delegated expansion metadata (for tracing):",
    `- requestId: ${params.requestId}`,
    `- expansionDepth: ${params.expansionDepth}`,
    `- originSessionKey: ${params.originSessionKey}`,
    "",
    "Return ONLY JSON with this shape:",
    "{",
    '  "answer": "string",',
    '  "citedIds": ["sum_xxx"],',
    '  "expandedSummaryCount": 0,',
    '  "totalSourceTokens": 0,',
    '  "truncated": false',
    "}",
    "",
    "Rules:",
    "- In delegated context, call `cc_expand` directly for source retrieval.",
    "- DO NOT call `cc_recall` from this delegated session.",
    "- Synthesize the final answer from retrieved evidence, not assumptions.",
    `- Keep answer concise and focused (target <= ${params.maxTokens} tokens).`,
    "- citedIds must be unique summary IDs.",
    "- expandedSummaryCount should reflect how many summaries were expanded/used.",
    "- totalSourceTokens should estimate total tokens consumed from expansion calls.",
    "- truncated should indicate whether source expansion appears truncated.",
  ].join("\n");
}

/**
 * Parse the child reply; accepts plain JSON or fenced JSON.
 */
function parseDelegatedExpandQueryReply(
  rawReply: string | undefined,
  fallbackExpandedSummaryCount: number,
): ExpandQueryReply {
  const fallback: ExpandQueryReply = {
    answer: (rawReply ?? "").trim(),
    citedIds: [],
    expandedSummaryCount: fallbackExpandedSummaryCount,
    totalSourceTokens: 0,
    truncated: false,
  };

  const reply = rawReply?.trim();
  if (!reply) {
    return fallback;
  }

  const candidates: string[] = [reply];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown;
        citedIds?: unknown;
        expandedSummaryCount?: unknown;
        totalSourceTokens?: unknown;
        truncated?: unknown;
      };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      const citedIds = normalizeSummaryIds(
        Array.isArray(parsed.citedIds)
          ? parsed.citedIds.filter((value): value is string => typeof value === "string")
          : undefined,
      );
      const expandedSummaryCount =
        typeof parsed.expandedSummaryCount === "number" &&
        Number.isFinite(parsed.expandedSummaryCount)
          ? Math.max(0, Math.floor(parsed.expandedSummaryCount))
          : fallbackExpandedSummaryCount;
      const totalSourceTokens =
        typeof parsed.totalSourceTokens === "number" && Number.isFinite(parsed.totalSourceTokens)
          ? Math.max(0, Math.floor(parsed.totalSourceTokens))
          : 0;
      const truncated = parsed.truncated === true;

      return {
        answer: answer || fallback.answer,
        citedIds,
        expandedSummaryCount,
        totalSourceTokens,
        truncated,
      };
    } catch {
      // Try next candidate.
    }
  }

  return fallback;
}

/**
 * Resolve a single source conversation for delegated expansion.
 */
function resolveSourceConversationId(params: {
  scopedConversationId?: number;
  allConversations: boolean;
  candidates: SummaryCandidate[];
}): number {
  if (typeof params.scopedConversationId === "number") {
    const mismatched = params.candidates
      .filter((candidate) => candidate.conversationId !== params.scopedConversationId)
      .map((candidate) => candidate.summaryId);
    if (mismatched.length > 0) {
      throw new Error(
        `Some summaryIds are outside conversation ${params.scopedConversationId}: ${mismatched.join(", ")}`,
      );
    }
    return params.scopedConversationId;
  }

  const conversationIds = Array.from(
    new Set(params.candidates.map((candidate) => candidate.conversationId)),
  );
  if (conversationIds.length === 1 && typeof conversationIds[0] === "number") {
    return conversationIds[0];
  }

  if (params.allConversations && conversationIds.length > 1) {
    throw new Error(
      "Query matched summaries from multiple conversations. Provide conversationId or narrow the query.",
    );
  }

  throw new Error(
    "Unable to resolve a single conversation scope. Provide conversationId or set a narrower summary scope.",
  );
}

/** Escape LIKE meta-characters (%, _, \) so the value is treated literally. */
function escapeLikeValue(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Common stopwords to drop from evidence search queries
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "about", "this",
  "that", "it", "its", "and", "or", "but", "not", "no", "what", "which",
  "who", "when", "where", "how", "why", "all", "each", "every", "our",
  "we", "us", "my", "your", "i", "me", "he", "she", "they", "them",
]);

/** Extract 2-5 salient search terms from a query, dropping stopwords. */
function extractSearchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;:!?.]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .slice(0, 5);
}

/**
 * Evidence graph fallback — search claims and decisions when summaries return zero.
 * Tokenizes the query and uses OR-style matching on salient terms.
 * Returns a formatted result with source-type labels and metadata, or null if nothing found.
 */
async function tryEvidenceFallback(
  input: { deps: LcmDependencies; lcm: LcmContextEngine },
  searchQuery: string,
): Promise<ReturnType<typeof jsonResult> | null> {
  try {
    const graphDb = input.lcm.getGraphDb();
    if (!graphDb) return null;

    const terms = extractSearchTerms(searchQuery);
    if (terms.length === 0) return null;

    // Build OR-style LIKE conditions for each term (searching structured_json fields)
    const likeConditions = terms.map(() => "(json_extract(structured_json, '$.subject') LIKE ? ESCAPE '\\' OR json_extract(structured_json, '$.objectText') LIKE ? ESCAPE '\\')").join(" OR ");
    const likeArgs = terms.flatMap((t) => { const e = escapeLikeValue(t); return [`%${e}%`, `%${e}%`]; });

    const lines: string[] = [];

    // Search claims (top 5)
    const claims = graphDb.prepare(`
      SELECT id,
        json_extract(structured_json, '$.subject') as subject,
        json_extract(structured_json, '$.predicate') as predicate,
        json_extract(structured_json, '$.objectText') as object_text,
        confidence, trust_score, last_observed_at as last_seen_at
      FROM memory_objects WHERE kind = 'claim' AND status = 'active' AND scope_id = 1 AND branch_id = 0 AND (${likeConditions})
      ORDER BY confidence DESC LIMIT 5
    `).all(...likeArgs) as Array<{
      id: number; subject: string; predicate: string; object_text: string | null;
      confidence: number; trust_score: number; last_seen_at: string;
    }>;

    // Token budget for evidence fallback (keep it cheap)
    let tokenBudget = 500;
    let claimsShown = 0;
    let decisionsShown = 0;

    if (claims.length > 0) {
      lines.push("[Evidence Fallback — claims (no summary matches found)]\n");
      for (const c of claims) {
        const line1 = `[claim #${c.id}] ${c.subject} ${c.predicate}: ${c.object_text ?? "(empty)"}`;
        const line2 = `  confidence=${c.confidence.toFixed(2)} trust=${c.trust_score.toFixed(2)} last_seen=${c.last_seen_at}`;
        const cost = Math.ceil((line1.length + line2.length) / 4);
        if (tokenBudget - cost < 0) break;
        tokenBudget -= cost;
        lines.push(line1);
        lines.push(line2);
        claimsShown++;
      }
    }

    // Search decisions (top 3)
    const decLikeConditions = terms.map(() => "(json_extract(structured_json, '$.topic') LIKE ? ESCAPE '\\' OR json_extract(structured_json, '$.decisionText') LIKE ? ESCAPE '\\')").join(" OR ");
    const decLikeArgs = terms.flatMap((t) => { const e = escapeLikeValue(t); return [`%${e}%`, `%${e}%`]; });

    const decisions = graphDb.prepare(`
      SELECT id,
        json_extract(structured_json, '$.topic') as topic,
        json_extract(structured_json, '$.decisionText') as decision_text,
        status,
        json_extract(structured_json, '$.decidedAt') as decided_at,
        json_extract(structured_json, '$.supersededBy') as superseded_by
      FROM memory_objects WHERE kind = 'decision' AND status = 'active' AND scope_id = 1 AND (${decLikeConditions})
      ORDER BY json_extract(structured_json, '$.decidedAt') DESC LIMIT 3
    `).all(...decLikeArgs) as Array<{
      id: number; topic: string; decision_text: string; status: string;
      decided_at: string; superseded_by: number | null;
    }>;

    if (decisions.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("[Evidence Fallback — decisions]\n");
      for (const d of decisions) {
        const line1 = `[decision #${d.id}] ${d.topic}: ${d.decision_text}`;
        const line2 = `  status=${d.status} decided=${d.decided_at}${d.superseded_by ? ` superseded_by=#${d.superseded_by}` : ""}`;
        const cost = Math.ceil((line1.length + line2.length) / 4);
        if (tokenBudget - cost < 0) break;
        tokenBudget -= cost;
        lines.push(line1);
        lines.push(line2);
        decisionsShown++;
      }
    }

    if (lines.length > 0) {
      const totalAvailable = claims.length + decisions.length;
      const totalShown = claimsShown + decisionsShown;
      const hasMore = totalShown < totalAvailable;

      if (hasMore) {
        lines.push(`\n(Showing ${totalShown} of ${totalAvailable} matching results. More information is available. Use cc_claims or cc_state for complete results.)`);
      }

      return jsonResult({
        answer: lines.join("\n"),
        mode: "evidence_fallback",
        note: "No summary matches found. Showing matching claims and decisions from the evidence graph.",
        searched: ["summaries", "claims", "decisions"],
        searchTerms: terms,
        claimCount: claims.length,
        decisionCount: decisions.length,
        claimsShown,
        decisionsShown,
        hasMore,
      });
    }
  } catch (err) {
    // Non-fatal: evidence fallback failure should not break the query pipeline
    console.warn("[cc-mem] evidence fallback search failed:", err instanceof Error ? err.message : String(err));
  }
  return null;
}

/**
 * Resolve summary candidates from explicit IDs and/or query matches.
 */
async function resolveSummaryCandidates(params: {
  lcm: LcmContextEngine;
  explicitSummaryIds: string[];
  query?: string;
  conversationId?: number;
  conversationIds?: number[];
}): Promise<SummaryCandidate[]> {
  const retrieval = params.lcm.getRetrieval();
  const candidates = new Map<string, SummaryCandidate>();

  for (const summaryId of params.explicitSummaryIds) {
    const described = await retrieval.describe(summaryId);
    if (!described || described.type !== "summary" || !described.summary) {
      throw new Error(`Summary not found: ${summaryId}`);
    }
    candidates.set(summaryId, {
      summaryId,
      conversationId: described.summary.conversationId,
    });
  }

  if (params.query) {
    const grepResult = await retrieval.grep({
      query: params.query,
      mode: "full_text",
      scope: "summaries",
      conversationId: params.conversationId,
      conversationIds: params.conversationIds,
    });
    for (const summary of grepResult.summaries) {
      candidates.set(summary.summaryId, {
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
      });
    }
  }

  return Array.from(candidates.values());
}

export function createLcmExpandQueryTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  /** Session id used for LCM conversation scoping. */
  sessionId?: string;
  /** Requester agent session key used for delegated child session/auth scoping. */
  requesterSessionKey?: string;
  /** Session key for scope fallback when sessionId is unavailable. */
  sessionKey?: string;
  agentId?: string;
}): AnyAgentTool {
  return {
    name: "cc_recall",
    label: "ThreadClaw Recall",
    description:
      "Answer a focused question using delegated ThreadClaw Memory expansion. " +
      "Find candidate summaries (by IDs or query), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer with cited summary IDs.",
    parameters: LcmExpandQuerySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const explicitSummaryIds = normalizeSummaryIds(p.summaryIds as string[] | undefined);
      const query = typeof p.query === "string" ? p.query.trim() : "";
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      const requestedMaxTokens =
        typeof p.maxTokens === "number" ? Math.trunc(p.maxTokens) : undefined;
      const maxTokens =
        typeof requestedMaxTokens === "number" && Number.isFinite(requestedMaxTokens)
          ? Math.max(1, requestedMaxTokens)
          : DEFAULT_MAX_ANSWER_TOKENS;
      const requestedTokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const expansionTokenCap =
        typeof requestedTokenCap === "number" && Number.isFinite(requestedTokenCap)
          ? Math.max(1, requestedTokenCap)
          : Math.max(1, Math.trunc(input.deps.config.maxExpandTokens));

      if (!prompt) {
        return jsonResult({
          error: "prompt is required.",
        });
      }

      if (explicitSummaryIds.length === 0 && !query) {
        return jsonResult({
          error: "Either summaryIds or query must be provided.",
        });
      }

      const callerSessionKey =
        (typeof input.requesterSessionKey === "string"
          ? input.requesterSessionKey
          : input.sessionId
        )?.trim() ?? "";
      const requestId = resolveExpansionRequestId(callerSessionKey);
      const recursionCheck = evaluateExpansionRecursionGuard({
        sessionKey: callerSessionKey,
        requestId,
      });
      recordExpansionDelegationTelemetry({
        deps: input.deps,
        component: "cc_recall",
        event: "start",
        requestId,
        sessionKey: callerSessionKey,
        expansionDepth: recursionCheck.expansionDepth,
        originSessionKey: recursionCheck.originSessionKey,
      });
      if (recursionCheck.blocked) {
        recordExpansionDelegationTelemetry({
          deps: input.deps,
          component: "cc_recall",
          event: "block",
          requestId,
          sessionKey: callerSessionKey,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
        return jsonResult({
          errorCode: recursionCheck.code,
          error: recursionCheck.message,
          requestId: recursionCheck.requestId,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
      }

      const conversationScope = await resolveLcmConversationScope({
        lcm: input.lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        agentId: input.agentId,
        params: p,
      });
      let scopedConversationId = conversationScope.conversationId;
      if (
        !conversationScope.allConversations &&
        scopedConversationId == null &&
        callerSessionKey
      ) {
        scopedConversationId = await resolveRequesterConversationScopeId({
          deps: input.deps,
          requesterSessionKey: callerSessionKey,
          lcm: input.lcm,
        });
      }

      if (!conversationScope.allConversations && scopedConversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      let childSessionKey = "";
      let grantCreated = false;

      try {
        const candidates = await resolveSummaryCandidates({
          lcm: input.lcm,
          explicitSummaryIds,
          query: query || undefined,
          conversationId: scopedConversationId,
          conversationIds: conversationScope.conversationIds,
        });

        if (candidates.length === 0) {
          // Fallback: search claims and decisions from evidence graph
          const evidenceFallback = await tryEvidenceFallback(input, query || prompt);
          if (evidenceFallback) return evidenceFallback;

          const hint = !conversationScope.allConversations
            ? "\n\nNo results in this conversation. Do you want me to look in other active conversations?"
            : "";

          if (typeof scopedConversationId !== "number") {
            return jsonResult({
              answer: "No matching summaries, claims, decisions, or messages found." + hint,
              mode: "no_results",
              searched: ["summaries", "claims", "decisions"],
            });
          }
          return jsonResult({
            answer: "No matching summaries, claims, decisions, or messages found for this scope." + hint,
            citedIds: [],
            sourceConversationId: scopedConversationId,
            expandedSummaryCount: 0,
            totalSourceTokens: 0,
            truncated: false,
            mode: "no_results",
            searched: ["summaries", "claims", "decisions"],
          });
        }

        const sourceConversationId = resolveSourceConversationId({
          scopedConversationId,
          allConversations: conversationScope.allConversations,
          candidates,
        });
        const summaryIds = normalizeSummaryIds(
          candidates
            .filter((candidate) => candidate.conversationId === sourceConversationId)
            .map((candidate) => candidate.summaryId),
        );

        if (summaryIds.length === 0) {
          return jsonResult({
            error: "No summaryIds available after applying conversation scope.",
          });
        }

        const requesterAgentId = input.deps.normalizeAgentId(
          input.deps.parseAgentSessionKey(callerSessionKey)?.agentId,
        );
        childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
        const childExpansionDepth = resolveNextExpansionDepth(callerSessionKey);
        const originSessionKey = recursionCheck.originSessionKey || callerSessionKey || "main";

        createDelegatedExpansionGrant({
          delegatedSessionKey: childSessionKey,
          issuerSessionId: callerSessionKey || "main",
          allowedConversationIds: [sourceConversationId],
          tokenCap: expansionTokenCap,
          ttlMs: DELEGATED_WAIT_TIMEOUT_MS + 30_000,
        });
        stampDelegatedExpansionContext({
          sessionKey: childSessionKey,
          requestId,
          expansionDepth: childExpansionDepth,
          originSessionKey,
          stampedBy: "cc_recall",
        });
        grantCreated = true;

        const task = buildDelegatedExpandQueryTask({
          summaryIds,
          conversationId: sourceConversationId,
          query: query || undefined,
          prompt,
          maxTokens,
          tokenCap: expansionTokenCap,
          requestId,
          expansionDepth: childExpansionDepth,
          originSessionKey,
        });

        const childIdem = crypto.randomUUID();
        const response = (await input.deps.callGateway({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            deliver: false,
            lane: input.deps.agentLaneSubagent,
            idempotencyKey: childIdem,
            extraSystemPrompt: input.deps.buildSubagentSystemPrompt({
              depth: 1,
              maxDepth: 8,
              taskSummary: "Run cc_expand and return prompt-focused JSON answer",
            }),
          },
          timeoutMs: GATEWAY_TIMEOUT_MS,
        })) as { runId?: string };

        const runId = typeof response?.runId === "string" ? response.runId.trim() : "";
        if (!runId) {
          return jsonResult({
            error: "Delegated expansion did not return a runId.",
          });
        }

        const wait = (await input.deps.callGateway({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
          },
          timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
        })) as { status?: string; error?: string };
        const status = typeof wait?.status === "string" ? wait.status : "error";
        if (status === "timeout") {
          recordExpansionDelegationTelemetry({
            deps: input.deps,
            component: "cc_recall",
            event: "timeout",
            requestId,
            sessionKey: callerSessionKey,
            expansionDepth: childExpansionDepth,
            originSessionKey,
            runId,
          });
          return jsonResult({
            error: "cc_recall timed out waiting for delegated expansion (120s).",
          });
        }
        if (status !== "ok") {
          return jsonResult({
            error:
              typeof wait?.error === "string" && wait.error.trim()
                ? wait.error
                : "Delegated expansion query failed.",
          });
        }

        const replyPayload = (await input.deps.callGateway({
          method: "sessions.get",
          params: { key: childSessionKey, limit: 80 },
          timeoutMs: GATEWAY_TIMEOUT_MS,
        })) as { messages?: unknown[] };
        const reply = input.deps.readLatestAssistantReply(
          Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
        );
        const parsed = parseDelegatedExpandQueryReply(reply, summaryIds.length);
        recordExpansionDelegationTelemetry({
          deps: input.deps,
          component: "cc_recall",
          event: "success",
          requestId,
          sessionKey: callerSessionKey,
          expansionDepth: childExpansionDepth,
          originSessionKey,
          runId,
        });

        return jsonResult({
          answer: parsed.answer,
          citedIds: parsed.citedIds,
          sourceConversationId,
          expandedSummaryCount: parsed.expandedSummaryCount,
          totalSourceTokens: parsed.totalSourceTokens,
          truncated: parsed.truncated,
          mode: "full_recall",
          searched: ["summaries"],
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const isGatewayUnavailable = errMsg.includes("subagent") || errMsg.includes("gateway") || errMsg.includes("Plugin runtime");

        if (isGatewayUnavailable) {
          // Lightweight recall mode — priority order:
          // 1. Summary snippets (best: compacted context)
          // 2. Evidence fallback (claims/decisions from graph)
          // 3. Raw message snippets (last resort)
          try {
            const retrieval = input.lcm.getRetrieval();
            const searchQuery = query || prompt;

            // 1. Try summary snippets first
            const grepResult = await retrieval.grep({
              query: searchQuery,
              mode: "full_text",
              scope: "summaries",
              conversationId: scopedConversationId,
              conversationIds: conversationScope.conversationIds,
            });

            if (grepResult.summaries.length > 0) {
              const lines = ["[Lightweight Recall — summary snippets (delegated expansion unavailable)]\n"];
              let tokenBudget = 500;
              let shown = 0;
              for (const s of grepResult.summaries.slice(0, 5)) {
                const line = `[summary:${s.summaryId}] ${s.snippet ?? "(no snippet)"}`;
                if (tokenBudget - Math.ceil(line.length / 4) < 0) break;
                tokenBudget -= Math.ceil(line.length / 4);
                lines.push(line);
                shown++;
              }
              if (shown < grepResult.summaries.length) {
                lines.push(`\n(Showing ${shown} of ${grepResult.summaries.length} matching summaries. More information is available. Use cc_claims or cc_state for complete results.)`);
              }
              recordExpansionDelegationTelemetry({
                deps: input.deps, component: "cc_recall", event: "lightweight",
                requestId, sessionKey: callerSessionKey,
                reason: "summary_snippet",
              });
              return jsonResult({
                answer: lines.join("\n"),
                mode: "summary_snippet",
                note: "Used lightweight recall mode because delegated expansion is unavailable in this runtime.",
                searched: ["summaries"],
                hasMore: shown < grepResult.summaries.length,
              });
            }

            // 2. Evidence fallback (claims + decisions)
            const evidenceFallback = await tryEvidenceFallback(input, searchQuery);
            if (evidenceFallback) {
              recordExpansionDelegationTelemetry({
                deps: input.deps, component: "cc_recall", event: "lightweight",
                requestId, sessionKey: callerSessionKey,
                reason: "evidence_fallback",
              });
              const details = typeof evidenceFallback.details === "object" && evidenceFallback.details !== null
                ? { ...(evidenceFallback.details as Record<string, unknown>) }
                : {};
              details.note = "Used lightweight recall mode. No summary matches found; showing claims/decisions from evidence graph.";
              details.searched = ["summaries", "claims", "decisions"];
              return { content: evidenceFallback.content, details };
            }

            // 3. Raw message snippets (last resort)
            const msgResult = await retrieval.grep({
              query: searchQuery,
              mode: "full_text",
              scope: "messages",
              conversationId: scopedConversationId,
              conversationIds: conversationScope.conversationIds,
            });

            if (msgResult.messages.length > 0) {
              const lines = ["[Lightweight Recall — message matches (no summaries or evidence found)]\n"];
              let tokenBudget = 400;
              let shown = 0;
              for (const m of msgResult.messages.slice(0, 3)) {
                const line = `[msg:${m.messageId}] ${m.snippet ?? "(no snippet)"}`;
                if (tokenBudget - Math.ceil(line.length / 4) < 0) break;
                tokenBudget -= Math.ceil(line.length / 4);
                lines.push(line);
                shown++;
              }
              if (shown < msgResult.messages.length) {
                lines.push(`\n(Showing ${shown} of ${msgResult.messages.length} matching messages. More information is available. Use cc_claims or cc_state for complete results.)`);
              }
              recordExpansionDelegationTelemetry({
                deps: input.deps, component: "cc_recall", event: "lightweight",
                requestId, sessionKey: callerSessionKey,
                reason: "message_snippet",
              });
              return jsonResult({
                answer: lines.join("\n"),
                mode: "message_snippet",
                note: "Used lightweight recall mode. No summaries or evidence matches; showing raw message matches.",
                searched: ["summaries", "claims", "decisions", "messages"],
                hasMore: shown < msgResult.messages.length,
              });
            }
          } catch {
            // Lightweight mode also failed — fall through to error
          }
        }

        return jsonResult({
          error: errMsg,
        });
      } finally {
        if (childSessionKey) {
          try {
            await input.deps.callGateway({
              method: "sessions.delete",
              params: { key: childSessionKey, deleteTranscript: true },
              timeoutMs: GATEWAY_TIMEOUT_MS,
            });
          } catch {
            // Cleanup is best-effort.
          }
        }
        if (grantCreated && childSessionKey) {
          revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
        }
        if (childSessionKey) {
          clearDelegatedExpansionContext(childSessionKey);
        }
      }
    },
  };
}
