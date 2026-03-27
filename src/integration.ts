/**
 * OpenClaw integration — check/apply pattern.
 *
 * ThreadClaw manages a small, well-defined block in openclaw.json.
 * This module provides:
 *   - checkOpenClawIntegration() — read-only check, returns drifts
 *   - applyOpenClawIntegration() — writes managed block (CLI-only, never startup)
 *   - computeIntegrationHash() — SHA-256 of the managed block for drift detection
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { sha256, readManifest } from "./version.js";

// ── Types ──

export interface IntegrationDrift {
  field: string;
  expected: unknown;
  actual: unknown;
  severity: "error" | "warn";
}

export interface IntegrationStatus {
  ok: boolean;
  openclawFound: boolean;
  configPath: string;
  drifts: IntegrationDrift[];
  hashMatch: boolean;
}

// ── Managed block definition ──

// memoryEnginePath parameter is reserved for future use (e.g., validating plugin load path)
function getExpectedBlock(_memoryEnginePath: string): Record<string, unknown> {
  return {
    "plugins.slots.contextEngine": "threadclaw-memory",
    "plugins.slots.memory": "none",
    "plugins.entries.memory-core.enabled": false,
    "plugins.entries.threadclaw-memory.enabled": true,
    "agents.defaults.memorySearch": "__ABSENT__",
  };
}

function getNestedValue(obj: any, path: string): unknown {
  const parts = path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

// ── Find OpenClaw ──

export function findOpenClawConfigPath(): string | null {
  const candidates = [
    resolve(homedir(), ".openclaw", "openclaw.json"),
    resolve(homedir(), ".clawd", "openclaw.json"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ── Check (read-only) ──

export function checkOpenClawIntegration(memoryEnginePath?: string): IntegrationStatus {
  const configPath = findOpenClawConfigPath();
  if (!configPath) {
    return { ok: true, openclawFound: false, configPath: "", drifts: [], hashMatch: true };
  }

  try {
    const oc = JSON.parse(readFileSync(configPath, "utf-8"));
    const expected = getExpectedBlock(memoryEnginePath ?? "");
    const drifts: IntegrationDrift[] = [];

    for (const [path, expectedValue] of Object.entries(expected)) {
      const actual = getNestedValue(oc, path);

      if (expectedValue === "__ABSENT__") {
        // Use "in" operator to detect presence of key (catches falsy values like "" and 0)
        const parentPath = path.split(".").slice(0, -1).join(".");
        const key = path.split(".").pop()!;
        const parent = parentPath ? getNestedValue(oc, parentPath) : oc;
        if (parent && typeof parent === "object" && key in (parent as Record<string, unknown>)) {
          drifts.push({
            field: path,
            expected: "(should not exist)",
            actual,
            severity: "warn",
          });
        }
        continue;
      }

      if (actual !== expectedValue) {
        drifts.push({
          field: path,
          expected: expectedValue,
          actual: actual ?? "(missing)",
          severity: "error",
        });
      }
    }

    // Check plugin load path includes memory-engine
    const loadPaths: string[] = oc?.plugins?.load?.paths ?? [];
    const hasMemoryEnginePath = loadPaths.some((p: string) => p.includes("memory-engine"));
    if (!hasMemoryEnginePath) {
      drifts.push({
        field: "plugins.load.paths",
        expected: "(includes memory-engine)",
        actual: loadPaths.length === 0 ? "(empty)" : loadPaths.join(", "),
        severity: "error",
      });
    }

    // Check plugins.allow includes threadclaw-memory
    const allowList: string[] = oc?.plugins?.allow ?? [];
    if (!allowList.includes("threadclaw-memory")) {
      drifts.push({
        field: "plugins.allow",
        expected: "(includes threadclaw-memory)",
        actual: allowList.length === 0 ? "(empty/missing)" : allowList.join(", "),
        severity: "error",
      });
    }

    const currentHash = computeIntegrationHash(oc);
    const ok = drifts.length === 0;

    // Compare current hash against the stored manifest hash to detect external drift
    let storedHash = "";
    try {
      storedHash = readManifest().integrationHash ?? "";
    } catch {
      // manifest may not exist yet
    }
    const hashMatch = storedHash ? currentHash === storedHash : ok;

    return { ok, openclawFound: true, configPath, drifts, hashMatch };
  } catch {
    return { ok: false, openclawFound: true, configPath, drifts: [{ field: "parse", expected: "valid JSON", actual: "parse error", severity: "error" }], hashMatch: false };
  }
}

// ── Apply (write, CLI-only) ──

export function applyOpenClawIntegration(memoryEnginePath: string): { applied: boolean; changes: string[] } {
  const configPath = findOpenClawConfigPath();
  if (!configPath) {
    return { applied: false, changes: ["OpenClaw not found"] };
  }

  try {
    const oc = JSON.parse(readFileSync(configPath, "utf-8"));
    const changes: string[] = [];

    // Ensure structure
    if (!oc.plugins) oc.plugins = {};
    if (!oc.plugins.slots) oc.plugins.slots = {};
    if (!oc.plugins.entries) oc.plugins.entries = {};
    if (!oc.plugins.load) oc.plugins.load = {};
    if (!oc.plugins.load.paths) oc.plugins.load.paths = [];
    if (!oc.agents) oc.agents = {};
    if (!oc.agents.defaults) oc.agents.defaults = {};

    // Remove memorySearch
    if (oc.agents.defaults.memorySearch) {
      delete oc.agents.defaults.memorySearch;
      changes.push("removed agents.defaults.memorySearch");
    }

    // Set slots
    if (oc.plugins.slots.contextEngine !== "threadclaw-memory") {
      oc.plugins.slots.contextEngine = "threadclaw-memory";
      changes.push("set plugins.slots.contextEngine = threadclaw-memory");
    }
    if (oc.plugins.slots.memory !== "none") {
      oc.plugins.slots.memory = "none";
      changes.push("set plugins.slots.memory = none");
    }

    // Disable memory-core
    if (!oc.plugins.entries["memory-core"]) oc.plugins.entries["memory-core"] = {};
    if (oc.plugins.entries["memory-core"].enabled !== false) {
      oc.plugins.entries["memory-core"].enabled = false;
      changes.push("disabled memory-core plugin");
    }

    // Enable threadclaw-memory with Evidence OS config
    if (!oc.plugins.entries["threadclaw-memory"]) oc.plugins.entries["threadclaw-memory"] = {};
    if (oc.plugins.entries["threadclaw-memory"].enabled !== true) {
      oc.plugins.entries["threadclaw-memory"].enabled = true;
      changes.push("enabled threadclaw-memory plugin");
    }

    // Ensure Evidence OS features are in plugin config (memory engine runs in OpenClaw's process,
    // so it reads from plugin config, not ThreadClaw's .env)
    if (!oc.plugins.entries["threadclaw-memory"].config) {
      oc.plugins.entries["threadclaw-memory"].config = {};
    }
    const memConfig = oc.plugins.entries["threadclaw-memory"].config;
    if (memConfig.relationsEnabled !== true) {
      memConfig.relationsEnabled = true;
      changes.push("enabled relationsEnabled in plugin config");
    }
    if (memConfig.relationsAwarenessEnabled !== true) {
      memConfig.relationsAwarenessEnabled = true;
      changes.push("enabled relationsAwarenessEnabled in plugin config");
    }
    if (memConfig.relationsClaimExtractionEnabled !== true) {
      memConfig.relationsClaimExtractionEnabled = true;
      changes.push("enabled relationsClaimExtractionEnabled in plugin config");
    }
    if (memConfig.relationsAttemptTrackingEnabled !== true) {
      memConfig.relationsAttemptTrackingEnabled = true;
      changes.push("enabled relationsAttemptTrackingEnabled in plugin config");
    }

    // Ensure load path
    const hasPath = oc.plugins.load.paths.some((p: string) => p.includes("memory-engine"));
    if (!hasPath && memoryEnginePath) {
      oc.plugins.load.paths.push(memoryEnginePath);
      changes.push("added memory-engine to plugins.load.paths");
    }

    // Ensure plugins.allow includes threadclaw-memory
    if (!Array.isArray(oc.plugins.allow)) oc.plugins.allow = [];
    if (!oc.plugins.allow.includes("threadclaw-memory")) {
      oc.plugins.allow.push("threadclaw-memory");
      changes.push("added threadclaw-memory to plugins.allow");
    }

    if (changes.length > 0) {
      // Atomic write: write to tmp file then rename to prevent corruption
      const tmpPath = configPath + ".tmp";
      writeFileSync(tmpPath, JSON.stringify(oc, null, 2) + "\n");
      renameSync(tmpPath, configPath);
    }

    return { applied: changes.length > 0, changes };
  } catch (e: any) {
    return { applied: false, changes: [`Error: ${e.message}`] };
  }
}

// ── Hash ──

export function computeIntegrationHash(oc: any): string {
  const managed = {
    contextEngine: oc?.plugins?.slots?.contextEngine,
    memory: oc?.plugins?.slots?.memory,
    memoryCoreEnabled: oc?.plugins?.entries?.["memory-core"]?.enabled,
    threadclawMemoryEnabled: oc?.plugins?.entries?.["threadclaw-memory"]?.enabled,
    hasMemorySearch: oc?.agents?.defaults?.memorySearch !== undefined,
    loadPaths: oc?.plugins?.load?.paths ?? [],
    allowList: oc?.plugins?.allow ?? [],
  };
  return sha256(JSON.stringify(managed));
}
