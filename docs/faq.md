# FAQ

## General

**Q: Does ThreadClaw require an internet connection?**
A: No. All models can run locally. Cloud providers are optional for embeddings, reranking, and deep extraction.

**Q: What databases does ThreadClaw use?**
A: SQLite (2 database files). Document store and evidence graph are consolidated in `threadclaw.db` (uses `better-sqlite3` with `sqlite-vec`). Memory engine uses `memory.db` (`node:sqlite`, Node 22+ built-in). The evidence graph's core tables are `memory_objects` (unified knowledge store) and `provenance_links` (cross-object relationships).

**Q: How much disk space does ThreadClaw need?**
A: Models: 2-12 GB (depends on tier). Data: grows with usage. Typical: 50-500 MB for moderate use.

## Evidence OS

**Q: What's the difference between awareness and the context compiler?**
A: Awareness (Horizon 1) surfaces entity-level notes — mismatches, staleness, connections between entities. The context compiler (Horizon 2) surfaces structured evidence — claims, decisions, loops, invariants, anti-runbooks. Both inject into the system prompt.

**Q: Are claims extracted from every message?**
A: Yes, claims are extracted at ingest time (no compaction required). In **fast** extraction mode (regex-only), only structured signals are detected: tool results, "Remember:" statements, heading+bullet patterns, YAML frontmatter. In **smart** extraction mode (LLM-based), natural language claims are also detected (e.g. "The API runs on port 8080"). Quality filters reject junk claims (message metadata, file paths, confidence < 0.35).

**Q: How do anti-runbooks work?**
A: When a tool fails, you can record an anti-runbook pattern. Anti-runbooks are surfaced with the highest priority (score 0.95) by the context compiler, warning agents to avoid known failure patterns. Their confidence decays over time if no new failures are observed.

**Q: What happens if I disable relations after using them?**
A: Setting `RELATIONS_ENABLED=false` disables all evidence features. The data remains in `threadclaw.db` but isn't queried or surfaced. Re-enable to restore.

**Q: Can different agents share evidence?**
A: Yes. All agents in the same scope share the evidence graph by default. Use branches for agent-specific speculation, and `crossAgent=true` parameter for cross-agent search.

**Q: How does the context compiler decide what to include?**
A: Each evidence capsule is scored: `(usefulness x confidence x freshness) / tokenCost`. Capsules are ranked by score-per-token and filled greedily until the budget is exhausted. Anti-runbooks and invariants score highest.

## Performance

**Q: How fast is entity extraction?**
A: Pure regex, ~3-5ms per chunk. No LLM calls.

**Q: How fast is awareness note generation?**
A: Graph queries take ~10-15ms. Three query types (mismatch, staleness, connections) each have a 25ms budget guard.

**Q: How fast is context compilation?**
A: ~5-10ms. Reads from indexed tables, scores capsules, fills budget.

**Q: Does deep extraction slow things down?**
A: Deep extraction runs when enabled via config, not on every message. Smart extraction mode uses a single structured LLM call per message. Typical LLM call adds 1-5 seconds depending on model. Fast mode (regex-only) takes <5ms.

## Cost

**Q: Does ThreadClaw make API calls?**
A: In fast extraction mode, zero API calls (all regex/pattern-based). Smart extraction mode and deep extraction optionally use LLM calls, gated by config. Input is truncated to 4000 chars, output capped at 1000 tokens.

**Q: What's the token overhead per turn?**
A: Awareness notes: 0-80 tokens (~10-20% of turns). Evidence capsules: 0-280 tokens (budget-governed). Total: 0-360 tokens per turn.
