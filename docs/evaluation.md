# Evaluation & Metrics

## Awareness Eval Harness

Ships with Horizon 1. Tracks awareness note quality, latency, and fire rate via an in-memory ring buffer (2,000 events max).

### Metrics

| Metric | Description |
|--------|-------------|
| `totalTurns` | Total awareness checks in window |
| `firedCount` | Times an awareness note was generated |
| `fireRate` | Percentage of turns that produced notes |
| `latencyP50` | Median awareness check latency |
| `latencyP95` | 95th percentile latency |
| `avgTokensWhenFired` | Average token cost when notes fire |
| `noteTypeBreakdown` | Count per type: mismatch, staleness, connection, proactive |
| `proactiveFiredCount` | Times proactive awareness fired (top entities, no specific matches) |

### Access

```typescript
import { getAwarenessStats } from "./relations/eval.js";
const stats = getAwarenessStats(86_400_000); // 24-hour window
```

### HTTP Endpoint

`GET /analytics/awareness` (when running in-process with ThreadClaw HTTP server).

## Performance Targets

| Operation | Target | Measured |
|-----------|--------|----------|
| Entity extraction per chunk | < 5ms | ~3ms |
| Awareness graph queries | < 15ms | ~10ms |
| Context compilation | < 10ms | ~5ms |
| Awareness total path | < 50ms p95 | ~25ms |
| Backfill per chunk | ~5ms | ~4ms |

## Token Overhead

| Component | Tokens | When |
|-----------|--------|------|
| Awareness notes (reactive) | 30-80 | ~10-20% of turns |
| Awareness notes (proactive) | 20-50 | When no reactive matches found |
| Evidence capsules | 0-280 | Every turn (budget-governed) |
| Total overhead | 30-360 | Per turn |

## False Positive Management

### Entity Awareness
- Minimum mention threshold (default: 2) filters noise
- Word-boundary matching prevents substring false positives
- 30-second entity cache TTL limits stale surfacing
- Proactive mode surfaces top entities when no reactive matches found, increasing overall awareness fire rate

### Claim Extraction
- Fast extraction only processes structured signals (no free-text parsing)
- Smart extraction additionally filters junk claims (message metadata, file paths, confidence < 0.35, code blocks stripped)
- Source trust hierarchy weights claims by origin quality
- Deduplication by canonical key prevents duplicates in memory_objects
