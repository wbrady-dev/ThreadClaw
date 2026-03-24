/**
 * Fast claim extraction — no LLM calls.
 *
 * Four strategies for extracting structured claims:
 * 1. Tool results (trust 1.0): JSON → subject/predicate/object triples
 * 2. User explicit (trust 0.9): "Remember: X" prefixed statements
 * 3. Document KV (trust 0.7): Heading + bullet patterns
 * 4. YAML frontmatter (trust 0.7): Key-value frontmatter blocks
 */

import type { ClaimExtractionResult, EvidenceRole } from "./types.js";
import { SOURCE_TRUST } from "./types.js";
import { buildCanonicalKey } from "./claim-store.js";

// ---------------------------------------------------------------------------
// Strategy 1: Tool results (trust 1.0)
// ---------------------------------------------------------------------------

/**
 * Walk a JSON object recursively, emitting claims for leaf values.
 * Capped at depth=3 to avoid deep nesting.
 */
export function extractClaimsFromToolResult(
  toolName: string,
  resultJson: unknown,
  sourceId: string,
): ClaimExtractionResult[] {
  const results: ClaimExtractionResult[] = [];
  if (resultJson == null || typeof resultJson !== "object") return results;

  function walk(obj: Record<string, unknown>, path: string[], depth: number): void {
    if (depth > 3) return;
    for (const [key, value] of Object.entries(obj)) {
      const currentPath = [...path, key];
      if (value == null) continue;

      if (typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, currentPath, depth + 1);
      } else if (Array.isArray(value)) {
        // Skip arrays of primitives; walk arrays of objects
        for (let i = 0; i < Math.min(value.length, 10); i++) {
          const item = value[i];
          if (item != null && typeof item === "object" && !Array.isArray(item)) {
            walk(item as Record<string, unknown>, [...currentPath, String(i)], depth + 1);
          }
        }
      } else {
        // Leaf value — emit as claim
        const subject = toolName.toLowerCase().trim();
        const predicate = currentPath.join(".");
        const objectText = String(value);
        if (objectText.length > 0 && objectText.length < 500) {
          results.push({
            claim: {
              subject,
              predicate,
              objectText,
              valueType: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "text",
              confidence: 0.8,
              trustScore: SOURCE_TRUST.tool_result,
              sourceAuthority: SOURCE_TRUST.tool_result,
              canonicalKey: buildCanonicalKey(subject, predicate),
            },
            evidence: {
              sourceType: "tool_result",
              sourceId,
              sourceDetail: `${toolName}.${predicate}`,
              evidenceRole: "support" as EvidenceRole,
              confidenceDelta: 0.1,
            },
          });
        }
      }
    }
  }

  walk(resultJson as Record<string, unknown>, [], 0);
  return results;
}

// ---------------------------------------------------------------------------
// Strategy 2: User explicit statements (trust 0.9)
// ---------------------------------------------------------------------------

// Match explicit user fact statements anywhere in text.
// Allows optional words between keyword and colon (e.g., "Remember this:", "Note that:")
const USER_EXPLICIT_RE = /(?:^|\n)\s*(?:remember(?:\s+\w+)?|note(?:\s+\w+)?|fyi|important|keep\s+in\s+mind|fact|observation|key\s+point|critical|essential|must\s+remember|don'?t\s+forget)\s*:\s*(.+)/gim;

/**
 * Extract claims from user-prefixed explicit statements.
 * Pattern: "Remember: <claim text>"
 * Matches ALL occurrences in the text, not just the first.
 */
export function extractClaimsFromUserExplicit(
  text: string,
  sourceId: string,
): ClaimExtractionResult[] {
  const results: ClaimExtractionResult[] = [];

  // Reset regex state (global flag)
  USER_EXPLICIT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = USER_EXPLICIT_RE.exec(text)) !== null) {
    const claimText = match[1].trim();
    // Take first sentence only
    const sentence = claimText.split(/[.!?]\s/)[0].trim();
    if (sentence.length < 3 || sentence.length > 300) continue;

    // Try to parse "subject predicate object" from the sentence
    // Pattern: "X owns/is/uses/has Y" or "X: Y"
    const kvMatch = sentence.match(/^(.+?)\s+(?:is|are|was|has|have|owns|uses|runs|manages|depends|requires|needs|expires|rotates|must|should|cannot|never)\s+(.+)$/i);
    const colonMatch = sentence.match(/^(.+?):\s+(.+)$/);
    // Pattern: "never/always/do not <action>" — store as constraint
    const constraintMatch = sentence.match(/^(never|always|do\s+not|don't)\s+(.+)$/i);

    let subject: string;
    let predicate: string;
    let objectText: string;

    if (kvMatch) {
      const rawSubject = kvMatch[1].trim();
      // For first-person statements ("I have brown hair"), use the object as subject
      // to avoid all first-person claims colliding on canonical key "i::is"
      if (/^(?:i|my|me|we|our)$/i.test(rawSubject)) {
        subject = kvMatch[2].trim(); // "brown hair" becomes the subject
        predicate = "user_" + rawSubject.toLowerCase().replace(/\s+/g, "_"); // "user_i", "user_my"
        objectText = sentence; // full sentence as the value
      } else {
        subject = rawSubject;
        predicate = "is";
        objectText = kvMatch[2].trim();
      }
    } else if (colonMatch) {
      subject = colonMatch[1].trim();
      predicate = "is";
      objectText = colonMatch[2].trim();
    } else if (constraintMatch) {
      subject = "constraint";
      predicate = "states";
      objectText = sentence;
    } else {
      // Can't parse structure — store as general claim
      subject = "user_note";
      predicate = "states";
      objectText = sentence;
    }

    results.push({
      claim: {
        subject: subject.toLowerCase(),
        predicate,
        objectText,
        valueType: "text",
        confidence: 0.9,
        trustScore: SOURCE_TRUST.user_explicit,
        sourceAuthority: SOURCE_TRUST.user_explicit,
        canonicalKey: buildCanonicalKey(subject, predicate),
      },
      evidence: {
        sourceType: "user_explicit",
        sourceId,
        sourceDetail: sentence,
        evidenceRole: "support" as EvidenceRole,
        confidenceDelta: 0.2,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 3: Document KV patterns (trust 0.7)
// ---------------------------------------------------------------------------

// Safe from ReDoS: . does not match \n (non-dotall), so each .+ is bounded per line.
const HEADING_BULLETS_RE = /^(#{1,6})\s+(.+)\n((?:[\t ]*[-*]\s+.+(?:\n|$))+)/gm;
const BULLET_KV_RE = /^[\t ]*[-*]\s+(\w[\w\s]*?):\s*(.+)/;

/**
 * Extract claims from heading + bullet patterns.
 * e.g. "## Auth System\n- Owner: Bob\n- Status: Active"
 */
export function extractClaimsFromDocumentKV(
  text: string,
  sourceId: string,
): ClaimExtractionResult[] {
  const results: ClaimExtractionResult[] = [];
  let match: RegExpExecArray | null;
  HEADING_BULLETS_RE.lastIndex = 0;

  while ((match = HEADING_BULLETS_RE.exec(text)) !== null) {
    const heading = match[2].trim();
    const bulletsBlock = match[3];
    const bullets = bulletsBlock.split("\n").filter((l) => l.trim().length > 0);

    for (const bullet of bullets) {
      const kvMatch = BULLET_KV_RE.exec(bullet);
      if (!kvMatch) continue;

      const predicate = kvMatch[1].trim();
      const objectText = kvMatch[2].trim();
      if (predicate.length > 50 || objectText.length > 300) continue;

      results.push({
        claim: {
          subject: heading.toLowerCase(),
          predicate: predicate.toLowerCase(),
          objectText,
          valueType: "text",
          confidence: 0.7,
          trustScore: SOURCE_TRUST.document,
          sourceAuthority: SOURCE_TRUST.document,
          canonicalKey: buildCanonicalKey(heading, predicate),
        },
        evidence: {
          sourceType: "document",
          sourceId,
          sourceDetail: `${heading} > ${predicate}`,
          evidenceRole: "support" as EvidenceRole,
          confidenceDelta: 0.1,
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 4: YAML frontmatter (trust 0.7)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;
const YAML_KV_RE = /^(\w[\w\s-]*?):\s*(.+)$/;

/**
 * Extract claims from YAML frontmatter blocks.
 * Simple key: value line parsing (no nested YAML).
 */
export function extractClaimsFromFrontmatter(
  text: string,
  sourceId: string,
): ClaimExtractionResult[] {
  const results: ClaimExtractionResult[] = [];
  const fmMatch = FRONTMATTER_RE.exec(text);
  if (!fmMatch) return results;

  const lines = fmMatch[1].split("\n");
  for (const line of lines) {
    const kvMatch = YAML_KV_RE.exec(line.trim());
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    const value = kvMatch[2].trim();
    if (key.length > 50 || value.length > 300) continue;
    // Skip obvious non-claim fields
    if (/^(title|date|draft|layout|template|slug|permalink)$/i.test(key)) continue;

    results.push({
      claim: {
        subject: "document",
        predicate: key.toLowerCase(),
        objectText: value,
        valueType: "text",
        confidence: 0.7,
        trustScore: SOURCE_TRUST.document,
        sourceAuthority: SOURCE_TRUST.document,
        canonicalKey: buildCanonicalKey("document", key),
      },
      evidence: {
        sourceType: "document",
        sourceId,
        sourceDetail: `frontmatter.${key}`,
        evidenceRole: "support" as EvidenceRole,
        confidenceDelta: 0.1,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract claims using all applicable fast strategies.
 * Deduplicates by canonical_key (highest trust wins).
 */
// ---------------------------------------------------------------------------
// Strategy 5: Decision extraction from conversation text
// ---------------------------------------------------------------------------

const DECISION_RE = /(?:^|\n)\s*(?:we(?:'ve)?\s+decided|decision|decided|we\s+chose|we(?:'re)?\s+going\s+(?:to|with)|we\s+agreed|agreed\s+(?:to|upon|that)|choosing|going\s+with)\s*(?:to|that|:)?\s*(.+)/gim;

export interface DecisionExtractionResult {
  topic: string;
  decisionText: string;
  sourceType: string;
  sourceId: string;
}

/**
 * Extract decisions from conversation text.
 * Patterns: "We've decided to...", "We decided...", "Decision: ..."
 */
export function extractDecisionsFromText(
  text: string,
  sourceId: string,
): DecisionExtractionResult[] {
  const results: DecisionExtractionResult[] = [];
  DECISION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DECISION_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    const sentence = raw.split(/[.!?]\s/)[0].trim();
    if (sentence.length < 5 || sentence.length > 300) continue;

    // Extract topic: try structured patterns, then fall back to key nouns
    let topic: string;
    let decisionText: string = sentence;

    // Pattern: "use X for/instead of Y" → topic = what we're deciding about (Y context)
    const forMatch = sentence.match(/(?:use|switch\s+to|adopt|go\s+with|migrate\s+to)\s+(.+?)\s+(?:for|instead\s+of|as|over)\s+(.+)/i);
    // Pattern: "use X" without context → topic = X itself
    const useMatch = sentence.match(/(?:use|switch\s+to|adopt|go\s+with|migrate\s+to)\s+(.+)/i);

    if (forMatch) {
      // Context (what we're deciding ABOUT) is the topic, not what we chose.
      // "use SQLite for the test harness" → topic = "test harness", not "sqlite"
      // This ensures "use Postgres for the test harness" supersedes the SQLite decision.
      const context = forMatch[2].trim().toLowerCase()
        .replace(/^(?:the|a|an|our|my)\s+/, ""); // strip leading articles
      topic = context.substring(0, 60);
    } else if (useMatch) {
      topic = useMatch[1].trim().toLowerCase().substring(0, 60);
    } else {
      // Extract key nouns: drop stopwords, keep distinctive terms
      const stopwords = new Set(["to", "the", "a", "an", "all", "our", "by", "for", "and", "or", "that", "this", "with"]);
      const words = sentence.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !stopwords.has(w));
      topic = words.slice(0, 3).join(" ").substring(0, 60);
    }

    results.push({
      topic,
      decisionText,
      sourceType: "message",
      sourceId,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 6: Loop/task extraction from conversation text
// ---------------------------------------------------------------------------

const LOOP_RE = /(?:^|\n)\s*(?:task|todo|remind(?:er|\s+me)|action\s*item|open\s*(?:task|item|question)|follow[\s-]?up|next\s+step|pending|blocker|action|question|need\s+to)\s*:\s*(.+)/gim;

export interface LoopExtractionResult {
  text: string;
  loopType: "task" | "question" | "follow_up" | "dependency";
  sourceType: string;
  sourceId: string;
}

/**
 * Extract open loops/tasks from conversation text.
 * Patterns: "Task: ...", "Todo: ...", "Reminder: ...", "Action item: ...", "Follow-up: ..."
 */
export function extractLoopsFromText(
  text: string,
  sourceId: string,
): LoopExtractionResult[] {
  const results: LoopExtractionResult[] = [];
  LOOP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = LOOP_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    const sentence = raw.split(/[.!?]\s/)[0].trim();
    if (sentence.length < 5 || sentence.length > 300) continue;

    // Determine loop type from the matched keyword
    const fullMatch = match[0].toLowerCase();
    let loopType: "task" | "question" | "follow_up" | "dependency" = "task";
    if (fullMatch.includes("question")) loopType = "question";
    else if (fullMatch.includes("follow")) loopType = "follow_up";
    else if (fullMatch.includes("remind")) loopType = "follow_up"; // matches "reminder" and "remind me"
    else if (fullMatch.includes("next step")) loopType = "follow_up";
    else if (fullMatch.includes("blocker")) loopType = "dependency";

    results.push({
      text: sentence,
      loopType,
      sourceType: "message",
      sourceId,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Strategy 7: Fast relation extraction between known entities
// ---------------------------------------------------------------------------

// Relation verb patterns — must be specific enough to avoid false positives.
// Each regex matches text BETWEEN two entity names in a sentence.
const RELATION_VERBS: Array<{ re: RegExp; predicate: string }> = [
  // Backup / recovery
  { re: /\bis\s+(?:the\s+)?(?:a\s+)?backup\s+(?:server\s+)?(?:for|of)\b/i, predicate: "backup_for" },
  { re: /\bbacks?\s+up\b/i, predicate: "backup_for" },
  // Dependency / reliance
  { re: /\bdepends?\s+on\b/i, predicate: "depends_on" },
  { re: /\breli(?:es|ed)\s+on\b/i, predicate: "depends_on" },
  { re: /\brequires?\b/i, predicate: "requires" },
  // Ownership / management (require preposition to avoid false positives)
  { re: /\bleads?\s+(?:the\s+)?/i, predicate: "leads" },
  { re: /\bowns?\s+(?:the\s+)?/i, predicate: "owns" },
  { re: /\bmanages?\s+(?:the\s+)?/i, predicate: "manages" },
  { re: /\bmaintains?\s+(?:the\s+)?/i, predicate: "maintains" },
  // Infrastructure
  { re: /\bruns?\s+on\b/i, predicate: "runs_on" },
  { re: /\bconnects?\s+to\b/i, predicate: "connects_to" },
  { re: /\bdeployed\s+(?:on|to|in)\b/i, predicate: "deployed_on" },
  { re: /\bhosted\s+(?:on|by|in)\b/i, predicate: "hosted_on" },
  // Composition
  { re: /\bis\s+(?:a\s+)?(?:part|component|module|service|member)\s+of\b/i, predicate: "part_of" },
  { re: /\bbelongs?\s+to\b/i, predicate: "part_of" },
  // Serving / powering
  { re: /\bserves?\s+(?:as\s+)?(?:the\s+)?/i, predicate: "serves" },
  { re: /\bpowers?\s+(?:the\s+)?/i, predicate: "powers" },
  // Integration / API
  { re: /\bintegrates?\s+(?:with|into)\b/i, predicate: "integrates_with" },
  { re: /\bcalls?\b/i, predicate: "calls" },
  { re: /\binvokes?\b/i, predicate: "calls" },
  { re: /\bextends?\b/i, predicate: "extends" },
  { re: /\bimplements?\b/i, predicate: "implements" },
  // Data flow
  { re: /\bfeeds?\s+(?:into|to)\b/i, predicate: "feeds" },
  { re: /\bsends?\s+(?:to|data\s+to)\b/i, predicate: "sends_to" },
  // Auth
  { re: /\bauthorizes?\b/i, predicate: "authorizes" },
  { re: /\bauthenticates?\s+(?:with|via|against)\b/i, predicate: "authenticates_with" },
];

export interface RelationExtractionResult {
  subjectName: string;
  predicate: string;
  objectName: string;
  confidence: number;
  sourceType: string;
  sourceId: string;
}

/**
 * Extract relations between known entity names using regex patterns.
 * Pure regex — no LLM calls, zero tokens.
 * Scans for pairs of entity names in the same sentence with a relationship verb between them.
 */
export function extractRelationsFast(
  text: string,
  entityNames: string[],
  sourceId: string,
): RelationExtractionResult[] {
  if (!text || entityNames.length < 2) return [];

  const results: RelationExtractionResult[] = [];
  const seen = new Set<string>();

  // Sort entities by length (longest first) to prevent substring collisions
  // e.g., "Azure App Service" should match before "Azure"
  const sortedEntities = [...entityNames].sort((a, b) => b.length - a.length);

  // Split into sentences for locality
  const sentences = text.split(/[.!?\n]+/).filter((s) => s.trim().length > 10);

  for (const sentence of sentences) {
    const lowerSentence = sentence.toLowerCase();

    // Find which entities appear in this sentence (longest-first prevents substring collision)
    const presentEntities: string[] = [];
    for (const name of sortedEntities) {
      if (lowerSentence.includes(name.toLowerCase())) {
        presentEntities.push(name);
      }
    }
    if (presentEntities.length < 2) continue;

    // For each pair of entities, check for relationship verbs between them
    for (let i = 0; i < presentEntities.length; i++) {
      for (let j = 0; j < presentEntities.length; j++) {
        if (i === j) continue;
        const subj = presentEntities[i];
        const obj = presentEntities[j];

        // Find positions in sentence
        const subjIdx = lowerSentence.indexOf(subj.toLowerCase());
        const objIdx = lowerSentence.indexOf(obj.toLowerCase());
        if (subjIdx < 0 || objIdx < 0 || subjIdx >= objIdx) continue;

        // Extract text between the two entities
        const between = sentence.substring(subjIdx + subj.length, objIdx).trim();
        if (between.length < 2 || between.length > 100) continue;

        // Check for relationship verbs
        for (const { re, predicate } of RELATION_VERBS) {
          if (re.test(between)) {
            const key = `${subj.toLowerCase()}::${predicate}::${obj.toLowerCase()}`;
            if (seen.has(key)) break;
            seen.add(key);
            results.push({
              subjectName: subj.toLowerCase(),
              predicate,
              objectName: obj.toLowerCase(),
              confidence: 0.7,
              sourceType: "message",
              sourceId,
            });
            break; // One predicate per entity pair per sentence
          }
        }
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Sensitive content filter
// ---------------------------------------------------------------------------

const SENSITIVE_PATTERNS = [
  /password/i,
  /secret/i,
  /api[_\s-]?key/i,
  /token(?:\s|$)/i,
  /fingerprint/i,
  /private[_\s-]?key/i,
  /credential/i,
  /ssh[_\s-]?key/i,
  /\.pem\b/i,
  /bearer\s/i,
  /auth[_\s-]?token/i,
  /access[_\s-]?key/i,
  /secret[_\s-]?key/i,
];

/**
 * Check if a claim contains sensitive data that should not be persisted.
 * Returns true if the claim text contains passwords, keys, secrets, etc.
 */
function isSensitiveClaim(claim: ClaimExtractionResult): boolean {
  const text = `${claim.claim.subject} ${claim.claim.objectText ?? ""}`.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => p.test(text));
}

// Subjects that are meta/self-referential and should not become claims
const META_SUBJECTS = new Set([
  "document", "threadclaw", "openclaw", "copper", "agent", "bot",
  "environment", "user_note", "system", "model", "plugin",
]);

/**
 * Check if a claim is meta/self-referential (tool descriptions, identity, etc.)
 */
function isMetaClaim(claim: ClaimExtractionResult): boolean {
  const subject = claim.claim.subject.toLowerCase().trim();
  if (META_SUBJECTS.has(subject)) return true;
  if (subject.includes(" vibe") || subject.includes(" identity")) return true;
  // Tool list claims (cc_grep, cc_recall, cc_state, etc.)
  const obj = (claim.claim.objectText ?? "").toLowerCase();
  if (/cc_\w+.*cc_\w+/.test(obj)) return true; // two or more cc_ references = tool list
  return false;
}

// ---------------------------------------------------------------------------
// Narrative fact extraction (trust 0.6)
// ---------------------------------------------------------------------------

// Narrative fact patterns — capture project relationships from ordinary sentences
const NARRATIVE_PATTERNS = [
  // "X is a/the Y for Z"
  /(?:^|\.\s+)([A-Z][\w\s-]{1,30})\s+is\s+(?:a|the|an)\s+(.{5,80}?)(?:\.|$)/gm,
  // "The lead/owner is X"
  /(?:^|\.\s+)(?:the\s+)?(?:lead|owner|maintainer)\s+is\s+([A-Z][\w\s]{2,30})(?:\.|,|$)/gim,
  // "X leads/owns/manages Y"
  /([A-Z][\w\s]{2,30})\s+(?:leads?|owns?|manages?|maintains?|runs?)\s+([A-Z][\w\s]{2,40})(?:\.|,|$)/gm,
  // "X depends on Y"
  /([A-Z][\w\s]{2,30})\s+(?:depends?\s+on|relies?\s+on|uses?|requires?)\s+([A-Z][\w\s]{2,40})(?:\s+for\s+(.{3,40}))?(?:\.|,|$)/gm,
  // "X runs on Y at Z"
  /(?:^|\.\s+)(?:it\s+)?runs\s+on\s+([\w-]{3,30})\s+at\s+([\d.]{7,15})(?:\.|,|$)/gim,
  // "X on port N"
  /([A-Z][\w\s]{2,20})\s+(?:on|uses)\s+port\s+(\d{2,5})/gim,
  // "X handles/processes Y"
  /([A-Z][\w\s]{2,20})\s+(?:handles?|processes?)\s+(?:the\s+)?(.{5,60}?)(?:\.|,|$)/gm,
];

function extractNarrativeFacts(text: string, sourceId: string): ClaimExtractionResult[] {
  const results: ClaimExtractionResult[] = [];

  for (const pattern of NARRATIVE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const fullMatch = match[0].trim();
      if (fullMatch.length < 10 || fullMatch.length > 200) continue;

      // Use first capture as subject, rest as object
      const subject = (match[1] ?? "").trim().toLowerCase();
      const objectText = (match[2] ?? match[0] ?? "").trim();
      const extraContext = (match[3] ?? "").trim(); // optional "for Z" context

      if (!subject || subject.length < 2 || !objectText) continue;

      // Skip if subject is a common word
      const skipSubjects = ["it", "this", "that", "the", "we", "i", "he", "she", "they", "both"];
      if (skipSubjects.includes(subject)) continue;

      // Detect predicate from the matched verb in fullMatch
      let predicate = "is";
      const verbMatch = fullMatch.match(/\b(leads?|owns?|manages?|maintains?|depends?\s+on|relies?\s+on|uses?|requires?|handles?|processes?|runs?\s+on)\b/i);
      if (verbMatch) {
        predicate = verbMatch[1].toLowerCase().replace(/s$/, "").trim();
      }

      const fullObjectText = extraContext ? `${objectText} for ${extraContext}` : objectText;

      results.push({
        claim: {
          subject,
          predicate,
          objectText: fullObjectText,
          valueType: "text",
          confidence: 0.6,
          trustScore: 0.6,
          sourceAuthority: 0.6,
          canonicalKey: buildCanonicalKey(subject, predicate),
        },
        evidence: {
          sourceType: "narrative",
          sourceId,
          sourceDetail: fullMatch.substring(0, 100),
          evidenceRole: "support" as EvidenceRole,
          confidenceDelta: 0.1,
        },
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Combined fast extraction (all strategies)
// ---------------------------------------------------------------------------

export function extractClaimsFast(
  text: string,
  context: {
    sourceType: string;
    sourceId: string;
    toolName?: string;
    toolResult?: unknown;
  },
): ClaimExtractionResult[] {
  if (!text && !context.toolResult) return [];

  const all: ClaimExtractionResult[] = [];

  // Tool result extraction (highest trust)
  if (context.toolResult && context.toolName) {
    all.push(...extractClaimsFromToolResult(context.toolName, context.toolResult, context.sourceId));
  }

  if (text) {
    // User explicit extraction
    all.push(...extractClaimsFromUserExplicit(text, context.sourceId));
    // Narrative fact extraction (project facts from ordinary sentences)
    all.push(...extractNarrativeFacts(text, context.sourceId));
    // Document KV extraction
    all.push(...extractClaimsFromDocumentKV(text, context.sourceId));
    // YAML frontmatter extraction
    all.push(...extractClaimsFromFrontmatter(text, context.sourceId));
  }

  // Deduplicate by canonical_key — highest trust wins
  const deduped = new Map<string, ClaimExtractionResult>();
  for (const result of all) {
    const key = result.claim.canonicalKey;
    const existing = deduped.get(key);
    if (!existing || (result.claim.trustScore ?? 0) > (existing.claim.trustScore ?? 0)) {
      deduped.set(key, result);
    }
  }

  // Filter out sensitive claims (passwords, keys, secrets) and meta claims (identity, tool lists)
  const safe = Array.from(deduped.values()).filter((r) => !isSensitiveClaim(r) && !isMetaClaim(r));

  return safe;
}
