import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  /** When allConversations=true and agent-scoped, contains the agent's conversation IDs. */
  conversationIds?: number[];
  allConversations: boolean;
};

/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export function parseIsoTimestampParam(
  params: Record<string, unknown>,
  key: string,
): Date | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed;
}

/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true — scoped to the caller's agent by default
 * 3. Current session's LCM conversation
 *
 * When allConversations=true, the scope is restricted to conversations
 * belonging to the same agent (derived from the session key). This prevents
 * cross-agent memory pollution. Pass crossAgent=true to opt in to truly
 * global search across all agents.
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return { conversationId: explicitConversationId, allConversations: false };
  }

  if (params.allConversations === true) {
    // crossAgent=true bypasses agent scoping for truly global search.
    // Only allowed when agentId is absent (backward compat) or explicitly enabled via env.
    if (!input.agentId) {
      return { conversationId: undefined, allConversations: true };
    }
    if (params.crossAgent === true) {
      const allowed = process.env.CLAWCORE_MEMORY_ALLOW_CROSS_AGENT_SEARCH === "true";
      if (allowed) {
        return { conversationId: undefined, allConversations: true };
      }
      // Fall through to agent-scoped search when cross-agent is not enabled
    }

    // Scope to the caller's agent conversations only.
    const conversationIds = await lcm
      .getConversationStore()
      .getConversationIdsByAgentId(input.agentId);

    if (conversationIds.length === 0) {
      return { conversationId: undefined, allConversations: true };
    }

    return { conversationIds, allConversations: true };
  }

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && input.sessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(input.sessionKey.trim());
  }
  if (!normalizedSessionId) {
    return { conversationId: undefined, allConversations: false };
  }

  const conversation = await lcm.getConversationStore().getConversationBySessionId(normalizedSessionId);
  if (!conversation) {
    return { conversationId: undefined, allConversations: false };
  }

  return { conversationId: conversation.conversationId, allConversations: false };
}
