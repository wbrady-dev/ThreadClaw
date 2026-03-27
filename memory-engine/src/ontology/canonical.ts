/**
 * Canonical Key Generation — core infrastructure for RSMA.
 *
 * Canonical keys determine what a MemoryObject is "about." Two objects sharing
 * a canonical key triggers the TruthEngine to decide their relationship
 * (supersession, conflict, or coexistence).
 *
 * Per-kind strategies — no universal formula. Different kinds of knowledge
 * have different identity semantics.
 */

import { createHash } from "node:crypto";
import type { MemoryKind, StructuredInvariant, StructuredClaim } from "./types.js";

// ── Normalization ───────────────────────────────────────────────────────────

/** Normalize a string for canonical key comparison. */
export function normalize(value: string | undefined | null): string {
  if (!value) return "";
  return value.toLowerCase().trim().replace(/\s+/g, " ");
}

/** SHA-256 prefix hash (for content-based keys). Trim first, then truncate. */
export function hashPrefix(text: string, maxChars: number): string {
  const trimmed = text.trim().toLowerCase().substring(0, maxChars);
  return createHash("sha256").update(trimmed).digest("hex").substring(0, 16);
}

/**
 * Normalize predicates to a standard set so synonyms merge into the same
 * canonical key. "runs_on", "technology", "built_with" → "uses", etc.
 */
const PREDICATE_ALIASES: Record<string, string> = {
  runs_on: "uses", technology: "uses", built_with: "uses", powered_by: "uses",
  run_on: "uses", use: "uses", utilizes: "uses",
  works_under: "reports_to", managed_by: "reports_to", supervised_by: "reports_to", boss_of: "manages",
  leads: "manages", supervises: "manages", runs: "manages", is_boss_of: "manages",
  employed_by: "works_at", works_for: "works_at",
  has: "owns", possesses: "owns",
  based_in: "located_at", lives_in: "located_at", found_at: "located_at",
  state: "status", condition: "status", health: "status",
  called: "name", known_as: "name", titled: "name",
  spouse_of: "married_to", partner_of: "married_to",
  working_with: "works_with",
};

export function normalizePredicate(predicate: string): string {
  const lower = predicate.toLowerCase().trim().replace(/\s+/g, "_");
  return PREDICATE_ALIASES[lower] ?? lower;
}

/**
 * Normalize topic labels so abbreviations and synonyms merge into the same
 * canonical key. "db" → "database", "tech" → "technology", etc.
 */
const TOPIC_ALIASES: Record<string, string> = {
  db: "database", db_technology: "database", rdbms: "database", datastore: "database",
  tech: "technology", stack: "technology",
  mgr: "manager", supervisor: "manager", boss: "manager",
  config: "configuration", cfg: "configuration", settings: "configuration",
  env: "environment", environ: "environment",
  repo: "repository", repos: "repository",
  dir: "directory", folder: "directory", path: "directory",
  auth: "authentication", authn: "authentication",
  authz: "authorization",
  infra: "infrastructure",
  loc: "location", region: "location", area: "location",
  lang: "language", programming_language: "language",
  os: "operating_system", platform: "operating_system",
  ver: "version", vers: "version",
  dept: "department", team: "department",
};

export function normalizeTopic(topic: string): string {
  const lower = topic.toLowerCase().trim().replace(/\s+/g, "_");
  return TOPIC_ALIASES[lower] ?? lower;
}

// ── Per-Kind Key Strategies ─────────────────────────────────────────────────

interface StructuredDecision {
  topic?: string;
}

interface StructuredProcedure {
  toolName?: string;
  key?: string;
}

interface StructuredRelation {
  subjectName?: string;
  predicate?: string;
  objectName?: string;
}

interface StructuredCapability {
  capabilityType?: string;
  capabilityKey?: string;
}

/**
 * Build a canonical key for a MemoryObject based on its kind.
 *
 * Returns undefined for kinds that don't support dedup/supersession
 * (chunks, messages, summaries, attempts, deltas, events).
 */
export function buildCanonicalKey(
  kind: MemoryKind,
  content: string,
  structured?: unknown,
): string | undefined {
  switch (kind) {
    case "claim": {
      // subject::topic (preferred) or subject::predicate (fallback)
      // Topic is a semantic label from the LLM ("database", "manager", "status")
      // that groups related claims regardless of predicate wording.
      const s = structured as StructuredClaim | undefined;
      const subject = normalize(s?.subject);
      const topic = s?.topic ? normalizeTopic(s.topic) : "";
      const predicate = s?.predicate ? normalizePredicate(s.predicate) : "";
      const aspect = topic || predicate;
      if (!subject || !aspect) return undefined;
      return `claim::${subject}::${aspect}`;
    }

    case "decision": {
      // decision::hash(topic) — hash avoids collisions from truncation
      const s = structured as StructuredDecision | undefined;
      const topic = normalize(s?.topic);
      if (!topic) return undefined;
      return `decision::${hashPrefix(topic, 200)}`;
    }

    case "entity": {
      // entity::type::name (type-qualified to prevent cross-type collisions)
      const name = normalize(content);
      if (!name) return undefined;
      const s = structured as { entityType?: string | null } | undefined;
      const entityType = s?.entityType ? s.entityType.toLowerCase().trim() : "unknown";
      return `entity::${entityType}::${name}`;
    }

    case "relation": {
      // relation::subject::predicate::object (with predicate normalization)
      const r = structured as StructuredRelation | undefined;
      const subj = normalize(r?.subjectName);
      const pred = r?.predicate ? normalizePredicate(r.predicate) : "";
      const obj = normalize(r?.objectName);
      if (!subj || !pred || !obj) return undefined;
      return `relation::${subj}::${pred}::${obj}`;
    }

    case "loop": {
      // loop::hash(first 100 chars) — catches near-duplicate tasks
      if (!content || content.trim().length < 3) return undefined;
      return `loop::${hashPrefix(content, 100)}`;
    }

    case "procedure": {
      // proc::tool_name::pattern_key
      const s = structured as StructuredProcedure | undefined;
      const toolName = normalize(s?.toolName);
      const key = normalize(s?.key);
      if (!toolName || !key) return undefined;
      return `proc::${toolName}::${key}`;
    }

    case "invariant": {
      // inv::key
      const s = structured as StructuredInvariant | undefined;
      const key = normalize(s?.key);
      if (!key) return undefined;
      return `inv::${key}`;
    }

    case "capability": {
      // capability::type::key
      const s = structured as StructuredCapability | undefined;
      const capType = normalize(s?.capabilityType);
      const capKey = normalize(s?.capabilityKey);
      if (!capType || !capKey) return undefined;
      return `capability::${capType}::${capKey}`;
    }

    case "conflict": {
      // conflict::hash(content) — conflicts are unique per subject matter
      if (!content || !content.trim()) return undefined;
      return `conflict::${hashPrefix(content, 200)}`;
    }

    // No dedup for these kinds — they are append-only or identity-less
    case "event":
    case "chunk":
    case "message":
    case "summary":
    case "attempt":
    case "delta":
      return undefined;

    default:
      return undefined;
  }
}
