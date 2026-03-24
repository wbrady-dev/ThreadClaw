import { existsSync, readFileSync, writeFileSync, renameSync, statSync, copyFileSync } from "fs";
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
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }
  return values;
}

export function readEnvValue(root: string, key: string, fallback = ""): string {
  return readEnvMap(root)[key] ?? fallback;
}

export function writeEnvMap(root: string, values: EnvMap): void {
  const envPath = ensureEnvFile(root);
  const lines = ["# ThreadClaw Configuration"];
  const entries = Object.entries(values).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  const tmpPath = envPath + ".tmp";
  writeFileSync(tmpPath, lines.join("\n") + "\n");
  renameSync(tmpPath, envPath);
}

const ONE_HOUR_MS = 60 * 60 * 1000;

function backupEnvIfNeeded(envPath: string): void {
  const bakPath = envPath + ".bak";
  try {
    if (!existsSync(bakPath)) {
      copyFileSync(envPath, bakPath);
      return;
    }
    const age = Date.now() - statSync(bakPath).mtimeMs;
    if (age > ONE_HOUR_MS) {
      copyFileSync(envPath, bakPath);
    }
  } catch {}
}

export function updateEnvValues(root: string, updates: EnvMap): void {
  const envPath = ensureEnvFile(root);
  backupEnvIfNeeded(envPath);
  let content = readFileSync(envPath, "utf-8");

  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
    if (pattern.test(content)) {
      content = content.replace(pattern, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  const tmpPath = envPath + ".tmp";
  writeFileSync(tmpPath, content);
  renameSync(tmpPath, envPath);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
