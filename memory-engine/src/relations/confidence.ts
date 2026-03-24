/**
 * Confidence decay for entity awareness.
 *
 * effective = base * min(1.0, mentions / 3) * recencyWeight(daysSince)
 *
 * Recency weights (configurable, defaults shown):
 *   < 7 days  -> 1.0
 *   < 30 days -> 0.8
 *   < 90 days -> 0.5
 *   >= 90 days -> 0.3
 */

export interface RecencyConfig {
  fullDays?: number;       // default 7
  highDays?: number;       // default 30
  mediumDays?: number;     // default 90
  highWeight?: number;     // default 0.8
  mediumWeight?: number;   // default 0.5
  staleWeight?: number;    // default 0.3
}

function recencyWeight(daysSinceLastSeen: number, cfg?: RecencyConfig): number {
  const fullDays = cfg?.fullDays ?? 7;
  const highDays = cfg?.highDays ?? 30;
  const mediumDays = cfg?.mediumDays ?? 90;
  const highWeight = cfg?.highWeight ?? 0.8;
  const mediumWeight = cfg?.mediumWeight ?? 0.5;
  const staleWeight = cfg?.staleWeight ?? 0.3;

  if (daysSinceLastSeen < fullDays) return 1.0;
  if (daysSinceLastSeen < highDays) return highWeight;
  if (daysSinceLastSeen < mediumDays) return mediumWeight;
  return staleWeight;
}

/**
 * Compute effective confidence for an entity given its base confidence,
 * mention count, and recency.
 */
export function effectiveConfidence(
  base: number,
  mentionCount: number,
  daysSinceLastSeen: number,
  recencyConfig?: RecencyConfig,
): number {
  if (!Number.isFinite(base) || base < 0) return 0;
  if (!Number.isFinite(mentionCount) || mentionCount < 0) mentionCount = 0;
  if (!Number.isFinite(daysSinceLastSeen) || daysSinceLastSeen < 0) daysSinceLastSeen = 999;
  const mentionFactor = Math.min(1.0, mentionCount / 3);
  const recency = recencyWeight(daysSinceLastSeen, recencyConfig);
  return base * mentionFactor * recency;
}
