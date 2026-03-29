import type { GraphDb } from "./types.js";

export interface SessionBriefing {
  sinceTimestamp: string;
  timeSince: string; // "2h ago", "1d ago"
  newDecisions: number;
  supersededDecisions: number;
  newConflicts: number;
  newClaims: number;
  supersededClaims: number;
  total: number;
}

export function buildSessionBriefing(
  db: GraphDb,
  scopeId: number,
  sinceTimestamp: string,
): string | null {
  // Query memory_objects for changes since timestamp
  // Use updated_at alone (not OR with created_at) for index efficiency
  const rows = db.prepare(`
    SELECT kind, status, COUNT(*) as cnt FROM memory_objects
    WHERE scope_id = ? AND updated_at > ?
    GROUP BY kind, status
  `).all(scopeId, sinceTimestamp) as Array<{ kind: string; status: string; cnt: number }>;

  // Parse counts
  let newDecisions = 0, supersededDecisions = 0, newConflicts = 0;
  let newClaims = 0, supersededClaims = 0;
  for (const r of rows) {
    if (r.kind === "decision" && r.status === "active") newDecisions = Number(r.cnt);
    if (r.kind === "decision" && r.status === "superseded") supersededDecisions = Number(r.cnt);
    if (r.kind === "conflict") newConflicts += Number(r.cnt);
    if (r.kind === "claim" && r.status === "active") newClaims = Number(r.cnt);
    if (r.kind === "claim" && r.status === "superseded") supersededClaims = Number(r.cnt);
  }

  const total = newDecisions + supersededDecisions + newConflicts + newClaims + supersededClaims;
  if (total === 0) return null;

  // Format time since
  const msSince = Date.now() - new Date(sinceTimestamp).getTime();
  const hours = Math.floor(msSince / 3600000);
  const timeSince = hours < 1 ? `${Math.floor(msSince / 60000)}m ago`
    : hours < 24 ? `${hours}h ago`
    : `${Math.floor(hours / 24)}d ago`;

  // Build briefing
  const parts: string[] = [];
  if (newDecisions) parts.push(`${newDecisions} new decision${newDecisions > 1 ? "s" : ""}`);
  if (supersededDecisions) parts.push(`${supersededDecisions} superseded`);
  if (newClaims) parts.push(`${newClaims} new claim${newClaims > 1 ? "s" : ""}`);
  if (supersededClaims) parts.push(`${supersededClaims} claim${supersededClaims > 1 ? "s" : ""} superseded`);
  if (newConflicts) parts.push(`${newConflicts} conflict${newConflicts > 1 ? "s" : ""}`);

  return `[Session Briefing] Since last session (${timeSince}): ${parts.join(", ")}.`;
}
