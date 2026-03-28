import { existsSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync, chmodSync } from "fs";
import { resolve } from "path";

export type EnvMap = Record<string, string>;

export function getEnvPath(root: string): string {
  return resolve(root, ".env");
}

export function ensureEnvFile(root: string): string {
  const envPath = getEnvPath(root);
  if (!existsSync(envPath)) {
    writeFileSync(
      envPath,
      [
        "# ThreadClaw Configuration",
        "#",
        "# WATCH_PATHS — directories to watch for automatic ingestion.",
        "# Format: path|collection,path2|collection2",
        "# Example: C:\\Users\\me\\notes|notes,C:\\Users\\me\\docs|documents",
        "",
      ].join("\n"),
    );
  }
  return envPath;
}

/**
 * Strip surrounding quotes from a value and unescape inner sequences.
 * Handles both "double" and 'single' quoted strings.
 */
function stripQuotes(raw: string): string {
  if (raw.length >= 2) {
    if ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))) {
      const inner = raw.slice(1, -1);
      // Unescape common sequences (only meaningful for double-quoted)
      if (raw.startsWith('"')) {
        return inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
      return inner;
    }
  }
  return raw;
}

/**
 * Escape a value so it can be safely stored inside double quotes in .env.
 */
function escapeEnvValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

export function readEnvMap(root: string): EnvMap {
  const envPath = getEnvPath(root);
  if (!existsSync(envPath)) return {};

  const values: EnvMap = {};
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    // Last occurrence wins (handles duplicate keys in file)
    values[key] = stripQuotes(raw);
  }
  return values;
}

export function writeEnvMap(root: string, values: EnvMap): void {
  const envPath = ensureEnvFile(root);
  const lines = ["# ThreadClaw Configuration"];

  // Object.entries is already deduplicated — sort for determinism
  const deduped = Object.entries(values);
  deduped.sort(([left], [right]) => left.localeCompare(right));

  for (const [key, value] of deduped) {
    lines.push(`${key}="${escapeEnvValue(value)}"`);
  }
  const tmpPath = envPath + ".tmp";
  writeFileSync(tmpPath, lines.join("\n") + "\n");
  renameSync(tmpPath, envPath);
  // Restrict .env to owner-only (contains API keys and secrets)
  if (process.platform !== "win32") {
    try { chmodSync(envPath, 0o600); } catch {}
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000;

export function backupEnvIfNeeded(envPath: string): void {
  const bakPath = envPath + ".bak";
  try {
    if (!existsSync(bakPath)) {
      copyFileSync(envPath, bakPath);
      if (process.platform !== "win32") {
        try { chmodSync(bakPath, 0o600); } catch {}
      }
      return;
    }
    const age = Date.now() - statSync(bakPath).mtimeMs;
    if (age > ONE_HOUR_MS) {
      copyFileSync(envPath, bakPath);
      if (process.platform !== "win32") {
        try { chmodSync(bakPath, 0o600); } catch {}
      }
    }
  } catch {}
}

export function updateEnvValues(root: string, updates: EnvMap): void {
  const envPath = ensureEnvFile(root);
  backupEnvIfNeeded(envPath);
  let content = readFileSync(envPath, "utf-8");

  for (const [key, value] of Object.entries(updates)) {
    const quoted = `${key}="${escapeEnvValue(value)}"`;
    // Global flag replaces ALL occurrences of this key (dedup on write)
    const testPattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
    if (testPattern.test(content)) {
      // Replace first occurrence, remove subsequent duplicates
      const replacePattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "gm");
      let first = true;
      content = content.replace(replacePattern, (match) => {
        if (first) {
          first = false;
          return quoted;
        }
        return ""; // remove duplicate lines
      });
      // Clean up blank lines left by removed duplicates (3+ newlines → 2)
      content = content.replace(/\n{3,}/g, "\n\n");
    } else {
      content = content.trimEnd() + `\n${quoted}\n`;
    }
  }

  const tmpPath = envPath + ".tmp";
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, envPath);
  // Restore restrictive permissions on non-Windows (rename preserves tmp file's permissions)
  if (process.platform !== "win32") {
    try { chmodSync(envPath, 0o600); } catch {}
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
