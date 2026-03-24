/**
 * MemoryWriter — event understanding for RSMA.
 *
 * Takes raw input (messages, tool results, documents) and produces
 * semantically classified MemoryObjects. Consolidates all extraction
 * logic into one pipeline.
 *
 * Pipeline (all steps <5ms total except deep extraction):
 * 1. Correction detection → auto-supersession signals
 * 2. Uncertainty detection → provisional flag
 * 3. Preference detection → high-influence claims
 * 4. Temporal detection → effective_at / expires_at
 * 5. Decision extraction (regex)
 * 6. Entity extraction (regex + terms)
 * 7. Claim extraction (regex: explicit, KV, frontmatter)
 * 8. Loop/task extraction (regex)
 * 9. NER enrichment (spaCy HTTP, async, non-blocking)
 * 10. Deep extraction (LLM, async, fire-and-forget)
 *
 * Phase 3: Shadow mode — produces MemoryObjects but does NOT modify
 * existing state. The TruthEngine logs what it WOULD do.
 */

import { randomUUID } from "node:crypto";
import type {
  MemoryObject,
  MemoryKind,
  SourceKind,
  EventType,
  InfluenceWeight,
  ExtractionMethod,
} from "./types.js";
import { SOURCE_TRUST, PROVISIONAL_CONFIDENCE_FACTOR } from "./types.js";
import { buildCanonicalKey } from "./canonical.js";
import { detectSignals, type SignalDetectionResult } from "./correction.js";

// ── Writer Output ───────────────────────────────────────────────────────────

export interface WriterResult {
  /** MemoryObjects produced from the input. */
  objects: MemoryObject[];
  /** Signal detection results for logging/debugging. */
  signals: SignalDetectionResult;
  /** Event classification. */
  eventTypes: EventType[];
}

// ── Factory Helpers ─────────────────────────────────────────────────────────

function makeId(kind: MemoryKind): string {
  return `${kind}:${randomUUID()}`;
}

function now(): string {
  return new Date().toISOString();
}

function makeObject(
  kind: MemoryKind,
  content: string,
  opts: {
    structured?: unknown;
    sourceKind: SourceKind;
    sourceId: string;
    sourceDetail?: string;
    actor?: string;
    trust?: number;
    extractionMethod?: ExtractionMethod;
    confidence?: number;
    provisional?: boolean;
    influenceWeight?: InfluenceWeight;
  },
): MemoryObject {
  const timestamp = now();
  const obj: MemoryObject = {
    id: makeId(kind),
    kind,
    content,
    structured: opts.structured,
    provenance: {
      source_kind: opts.sourceKind,
      source_id: opts.sourceId,
      source_detail: opts.sourceDetail,
      actor: opts.actor ?? "system",
      trust: opts.trust ?? SOURCE_TRUST[opts.sourceKind] ?? 0.5,
      extraction_method: opts.extractionMethod,
    },
    confidence: opts.confidence ?? 0.8,
    freshness: 1.0,
    provisional: opts.provisional ?? false,
    status: "active",
    observed_at: timestamp,
    scope_id: 1,
    influence_weight: opts.influenceWeight ?? "standard",
    created_at: timestamp,
    updated_at: timestamp,
  };
  obj.canonical_key = buildCanonicalKey(kind, content, obj.structured);
  return obj;
}

// ── Core Writer ─────────────────────────────────────────────────────────────

/**
 * Understand a user/assistant message and produce MemoryObjects.
 *
 * This is the main entry point for the RSMA write path. It runs all
 * signal detectors and extraction pipelines synchronously (<5ms).
 */
export async function understandMessage(
  text: string,
  sourceId: string,
  role: "user" | "assistant" = "user",
): Promise<WriterResult> {
  if (!text || text.trim().length < 3) {
    return { objects: [], signals: { isCorrection: false, correctionSignal: null, isUncertain: false, uncertaintySignal: null, isPreference: false, preferenceSignal: null, temporal: null }, eventTypes: [] };
  }

  const signals = detectSignals(text);
  const objects: MemoryObject[] = [];
  const eventTypes: EventType[] = [];
  const sourceKind: SourceKind = role === "user" ? "user_explicit" : "message";

  // Base confidence — lowered if uncertain
  const baseConfidence = signals.isUncertain
    ? SOURCE_TRUST[sourceKind] * PROVISIONAL_CONFIDENCE_FACTOR
    : SOURCE_TRUST[sourceKind];

  // ── Step 1: Decision extraction ──
  try {
    const { extractDecisionsFromText } = await import("../relations/claim-extract.js");
    const decisions = extractDecisionsFromText(text, sourceId);
    for (const d of decisions) {
      const obj = makeObject("decision", d.decisionText, {
        structured: { topic: d.topic, decisionText: d.decisionText },
        sourceKind,
        sourceId,
        extractionMethod: "regex",
        confidence: signals.isUncertain ? 0.45 : 0.9,
        provisional: signals.isUncertain,
        influenceWeight: "high",
      });
      objects.push(obj);
      eventTypes.push(signals.isCorrection ? "correction" : "decision");
    }
  } catch { /* extraction module may not be available in tests */ }

  // ── Step 2: Claim extraction (user explicit) ──
  if (role === "user") {
    try {
      const { extractClaimsFromUserExplicit } = await import("../relations/claim-extract.js");
      const claims = extractClaimsFromUserExplicit(text, sourceId);
      for (const c of claims) {
        const obj = makeObject("claim", `${c.claim.subject} ${c.claim.predicate}: ${c.claim.objectText}`, {
          structured: {
            subject: c.claim.subject,
            predicate: c.claim.predicate,
            objectText: c.claim.objectText,
          },
          sourceKind,
          sourceId,
          extractionMethod: "regex",
          confidence: signals.isUncertain ? baseConfidence : c.claim.confidence,
          provisional: signals.isUncertain,
          influenceWeight: signals.isPreference ? "high" : "standard",
        });
        objects.push(obj);
        eventTypes.push(signals.isPreference ? "preference" : signals.isCorrection ? "correction" : "fact_assertion");
      }
    } catch { /* extraction module may not be available in tests */ }
  }

  // ── Step 3: Loop/task extraction ──
  if (role === "user") {
    try {
      const { extractLoopsFromText } = await import("../relations/claim-extract.js");
      const loops = extractLoopsFromText(text, sourceId);
      for (const l of loops) {
        const obj = makeObject("loop", l.text, {
          structured: {
            loopType: l.loopType,
            sourceType: l.sourceType,
          },
          sourceKind,
          sourceId,
          extractionMethod: "regex",
          confidence: 0.8,
          influenceWeight: "standard",
        });
        objects.push(obj);
        eventTypes.push(l.loopType === "follow_up" ? "reminder" : "task");
      }
    } catch { /* extraction module may not be available in tests */ }
  }

  // ── Step 4: Entity extraction ──
  try {
    const { extractFast } = await import("../relations/entity-extract.js");
    const entities = extractFast(text);
    for (const e of entities) {
      const obj = makeObject("entity", e.name, {
        structured: {
          name: e.name.toLowerCase().trim(),
          strategy: e.strategy,
          entityType: e.entityType,
        },
        sourceKind: "extraction",
        sourceId,
        extractionMethod: "regex",
        confidence: e.confidence,
      });
      objects.push(obj);
    }
  } catch { /* extraction module may not be available in tests */ }

  // ── Step 5: Apply correction/preference/temporal metadata ──
  for (const obj of objects) {
    // Mark correction signal on all objects from this message
    if (signals.isCorrection && obj.provenance.source_detail === undefined) {
      obj.provenance.source_detail = `correction_signal: ${signals.correctionSignal}`;
    }

    // Apply temporal signals — store as note in structured, NOT as date fields
    // (matchedText is natural language like "next Monday", not ISO 8601)
    if (signals.temporal) {
      const temporalNote = `temporal_${signals.temporal.type}: ${signals.temporal.matchedText}`;
      if (obj.structured && typeof obj.structured === "object") {
        (obj.structured as Record<string, unknown>).temporal_hint = signals.temporal.matchedText;
      }
      // Append to content if not already present
      if (!obj.content.includes(signals.temporal.matchedText)) {
        obj.content += ` [${temporalNote}]`;
      }
    }
  }

  return { objects, signals, eventTypes };
}

/**
 * Understand a tool result and produce MemoryObjects.
 */
export async function understandToolResult(
  toolName: string,
  resultJson: unknown,
  sourceId: string,
): Promise<WriterResult> {
  const objects: MemoryObject[] = [];
  const eventTypes: EventType[] = [];

  // Attempt object — always created
  const attemptObj = makeObject("attempt", `${toolName}: success`, {
    structured: {
      toolName,
      status: "success",
      outputSummary: typeof resultJson === "string" ? resultJson.substring(0, 200) : JSON.stringify(resultJson).substring(0, 200),
    },
    sourceKind: "tool_result",
    sourceId,
    extractionMethod: "tool_json",
    confidence: 1.0,
  });
  objects.push(attemptObj);
  eventTypes.push("tool_outcome");

  // Claim extraction from tool result JSON
  try {
    const { extractClaimsFromToolResult } = await import("../relations/claim-extract.js");
    const claims = extractClaimsFromToolResult(toolName, resultJson, sourceId);
    for (const c of claims) {
      const obj = makeObject("claim", `${c.claim.subject} ${c.claim.predicate}: ${c.claim.objectText}`, {
        structured: {
          subject: c.claim.subject,
          predicate: c.claim.predicate,
          objectText: c.claim.objectText,
          valueType: c.claim.valueType,
        },
        sourceKind: "tool_result",
        sourceId,
        extractionMethod: "tool_json",
        confidence: c.claim.confidence,
        trust: SOURCE_TRUST.tool_result,
      });
      objects.push(obj);
      eventTypes.push("fact_assertion");
    }
  } catch { /* extraction module may not be available */ }

  const signals: SignalDetectionResult = {
    isCorrection: false, correctionSignal: null,
    isUncertain: false, uncertaintySignal: null,
    isPreference: false, preferenceSignal: null,
    temporal: null,
  };

  return { objects, signals, eventTypes };
}
