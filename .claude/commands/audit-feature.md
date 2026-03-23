# Feature Audit

Deep functional audit of a specific ClawCore feature. Goes beyond code reading — verifies the feature actually works by tracing data, checking types, and identifying structural risks.

## Input

The user will provide a feature name, e.g.:
- "relations extraction"
- "query reranking"
- "compaction"
- "Evidence OS claims"
- "file watcher"

## Process

### Phase 1: Data Flow Trace
Run the equivalent of `/trace-flow` for this feature. Identify the full chain from input to output.

### Phase 2: Boundary Contracts
For every module boundary in the chain:
1. What type does the producer return?
2. What type does the consumer expect?
3. Are they the same? Character-by-character field name comparison.
4. Is there a TypeScript interface enforcing the contract?

### Phase 3: Failure Modes
For each step:
1. What happens if this step throws?
2. What happens if it returns null/undefined/empty?
3. What happens if the external dependency is down (LLM, model server, DB)?
4. Are failures logged or silent?
5. Does a fallback path exist? Does it produce compatible data?

### Phase 4: Config & Defaults
1. What env vars / config flags control this feature?
2. What are the defaults? Is the feature ON or OFF for a fresh install?
3. Can a user accidentally disable it with a typo or quoted value?

### Phase 5: Concurrent Access
1. Can this feature be called concurrently?
2. Are there race conditions (read-then-write, check-then-act)?
3. Are DB operations properly transactioned?

### Phase 6: Test Coverage
1. Unit tests for individual functions?
2. Integration test covering the full chain?
3. Data shape tests verifying field contracts?
4. Edge case tests (empty input, huge input, malformed input)?

### Phase 7: Live Verification Plan
Describe a concrete test a human or agent can run to verify the feature works:
- Exact input to send
- What to check in the DB afterward
- Expected row counts / field values

## Output

Produce a structured report with:
- **Status**: WORKING / BROKEN / PARTIALLY WORKING
- **Data flow chain** with field shapes at each boundary
- **Risks** ranked by severity
- **Missing tests** with exact descriptions
- **Fix list** with file:line for each issue
- **Verification plan** for live testing
