/**
 * Compatibility matrix — which ThreadClaw versions work with which OpenClaw versions.
 *
 * NOTE: Update this matrix when releasing new ThreadClaw versions or when
 * OpenClaw compatibility ranges change. The matrix is used by `threadclaw doctor`.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

export interface CompatEntry {
  openclaw: { min: string; max: string };
  node: string;
  evidenceSchema: { min: number; max: number };
  ragSchema: { min: number; max: number };
}

/** Compatibility requirements per ThreadClaw version. */
export const COMPAT_MATRIX: Record<string, CompatEntry> = {
  "0.3.0": {
    openclaw: { min: "2026.3.0", max: "2026.12.99" },
    node: ">=22",
    evidenceSchema: { min: 1, max: 28 },
    ragSchema: { min: 1, max: 2 },
  },
  "0.2.0": {
    openclaw: { min: "2026.3.0", max: "2026.12.99" },
    node: ">=22",
    evidenceSchema: { min: 1, max: 7 },
    ragSchema: { min: 1, max: 2 },
  },
  "0.1.0": {
    openclaw: { min: "2026.3.0", max: "2026.12.99" },
    node: ">=22",
    evidenceSchema: { min: 1, max: 7 },
    ragSchema: { min: 1, max: 2 },
  },
};

/** Read OpenClaw version from openclaw.json. */
export function getOpenClawVersion(): string | null {
  const candidates = [
    resolve(homedir(), ".openclaw", "openclaw.json"),
    resolve(homedir(), ".clawd", "openclaw.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const config = JSON.parse(readFileSync(p, "utf-8"));
        return config?.meta?.lastTouchedVersion ?? null;
      } catch { /* corrupt config */ }
    }
  }
  return null;
}

/**
 * Compare semver-like version strings. Returns -1, 0, or 1.
 *
 * Caveat: parseInt treats non-numeric prefixes like "0beta" as 0, so
 * pre-release suffixes are effectively ignored in comparisons.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((s) => parseInt(s, 10) || 0);
  const pb = b.split(".").map((s) => parseInt(s, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

export interface CompatCheckResult {
  compatible: boolean;
  level: "supported" | "partial" | "unsupported" | "unknown";
  reason: string;
}

export function checkOpenClawCompat(
  threadclawVersion: string,
  openclawVersion: string | null,
): CompatCheckResult {
  if (!openclawVersion) {
    return { compatible: true, level: "unknown", reason: "OpenClaw version not detected" };
  }

  const compat = COMPAT_MATRIX[threadclawVersion];
  if (!compat) {
    return { compatible: true, level: "unknown", reason: `No compatibility data for ThreadClaw ${threadclawVersion}` };
  }

  const minOk = compareVersions(openclawVersion, compat.openclaw.min) >= 0;
  const maxOk = compareVersions(openclawVersion, compat.openclaw.max) <= 0;

  if (minOk && maxOk) {
    return { compatible: true, level: "supported", reason: `OpenClaw ${openclawVersion} is supported` };
  }
  if (!minOk) {
    return { compatible: false, level: "unsupported", reason: `OpenClaw ${openclawVersion} is too old (minimum: ${compat.openclaw.min})` };
  }
  return { compatible: false, level: "partial", reason: `OpenClaw ${openclawVersion} may not be fully compatible (maximum tested: ${compat.openclaw.max})` };
}

export function checkNodeCompat(): { ok: boolean; version: string; required: string } {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0], 10);
  return { ok: major >= 22, version, required: ">=22" };
}
