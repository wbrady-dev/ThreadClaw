# Agent Tools Reference

ThreadClaw provides 16 agent tools. 4 are always available (memory engine core), and 12 are available when `THREADCLAW_MEMORY_RELATIONS_ENABLED=true`. All tools are registered as OpenClaw plugin tools accessible by the agent during conversations.

## Memory Engine Tools (Always Available)

### cc_grep
Search conversation memory by pattern (regex or full-text).
- `pattern` (required): Search pattern
- `since`, `before`: Time range filters
- `conversationId`, `allConversations`, `crossAgent`: Scope controls

### cc_describe
Look up metadata for a memory item by ID (sum_xxx for summaries, file_xxx for files).
- `id` (required): Item ID
- `conversationId`, `allConversations`, `crossAgent`: Scope controls

### cc_expand
Expand compacted conversation summaries by traversing the summary DAG.
- `summaryIds` or `query`: What to expand
- `maxDepth`, `tokenCap`, `includeMessages`: Control expansion depth

### cc_recall
Ask a focused question against expanded conversation summaries.
- `query` (required): The question
- `conversationId`, `allConversations`: Scope controls

## Evidence OS Tools (Requires `THREADCLAW_MEMORY_RELATIONS_ENABLED=true`)

### cc_memory
Unified smart memory search — automatically searches claims, decisions, relationships, and conversation history. Routes internally based on query content.
- `query` (required): What to find or recall — a question, topic, name, or keyword
- `scope`: Optional: 'all' to search across all conversations (default: current)

### cc_claims
List claims with evidence chains.
- `subject`: Filter by subject
- `scope_id`, `limit`: Scope and pagination

### cc_decisions
View active and historical decisions.
- `topic`: Filter by topic (shows full supersession history)
- `scope_id`, `include_superseded`: Controls

### cc_loops
View open loops (tasks, questions, dependencies).
- `status`: Filter by status
- `scope_id`, `limit`: Controls

### cc_attempts
Show tool execution history with success rates.
- `tool_name`: Filter by tool (shows success rate when provided)
- `scope_id`, `limit`: Controls

### cc_branch
Manage speculative branches.
- `action`: `list` (default), `create`, `discard`
- `branch_type`, `branch_key`: For create
- `branch_id`: For discard

### cc_procedures
List learned success and failure patterns (runbooks and anti-runbooks).
- `type`: Filter by type: `success`, `failure`, or `all` (default: `all`)
- `tool_name`: Filter by tool
- `scope_id`: Scope filter

### cc_conflicts
View and resolve contradictions between facts.
- `action`: `list` (default) or `resolve`
- `conflict_id`, `winner_id`: For resolving a conflict
- `scope_id`: Scope filter

### cc_state
Aggregated view of everything known about a subject — claims, decisions, invariants, conflicts, loops, relations, procedures, entities.
- `subject` (required): Entity or topic name
- `scope_id`: Scope filter

### cc_timeline
Show how knowledge about a subject evolved over time — supersessions, corrections, confidence changes.
- `subject` (required): Entity or subject name to trace
- `from`, `to`: Date range (YYYY-MM-DD)
- `kind`: Filter by kind (claim, decision, loop, entity)

### cc_manage_loop
Close or update an open loop.
- `action` (required): `close` or `update`
- `loop_id` (required): Loop ID (numeric) to close or update
- `priority`: New priority (0-10)
- `owner`: New owner
- `waiting_on`: What/who this loop is waiting on
- `status`: Loop status: `open`, `blocked`, `closed`, `stale`

### cc_diagnostics
Show internal RSMA health: summary counts, claim counts, awareness stats, context compiler output, recent evidence events, and compaction state.
- `scope_id`: Scope ID (default: 1 = global)
- `verbose`: Include capsule text and recent events (default: false)

## Tool Availability

- **Always available** (4): `cc_grep`, `cc_describe`, `cc_expand`, `cc_recall`
- **Requires `THREADCLAW_MEMORY_RELATIONS_ENABLED=true`** (12): `cc_memory`, `cc_claims`, `cc_decisions`, `cc_loops`, `cc_manage_loop`, `cc_attempts`, `cc_branch`, `cc_procedures`, `cc_conflicts`, `cc_state`, `cc_timeline`, `cc_diagnostics`

All tools handle empty results gracefully and wrap queries in try/catch for non-fatal error handling.

## Extraction Mode

The extraction mode (`THREADCLAW_MEMORY_RELATIONS_EXTRACTION_MODE=smart|fast`) is transparent to tools. The same 16 tools work regardless of whether smart (LLM) or fast (regex) extraction is active. The extraction mode only affects how incoming messages are processed into MemoryObjects — tools read from the same underlying stores either way.
