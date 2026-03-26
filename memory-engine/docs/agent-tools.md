# Agent Tools

ThreadClaw provides 13 agent tools: 4 core conversation tools and 9 evidence tools from the RSMA ontology.

## Tool Summary

| Tool | Category | Description |
|------|----------|-------------|
| `cc_grep` | Core | Full-text/regex search across conversation history |
| `cc_describe` | Core | Inspect a specific summary or stored file |
| `cc_expand` | Core | Low-level DAG expansion (sub-agents only) |
| `cc_recall` | Core | Deep recall with sub-agent DAG expansion |
| `cc_memory` | Evidence | Unified smart search across all memory sources |
| `cc_claims` | Evidence | Claims with evidence chains |
| `cc_decisions` | Evidence | Active decisions and supersession history |
| `cc_loops` | Evidence | Open tasks, questions, and dependencies |
| `cc_attempts` | Evidence | Tool outcome history with success rates |
| `cc_branch` | Evidence | Speculative branch management and promotion |
| `cc_procedures` | Evidence | Learned success and failure patterns |
| `cc_synthesize` | Evidence | On-demand LLM scope synthesis |
| `cc_diagnostics` | Evidence | Internal RSMA health and observability |

The 4 core tools are always available. The 9 evidence tools require Evidence OS (`THREADCLAW_MEMORY_RELATIONS_ENABLED=true`).

## Usage Patterns

### Primary: cc_memory for any recall question

`cc_memory` is the recommended starting point for any question about facts, decisions, relationships, or past conversations. It automatically routes to the right source:

1. Searches `memory_objects` for matching claims, decisions, and relationships
2. Searches conversation summaries and messages via grep
3. Falls back to RAG document search if nothing found

### Escalation pattern: grep -> describe -> recall

For conversation-specific searches:

1. **`cc_grep`** -- find relevant summaries or messages by keyword/regex
2. **`cc_describe`** -- inspect a specific summary's full content (cheap, no sub-agent)
3. **`cc_recall`** -- deep recall: spawn a sub-agent to expand the DAG and answer a focused question

Start with grep. If the snippet is enough, stop. If you need full summary content, use describe. If you need details that were compressed away, use recall.

### Evidence exploration

For structured knowledge:

1. **`cc_claims`** -- deep dive into claims with evidence chains
2. **`cc_decisions`** -- full decision history with supersession tracking
3. **`cc_loops`** -- open tasks and blockers
4. **`cc_procedures`** -- learned success/failure patterns from tool outcomes
5. **`cc_attempts`** -- raw tool execution history with success rates

---

## Core Tools

### cc_grep

Search across messages and/or summaries using regex or full-text search.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | string | yes | -- | Search pattern |
| `mode` | string | | `"regex"` | `"regex"` or `"full_text"` |
| `scope` | string | | `"both"` | `"messages"`, `"summaries"`, or `"both"` |
| `conversationId` | number | | current | Specific conversation to search |
| `allConversations` | boolean | | `false` | Search all conversations |
| `since` | string | | -- | ISO timestamp lower bound |
| `before` | string | | -- | ISO timestamp upper bound |
| `limit` | number | | 50 | Max results (1-200) |

**Returns:** Array of matches with `id`, `type` (message/summary), `snippet`, `conversationId`, `createdAt`. For summaries: `depth`, `kind`, `summaryId`.

### cc_describe

Look up metadata and content for a specific summary or stored file.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | yes | -- | `sum_xxx` for summaries, `file_xxx` for files |
| `conversationId` | number | | current | Scope to a specific conversation |
| `allConversations` | boolean | | `false` | Allow cross-conversation lookups |

**Returns for summaries:** Full content, depth, kind, token count, time range (earliestAt/latestAt), descendant count, parent/child IDs, source message IDs, file IDs.

**Returns for files:** Full content, fileName, mimeType, byteSize, exploration summary.

### cc_recall

Answer a focused question by expanding summaries through the DAG. Spawns a bounded sub-agent (~30-120 seconds) that walks parent links down to source material and returns a compact answer.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | yes | -- | The question to answer |
| `query` | string | * | -- | Text query to find summaries (if no `summaryIds`) |
| `summaryIds` | string[] | * | -- | Specific summary IDs to expand (if no `query`) |
| `maxTokens` | number | | 2000 | Answer length cap |
| `conversationId` | number | | current | Scope to a specific conversation |
| `allConversations` | boolean | | `false` | Search across all conversations |

*One of `query` or `summaryIds` is required.

**Returns:** `answer`, `citedIds`, `expandedSummaryCount`, `totalSourceTokens`, `truncated`.

### cc_expand

Low-level DAG expansion tool. **Only available to sub-agents** spawned by `cc_recall`. Main agents should always use `cc_recall` instead.

---

## Evidence Tools

All evidence tools operate on the unified `memory_objects` table. Knowledge is stored as `MemoryObject` instances with typed kinds (claim, decision, entity, loop, attempt, procedure, invariant, conflict) and cross-referenced via `provenance_links` (supports, contradicts, supersedes, mentioned_in, relates_to, resolved_by, derived_from).

### cc_memory

Unified smart search across all memory sources. **This is the recommended starting tool for any recall question.**

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | string | yes | -- | What to find -- a question, topic, name, or keyword |
| `scope` | string | | current | `"all"` to search across all conversations |

**Search pipeline:**
1. Claims -- searches `memory_objects` (kind=claim, status=active) by content and structured_json
2. Decisions -- searches `memory_objects` (kind=decision, status=active)
3. Relationships -- searches claims with relational predicates
4. Conversation history -- searches summaries and messages via grep
5. Documents -- falls back to RAG document search if nothing else found

**Returns:** Sections labeled [Known Facts], [Decisions], [Relationships], [From Summaries], [From Conversation], [From Documents]. Token budget managed internally (~600 tokens).

### cc_claims

List claims with their supporting evidence.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `subject` | string | | -- | Filter by subject |
| `scope_id` | number | | 1 | Scope ID (1 = global) |
| `limit` | number | | 20 | Max claims (1-50) |

### cc_decisions

List active decisions. When a topic is specified, shows the full decision history including superseded decisions.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `topic` | string | | -- | Filter by topic (shows full history) |
| `scope_id` | number | | 1 | Scope ID |
| `include_superseded` | boolean | | false | Include superseded decisions |

### cc_loops

List open loops -- tasks, questions, and dependencies being tracked.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope_id` | number | | 1 | Scope ID |
| `status` | string | | -- | Filter: open, blocked, closed |
| `limit` | number | | 20 | Max loops (1-100) |

### cc_attempts

Show tool outcome history with success rates.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tool_name` | string | | -- | Filter by tool name (also shows success rate) |
| `scope_id` | number | | 1 | Scope ID |
| `limit` | number | | 20 | Max attempts (1-100) |

### cc_branch

Manage speculative branches -- create, list, discard, or promote branches.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope_id` | number | | 1 | Scope ID |
| `action` | string | | `"list"` | `list`, `create`, `discard`, `promote` |
| `branch_type` | string | | `"hypothesis"` | Branch type (for create) |
| `branch_key` | string | | auto | Branch key (for create) |
| `branch_id` | number | | -- | Branch ID (for discard/promote) |
| `object_type` | string | | `"claim"` | Object type for promotion policy check |
| `confidence` | number | | 0.5 | Confidence for promotion check |
| `evidence_count` | number | | 1 | Evidence count for promotion check |
| `user_confirmed` | boolean | | false | Whether user has confirmed promotion |

### cc_procedures

Show learned success patterns (runbooks) and failure patterns (anti-runbooks) from tool outcomes.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `tool_name` | string | | -- | Filter by tool name |
| `scope_id` | number | | 1 | Scope ID |
| `type` | string | | `"all"` | `"success"` (runbooks), `"failure"` (anti-runbooks), or `"all"` |
| `runbook_id` | number | | -- | Get a specific runbook with full evidence chain |

### cc_synthesize

Generate retrospective synthesis of evidence state. Requires LLM. On-demand only.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope_id` | number | | 1 | Scope ID (default: global) |

**Returns:** LLM-generated narrative summarizing the current state of evidence for the scope.

### cc_diagnostics

Show internal RSMA health: memory stats, evidence counts, awareness metrics, compiler state, recent events.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `scope_id` | number | | 1 | Scope ID |
| `verbose` | boolean | | false | Include capsule text and recent events |

**Reports:**
- Memory Engine -- conversations, messages, summaries
- Evidence Graph -- entities, mentions, relations, claims, decisions, loops, attempts, runbooks, anti-runbooks, evidence events (all counted from `memory_objects` and `provenance_links`)
- Awareness Layer -- turns, fire rate, latency, note types
- Context Compiler -- tier, capsule tokens, producing status
- Cold Archive -- archived counts
- Config -- enabled features

---

## Conversation Scoping

By default, tools operate on the current conversation. Use `allConversations: true` to search across all of them. Use `conversationId` to target a specific conversation.

## Performance

| Tool | Latency | Notes |
|------|---------|-------|
| cc_grep | Fast | Direct database query |
| cc_describe | Fast | Direct database query |
| cc_memory | Fast | Direct database queries + optional RAG HTTP call |
| cc_claims | Fast | Direct database query |
| cc_decisions | Fast | Direct database query |
| cc_loops | Fast | Direct database query |
| cc_attempts | Fast | Direct database query + decay pass |
| cc_procedures | Fast | Direct database query + decay pass |
| cc_branch | Fast | Direct database query |
| cc_diagnostics | Fast | Multiple database queries |
| cc_recall | Slow | Spawns sub-agent, 30-120 seconds, 120s timeout |
| cc_expand | Slow | Sub-agent only, DAG traversal |
