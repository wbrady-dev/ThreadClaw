# Data Flow Tracer

Trace a feature's data flow end-to-end to find field mismatches, broken paths, and missing tests.

## Input

The user will provide:
- **Feature name**: e.g. "relations extraction", "query pipeline", "ingest chunking"
- **Sample input** (optional): e.g. "Cassidy works for Sam", a file path, a query string

If no sample input is provided, construct a realistic one.

## Process

### Step 1: Identify the entry point
Find where the sample input enters the system. Read the entry function fully.

### Step 2: Trace every function call
Follow the input through EVERY function in the chain. At each boundary:
1. Read the producing function — what fields does it SET on the output object?
2. Read the consuming function — what fields does it READ from the input object?
3. **Log the exact field names at both sides**
4. **Flag any mismatch** — this is the #1 class of bug that survives audits

### Step 3: Check types
For each data object that crosses a module boundary:
- Is it typed with a specific interface, or `Record<string, unknown>` / `any`?
- If untyped: **flag as risk** — TypeScript can't catch field mismatches
- If typed: verify the interface matches what's actually produced

### Step 4: Check config gates
List every boolean flag, env var, or condition that gates the feature:
- What must be true for the feature to run?
- What's the default? Could a fresh install have it disabled?
- Are there silent fallbacks that mask failures?

### Step 5: Check error handling
At each step in the chain:
- What happens on failure?
- Is the error logged or silently swallowed?
- Does a fallback run that produces different-shaped data?

### Step 6: Check test coverage
- Does an integration test exist that covers the FULL chain?
- Does a data-shape test verify field names match between producer and consumer?
- If not: **flag as critical gap**

## Output Format

```
## Data Flow Trace: [feature name]

### Chain
1. [entry function] → produces: { field1, field2, field3 }
2. [next function] → reads: { field1, field2 } → produces: { fieldA, fieldB }
3. [store function] → reads: { fieldA, fieldB } → INSERT INTO table

### Field Mismatches
- NONE FOUND (or list each mismatch with file:line)

### Type Safety
- [object name]: typed as [interface] ✓
- [object name]: typed as Record<string, unknown> ⚠️ RISK

### Config Gates
- ENV_VAR=value (default: X) — required for step N
- flag.enabled (default: false) — gates step M

### Silent Failures
- [file:line]: catch block swallows error without logging

### Test Coverage
- Integration test: YES/NO [file if exists]
- Data shape test: YES/NO [file if exists]
- Missing tests: [list what's needed]

### Fixes Needed
1. [specific fix with file and line]
```

## Rules
- Read EVERY file in the chain — do not skip or assume
- Follow the ACTUAL object shape, not what the variable name suggests
- Check fallback paths too — they often produce different-shaped data
- Be paranoid about `any`, `as`, and `Record<string, unknown>` — these hide bugs
- Cross-reference field names character by character between producer and consumer
