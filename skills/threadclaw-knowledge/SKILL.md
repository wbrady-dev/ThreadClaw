---
name: threadclaw-knowledge
description: Search the ThreadClaw document knowledge base for files, PDFs, code, reference material, and ingested documents. Do NOT use this for conversation history or structured evidence/state.
---

# Knowledge Search (ThreadClaw)

Use `threadclaw query` to search the document knowledge base: files, PDFs, code, notes, research, and other ingested reference material. The RAG pipeline uses hybrid search (dense vector + BM25 keyword via FTS5), fused with Reciprocal Rank Fusion (RRF), then cross-encoder reranking for precision.

**Deep document extraction**: When documents are ingested, ThreadClaw automatically extracts factual claims from each chunk using an LLM (subject/predicate/objectText triples). These are stored as provisional claims (confidence capped at 0.4) in the Evidence OS graph, making document knowledge searchable via `cc_memory` and `cc_claims` without manual annotation. Extraction uses NER + regex for entities and LLM for deeper semantic claims. Falls back gracefully to regex-only when no model server is available.

This skill is for **documents and reference material only**.

- For conversation history, use `cc_grep` or `cc_recall`
- For structured state, claims, decisions, loops, or evidence-backed memory, use the `threadclaw-evidence` skill

## When to use ThreadClaw Knowledge
- "What does the documentation say about X?"
- "Find the section about Y in my files"
- "What do my research papers say about Z?"
- "Search the workspace docs for this topic"
- Any question about ingested documents or reference material

## When NOT to use ThreadClaw Knowledge
- "What did we discuss earlier?" — use `cc_grep` or `cc_recall`
- "What does ThreadClaw know about X right now?" — use `cc_memory` or `cc_claims`
- "What decisions have been made?" — use `cc_decisions`
- "What is still open?" — use `cc_loops`
- Any question about conversation history, structured evidence, or current state

## Command Patterns

**Default — use `--brief`:**
```bash
exec: threadclaw query "search terms" --collection <collection-name> --brief
```

**Discovery — use `--titles` first when you are not sure which document is relevant:**
```bash
exec: threadclaw query "topic" --collection all --titles
```

**Full content — only when the user explicitly wants to read or inspect a document:**
```bash
exec: threadclaw query "search terms" --collection <collection-name> --full
```

**List collections when you do not know which one to use:**
```bash
exec: threadclaw collections
```

**Ingest a file — only when the user explicitly asks to add or import a file:**
```bash
exec: threadclaw ingest "/path/to/file" --collection <collection-name>
```

## Collection Rules

Collections are workspace-specific.

Common pattern:

| Collection | Content |
|------------|---------|
| default | General user-ingested documents |

Use these rules:
- Use a **specific collection** when the correct collection is known
- Use `all` only for **discovery** or when the collection is unknown
- Run `threadclaw collections` only when needed to choose the right collection
- Do not guess and spray queries across multiple collections unless discovery is necessary

## CRITICAL RULES

1. **Do not search if the answer is already in your current context.** Use what you already have.
2. **Use `--brief` by default.** It is usually enough to answer the question.
3. **Use `--titles` for discovery.** Use it first when you need to find the right document.
4. **Use `--full` only when the user explicitly wants to read the document.** Do not pull full content just to answer a normal question.
5. **Use one primary query, then at most one fallback.** If the first query fails, you may try one better-targeted alternative. Do not chain multiple retries.
6. **Do not loop.** If there are no results, say so. Do not retry with synonyms, broader queries, or repeated fishing.
7. **Cite exact sources.** Name the returned document title, file name, or document identifier that supported the answer. Do not invent source names.
8. **Never dump raw output.** Summarize the result in 1-3 sentences unless the user explicitly asked to see the document.
9. **Do not ingest or modify collections unless the user explicitly asks.** Searching is the default. Writing is opt-in.
10. **If the question is really about state or memory, switch skills.** Do not force document search for an evidence/state question.

## Token Cost Guide
- `--titles`: ~50 tokens
- `--brief`: ~250 tokens (default)
- No results: ~5 tokens
- `--full`: ~1500 tokens

## Setup

This skill is installed automatically with ThreadClaw.

Collections are configured in the TUI under **Sources**, or via watch paths in the `.env` file.

### Manual Installation
Copy this file to:
```text
<openclaw-workspace>/skills/threadclaw-knowledge/SKILL.md
```

### Personalization
- Update collection names to match the workspace
- Keep examples using real collection names if your workspace uses more than `default`
- If auto-ingest is enabled in your environment, that is a system feature — not a reason for the agent to ingest files without user intent
