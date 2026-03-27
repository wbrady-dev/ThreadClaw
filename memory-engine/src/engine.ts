import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
} from "openclaw/plugin-sdk";
import { blockFromPart, ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import type { LcmConfig } from "./db/config.js";
import { getLcmConnection } from "./db/connection.js";
import { getLcmDbFeatures } from "./db/features.js";
import { runLcmMigrations } from "./db/migration.js";
import {
  createDelegatedExpansionGrant,
  removeDelegatedExpansionGrantForSession,
  revokeDelegatedExpansionGrantForSession,
} from "./expansion-auth.js";
import { DEFAULT_SCOPE_ID } from "./ontology/types.js";
import { isMigrationNeeded as isProvenanceMigrationNeeded, migrateToProvenanceLinks } from "./ontology/migration.js";
import {
  extensionFromNameOrMime,
  formatFileReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";
import { RetrievalEngine } from "./retrieval.js";
import {
  ConversationStore,
  type CreateMessagePartInput,
  type MessagePartRecord,
  type MessagePartType,
} from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { createLcmSummarizeFromLegacyParams } from "./summarize.js";
import type { LcmDependencies } from "./types.js";
import { estimateTokens } from "./utils/tokens.js";
import type { GraphDb } from "./relations/types.js";
import { getGraphConnection } from "./relations/graph-connection.js";
import { runGraphMigrations } from "./relations/schema.js";
import { buildAwarenessNote } from "./relations/awareness.js";
import { compileContextCapsules } from "./relations/context-compiler.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];
type AssembleResultWithSystemPrompt = AssembleResult & { systemPromptAddition?: string };

// ── RSMA Extraction Health Monitoring ────────────────────────────────────────
let _rsmaSuccessCount = 0;
let _rsmaFailCount = 0;
const _RSMA_LOG_INTERVAL = 100;

// ── Extraction backpressure ─────────────────────────────────────────────────
let _activeExtractions = 0;
const MAX_CONCURRENT_EXTRACTIONS = 3;

// ── NER Circuit Breaker ─────────────────────────────────────────────────────
let _nerCircuitOpen = false;
let _nerLastFailure = 0;
// NER_CIRCUIT_RESET_MS is now driven by config.nerCircuitResetMs (default 30_000)

// ── Helpers ──────────────────────────────────────────────────────────────────

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function appendTextValue(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendTextValue(entry, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  appendTextValue(record.text, out);
  appendTextValue(record.value, out);
}

function extractReasoningText(record: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  appendTextValue(record.summary, chunks);
  if (chunks.length === 0) {
    return undefined;
  }

  const normalized = chunks
    .map((chunk) => chunk.trim())
    .filter((chunk, idx, arr) => chunk.length > 0 && arr.indexOf(chunk) === idx);
  return normalized.length > 0 ? normalized.join("\n") : undefined;
}

function normalizeUnknownBlock(value: unknown): {
  type: string;
  text?: string;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      type: "agent",
      metadata: { raw: value },
    };
  }

  const record = value as Record<string, unknown>;
  const rawType = safeString(record.type);
  return {
    type: rawType ?? "agent",
    text:
      safeString(record.text) ??
      safeString(record.thinking) ??
      ((rawType === "reasoning" || rawType === "thinking")
        ? extractReasoningText(record)
        : undefined),
    metadata: { raw: record },
  };
}

function toPartType(type: string): MessagePartType {
  switch (type) {
    case "text":
      return "text";
    case "thinking":
    case "reasoning":
      return "reasoning";
    case "tool_use":
    case "toolUse":
    case "tool-use":
    case "toolCall":
    case "functionCall":
    case "function_call":
    case "function_call_output":
    case "tool_result":
    case "toolResult":
    case "tool":
      return "tool";
    case "patch":
      return "patch";
    case "file":
    case "image":
      return "file";
    case "subtask":
      return "subtask";
    case "compaction":
      return "compaction";
    case "step_start":
    case "step-start":
      return "step_start";
    case "step_finish":
    case "step-finish":
      return "step_finish";
    case "snapshot":
      return "snapshot";
    case "retry":
      return "retry";
    case "agent":
      return "agent";
    default:
      return "agent";
  }
}

/**
 * Convert AgentMessage content into plain text for DB storage.
 *
 * For content block arrays we keep only text blocks to avoid persisting raw
 * JSON syntax that can later pollute assembled model context.
 */
function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object";
      })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }

  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
}

function toRuntimeRoleForTokenEstimate(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool" || role === "toolResult") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

function toSyntheticMessagePartRecord(
  part: CreateMessagePartInput,
  messageId: number,
): MessagePartRecord {
  return {
    partId: `estimate-part-${part.ordinal}`,
    messageId,
    sessionId: part.sessionId,
    partType: part.partType,
    ordinal: part.ordinal,
    textContent: part.textContent ?? null,
    toolCallId: part.toolCallId ?? null,
    toolName: part.toolName ?? null,
    toolInput: part.toolInput ?? null,
    toolOutput: part.toolOutput ?? null,
    metadata: part.metadata ?? null,
  };
}

function normalizeMessageContentForStorage(params: {
  message: AgentMessage;
  fallbackContent: string;
}): unknown {
  const { message, fallbackContent } = params;
  if (!("content" in message)) {
    return fallbackContent;
  }

  const role = toRuntimeRoleForTokenEstimate(message.role);
  const parts = buildMessageParts({
    sessionId: "storage-estimate",
    message,
    fallbackContent,
  }).map((part) => toSyntheticMessagePartRecord(part, 0));

  if (parts.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }

  const blocks = parts.map(blockFromPart);
  if (role === "user" && blocks.length === 1 && isTextBlock(blocks[0])) {
    return blocks[0].text;
  }
  return blocks;
}

/**
 * Estimate token usage for the content shape that the assembler will emit.
 *
 * LCM stores a plain-text fallback copy in messages.content, but message_parts
 * can rehydrate larger structured/raw blocks. This estimator mirrors the
 * rehydrated shape so compaction decisions use realistic token totals.
 */
function estimateContentTokensForRole(params: {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  fallbackContent: string;
}): number {
  const { role, content, fallbackContent } = params;

  if (typeof content === "string") {
    return estimateTokens(content);
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return estimateTokens(fallbackContent);
    }

    if (role === "user" && content.length === 1 && isTextBlock(content[0])) {
      return estimateTokens(content[0].text);
    }

    const serialized = JSON.stringify(content);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  if (content && typeof content === "object") {
    if (role === "user" && isTextBlock(content)) {
      return estimateTokens(content.text);
    }

    const serialized = JSON.stringify([content]);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  return estimateTokens(fallbackContent);
}

function buildMessageParts(params: {
  sessionId: string;
  message: AgentMessage;
  fallbackContent: string;
}): import("./store/conversation-store.js").CreateMessagePartInput[] {
  const { sessionId, message, fallbackContent } = params;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelToolCallId =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id) ??
    safeString(topLevel.toolUseId) ??
    safeString(topLevel.tool_use_id) ??
    safeString(topLevel.call_id) ??
    safeString(topLevel.id);
  const topLevelToolName =
    safeString(topLevel.toolName) ??
    safeString(topLevel.tool_name);
  const topLevelIsError =
    safeBoolean(topLevel.isError) ??
    safeBoolean(topLevel.is_error);

  // BashExecutionMessage: preserve a synthetic text part so output is round-trippable.
  if (!("content" in message) && "command" in message && "output" in message) {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: fallbackContent,
        metadata: toJson({
          originalRole: role,
          source: "bash-exec",
          command: safeString((message as { command?: unknown }).command),
        }),
      },
    ];
  }

  if (!("content" in message)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "unknown-message-shape",
          raw: message,
        }),
      },
    ];
  }

  if (typeof message.content === "string") {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: message.content,
        metadata: toJson({
          originalRole: role,
          toolCallId: topLevelToolCallId,
          toolName: topLevelToolName,
          isError: topLevelIsError,
        }),
      },
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "non-array-content",
          raw: message.content,
        }),
      },
    ];
  }

  const parts: CreateMessagePartInput[] = [];
  for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
    const block = normalizeUnknownBlock(message.content[ordinal]);
    const metadataRecord = block.metadata.raw as Record<string, unknown> | undefined;
    const partType = toPartType(block.type);
    const toolCallId =
      safeString(metadataRecord?.toolCallId) ??
      safeString(metadataRecord?.tool_call_id) ??
      safeString(metadataRecord?.toolUseId) ??
      safeString(metadataRecord?.tool_use_id) ??
      safeString(metadataRecord?.call_id) ??
      (partType === "tool" ? safeString(metadataRecord?.id) : undefined) ??
      topLevelToolCallId;

    parts.push({
      sessionId,
      partType,
      ordinal,
      textContent: block.text ?? null,
      toolCallId,
      toolName:
        safeString(metadataRecord?.name) ??
        safeString(metadataRecord?.toolName) ??
        safeString(metadataRecord?.tool_name) ??
        topLevelToolName,
      toolInput:
        metadataRecord?.input !== undefined
          ? toJson(metadataRecord.input)
          : metadataRecord?.arguments !== undefined
            ? toJson(metadataRecord.arguments)
          : metadataRecord?.toolInput !== undefined
            ? toJson(metadataRecord.toolInput)
            : (safeString(metadataRecord?.tool_input) ?? null),
      toolOutput:
        metadataRecord?.output !== undefined
          ? toJson(metadataRecord.output)
          : metadataRecord?.toolOutput !== undefined
            ? toJson(metadataRecord.toolOutput)
            : (safeString(metadataRecord?.tool_output) ?? null),
      metadata: toJson({
        originalRole: role,
        toolCallId: topLevelToolCallId,
        toolName: topLevelToolName,
        isError: topLevelIsError,
        rawType: block.type,
        raw: metadataRecord ?? message.content[ordinal],
      }),
    });
  }

  return parts;
}

/**
 * Map AgentMessage role to the DB enum.
 *
 *   "user"      -> "user"
 *   "assistant" -> "assistant"
 *
 * AgentMessage only has user/assistant roles, but we keep the mapping
 * explicit for clarity and future-proofing.
 */
function toDbRole(role: string): "user" | "assistant" | "system" | "tool" {
  if (role === "tool" || role === "toolResult") {
    return "tool";
  }
  if (role === "system") {
    return "system";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  // Unknown roles are preserved via message_parts metadata and treated as assistant.
  return "assistant";
}

type StoredMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokenCount: number;
};

/**
 * Normalize AgentMessage variants into the storage shape used by LCM.
 */
function toStoredMessage(message: AgentMessage): StoredMessage {
  const content =
    "content" in message
      ? extractMessageContent(message.content)
      : "output" in message
        ? `$ ${(message as { command: string; output: string }).command}\n${(message as { command: string; output: string }).output}`
        : "";
  const runtimeRole = toRuntimeRoleForTokenEstimate(message.role);
  const normalizedContent =
    "content" in message
      ? normalizeMessageContentForStorage({
          message,
          fallbackContent: content,
        })
      : content;
  const tokenCount =
    "content" in message
      ? estimateContentTokensForRole({
          role: runtimeRole,
          content: normalizedContent,
          fallbackContent: content,
        })
      : estimateTokens(content);

  return {
    role: toDbRole(message.role),
    content,
    tokenCount,
  };
}

function estimateMessageContentTokensForAfterTurn(content: unknown): number {
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      const text =
        typeof record.text === "string"
          ? record.text
          : typeof record.thinking === "string"
            ? record.thinking
            : "";
      if (text) {
        total += estimateTokens(text);
      }
    }
    return total;
  }
  if (content == null) {
    return 0;
  }
  const serialized = JSON.stringify(content);
  return estimateTokens(typeof serialized === "string" ? serialized : "");
}

function estimateSessionTokenCountForAfterTurn(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if ("content" in message) {
      total += estimateMessageContentTokensForAfterTurn(message.content);
      continue;
    }
    if ("command" in message || "output" in message) {
      const commandText =
        typeof (message as { command?: unknown }).command === "string"
          ? (message as { command?: string }).command
          : "";
      const outputText =
        typeof (message as { output?: unknown }).output === "string"
          ? (message as { output?: string }).output
          : "";
      total += estimateTokens(`${commandText}\n${outputText}`);
    }
  }
  return total;
}

function isBootstrapMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const msg = value as { role?: unknown; content?: unknown; command?: unknown; output?: unknown };
  if (typeof msg.role !== "string") {
    return false;
  }
  return "content" in msg || ("command" in msg && "output" in msg);
}

/** Load recoverable messages from a JSON/JSONL session file. */
function readLeafPathMessages(sessionFile: string): AgentMessage[] {
  let raw = "";
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(isBootstrapMessage);
    } catch {
      return [];
    }
  }

  const messages: AgentMessage[] = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    try {
      const parsed = JSON.parse(item);
      const candidate =
        parsed && typeof parsed === "object" && "message" in parsed
          ? (parsed as { message?: unknown }).message
          : parsed;
      if (isBootstrapMessage(candidate)) {
        messages.push(candidate);
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return messages;
}

function messageIdentity(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

// ── LcmContextEngine ────────────────────────────────────────────────────────

export class LcmContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "threadclaw-memory",
    name: "ThreadClaw Memory Engine",
    version: "0.3.0",
    ownsCompaction: true,
  };

  private config: LcmConfig;

  /** Get the configured timezone, falling back to system timezone. */
  get timezone(): string {
    return this.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private assembler: ContextAssembler;
  private compaction: CompactionEngine;
  private retrieval: RetrievalEngine;
  private graphDb: GraphDb | null = null;
  private migrated = false;
  private readonly fts5Available: boolean;
  private sessionOperationQueues = new Map<string, Promise<void>>();

  /** Extract a stable agent_id from a session ID or session key. */
  private resolveAgentIdFromSessionId(sessionId: string): string {
    const parsed = this.deps.parseAgentSessionKey(sessionId);
    return this.deps.normalizeAgentId(parsed?.agentId);
  }
  private largeFileTextSummarizerResolved = false;
  private largeFileTextSummarizer?: (prompt: string) => Promise<string | null>;
  private deps: LcmDependencies;

  /**
   * Replace the engine's dependencies (e.g. after re-registration with fresh config/env).
   * Updates config and deps without tearing down DB connections or stores.
   */
  updateDeps(deps: LcmDependencies): void {
    this.deps = deps;
    this.config = deps.config;
  }

  constructor(deps: LcmDependencies) {
    this.deps = deps;
    this.config = deps.config;

    const db = getLcmConnection(this.config.databasePath, this.config.busyTimeoutMs);
    this.fts5Available = getLcmDbFeatures(db).fts5Available;

    this.conversationStore = new ConversationStore(db, { fts5Available: this.fts5Available });
    this.summaryStore = new SummaryStore(db, { fts5Available: this.fts5Available });

    if (!this.fts5Available) {
      this.deps.log.warn(
        "[cc-mem] FTS5 unavailable in the current Node runtime; full_text search will fall back to LIKE and indexing is disabled",
      );
    }

    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
      this.config.timezone,
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      leafMinFanout: this.config.leafMinFanout,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinFanoutHard: this.config.condensedMinFanoutHard,
      incrementalMaxDepth: this.config.incrementalMaxDepth,
      leafChunkTokens: this.config.leafChunkTokens,
      leafTargetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      maxRounds: this.config.maxRounds ?? 10,
      timezone: this.config.timezone,
    };
    // Initialize relations/evidence graph DB if enabled
    if (!this.config.relationsEnabled) {
      this.deps.log.info("[cc-mem] Relations/RSMA extraction disabled. Set THREADCLAW_MEMORY_RELATIONS_ENABLED=true to enable.");
    }
    if (this.config.relationsEnabled) {
      try {
        const graphDbConn = getGraphConnection(this.config.relationsGraphDbPath, this.config.graphBusyTimeoutMs);
        runGraphMigrations(graphDbConn, this.config.relationsGraphDbPath);
        this.graphDb = graphDbConn;
      } catch (err) {
        this.deps.log.warn(
          `[cc-mem] Failed to initialize evidence graph DB: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      compactionConfig,
      this.graphDb ?? undefined,
      { claimExtractionEnabled: this.config.relationsClaimExtractionEnabled },
    );

    this.retrieval = new RetrievalEngine(this.conversationStore, this.summaryStore);

    // Periodic cleanup of settled session queues (every 5 minutes)
    setInterval(() => {
      for (const [id, promise] of this.sessionOperationQueues) {
        // Check if promise is settled by racing with a short timeout
        const marker = Symbol("pending");
        Promise.race([promise.then(() => "done", () => "done"), new Promise<typeof marker>((r) => setTimeout(() => r(marker), 10))]).then((v) => {
          if (v !== marker) this.sessionOperationQueues.delete(id);
        });
      }
    }, 5 * 60 * 1000).unref();
  }

  /** Ensure DB schema is up-to-date. Called lazily on first bootstrap/ingest/assemble/compact. */
  private ensureMigrated(): void {
    if (this.migrated) {
      return;
    }
    const db = getLcmConnection(this.config.databasePath, this.config.busyTimeoutMs);
    runLcmMigrations(db, { fts5Available: this.fts5Available });

    // RSMA: backfill provenance_links from legacy join tables (idempotent, synchronous)
    if (this.graphDb) {
      try {
        if (isProvenanceMigrationNeeded(this.graphDb)) {
          const stats = migrateToProvenanceLinks(this.graphDb);
          if (stats.total > 0) {
            this.deps.log.info(`[rsma] Migrated ${stats.total} legacy relationships to provenance_links`);
          }
        }
      } catch (err) {
        this.deps.log.warn(`[rsma] Provenance migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.migrated = true;
  }

  /**
   * Serialize mutating operations per session to prevent ingest/compaction races.
   */
  private async withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionId) ?? Promise.resolve();
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.sessionOperationQueues.set(sessionId, next);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseQueue();
      void next.finally(() => {
        if (this.sessionOperationQueues.get(sessionId) === next) {
          this.sessionOperationQueues.delete(sessionId);
        }
      });
    }
  }

  /** Normalize optional live token estimates supplied by runtime callers. */
  private normalizeObservedTokenCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  /** Resolve token budget from direct params or legacy fallback input. */
  private resolveTokenBudget(params: {
    tokenBudget?: number;
    legacyParams?: Record<string, unknown>;
  }): number | undefined {
    const lp = params.legacyParams ?? {};
    if (
      typeof params.tokenBudget === "number" &&
      Number.isFinite(params.tokenBudget) &&
      params.tokenBudget > 0
    ) {
      return Math.floor(params.tokenBudget);
    }
    if (
      typeof lp.tokenBudget === "number" &&
      Number.isFinite(lp.tokenBudget) &&
      lp.tokenBudget > 0
    ) {
      return Math.floor(lp.tokenBudget);
    }
    return undefined;
  }

  /** Resolve an LCM conversation id from a session key via the session store. */
  private async resolveConversationIdForSessionKey(
    sessionKey: string,
  ): Promise<number | undefined> {
    const trimmedKey = sessionKey.trim();
    if (!trimmedKey) {
      return undefined;
    }
    try {
      const runtimeSessionId = await this.deps.resolveSessionIdFromSessionKey(trimmedKey);
      if (!runtimeSessionId) {
        return undefined;
      }
      const conversation =
        await this.conversationStore.getConversationBySessionId(runtimeSessionId);
      return conversation?.conversationId;
    } catch {
      return undefined;
    }
  }

  /** Build a summarize callback with runtime provider fallback handling. */
  private async resolveSummarize(params: {
    legacyParams?: Record<string, unknown>;
    customInstructions?: string;
  }): Promise<(text: string, aggressive?: boolean) => Promise<string>> {
    const lp = params.legacyParams ?? {};
    if (typeof lp.summarize === "function") {
      return lp.summarize as (text: string, aggressive?: boolean) => Promise<string>;
    }
    try {
      const runtimeSummarizer = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: lp,
        customInstructions: params.customInstructions,
      });
      if (runtimeSummarizer) {
        return runtimeSummarizer;
      }
      console.error(`[cc-mem] resolveSummarize: createLcmSummarizeFromLegacyParams returned undefined`);
    } catch (err) {
      console.error(`[cc-mem] resolveSummarize failed, using emergency fallback:`, err instanceof Error ? err.message.slice(0, 500) : "unknown error");
    }
    console.error(`[cc-mem] resolveSummarize: FALLING BACK TO EMERGENCY TRUNCATION`);
    return createEmergencyFallbackSummarize();
  }

  /**
   * Resolve an optional model-backed summarizer for large text file exploration.
   *
   * This is opt-in via env so ingest remains deterministic and lightweight when
   * no summarization model is configured.
   */
  private async resolveLargeFileTextSummarizer(): Promise<
    ((prompt: string) => Promise<string | null>) | undefined
  > {
    if (this.largeFileTextSummarizerResolved) {
      return this.largeFileTextSummarizer;
    }
    this.largeFileTextSummarizerResolved = true;

    const provider = this.deps.config.largeFileSummaryProvider;
    const model = this.deps.config.largeFileSummaryModel;
    if (!provider || !model) {
      return undefined;
    }

    try {
      const summarize = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: { provider, model },
      });
      if (!summarize) {
        return undefined;
      }

      this.largeFileTextSummarizer = async (prompt: string): Promise<string | null> => {
        const summary = await summarize(prompt, false);
        if (typeof summary !== "string") {
          return null;
        }
        const trimmed = summary.trim();
        return trimmed.length > 0 ? trimmed : null;
      };
      return this.largeFileTextSummarizer;
    } catch {
      return undefined;
    }
  }

  /** Persist intercepted large-file text payloads to ~/.openclaw/threadclaw-files. */
  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = join(homedir(), ".openclaw", "threadclaw-files", String(params.conversationId));
    await mkdir(dir, { recursive: true });

    const normalizedExtension = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "txt";
    const filePath = join(dir, `${params.fileId}.${normalizedExtension}`);
    await writeFile(filePath, params.content, "utf8");
    return filePath;
  }

  /**
   * Intercept oversized <file> blocks before persistence and replace them with
   * compact file references backed by large_files records.
   */
  private async interceptLargeFiles(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const blocks = parseFileBlocks(params.content);
    if (blocks.length === 0) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const summarizeText = await this.resolveLargeFileTextSummarizer();
    const fileIds: string[] = [];
    const rewrittenSegments: string[] = [];
    let cursor = 0;
    let interceptedAny = false;

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens < threshold) {
        continue;
      }

      interceptedAny = true;
      const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const extension = extensionFromNameOrMime(block.fileName, block.mimeType);
      const storageUri = await this.storeLargeFileContent({
        conversationId: params.conversationId,
        fileId,
        extension,
        content: block.text,
      });
      const byteSize = Buffer.byteLength(block.text, "utf8");
      const explorationSummary = await generateExplorationSummary({
        content: block.text,
        fileName: block.fileName,
        mimeType: block.mimeType,
        summarizeText,
      });

      await this.summaryStore.insertLargeFile({
        fileId,
        conversationId: params.conversationId,
        fileName: block.fileName,
        mimeType: block.mimeType,
        byteSize,
        storageUri,
        explorationSummary,
      });

      rewrittenSegments.push(params.content.slice(cursor, block.start));
      rewrittenSegments.push(
        formatFileReference({
          fileId,
          fileName: block.fileName,
          mimeType: block.mimeType,
          byteSize,
          summary: explorationSummary,
        }),
      );
      cursor = block.end;
      fileIds.push(fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    rewrittenSegments.push(params.content.slice(cursor));
    return {
      rewrittenContent: rewrittenSegments.join(""),
      fileIds,
    };
  }

  // ── ContextEngine interface ─────────────────────────────────────────────

  /**
   * Reconcile session-file history with persisted messages and append only the
   * tail that is present in JSONL but missing from LCM.
   */
  private async reconcileSessionTail(params: {
    sessionId: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
  }): Promise<{
    importedMessages: number;
    hasOverlap: boolean;
  }> {
    const { sessionId, conversationId, historicalMessages } = params;
    if (historicalMessages.length === 0) {
      return { importedMessages: 0, hasOverlap: false };
    }

    const latestDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!latestDbMessage) {
      return { importedMessages: 0, hasOverlap: false };
    }

    const storedHistoricalMessages = historicalMessages.map((message) => toStoredMessage(message));

    // Fast path: one tail comparison for the common in-sync case.
    const latestHistorical = storedHistoricalMessages[storedHistoricalMessages.length - 1];
    const latestIdentity = messageIdentity(latestDbMessage.role, latestDbMessage.content);
    if (latestIdentity === messageIdentity(latestHistorical.role, latestHistorical.content)) {
      const dbOccurrences = await this.conversationStore.countMessagesByIdentity(
        conversationId,
        latestDbMessage.role,
        latestDbMessage.content,
      );
      let historicalOccurrences = 0;
      for (const stored of storedHistoricalMessages) {
        if (messageIdentity(stored.role, stored.content) === latestIdentity) {
          historicalOccurrences += 1;
        }
      }
      if (dbOccurrences === historicalOccurrences) {
        return { importedMessages: 0, hasOverlap: true };
      }
    }

    // Slow path: walk backward through JSONL to find the most recent anchor
    // message that already exists in LCM, then append everything after it.
    let anchorIndex = -1;
    const historicalIdentityTotals = new Map<string, number>();
    for (const stored of storedHistoricalMessages) {
      const identity = messageIdentity(stored.role, stored.content);
      historicalIdentityTotals.set(identity, (historicalIdentityTotals.get(identity) ?? 0) + 1);
    }

    const historicalIdentityCountsAfterIndex = new Map<string, number>();
    const dbIdentityCounts = new Map<string, number>();
    for (let index = storedHistoricalMessages.length - 1; index >= 0; index--) {
      const stored = storedHistoricalMessages[index];
      const identity = messageIdentity(stored.role, stored.content);
      const seenAfter = historicalIdentityCountsAfterIndex.get(identity) ?? 0;
      const total = historicalIdentityTotals.get(identity) ?? 0;
      const occurrencesThroughIndex = total - seenAfter;
      const exists = await this.conversationStore.hasMessage(
        conversationId,
        stored.role,
        stored.content,
      );
      historicalIdentityCountsAfterIndex.set(identity, seenAfter + 1);
      if (!exists) {
        continue;
      }

      let dbCountForIdentity = dbIdentityCounts.get(identity);
      if (dbCountForIdentity === undefined) {
        dbCountForIdentity = await this.conversationStore.countMessagesByIdentity(
          conversationId,
          stored.role,
          stored.content,
        );
        dbIdentityCounts.set(identity, dbCountForIdentity);
      }

      // Match the same occurrence index as the DB tail so repeated empty
      // tool messages do not anchor against a later, still-missing entry.
      if (dbCountForIdentity !== occurrencesThroughIndex) {
        continue;
      }

      anchorIndex = index;
      break;
    }

    if (anchorIndex < 0) {
      return { importedMessages: 0, hasOverlap: false };
    }
    if (anchorIndex >= historicalMessages.length - 1) {
      return { importedMessages: 0, hasOverlap: true };
    }

    const missingTail = historicalMessages.slice(anchorIndex + 1);
    let importedMessages = 0;
    for (const message of missingTail) {
      const result = await this.ingestSingle({ sessionId, message });
      if (result.ingested) {
        importedMessages += 1;
      }
    }

    return { importedMessages, hasOverlap: true };
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    this.ensureMigrated();

    const result = await this.withSessionQueue(params.sessionId, async () =>
      this.conversationStore.withTransaction(async () => {
        const conversation = await this.conversationStore.getOrCreateConversation(params.sessionId, {
          agentId: this.resolveAgentIdFromSessionId(params.sessionId),
        });
        const conversationId = conversation.conversationId;
        const historicalMessages = readLeafPathMessages(params.sessionFile);

        // First-time import path: no LCM rows yet, so seed directly from the
        // active leaf context snapshot.
        const existingCount = await this.conversationStore.getMessageCount(conversationId);
        if (existingCount === 0) {
          if (historicalMessages.length === 0) {
            await this.conversationStore.markConversationBootstrapped(conversationId);
            return {
              bootstrapped: false,
              importedMessages: 0,
              reason: "no leaf-path messages in session",
            };
          }

          const nextSeq = (await this.conversationStore.getMaxSeq(conversationId)) + 1;
          const bulkInput = historicalMessages.map((message, index) => {
            const stored = toStoredMessage(message);
            return {
              conversationId,
              seq: nextSeq + index,
              role: stored.role,
              content: stored.content,
              tokenCount: stored.tokenCount,
            };
          });

          const inserted = await this.conversationStore.createMessagesBulk(bulkInput);

          // Preserve structured content (tool calls, reasoning blocks, etc.)
          // so bootstrap has the same fidelity as live ingest.
          for (let i = 0; i < inserted.length; i++) {
            const message = historicalMessages[i];
            const stored = toStoredMessage(message);
            await this.conversationStore.createMessageParts(
              inserted[i].messageId,
              buildMessageParts({
                sessionId: params.sessionId,
                message,
                fallbackContent: stored.content,
              }),
            );
          }

          await this.summaryStore.appendContextMessages(
            conversationId,
            inserted.map((record) => record.messageId),
          );
          await this.conversationStore.markConversationBootstrapped(conversationId);

          // Prune HEARTBEAT_OK turns from the freshly imported data
          if (this.config.pruneHeartbeatOk) {
            const pruned = await this.pruneHeartbeatOkTurns(conversationId);
            if (pruned > 0) {
              console.error(
                `[cc-mem] bootstrap: pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversationId}`,
              );
            }
          }

          return {
            bootstrapped: true,
            importedMessages: inserted.length,
          };
        }

        // Existing conversation path: reconcile crash gaps by appending JSONL
        // messages that were never persisted to LCM.
        const reconcile = await this.reconcileSessionTail({
          sessionId: params.sessionId,
          conversationId,
          historicalMessages,
        });

        if (!conversation.bootstrappedAt) {
          await this.conversationStore.markConversationBootstrapped(conversationId);
        }

        if (reconcile.importedMessages > 0) {
          return {
            bootstrapped: true,
            importedMessages: reconcile.importedMessages,
            reason: "reconciled missing session messages",
          };
        }

        if (conversation.bootstrappedAt) {
          return {
            bootstrapped: false,
            importedMessages: 0,
            reason: "already bootstrapped",
          };
        }

        return {
          bootstrapped: false,
          importedMessages: 0,
          reason: reconcile.hasOverlap
            ? "conversation already up to date"
            : "conversation already has messages",
        };
      }),
    );

    // Post-bootstrap pruning: clean HEARTBEAT_OK turns that were already
    // in the DB from prior bootstrap cycles (before pruning was enabled).
    if (this.config.pruneHeartbeatOk && result.bootstrapped === false) {
      try {
        const conversation = await this.conversationStore.getConversationBySessionId(
          params.sessionId,
        );
        if (conversation) {
          const pruned = await this.pruneHeartbeatOkTurns(conversation.conversationId);
          if (pruned > 0) {
            console.error(
              `[cc-mem] bootstrap: retroactively pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversation.conversationId}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[cc-mem] bootstrap: heartbeat pruning failed:`,
          err instanceof Error ? err.message.slice(0, 500) : "unknown error",
        );
      }
    }

    return result;
  }

  private async ingestSingle(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, message, isHeartbeat } = params;
    if (isHeartbeat) {
      return { ingested: false };
    }
    const stored = toStoredMessage(message);

    // Get or create conversation for this session
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId, {
      agentId: this.resolveAgentIdFromSessionId(sessionId),
    });
    const conversationId = conversation.conversationId;

    let messageForParts = message;
    if (stored.role === "user") {
      const intercepted = await this.interceptLargeFiles({
        conversationId,
        content: stored.content,
      });
      if (intercepted) {
        stored.content = intercepted.rewrittenContent;
        stored.tokenCount = estimateTokens(stored.content);
        if ("content" in message) {
          messageForParts = {
            ...message,
            content: stored.content,
          } as AgentMessage;
        }
      }
    }

    // Determine next sequence number
    const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
    const seq = maxSeq + 1;

    // Persist the message
    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: stored.role,
      content: stored.content,
      tokenCount: stored.tokenCount,
    });
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId,
        message: messageForParts,
        fallbackContent: stored.content,
      }),
    );

    // Append to context items so assembler can see it
    await this.summaryStore.appendContextMessage(conversationId, msgRecord.messageId);

    // Generate a run_id for this message processing cycle so all EEL events
    // from the same ingest can be correlated.
    const runId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Derive actor from message role: user messages → 'user', tool results → 'assistant', else 'system'
    const eeActor: string = stored.role === "user" ? "user" : stored.role === "tool" ? "assistant" : "system";

    // Entity pre-seeding: regex + NER run ONLY when RSMA/LLM won't handle it.
    // When RSMA runs, the semantic extractor handles entity extraction via LLM.
    // Regex is the fallback for when no extraction model is configured.
    const rsmaHasModel = !!(this.config.relationsDeepExtractionEnabled && this.config.relationsDeepExtractionModel);
    if (this.graphDb && this.config.relationsEnabled && stored.content.length > 5 && !rsmaHasModel) {
      // Regex entity extraction — fallback only (no LLM model configured)
      try {
        const { extractFast } = await import("./relations/entity-extract.js");
        const { storeExtractionResult } = await import("./relations/graph-store.js");
        const { loadTerms } = await import("./relations/terms.js");
        const terms = loadTerms();
        const entities = extractFast(stored.content, terms);
        if (entities.length > 0) {
          storeExtractionResult(this.graphDb, entities, {
            sourceType: "message",
            sourceId: String(msgRecord.messageId),
            actor: eeActor,
            runId,
          });
        }
      } catch (err) {
        console.warn("[cc-mem] regex entity extraction failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // NER enhancement — runs regardless of RSMA (supplements LLM extraction with
    // spaCy NER for structured entity types like PERSON, ORG, GPE, DATE).
    // Circuit breaker: skip if server was recently unreachable.
    if (this.graphDb && this.config.relationsEnabled && stored.content.length > 5) {
      if (_nerCircuitOpen && Date.now() - _nerLastFailure < (this.config.nerCircuitResetMs ?? 30_000)) {
        console.debug("[cc-mem] NER circuit open, skipping request");
      } else {
        try {
          const nerUrl = `${process.env.THREADCLAW_MODEL_SERVER_URL ?? process.env.MODEL_SERVER_URL ?? "http://127.0.0.1:8012"}/ner`;
          const nerResp = await fetch(nerUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ texts: [stored.content] }),
            signal: AbortSignal.timeout(5000),
          });
          if (nerResp.ok) {
            _nerCircuitOpen = false;
            const nerData = await nerResp.json() as { results: Array<{ entities: Array<{ text: string; label: string }> }> };
            const nerEntities = nerData.results?.[0]?.entities ?? [];
            if (nerEntities.length > 0) {
              const { storeExtractionResult: storeNer } = await import("./relations/graph-store.js");
              const nerResults = nerEntities.map((e: { text: string; label: string }) => ({
                name: e.text,
                confidence: 0.8,
                strategy: `ner:${e.label}` as import("./relations/types.js").ExtractionStrategy,
                entityType: e.label.toLowerCase(),
              }));
              try {
                storeNer(this.graphDb!, nerResults, {
                  sourceType: "message",
                  sourceId: String(msgRecord.messageId),
                  actor: eeActor,
                  runId,
                });
              } catch (storeErr) {
                console.debug("[cc-mem] NER entity storage failed (NER itself succeeded):", storeErr instanceof Error ? storeErr.message : String(storeErr));
              }
            }
          }
        } catch (err) {
          _nerCircuitOpen = true;
          _nerLastFailure = Date.now();
          console.debug("[cc-mem] NER request failed (circuit opened):", err instanceof Error ? err.message : String(err));
        }
      }
    }

    // Real-time attempt tracking from tool results
    const messageRole = (message as Record<string, unknown>).role;
    // Extract tool name once for use by both attempt tracking and claim extraction
    const toolMsg = message as Record<string, unknown>;
    const toolName = (toolMsg.toolName as string)
      ?? (toolMsg.name as string)
      ?? (typeof toolMsg.content === "object" && toolMsg.content !== null ? (toolMsg.content as any).toolName : null)
      ?? "unknown";
    if (this.graphDb && this.config.relationsAttemptTrackingEnabled && messageRole === "toolResult") {
      try {
        const { recordAttempt } = await import("./relations/attempt-store.js");
        const { withWriteTransaction } = await import("./relations/evidence-log.js");
        const graphDb = this.graphDb;
        const content = stored.content ?? "";
        // Word-boundary-aware error detection: match patterns that indicate
        // actual errors while excluding false positives like "0 errors found".
        const falsePositivePattern = /\b(no\s+error|0\s+error|without\s+error|error[\s-]*free|fixed\s+error|resolved\s+error|errors?\s*:\s*0|0\s+errors?\b)/i;
        const contentWithoutFalsePositives = content.replace(falsePositivePattern, "");
        const errorPattern = /\b(error\s*:|Error:|ERROR:|failed\s+to\b|failure:|FATAL\b|crash(ed|ing)?\b|exception\s+(thrown|occurred|at)\b|traceback\s*\(|panic:|unhandled\s+exception)/i;
        const isError = errorPattern.test(contentWithoutFalsePositives);
        const status: "success" | "failure" = isError ? "failure" : "success";

        // Redact sensitive data from error text before storing
        let errorText = isError ? content.substring(0, 500) : undefined;
        if (errorText) {
          const sensitivePatterns = [/password[=:]\s*\S+/gi, /key[=:]\s*\S+/gi, /token[=:]\s*\S+/gi, /secret[=:]\s*\S+/gi, /bearer\s+\S+/gi];
          for (const p of sensitivePatterns) {
            errorText = errorText.replace(p, (m) => m.split(/[=:\s]/)[0] + "=[REDACTED]");
          }
        }

        // Extract inputSummary from the tool call's input/arguments if available
        let inputSummary: string | undefined;
        const rawInput = toolMsg.input ?? toolMsg.arguments ?? toolMsg.params;
        if (rawInput != null) {
          const inputStr = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
          inputSummary = inputStr.substring(0, 200);
        }

        withWriteTransaction(graphDb, () => {
          recordAttempt(graphDb, {
            scopeId: DEFAULT_SCOPE_ID,
            toolName: toolName.substring(0, 100),
            status,
            errorText,
            inputSummary,
            outputSummary: isError ? undefined : content.substring(0, 200),
          });
        });

        // Auto-infer runbooks from repeated successful tool usage
        if (status === "success") {
          try {
            const { inferRunbookFromAttempts } = await import("./relations/runbook-store.js");
            inferRunbookFromAttempts(graphDb, 1, toolName.substring(0, 100));
          } catch { /* non-fatal */ }
        }

        // Auto-infer anti-runbooks from repeated failures
        if (status === "failure") {
          try {
            const { inferAntiRunbookFromAttempts } = await import("./relations/anti-runbook-store.js");
            inferAntiRunbookFromAttempts(graphDb, DEFAULT_SCOPE_ID, toolName.substring(0, 100));
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        // Non-fatal: attempt tracking failure must not break message ingest
        console.warn("[cc-mem] attempt tracking failed:", err instanceof Error ? err.message : String(err));
      }

      // Tool result claim extraction (Strategy 1: highest trust, 1.0)
      if (this.graphDb && this.config.relationsClaimExtractionEnabled) {
        try {
          const { extractClaimsFromToolResult } = await import("./relations/claim-extract.js");
          const { storeClaimExtractionResults } = await import("./relations/claim-store.js");
          const { withWriteTransaction: wt } = await import("./relations/evidence-log.js");
          const gdb = this.graphDb;

          // Parse tool result from raw message content (stored.content is text, not JSON)
          let toolResult: unknown = undefined;
          const rawContent = (message as Record<string, unknown>).content;
          if (typeof rawContent === "string") {
            try { toolResult = JSON.parse(rawContent); } catch { /* not JSON text */ }
          } else if (Array.isArray(rawContent)) {
            // Find tool_result block in content array
            for (const block of rawContent) {
              if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result") {
                const output = (block as Record<string, unknown>).output ?? (block as Record<string, unknown>).content;
                if (typeof output === "string") {
                  try { toolResult = JSON.parse(output); } catch { /* not JSON text */ }
                } else if (output && typeof output === "object") {
                  toolResult = output;
                }
                break;
              }
            }
          }

          if (toolResult && toolName !== "unknown") {
            wt(gdb, () => {
              const claimResults = extractClaimsFromToolResult(toolName, toolResult, String(msgRecord.messageId));
              if (claimResults.length > 0) {
                storeClaimExtractionResults(gdb, claimResults, {
                  scopeId: DEFAULT_SCOPE_ID,
                  sourceType: "tool_result",
                  sourceId: String(msgRecord.messageId),
                });
              }
            });
          }
        } catch (err) {
          console.warn("[cc-mem] tool result claim extraction failed:", err instanceof Error ? err.message : String(err));
        }
      }
    }

    // ── EXTRACTION PIPELINE ──────────────────────────────────────────────
    // LLM-primary: RSMA semantic extraction handles claims, decisions, loops,
    // entities, relations, invariants via LLM. Regex is ONLY a fallback when
    // no LLM extraction model is configured.
    //
    // When RSMA runs (graphDb + relationsEnabled + user + len>5), the LLM
    // pipeline handles everything. Legacy regex extraction is gated to NOT
    // run when RSMA will run (avoids double-writes with confidence drift).
    const rsmaWillRun = !!(this.graphDb && this.config.relationsEnabled && stored.role === "user" && stored.content.length > 5);

    const claimExtractionEnabled = this.config.relationsClaimExtractionEnabled || this.config.relationsUserClaimExtractionEnabled;
    // Legacy regex extraction — ONLY when RSMA won't run (no graphDb, relations disabled, or non-user)
    if (this.graphDb && claimExtractionEnabled && stored.role === "user" && !rsmaWillRun) {
      try {
        const { extractClaimsFast, extractClaimsFromUserExplicit, extractDecisionsFromText, extractLoopsFromText, extractInvariantsFromText } = await import("./relations/claim-extract.js");
        const { storeClaimExtractionResults } = await import("./relations/claim-store.js");
        const { upsertDecision } = await import("./relations/decision-store.js");
        const { openLoop } = await import("./relations/loop-store.js");
        const { withWriteTransaction } = await import("./relations/evidence-log.js");
        const graphDb = this.graphDb;

        withWriteTransaction(graphDb, () => {
          // Regex claims — free, instant (catches explicit patterns like "Remember:", "Fact:", etc.)
          const claimResults = this.config.relationsClaimExtractionEnabled
            ? extractClaimsFast(stored.content, {
                sourceType: "message",
                sourceId: String(msgRecord.messageId),
              })
            : (stored.role === "user"
                ? extractClaimsFromUserExplicit(stored.content, String(msgRecord.messageId))
                : []);
          if (claimResults.length > 0) {
            storeClaimExtractionResults(graphDb, claimResults, {
              scopeId: DEFAULT_SCOPE_ID,
              sourceType: "message",
              sourceId: String(msgRecord.messageId),
              actor: eeActor,
              runId,
            });
          }

          // Regex decisions + loops (user messages only — free, instant)
          if (stored.role === "user") {
            const decisions = extractDecisionsFromText(stored.content, String(msgRecord.messageId));
            for (const d of decisions) {
              upsertDecision(graphDb, {
                scopeId: DEFAULT_SCOPE_ID,
                topic: d.topic,
                decisionText: d.decisionText,
                sourceType: d.sourceType,
                sourceId: d.sourceId,
                actor: eeActor,
                runId,
              });
            }

            const loops = extractLoopsFromText(stored.content, String(msgRecord.messageId));
            for (const l of loops) {
              openLoop(graphDb, {
                scopeId: DEFAULT_SCOPE_ID,
                loopType: l.loopType,
                text: l.text,
                priority: l.priority,
                sourceType: l.sourceType,
                sourceId: l.sourceId,
              });
            }

          }
        });

        // Invariant extraction (outside transaction — requires async import)
        try {
          const { upsertInvariant } = await import("./relations/invariant-store.js");
          const invariants = extractInvariantsFromText(stored.content, String(msgRecord.messageId));
          if (invariants.length > 0) {
            const { withWriteTransaction: wt4 } = await import("./relations/evidence-log.js");
            wt4(graphDb, () => {
              for (const inv of invariants) {
                upsertInvariant(graphDb, {
                  scopeId: DEFAULT_SCOPE_ID,
                  invariantKey: inv.key,
                  description: inv.description,
                  severity: inv.severity as "critical" | "error" | "warning" | "info",
                  enforcementMode: inv.enforcementMode as "strict" | "advisory",
                  sourceId: inv.sourceId,
                });
              }
            });
          }
        } catch { /* non-fatal */ }
      } catch (err) {
        console.warn("[cc-mem] regex extraction failed:", err instanceof Error ? err.message : String(err));
      }
    }

    // ── RSMA extraction: fire-and-forget (non-blocking) ──────────────
    // Runs in background so it doesn't delay Copper's response.
    // The LLM call (GPT-4o-mini) is independent of the agent model (GPT-5.4).
    // Results populate memory for FUTURE turns, not the current response.
    //
    // BUG 8 NOTE: Only user messages are extracted (stored.role === "user").
    // This is BY DESIGN for safety — assistant messages contain narrative,
    // promises, and speculative reasoning that would pollute the knowledge
    // graph with low-quality claims. The semantic extractor has an assistant
    // mode with strict filtering, but it's not enabled here to avoid
    // hallucinated facts from assistant self-description.
    //
    // NOTE: withWriteTransaction is synchronous and runs inside the
    // fire-and-forget async IIFE. Reconciliation runs before store writes
    // so supersession actions apply to the latest objects.
    if (rsmaWillRun) {
      if (_activeExtractions >= MAX_CONCURRENT_EXTRACTIONS) {
        console.warn(`[rsma] backpressure: ${_activeExtractions} extractions in flight, skipping extraction for message ${msgRecord.messageId}`);
      } else {
      const _graphDb = this.graphDb!;
      const _content = stored.content;
      const _messageId = String(msgRecord.messageId);
      const _role = (stored.role === "assistant" ? "assistant" : "user") as "user" | "assistant";
      const _config = this.config;
      const _deps = this.deps;
      const _runId = runId;
      const _eeActor = eeActor;
      _activeExtractions++;
      (async () => { try {
        const graphDb = _graphDb;
        const role = _role;
        const extractionMode = _config.relationsExtractionMode ?? "smart";
        const useLlm = extractionMode !== "fast" && _config.relationsDeepExtractionEnabled;

        let writerResult;
        // Only use LLM if an extraction model is explicitly configured.
        // Empty model config = regex only (don't fall back to agent's expensive model).
        const hasExtractionModel = !!_config.relationsDeepExtractionModel;
        if (useLlm && hasExtractionModel) {
          try {
            const { semanticExtract } = await import("./ontology/semantic-extractor.js");
            const extractionModel = _config.relationsDeepExtractionModel;
            const extractionProvider = _config.relationsDeepExtractionProvider || "anthropic";

            // Use direct API key if configured, otherwise use OpenClaw's OAuth
            let completeFn = _deps.complete;
            const directApiKey = _config.relationsDeepExtractionApiKey;
            if (!directApiKey && extractionProvider !== "ollama") {
              // BUG 5: Log when falling back to gateway's complete function.
              // The gateway's OAuth may have wrong auth for the extraction model.
              console.debug("[rsma] No direct API key configured, using gateway completion function for extraction");
            }
            if (directApiKey || extractionProvider === "ollama") {
              const { createDirectComplete } = await import("./ontology/direct-llm.js");
              const directFn = createDirectComplete({
                provider: extractionProvider,
                model: extractionModel,
                apiKey: directApiKey || undefined,
                baseUrl: _config.relationsDeepExtractionBaseUrl || undefined,
              });
              if (directFn) {
                completeFn = directFn;
                console.log(`[rsma] Using direct ${extractionProvider}/${extractionModel} for extraction (API key configured)`);
              }
            }

            // Query known subjects from active claims so LLM normalizes against them.
            // Ordered by most recently updated so LIMIT 50 captures relevant entities.
            let knownSubjects: string[] = [];
            try {
              const rows = graphDb.prepare(
                `SELECT JSON_EXTRACT(structured_json, '$.subject') as subj
                 FROM memory_objects
                 WHERE kind = 'claim' AND status = 'active' AND scope_id = ?
                   AND JSON_EXTRACT(structured_json, '$.subject') IS NOT NULL
                 GROUP BY subj
                 ORDER BY MAX(updated_at) DESC
                 LIMIT 50`,
              ).all(_config.relationsScopeId ?? 1) as Array<{ subj: string }>;
              knownSubjects = rows.map((r) => r.subj).filter((s) => s && s.length >= 2);
            } catch { /* non-fatal — extraction still works without entity context */ }

            // Query known topics per subject so LLM reuses existing topic labels.
            const knownTopicsBySubject = new Map<string, string[]>();
            try {
              if (knownSubjects.length > 0) {
                const topicRows = graphDb.prepare(
                  `SELECT JSON_EXTRACT(structured_json, '$.subject') as subj,
                          JSON_EXTRACT(structured_json, '$.topic') as topic
                   FROM memory_objects
                   WHERE kind = 'claim' AND status = 'active' AND scope_id = ?
                     AND JSON_EXTRACT(structured_json, '$.topic') IS NOT NULL
                     AND JSON_EXTRACT(structured_json, '$.subject') IS NOT NULL
                   ORDER BY updated_at DESC
                   LIMIT 200`,
                ).all(_config.relationsScopeId ?? 1) as Array<{ subj: string; topic: string }>;
                for (const row of topicRows) {
                  if (!row.subj || !row.topic) continue;
                  const existing = knownTopicsBySubject.get(row.subj);
                  if (existing) {
                    if (!existing.includes(row.topic)) existing.push(row.topic);
                  } else {
                    knownTopicsBySubject.set(row.subj, [row.topic]);
                  }
                }
              }
            } catch { /* non-fatal */ }

            writerResult = await semanticExtract(_content, _messageId, role, {
              complete: completeFn,
              model: extractionModel,
              provider: extractionProvider,
              maxInputChars: 4000,
              knownSubjects,
              knownTopicsBySubject,
            });
          } catch (llmErr) {
            // LLM unavailable — fall back to regex
            console.warn("[rsma] LLM extraction failed, falling back to regex:", llmErr instanceof Error ? llmErr.message : String(llmErr));
            const { understandMessage } = await import("./ontology/writer.js");
            writerResult = await understandMessage(_content, _messageId, role);
          }
        } else {
          // No LLM extraction model configured — regex fallback
          console.debug("[rsma] No extraction model configured, using regex fallback");
          const { understandMessage } = await import("./ontology/writer.js");
          writerResult = await understandMessage(_content, _messageId, role);
        }

        if (writerResult.objects.length > 0) {
          const { reconcile } = await import("./ontology/truth.js");
          const { projectProvenance, recordSupersession, recordConflict, recordEvidence } = await import("./ontology/projector.js");
          const { upsertMemoryObject } = await import("./ontology/mo-store.js");
          const { withWriteTransaction, logEvidence } = await import("./relations/evidence-log.js");
          const { supersedeClaim } = await import("./relations/claim-store.js");
          const { recordStateDelta } = await import("./relations/delta-store.js");

          const reconciled = reconcile(graphDb, writerResult.objects, {
            isCorrection: writerResult.signals.isCorrection,
            correctionSignal: writerResult.signals.correctionSignal ?? undefined,
          });

          withWriteTransaction(graphDb, () => {
          for (const action of reconciled.actions) {
            if (action.type === "insert") {
              const insertResult = upsertMemoryObject(graphDb, action.object);
              projectProvenance(graphDb, action.object);
              logEvidence(graphDb, {
                scopeId: action.object.scope_id,
                objectType: action.object.kind,
                objectId: insertResult.moId,
                eventType: "create",
                actor: _eeActor,
                runId: _runId,
                payload: { source: "rsma_reconciliation", canonicalKey: action.object.canonical_key },
              });
            } else if (action.type === "supersede") {
              const supersedeResult = upsertMemoryObject(graphDb, action.newObject, { isSupersession: true });
              projectProvenance(graphDb, action.newObject);
              recordSupersession(graphDb, action.newObject.id, action.oldObjectId, action.reason);
              logEvidence(graphDb, {
                scopeId: action.newObject.scope_id,
                objectType: action.newObject.kind,
                objectId: supersedeResult.moId,
                eventType: "supersede",
                actor: _eeActor,
                runId: _runId,
                payload: { source: "rsma_reconciliation", oldObjectId: action.oldObjectId, reason: action.reason },
              });
              // BUG 3 FIX: Actually supersede the old record in the physical table.
              // Without this, old claims stay status='active' forever.
              try {
                // Handle relation supersession separately (composite_id format: relation:scope:subj:pred:obj)
                if (action.oldObjectId.startsWith("relation:")) {
                  graphDb.prepare(
                    "UPDATE memory_objects SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE composite_id = ? AND kind = 'relation'",
                  ).run(action.oldObjectId);
                }
                // Handle entity supersession (composite_id format: entity:{type}:{name} or legacy entity:{name})
                if (action.oldObjectId.startsWith("entity:")) {
                  graphDb.prepare(
                    "UPDATE memory_objects SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE composite_id = ? AND kind = 'entity'",
                  ).run(action.oldObjectId);
                }
                // Handle capability supersession (composite_id format: capability:{scopeId}:{type}:{key})
                if (action.oldObjectId.startsWith("capability:")) {
                  graphDb.prepare(
                    "UPDATE memory_objects SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE composite_id = ? AND kind = 'capability'",
                  ).run(action.oldObjectId);
                }
                const oldKindMatch = action.oldObjectId.match(/^(claim|decision|loop|invariant):(\d+)$/);  // relation handled above by composite_id
                if (oldKindMatch) {
                  const oldKind = oldKindMatch[1];
                  const oldRawId = parseInt(oldKindMatch[2], 10);
                  if (oldKind === "claim" && !isNaN(oldRawId)) {
                    // Mark the old claim as superseded in the claims table.
                    // The new object may have a UUID id (from semantic extraction)
                    // rather than a numeric DB id, so we pass 0 as superseded_by
                    // when the new id isn't numeric — the provenance_links table
                    // has the full supersession record regardless.
                    // The new object's id may be a UUID (e.g. "claim:a1b2c3d4-...")
                    // so regex for trailing digits won't work. Query the actual
                    // integer ID from the claims table using canonical_key instead.
                    const newCanonicalKey = action.newObject.canonical_key;
                    let newRawId = 0;
                    if (newCanonicalKey) {
                      const row = graphDb.prepare(
                        "SELECT id FROM memory_objects WHERE kind = 'claim' AND canonical_key = ? AND scope_id = 1 ORDER BY id DESC LIMIT 1",
                      ).get(newCanonicalKey) as { id: number } | undefined;
                      if (row) newRawId = row.id;
                    }
                    if (newRawId === 0) {
                      // Fallback: try numeric suffix for legacy integer IDs
                      const newRawMatch = action.newObject.id.match(/:(\d+)$/);
                      if (newRawMatch) newRawId = parseInt(newRawMatch[1], 10);
                    }
                    supersedeClaim(graphDb, oldRawId, newRawId);
                  } else if (oldKind === "decision" && !isNaN(oldRawId)) {
                    graphDb.prepare(
                      "UPDATE memory_objects SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE kind = 'decision' AND id = ?",
                    ).run(oldRawId);
                  } else if (oldKind === "loop" && !isNaN(oldRawId)) {
                    graphDb.prepare(
                      "UPDATE memory_objects SET status = 'superseded', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE kind = 'loop' AND id = ?",
                    ).run(oldRawId);
                  } else if (oldKind === "invariant" && !isNaN(oldRawId)) {
                    graphDb.prepare(
                      "UPDATE memory_objects SET status = 'retracted', updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now') WHERE kind = 'invariant' AND id = ?",
                    ).run(oldRawId);
                  }
                }
              } catch (supersErr) {
                console.debug("[rsma] failed to supersede old record in physical table:", supersErr instanceof Error ? supersErr.message : String(supersErr));
              }
              // Record state delta for supersession tracking
              try {
                recordStateDelta(graphDb, {
                  scopeId: action.newObject.scope_id ?? DEFAULT_SCOPE_ID,
                  deltaType: "supersession",
                  entityKey: action.newObject.canonical_key ?? action.newObject.id,
                  summary: action.reason,
                  oldValue: action.oldObjectId,
                  newValue: action.newObject.id,
                  confidence: action.newObject.confidence,
                  sourceType: "reconciliation",
                  sourceId: action.newObject.provenance?.source_id ?? "",
                });
              } catch { /* non-fatal */ }
            } else if (action.type === "conflict") {
              const conflictResult = upsertMemoryObject(graphDb, action.conflictObject);
              projectProvenance(graphDb, action.conflictObject);
              recordConflict(graphDb, action.conflictObject.id, action.objectIdA, action.objectIdB, action.reason);
              logEvidence(graphDb, {
                scopeId: action.conflictObject.scope_id,
                objectType: action.conflictObject.kind,
                objectId: conflictResult.moId,
                eventType: "create",
                actor: _eeActor,
                runId: _runId,
                payload: { source: "rsma_reconciliation", conflict: true, objectIdA: action.objectIdA, objectIdB: action.objectIdB, reason: action.reason },
              });
            } else if (action.type === "evidence") {
              // Update existing object's freshness (don't insert duplicate)
              try {
                graphDb.prepare(
                  "UPDATE memory_objects SET last_observed_at = strftime('%Y-%m-%dT%H:%M:%f','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'), confidence = MIN(1.0, confidence * 0.3 + ? * 0.7) WHERE composite_id = ?"
                ).run(action.newObject.confidence ?? 0.5, action.existingObjectId);
              } catch {}
              projectProvenance(graphDb, action.newObject);
              recordEvidence(graphDb, action.newObject.id, action.existingObjectId, action.predicate, 1.0, action.reason);
              // For evidence actions, look up the existing object's moId for the log
              try {
                const existingRow = graphDb.prepare(
                  "SELECT id FROM memory_objects WHERE composite_id = ? LIMIT 1"
                ).get(action.existingObjectId) as { id: number } | undefined;
                if (existingRow) {
                  logEvidence(graphDb, {
                    scopeId: action.newObject.scope_id,
                    objectType: action.newObject.kind,
                    objectId: existingRow.id,
                    eventType: "update",
                    actor: _eeActor,
                    runId: _runId,
                    payload: { source: "rsma_reconciliation", predicate: action.predicate, reason: action.reason },
                  });
                }
              } catch { /* non-fatal */ }
            }
          }
          }); // end withWriteTransaction

          // ── Create entity relations from relationship claims ──
          // After all objects are stored, scan for claims with relationship predicates
          // and create entity-to-entity relations in provenance_links.
          try {
            const { upsertRelation } = await import("./relations/relation-store.js");
            const { upsertEntity } = await import("./relations/graph-store.js");
            const junkPredicates = new Set([
              "is", "states", "has", "user_i", "user_my",
              "sent", "contains", "timestamp", "received", "delivered",
              "file_path", "sender", "sent_by", "from", "type", "size", "format",
            ]);

            for (const action of reconciled.actions) {
              const obj = action.type === "insert" ? action.object
                : action.type === "supersede" ? action.newObject
                : action.type === "evidence" ? action.newObject
                : null;
              if (!obj || obj.kind !== "claim") continue;

              const s = obj.structured as Record<string, unknown> | undefined;
              const subject = s?.subject ? String(s.subject) : null;
              const objectText = s?.objectText ? String(s.objectText) : null;
              const predicate = s?.predicate ? String(s.predicate) : null;

              if (!subject || !objectText || !predicate) continue;
              if (junkPredicates.has(predicate.toLowerCase())) continue;

              try {
                const subjEntity = upsertEntity(graphDb, { name: subject, actor: _eeActor, runId: _runId });
                const objEntity = upsertEntity(graphDb, { name: objectText, actor: _eeActor, runId: _runId });
                if (subjEntity.entityId && objEntity.entityId) {
                  upsertRelation(graphDb, {
                    scopeId: DEFAULT_SCOPE_ID,
                    subjectEntityId: subjEntity.entityId,
                    predicate: predicate,
                    objectEntityId: objEntity.entityId,
                    confidence: obj.confidence ?? 0.8,
                    sourceType: "message",
                    sourceId: obj.provenance?.source_id ?? "",
                  });
                }
              } catch { /* non-fatal per relation */ }
            }
          } catch { /* non-fatal: relation extraction is best-effort */ }

          // ── Deep extraction: LLM-powered entity relationship mining ──
          // Uses the dedicated deep-extract module to find entity-to-entity
          // relationships beyond what claim-based relation creation catches.
          if (_config.relationsDeepExtractionEnabled && hasExtractionModel) {
            try {
              const { extractRelationsDeep } = await import("./relations/deep-extract.js");
              const { upsertRelation: upsertRel } = await import("./relations/relation-store.js");
              const { upsertEntity: upsertEnt } = await import("./relations/graph-store.js");

              // Collect entity names from this extraction
              const entityNames = writerResult.objects
                .filter(o => o.kind === "entity")
                .map(o => (o.structured as Record<string, unknown>)?.name)
                .filter((n): n is string => typeof n === "string" && n.length > 0);

              if (entityNames.length >= 2) {
                const deepRelations = await extractRelationsDeep(
                  _content,
                  entityNames,
                  _deps,
                  _config,
                );

                for (const rel of deepRelations) {
                  try {
                    const subjEntity = upsertEnt(graphDb, { name: rel.subject, actor: _eeActor, runId: _runId });
                    const objEntity = upsertEnt(graphDb, { name: rel.object, actor: _eeActor, runId: _runId });
                    if (subjEntity.entityId && objEntity.entityId) {
                      upsertRel(graphDb, {
                        scopeId: DEFAULT_SCOPE_ID,
                        subjectEntityId: subjEntity.entityId,
                        predicate: rel.predicate,
                        objectEntityId: objEntity.entityId,
                        confidence: rel.confidence ?? 0.8,
                        sourceType: "message",
                        sourceId: _messageId,
                      });
                    }
                  } catch { /* non-fatal per relation */ }
                }
              }
            } catch (deepErr) {
              console.debug("[rsma] deep extraction failed:", deepErr instanceof Error ? deepErr.message : String(deepErr));
            }
          }
        }

          // ── Deep claim extraction: LLM-powered claim mining (fallback) ──
          // Only runs when semantic extraction didn't produce claims, to avoid
          // double-extracting the same facts.
          if (_config.relationsDeepExtractionEnabled && hasExtractionModel) {
            const semanticClaimCount = writerResult.objects.filter(o => o.kind === "claim").length;
            if (semanticClaimCount === 0) {
              try {
                const { extractClaimsDeep } = await import("./relations/deep-extract.js");
                const { storeClaimExtractionResults } = await import("./relations/claim-store.js");
                const deepClaims = await extractClaimsDeep(_content, _deps, _config);
                if (deepClaims.length > 0) {
                  // ── Route through TruthEngine for supersession/conflict/evidence ──
                  const { reconcile: reconcileDeep } = await import("./ontology/truth.js");
                  const { projectProvenance: projDeep, recordSupersession: recSuperDeep, recordConflict: recConflictDeep, recordEvidence: recEvidenceDeep } = await import("./ontology/projector.js");
                  const { upsertMemoryObject: upsertDeep } = await import("./ontology/mo-store.js");
                  const { buildCanonicalKey: buildCKDeep } = await import("./ontology/canonical.js");
                  const { SOURCE_TRUST: stDeep } = await import("./ontology/types.js");

                  const now = new Date().toISOString();
                  const deepMOs = deepClaims.map(dc => {
                    const structured = {
                      subject: dc.claim.subject,
                      predicate: dc.claim.predicate,
                      objectText: dc.claim.objectText,
                    };
                    const content = `${dc.claim.subject} ${dc.claim.predicate}: ${dc.claim.objectText}`;
                    return {
                      id: `claim:${randomUUID()}`,
                      kind: "claim" as const,
                      content,
                      structured,
                      provenance: {
                        source_kind: "extraction" as const,
                        source_id: _messageId,
                        source_detail: "deep_extraction",
                        actor: _eeActor,
                        trust: stDeep.extraction ?? 0.5,
                        extraction_method: "llm" as const,
                      },
                      confidence: dc.claim.confidence ?? 0.5,
                      freshness: 1.0,
                      provisional: false,
                      status: "active" as const,
                      observed_at: now,
                      scope_id: DEFAULT_SCOPE_ID,
                      influence_weight: "standard" as const,
                      created_at: now,
                      updated_at: now,
                      canonical_key: buildCKDeep("claim", content, structured),
                    };
                  });

                  const reconciledDeep = reconcileDeep(graphDb, deepMOs as any, {
                    isCorrection: false,
                  });

                  for (const action of reconciledDeep.actions) {
                    if (action.type === "insert") {
                      upsertDeep(graphDb, action.object);
                      projDeep(graphDb, action.object);
                    } else if (action.type === "supersede") {
                      upsertDeep(graphDb, action.newObject);
                      projDeep(graphDb, action.newObject);
                      recSuperDeep(graphDb, action.newObject.id, action.oldObjectId, action.reason);
                      try {
                        const oldMatch = action.oldObjectId.match(/^claim:(\d+)$/);
                        if (oldMatch) {
                          const { supersedeClaim: scDeep } = await import("./relations/claim-store.js");
                          const newCK = action.newObject.canonical_key;
                          let newRawId = 0;
                          if (newCK) {
                            const row = graphDb.prepare(
                              "SELECT id FROM memory_objects WHERE kind = 'claim' AND canonical_key = ? AND scope_id = 1 ORDER BY id DESC LIMIT 1",
                            ).get(newCK) as { id: number } | undefined;
                            if (row) newRawId = row.id;
                          }
                          scDeep(graphDb, parseInt(oldMatch[1], 10), newRawId);
                        }
                      } catch { /* non-fatal */ }
                    } else if (action.type === "conflict") {
                      upsertDeep(graphDb, action.conflictObject);
                      projDeep(graphDb, action.conflictObject);
                      recConflictDeep(graphDb, action.conflictObject.id, action.objectIdA, action.objectIdB, action.reason);
                    } else if (action.type === "evidence") {
                      try {
                        graphDb.prepare(
                          "UPDATE memory_objects SET last_observed_at = strftime('%Y-%m-%dT%H:%M:%f','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%f','now'), confidence = MIN(1.0, confidence * 0.3 + ? * 0.7) WHERE composite_id = ?"
                        ).run(action.newObject.confidence ?? 0.5, action.existingObjectId);
                      } catch {}
                      projDeep(graphDb, action.newObject);
                      recEvidenceDeep(graphDb, action.newObject.id, action.existingObjectId, action.predicate, 1.0, action.reason);
                    }
                  }

                  // Also store in legacy claims table for backward compat
                  const { withWriteTransaction: wt2 } = await import("./relations/evidence-log.js");
                  wt2(graphDb, () => {
                    storeClaimExtractionResults(graphDb, deepClaims, {
                      scopeId: DEFAULT_SCOPE_ID,
                      sourceType: "deep_extraction",
                      sourceId: _messageId,
                      actor: _eeActor,
                      runId: _runId,
                    });
                  });
                }
              } catch (deepClaimErr) {
                console.debug("[rsma] deep claim extraction failed:", deepClaimErr instanceof Error ? deepClaimErr.message : String(deepClaimErr));
              }
            }
          }

          // Invariant extraction: LLM is primary (via semanticExtract), regex is fallback
          const llmInvariantCount = writerResult.objects.filter(o => o.kind === "invariant").length;
          if (llmInvariantCount === 0) try {
            const { extractInvariantsFromText } = await import("./relations/claim-extract.js");
            const { upsertInvariant } = await import("./relations/invariant-store.js");
            const invariants = extractInvariantsFromText(_content, _messageId);
            if (invariants.length > 0) {
              const { withWriteTransaction: wt3 } = await import("./relations/evidence-log.js");
              wt3(graphDb, () => {
                for (const inv of invariants) {
                  upsertInvariant(graphDb, {
                    scopeId: DEFAULT_SCOPE_ID,
                    invariantKey: inv.key,
                    description: inv.description,
                    severity: inv.severity as "critical" | "error" | "warning" | "info",
                    enforcementMode: inv.enforcementMode as "strict" | "advisory",
                    sourceId: inv.sourceId,
                  });
                }
              });
            }
          } catch { /* non-fatal */ }
        // Health monitoring: track success
        _rsmaSuccessCount++;
        if (_rsmaSuccessCount % _RSMA_LOG_INTERVAL === 0) {
          console.info(`[rsma] health: ${_rsmaSuccessCount} successful extractions, ${_rsmaFailCount} failures`);
        }
      } catch (err) {
        _rsmaFailCount++;
        console.warn("[rsma] extraction pipeline failed:", err instanceof Error ? err.message : String(err));
        if ((_rsmaSuccessCount + _rsmaFailCount) % _RSMA_LOG_INTERVAL === 0) {
          console.info(`[rsma] health: ${_rsmaSuccessCount} successful extractions, ${_rsmaFailCount} failures`);
        }
      } finally {
        _activeExtractions--;
      }
      })().catch((err) => {
        // Safety net: catch any unhandled rejection from the fire-and-forget IIFE.
        // Without this, an unhandled promise rejection kills the entire process
        // (no process.on('unhandledRejection') handler exists in OpenClaw plugins).
        _activeExtractions = Math.max(0, _activeExtractions); // safety: never go negative
        console.warn("[rsma] unhandled extraction error:", err instanceof Error ? err.message : String(err));
      }); // fire-and-forget — don't await
      } // end backpressure else
    }

    return { ingested: true };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, () => this.ingestSingle(params));
  }

  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    this.ensureMigrated();
    if (params.messages.length === 0) {
      return { ingestedCount: 0 };
    }
    return this.withSessionQueue(params.sessionId, async () => {
      let ingestedCount = 0;
      for (const message of params.messages) {
        const result = await this.ingestSingle({
          sessionId: params.sessionId,
          message,
          isHeartbeat: params.isHeartbeat,
        });
        if (result.ingested) {
          ingestedCount += 1;
        }
      }
      return { ingestedCount };
    });
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: Record<string, unknown>;
    /** Back-compat param name. */
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    this.ensureMigrated();

    const ingestBatch: AgentMessage[] = [];
    if (params.autoCompactionSummary) {
      ingestBatch.push({
        role: "system",
        content: params.autoCompactionSummary,
      } as AgentMessage);
    }

    const newMessages = params.messages.slice(params.prePromptMessageCount);
    ingestBatch.push(...newMessages);
    if (ingestBatch.length === 0) {
      return;
    }

    try {
      await this.ingestBatch({
        sessionId: params.sessionId,
        messages: ingestBatch,
        isHeartbeat: params.isHeartbeat === true,
      });
    } catch (err) {
      // Never compact a stale or partially ingested frontier.
      console.error(
        `[cc-mem] afterTurn: ingest failed, skipping compaction:`,
        err instanceof Error ? err.message.slice(0, 500) : "unknown error",
      );
      return;
    }

    const tokenBudget = this.resolveTokenBudget({ tokenBudget: params.tokenBudget });
    if (!tokenBudget) {
      return;
    }

    const legacyParams = asRecord(params.runtimeContext) ?? asRecord(params.legacyCompactionParams);

    const liveContextTokens = estimateSessionTokenCountForAfterTurn(params.messages);

    try {
      const leafTrigger = await this.evaluateLeafTrigger(params.sessionId);
      if (leafTrigger.shouldCompact) {
        this.compactLeafAsync({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          tokenBudget,
          currentTokenCount: liveContextTokens,
          legacyParams,
        }).catch(() => {
          // Leaf compaction is best-effort and should not fail the caller.
        });
      }
    } catch {
      // Leaf trigger checks are best-effort.
    }

    try {
      await this.compact({
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        tokenBudget,
        currentTokenCount: liveContextTokens,
        compactionTarget: "threshold",
        legacyParams,
      });
    } catch {
      // Proactive compaction is best-effort in the post-turn lifecycle.
    }
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      this.ensureMigrated();

      const conversation = await this.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (!conversation) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
      if (contextItems.length === 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      // Guard against incomplete bootstrap/coverage: if the DB only has
      // raw context items and clearly trails the current live history, keep
      // the live path to avoid dropping prompt context.
      const hasSummaryItems = contextItems.some((item) => item.itemType === "summary");
      if (!hasSummaryItems && contextItems.length < params.messages.length) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const tokenBudget = this.resolveTokenBudget({ tokenBudget: params.tokenBudget }) ?? 128_000;

      const assembled = await this.assembler.assemble({
        conversationId: conversation.conversationId,
        tokenBudget,
        freshTailCount: this.config.freshTailCount,
      });

      // If assembly produced no messages for a non-empty live session,
      // fail safe to the live context.
      if (assembled.messages.length === 0 && params.messages.length > 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const result: AssembleResultWithSystemPrompt = {
        messages: assembled.messages,
        estimatedTokens: assembled.estimatedTokens,
        ...(assembled.systemPromptAddition
          ? { systemPromptAddition: assembled.systemPromptAddition }
          : {}),
      };

      // Awareness: inject entity graph notes into system prompt
      if (this.graphDb && this.config.relationsAwarenessEnabled) {
        try {
          const awarenessNote = buildAwarenessNote(
            assembled.messages as unknown[],
            this.graphDb,
            {
              maxNotes: this.config.relationsAwarenessMaxNotes,
              maxTokens: this.config.relationsAwarenessMaxTokens,
              staleDays: this.config.relationsStaleDays,
              minMentions: this.config.relationsMinMentions,
              docSurfacing: this.config.relationsAwarenessDocSurfacing,
              cacheMaxSize: this.config.relationsAwarenessCacheMaxSize,
              cacheTtlMs: this.config.relationsAwarenessCacheTtlMs,
            },
          );
          if (awarenessNote) {
            result.systemPromptAddition =
              (result.systemPromptAddition ?? "") + "\n\n" + awarenessNote;
          }
        } catch {
          // Non-fatal: awareness failure must not block assembly
        }
      }

      // Evidence context compiler: inject compiled capsules (claims, decisions, loops, etc.)
      if (this.graphDb && this.config.relationsEnabled) {
        try {
          const compiled = compileContextCapsules(this.graphDb, {
            tier: this.config.relationsContextTier,
            scopeId: DEFAULT_SCOPE_ID, // global scope
            autoArchiveIntervalMs: this.config.relationsAutoArchiveIntervalMs,
            autoArchiveEventThreshold: this.config.relationsAutoArchiveEventThreshold,
            decayDays: this.config.relationsDecayIntervalDays,
            runbookStaleDays: this.config.relationsRunbookStaleDays,
            decay: {
              toolSuccessMultiplier: this.config.relationsDecayToolSuccessMultiplier,
              stalenessMultiplier: this.config.relationsDecayStalenessMultiplier,
              toolSuccessFloor: this.config.relationsDecayToolSuccessFloor,
              stalenessFloor: this.config.relationsDecayStalenessFloor,
            },
          });
          if (compiled) {
            result.systemPromptAddition =
              (result.systemPromptAddition ?? "") + "\n\n" + compiled.text;
          }
        } catch {
          // Non-fatal: context compiler failure must not block assembly
        }
      }

      // Surface deprecated/broken capabilities as system prompt notes
      if (this.graphDb && this.config.relationsEnabled) {
        try {
          const { getCapabilities } = await import("./relations/capability-store.js");
          const caps = getCapabilities(this.graphDb, 1, { limit: 20 });
          const noteworthy = caps.filter((c: Record<string, unknown>) => c.status === "unavailable" || c.status === "degraded");
          if (noteworthy.length > 0) {
            const lines = noteworthy.map((c: Record<string, unknown>) =>
              `[CAPABILITY: ${c.status}] ${c.display_name ?? c.capability_key}`,
            );
            result.systemPromptAddition =
              (result.systemPromptAddition ?? "") + "\n\n[ThreadClaw Capabilities]\n" + lines.join("\n");
          }
        } catch { /* non-fatal */ }
      }

      // Account for system prompt additions in token estimate
      if (result.systemPromptAddition) {
        result.estimatedTokens += Math.ceil(result.systemPromptAddition.length / 4);
      }

      return result;
    } catch {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }
  }

  /** Evaluate whether incremental leaf compaction should run for a session. */
  async evaluateLeafTrigger(sessionId: string): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    this.ensureMigrated();
    const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
    if (!conversation) {
      const fallbackThreshold =
        typeof this.config.leafChunkTokens === "number" &&
        Number.isFinite(this.config.leafChunkTokens) &&
        this.config.leafChunkTokens > 0
          ? Math.floor(this.config.leafChunkTokens)
          : 20_000;
      return {
        shouldCompact: false,
        rawTokensOutsideTail: 0,
        threshold: fallbackThreshold,
      };
    }
    return this.compaction.evaluateLeafTrigger(conversation.conversationId);
  }

  /** Run one incremental leaf compaction pass in the per-session queue. */
  async compactLeafAsync(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    customInstructions?: string;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: Record<string, unknown>;
    /** Back-compat param name. */
    legacyParams?: Record<string, unknown>;
    force?: boolean;
    previousSummaryContent?: string;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, async () => {
      const conversation = await this.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (!conversation) {
        return {
          ok: true,
          compacted: false,
          reason: "no conversation found for session",
        };
      }

      const legacyParams = asRecord(params.runtimeContext) ?? params.legacyParams;

      const tokenBudget = this.resolveTokenBudget({
        tokenBudget: params.tokenBudget,
        legacyParams,
      });
      if (!tokenBudget) {
        return {
          ok: false,
          compacted: false,
          reason: "missing token budget in compact params",
        };
      }

      const lp = legacyParams ?? {};
      const observedTokens = this.normalizeObservedTokenCount(
        params.currentTokenCount ??
          (
            lp as {
              currentTokenCount?: unknown;
            }
          ).currentTokenCount,
      );
      const summarize = await this.resolveSummarize({
        legacyParams,
        customInstructions: params.customInstructions,
      });

      const leafResult = await this.compaction.compactLeaf({
        conversationId: conversation.conversationId,
        tokenBudget,
        summarize,
        force: params.force,
        previousSummaryContent: params.previousSummaryContent,
      });
      const tokensBefore = observedTokens ?? leafResult.tokensBefore;

      return {
        ok: true,
        compacted: leafResult.actionTaken,
        reason: leafResult.actionTaken ? "compacted" : "below threshold",
        result: {
          tokensBefore,
          tokensAfter: leafResult.tokensAfter,
          details: {
            rounds: leafResult.actionTaken ? 1 : 0,
            targetTokens: tokenBudget,
            mode: "leaf",
          },
        },
      };
    });
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: Record<string, unknown>;
    /** Back-compat param name. */
    legacyParams?: Record<string, unknown>;
    /** Force compaction even if below threshold */
    force?: boolean;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, async () => {
      const { sessionId, force = false } = params;

      // Look up conversation
      const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
      if (!conversation) {
        return {
          ok: true,
          compacted: false,
          reason: "no conversation found for session",
        };
      }

      const conversationId = conversation.conversationId;

      const legacyParams = asRecord(params.runtimeContext) ?? params.legacyParams;
      const lp = legacyParams ?? {};
      const manualCompactionRequested =
        (
          lp as {
            manualCompaction?: unknown;
          }
        ).manualCompaction === true;
      const forceCompaction = force || manualCompactionRequested;
      const tokenBudget = this.resolveTokenBudget({
        tokenBudget: params.tokenBudget,
        legacyParams,
      });
      if (!tokenBudget) {
        return {
          ok: false,
          compacted: false,
          reason: "missing token budget in compact params",
        };
      }

      const summarize = await this.resolveSummarize({
        legacyParams,
        customInstructions: params.customInstructions,
      });

      // Evaluate whether compaction is needed (unless forced)
      const observedTokens = this.normalizeObservedTokenCount(
        params.currentTokenCount ??
          (
            lp as {
              currentTokenCount?: unknown;
            }
          ).currentTokenCount,
      );
      const decision =
        observedTokens !== undefined
          ? await this.compaction.evaluate(conversationId, tokenBudget, observedTokens)
          : await this.compaction.evaluate(conversationId, tokenBudget);
      const targetTokens =
        params.compactionTarget === "threshold" ? decision.threshold : tokenBudget;
      const liveContextStillExceedsTarget =
        observedTokens !== undefined && observedTokens >= targetTokens;

      if (!forceCompaction && !decision.shouldCompact) {
        return {
          ok: true,
          compacted: false,
          reason: "below threshold",
          result: {
            tokensBefore: decision.currentTokens,
          },
        };
      }

      const useSweep =
        manualCompactionRequested || forceCompaction || params.compactionTarget === "threshold";
      if (useSweep) {
        const sweepResult = await this.compaction.compactFullSweep({
          conversationId,
          tokenBudget,
          summarize,
          force: forceCompaction,
          hardTrigger: false,
        });

        return {
          ok: sweepResult.actionTaken || !liveContextStillExceedsTarget,
          compacted: sweepResult.actionTaken,
          reason: sweepResult.actionTaken
            ? "compacted"
            : manualCompactionRequested
              ? "nothing to compact"
              : liveContextStillExceedsTarget
                ? "live context still exceeds target"
                : "already under target",
          result: {
            tokensBefore: decision.currentTokens,
            tokensAfter: sweepResult.tokensAfter,
            details: {
              rounds: sweepResult.actionTaken ? 1 : 0,
              targetTokens,
            },
          },
        };
      }

      // When forced, use the token budget as target
      const convergenceTargetTokens = tokenBudget;

      const compactResult = await this.compaction.compactUntilUnder({
        conversationId,
        tokenBudget,
        targetTokens: convergenceTargetTokens,
        ...(observedTokens !== undefined ? { currentTokens: observedTokens } : {}),
        summarize,
      });
      const didCompact = compactResult.rounds > 0;

      return {
        ok: compactResult.success,
        compacted: didCompact,
        reason: compactResult.success
          ? didCompact
            ? "compacted"
            : "already under target"
          : "could not reach target",
        result: {
          tokensBefore: decision.currentTokens,
          tokensAfter: compactResult.finalTokens,
          details: {
            rounds: compactResult.rounds,
            targetTokens: convergenceTargetTokens,
          },
        },
      };
    });
  }

  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    this.ensureMigrated();

    const childSessionKey = params.childSessionKey.trim();
    const parentSessionKey = params.parentSessionKey.trim();
    if (!childSessionKey || !parentSessionKey) {
      return undefined;
    }

    const conversationId = await this.resolveConversationIdForSessionKey(parentSessionKey);
    if (typeof conversationId !== "number") {
      return undefined;
    }

    const ttlMs =
      typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
        ? Math.floor(params.ttlMs)
        : undefined;

    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: parentSessionKey,
      allowedConversationIds: [conversationId],
      tokenCap: this.config.maxExpandTokens,
      ttlMs,
    });

    return {
      rollback: () => {
        revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
      },
    };
  }

  async onSubagentEnded(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void> {
    const childSessionKey = params.childSessionKey.trim();
    if (!childSessionKey) {
      return;
    }

    switch (params.reason) {
      case "deleted":
        revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
        break;
      case "completed":
        revokeDelegatedExpansionGrantForSession(childSessionKey);
        break;
      case "released":
      case "swept":
        removeDelegatedExpansionGrantForSession(childSessionKey);
        break;
    }
  }

  async dispose(): Promise<void> {
    // No-op for plugin singleton — the connection is shared across runs.
    // OpenClaw's runner calls dispose() after every run, but the plugin
    // registers a single engine instance reused by the factory. Closing
    // the DB here would break subsequent runs with "database is not open".
    // The connection is cleaned up on process exit via the connection module.
  }

  // ── Public accessors for retrieval (used by subagent expansion) ─────────

  getRetrieval(): RetrievalEngine {
    return this.retrieval;
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getSummaryStore(): SummaryStore {
    return this.summaryStore;
  }

  getGraphDb(): GraphDb | null {
    return this.graphDb;
  }

  // ── Heartbeat pruning ──────────────────────────────────────────────────

  /**
   * Detect HEARTBEAT_OK turn cycles in a conversation and delete them.
   *
   * A HEARTBEAT_OK turn is: a user message (the heartbeat prompt), followed by
   * any tool call/result messages, ending with an assistant message that is a
   * heartbeat ack. The entire sequence has no durable information value for LCM.
   *
   * Detection: assistant content (trimmed, lowercased) starts with "heartbeat_ok"
   * and any text after is not alphanumeric (matches OpenClaw core's ack detection).
   * This catches both exact "HEARTBEAT_OK" and chatty variants like
   * "HEARTBEAT_OK — weekend, no market".
   *
   * Returns the number of messages deleted.
   */
  private async pruneHeartbeatOkTurns(conversationId: number): Promise<number> {
    const allMessages = await this.conversationStore.getMessages(conversationId);
    if (allMessages.length === 0) {
      return 0;
    }

    const toDelete: number[] = [];

    // Walk through messages finding HEARTBEAT_OK assistant replies, then
    // collect the entire turn (back to the preceding user message).
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role !== "assistant") {
        continue;
      }
      if (!isHeartbeatOkContent(msg.content)) {
        continue;
      }

      // Found a HEARTBEAT_OK reply. Walk backward to find the turn start
      // (the preceding user message).
      const turnMessageIds: number[] = [msg.messageId];
      for (let j = i - 1; j >= 0; j--) {
        const prev = allMessages[j];
        turnMessageIds.push(prev.messageId);
        if (prev.role === "user") {
          break; // Found turn start
        }
      }

      toDelete.push(...turnMessageIds);
    }

    if (toDelete.length === 0) {
      return 0;
    }

    // Deduplicate (a message could theoretically appear in multiple turns)
    const uniqueIds = [...new Set(toDelete)];
    return this.conversationStore.deleteMessages(uniqueIds);
  }
}

// ── Heartbeat detection ─────────────────────────────────────────────────────

const HEARTBEAT_OK_TOKEN = "heartbeat_ok";

/**
 * Detect whether an assistant message is a heartbeat ack.
 *
 * Matches the same pattern as OpenClaw core's heartbeat-events-filter:
 * content starts with "heartbeat_ok" (case-insensitive) and any character
 * immediately after is not alphanumeric or underscore.
 *
 * This catches:
 *   - "HEARTBEAT_OK"
 *   - "  HEARTBEAT_OK  "
 *   - "HEARTBEAT_OK — weekend, no market."
 *   - "Saturday 10:48 AM PT — weekend, no market. HEARTBEAT_OK"
 *
 * But not:
 *   - "HEARTBEAT_OK_EXTENDED" (alphanumeric continuation)
 */
function isHeartbeatOkContent(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  // Check if it starts with the token
  if (trimmed.startsWith(HEARTBEAT_OK_TOKEN)) {
    const suffix = trimmed.slice(HEARTBEAT_OK_TOKEN.length);
    if (suffix.length === 0) {
      return true;
    }
    return !/[a-z0-9_]/.test(suffix[0]);
  }

  // Also check if it ends with the token (chatty prefix + HEARTBEAT_OK)
  if (trimmed.endsWith(HEARTBEAT_OK_TOKEN)) {
    return true;
  }

  return false;
}

// ── Emergency fallback summarization ────────────────────────────────────────

/**
 * Creates a deterministic truncation summarizer used only as an emergency
 * fallback when the model-backed summarizer cannot be created.
 *
 * CompactionEngine already escalates normal -> aggressive -> fallback for
 * convergence. This function simply provides a stable baseline summarize
 * callback to keep compaction operable when runtime setup is unavailable.
 */
function createEmergencyFallbackSummarize(): (
  text: string,
  aggressive?: boolean,
) => Promise<string> {
  return async (text: string, aggressive?: boolean): Promise<string> => {
    const maxChars = aggressive ? 600 * 4 : 900 * 4;
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + "\n[Truncated for context management]";
  };
}
