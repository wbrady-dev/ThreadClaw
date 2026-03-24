/**
 * Version tracking and manifest management.
 *
 * The manifest (~/.threadclaw/manifest.json) is the single source of truth
 * for what version is installed, what schema versions are active, and
 * what state the integration is in.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createHash } from "crypto";

// ── Paths ──

export const THREADCLAW_HOME = resolve(homedir(), ".threadclaw");
export const THREADCLAW_DATA_DIR = resolve(THREADCLAW_HOME, "data");
export const THREADCLAW_BACKUPS_DIR = resolve(THREADCLAW_HOME, "backups");
export const MANIFEST_PATH = resolve(THREADCLAW_HOME, "manifest.json");

// ── Manifest schema ──

export interface ThreadClawManifest {
  appVersion: string;
  schemaVersion: number;           // RAG DB _migrations max
  evidenceSchemaVersion: number;   // graph DB _evidence_migrations max
  configVersion: number;           // bumped when .env format changes
  installedAt: string;             // ISO timestamp
  lastUpgradeAt: string;           // ISO timestamp
  openclawMinVersion: string;
  openclawMaxVersion: string;
  integrationHash: string;         // SHA-256 of managed openclaw.json block
  features: {
    managedIntegration: boolean;   // new check-only integration (vs old auto-fix)
    consolidatedData: boolean;     // DBs moved to ~/.threadclaw/data/
    noAutoMigrate: boolean;        // startup doesn't auto-run migrations
  };
  skills: Record<string, string>;  // path → SHA-256 of shipped content
}

const DEFAULT_MANIFEST: ThreadClawManifest = {
  appVersion: "0.0.0",
  schemaVersion: 0,
  evidenceSchemaVersion: 0,
  configVersion: 0,
  installedAt: new Date().toISOString(),
  lastUpgradeAt: new Date().toISOString(),
  openclawMinVersion: "2026.3.0",
  openclawMaxVersion: "2026.12.99",
  integrationHash: "",
  features: {
    managedIntegration: false,
    consolidatedData: false,
    noAutoMigrate: false,
  },
  skills: {},
};

// ── Read/Write ──

export function readManifest(): ThreadClawManifest {
  if (!existsSync(MANIFEST_PATH)) {
    return { ...DEFAULT_MANIFEST };
  }
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
    return {
      ...DEFAULT_MANIFEST,
      ...raw,
      features: { ...DEFAULT_MANIFEST.features, ...raw.features },
    };
  } catch {
    return { ...DEFAULT_MANIFEST };
  }
}

export function writeManifest(manifest: ThreadClawManifest): void {
  mkdirSync(THREADCLAW_HOME, { recursive: true });
  const tmpPath = MANIFEST_PATH + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmpPath, MANIFEST_PATH);
}

// ── App version from package.json ──

let _cachedAppVersion: string | null = null;

export function getAppVersion(): string {
  if (_cachedAppVersion) return _cachedAppVersion;
  try {
    // Try dist location first, then src location
    const candidates = [
      resolve(__dirname, "..", "package.json"),
      resolve(__dirname, "..", "..", "package.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        _cachedAppVersion = JSON.parse(readFileSync(p, "utf-8")).version ?? "0.0.0";
        return _cachedAppVersion!;
      }
    }
  } catch {}
  return "0.0.0";
}

// ── Version comparison ──

export interface VersionMismatch {
  field: string;
  installed: string | number;
  current: string | number;
  severity: "info" | "warn" | "error";
  message: string;
}

export function detectVersionMismatches(
  manifest: ThreadClawManifest,
  currentSchemaVersion: number,
  currentEvidenceSchemaVersion: number,
): VersionMismatch[] {
  const mismatches: VersionMismatch[] = [];
  const appVersion = getAppVersion();

  if (manifest.appVersion !== appVersion) {
    mismatches.push({
      field: "appVersion",
      installed: manifest.appVersion,
      current: appVersion,
      severity: "warn",
      message: `App version changed (${manifest.appVersion} → ${appVersion}). Run 'threadclaw upgrade' to apply.`,
    });
  }

  if (manifest.schemaVersion < currentSchemaVersion) {
    mismatches.push({
      field: "schemaVersion",
      installed: manifest.schemaVersion,
      current: currentSchemaVersion,
      severity: "warn",
      message: `RAG DB schema upgrade available (v${manifest.schemaVersion} → v${currentSchemaVersion}). Run 'threadclaw upgrade'.`,
    });
  } else if (manifest.schemaVersion > currentSchemaVersion) {
    mismatches.push({
      field: "schemaVersion",
      installed: manifest.schemaVersion,
      current: currentSchemaVersion,
      severity: "error",
      message: `Schema downgrade detected (v${manifest.schemaVersion} → v${currentSchemaVersion}). This is not supported — restore the newer version.`,
    });
  }

  if (manifest.evidenceSchemaVersion < currentEvidenceSchemaVersion) {
    mismatches.push({
      field: "evidenceSchemaVersion",
      installed: manifest.evidenceSchemaVersion,
      current: currentEvidenceSchemaVersion,
      severity: "warn",
      message: `Evidence schema upgrade available (v${manifest.evidenceSchemaVersion} → v${currentEvidenceSchemaVersion}). Run 'threadclaw upgrade'.`,
    });
  } else if (manifest.evidenceSchemaVersion > currentEvidenceSchemaVersion) {
    mismatches.push({
      field: "evidenceSchemaVersion",
      installed: manifest.evidenceSchemaVersion,
      current: currentEvidenceSchemaVersion,
      severity: "error",
      message: `Evidence schema downgrade detected (v${manifest.evidenceSchemaVersion} → v${currentEvidenceSchemaVersion}). This is not supported.`,
    });
  }

  return mismatches;
}

// ── Hashing ──

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ── Legacy DB detection ──

export interface LegacyDbLocation {
  name: string;
  legacyPath: string;
  newPath: string;
  exists: boolean;
}

export function detectLegacyDbLocations(): LegacyDbLocation[] {
  const openclawHome = resolve(homedir(), ".openclaw");
  return [
    {
      name: "memory",
      legacyPath: resolve(openclawHome, "threadclaw-memory.db"),
      newPath: resolve(THREADCLAW_DATA_DIR, "memory.db"),
      exists: existsSync(resolve(openclawHome, "threadclaw-memory.db")),
    },
    {
      name: "graph",
      legacyPath: resolve(openclawHome, "threadclaw-graph.db"),
      newPath: resolve(THREADCLAW_DATA_DIR, "graph.db"),
      exists: existsSync(resolve(openclawHome, "threadclaw-graph.db")),
    },
  ];
}

// ── Ensure data directory ──

export function ensureThreadClawHome(): void {
  mkdirSync(THREADCLAW_DATA_DIR, { recursive: true });
  mkdirSync(THREADCLAW_BACKUPS_DIR, { recursive: true });
}
