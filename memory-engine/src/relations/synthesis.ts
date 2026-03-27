/**
 * Retrospective synthesis — LLM-powered summary of evidence state.
 *
 * Gathers active claims, decisions, loops, invariants, and anti-runbooks
 * for a scope and calls the LLM to produce a coherent narrative summary.
 */

import type { GraphDb } from "./types.js";
import type { LcmDependencies } from "../types.js";
import type { LcmConfig } from "../db/config.js";

const LLM_TIMEOUT_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
import { getActiveClaims } from "./claim-store.js";
import { getActiveDecisions } from "./decision-store.js";
import { getOpenLoops } from "./loop-store.js";
import { getActiveInvariants } from "./invariant-store.js";
import { getAntiRunbooks } from "./anti-runbook-store.js";

const SYNTHESIS_PROMPT = `Synthesize the following evidence into a coherent, concise summary. Focus on the most important facts, active decisions, and pending items. Write in third person, present tense.

Evidence:
`;

/**
 * Produce a retrospective synthesis of a scope's evidence state.
 */
export async function synthesizeScope(
  db: GraphDb,
  scopeId: number,
  deps: LcmDependencies,
  config: LcmConfig,
): Promise<string | null> {
  if (!config.relationsDeepExtractionEnabled) return null;

  // Gather evidence
  const claims = getActiveClaims(db, scopeId, undefined, 15);
  const decisions = getActiveDecisions(db, scopeId, undefined, 10);
  const loops = getOpenLoops(db, scopeId, undefined, 10);
  const invariants = getActiveInvariants(db, scopeId, 10);
  const antiRunbooks = getAntiRunbooks(db, scopeId, { limit: 5 });

  const sections: string[] = [];

  if (claims.length > 0) {
    sections.push("Claims:");
    for (const c of claims) {
      sections.push(`  - ${c.subject} ${c.predicate}: ${c.object_text ?? "?"} (confidence: ${c.confidence.toFixed(2)})`);
    }
  }
  if (decisions.length > 0) {
    sections.push("Decisions:");
    for (const d of decisions) {
      sections.push(`  - ${d.topic}: ${d.decision_text}`);
    }
  }
  if (loops.length > 0) {
    sections.push("Open Loops:");
    for (const l of loops) {
      sections.push(`  - [${l.loop_type}] ${l.text} (priority: ${l.priority})`);
    }
  }
  if (invariants.length > 0) {
    sections.push("Invariants:");
    for (const inv of invariants) {
      sections.push(`  - [${inv.severity}] ${inv.description}`);
    }
  }
  if (antiRunbooks.length > 0) {
    sections.push("Anti-Runbooks (avoid):");
    for (const ar of antiRunbooks) {
      sections.push(`  - ${ar.failure_pattern} (${ar.failure_count} failures)`);
    }
  }

  if (sections.length === 0) return null;

  // Token budget: cap evidence text to prevent LLM context overflow
  const MAX_EVIDENCE_TOKENS = 3000;
  let evidenceText = sections.join("\n");
  const estimatedTokens = Math.ceil(evidenceText.length / 4);
  if (estimatedTokens > MAX_EVIDENCE_TOKENS) {
    evidenceText = evidenceText.slice(0, MAX_EVIDENCE_TOKENS * 4) + "\n[... truncated]";
  }

  // Resolve model
  const model = config.relationsDeepExtractionModel || config.summaryModel;
  const provider = config.relationsDeepExtractionProvider || config.summaryProvider;
  let resolved: { provider: string; model: string };
  try {
    resolved = model ? deps.resolveModel(model, provider || undefined) : deps.resolveModel(undefined);
  } catch {
    resolved = deps.resolveModel(undefined);
  }

  try {
    const result = await withTimeout(deps.complete({
      model: resolved.model,
      provider: resolved.provider,
      messages: [
        { role: "user", content: SYNTHESIS_PROMPT + evidenceText },
      ],
      temperature: 0.1,
      maxTokens: 500,
    }), LLM_TIMEOUT_MS, "synthesis timed out");

    const content = typeof result.content === "string"
      ? result.content
      : Array.isArray(result.content)
        ? result.content.filter((b: unknown) => typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text")
            .map((b: unknown) => ((b as Record<string, unknown>).text as string) ?? "").join("")
        : "";

    return content.trim() || null;
  } catch {
    return null;
  }
}
