# Runbooks & Negative Memory

## Procedures (Unified in memory_objects)

Runbooks and anti-runbooks are now stored as **procedures** (kind='procedure') in the unified `memory_objects` table. The `structured_json` field contains an `isNegative` flag to distinguish success patterns from failure patterns. Evidence links to supporting attempts are stored in `provenance_links` (predicate='supports').

## Runbooks (Success Patterns)

Runbooks capture learned success patterns from tool execution history. When a tool succeeds 3+ consecutive times with similar input, ThreadClaw auto-infers a runbook. Runbook capsules are surfaced in CCL (context compiler) with success rate display.

### Lifecycle
1. **Observe**: Tool attempts are recorded as MemoryObjects (kind='attempt')
2. **Infer**: `inferRunbookFromAttempts()` detects success streaks (threshold: 3 consecutive)
3. **Store**: Pattern stored as MemoryObject (kind='procedure', isNegative=false) with success/failure counts and confidence
4. **Link**: Attempts are linked as evidence via `provenance_links` (predicate='supports')
5. **Surface**: Context compiler includes procedures based on ROI scoring
6. **Decay**: Runbooks with high failure rates get demoted; unused ones go stale

### Runbook Evidence Chain
Each runbook links back to the specific attempts that support it:
```
procedure (MO) -> provenance_links (supports) -> attempt (MO)
```

## Anti-Runbooks (Failure Patterns)

Anti-runbooks capture known failure patterns to prevent repeating mistakes. Stored as MemoryObjects with kind='procedure' and isNegative=true in structured_json.

### Properties
- **failure_pattern**: Description of what went wrong (in content field)
- **failure_count**: Increments with each new observation (in structured_json)
- **confidence**: Increases by +0.1 per observation (capped at 1.0)
- **status**: active, stale, or needs_confirmation

### Context Priority
Anti-runbooks receive the **highest context priority** (score 0.95) -- preventing known failures is more valuable than surfacing known successes.

## Decay Rules

### Anti-Runbook Decay
- If no new failure evidence in 90 days: confidence *= 0.8
- If confidence drops below 0.2: status = 'needs_confirmation'
- Decay is **lazy** -- applied before queries, not on schedule

### Runbook Decay
- If failure_rate > 0.5: confidence *= 0.5 (demoted)
- If no usage in 180 days: status = 'stale'
- Stale runbooks are excluded from context compilation

### Decay Application Points
Decay runs lazily in these query paths:
- `compileContextCapsules()` -- before gathering evidence
- `cc_procedures` tool -- before listing procedures
- `cc_attempts` tool -- before showing outcomes
