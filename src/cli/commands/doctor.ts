/**
 * threadclaw doctor — diagnose installation health.
 *
 * Checks versions, data integrity, OpenClaw integration, services,
 * skills, and compatibility. Never writes. Never fixes.
 */

import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { t } from "../../tui/theme.js";
import { getApiPort, getModelPort } from "../../tui/platform.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  readManifest, getAppVersion, detectLegacyDbLocations,
  detectVersionMismatches, THREADCLAW_DATA_DIR, THREADCLAW_HOME,
} from "../../version.js";
import { checkOpenClawCompat, checkNodeCompat, getOpenClawVersion } from "../../compatibility.js";
import { checkOpenClawIntegration } from "../../integration.js";
import { sha256 } from "../../version.js";

const ok = (msg: string) => console.log(`  ${t.ok("✓")} ${msg}`);
const warn = (msg: string) => console.log(`  ${t.warn("⚠")} ${msg}`);
const err = (msg: string) => console.log(`  ${t.err("✗")} ${msg}`);
const dim = (msg: string) => console.log(`    ${t.dim(msg)}`);

export const doctorCommand = new Command("doctor")
  .description("Diagnose ThreadClaw installation health")
  .option("--json", "Output as JSON")
  .option("--fix", "Alias for 'threadclaw integrate --apply'")
  .action(async (opts: { json?: boolean; fix?: boolean }) => {
    // --fix: alias for integrate --apply
    if (opts.fix) {
      try {
        const { applyOpenClawIntegration } = await import("../../integration.js");
        const rootDir = resolve(__dirname, "..", "..", "..");
        const memoryEnginePath = resolve(rootDir, "memory-engine");
        applyOpenClawIntegration(memoryEnginePath);
        console.log(t.ok("Integration applied successfully."));
      } catch (e) {
        console.error(t.err(`Fix failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      return;
    }

    const manifest = readManifest();
    const appVersion = getAppVersion();
    let totalPass = 0;
    let totalWarn = 0;
    let totalFail = 0;

    const pass = (msg: string) => { ok(msg); totalPass++; };
    const warning = (msg: string) => { warn(msg); totalWarn++; };
    const fail = (msg: string) => { err(msg); totalFail++; };

    console.log("");
    console.log(t.brand("ThreadClaw Doctor"));
    console.log("");

    // ── Version ──
    console.log(t.dim("── Version ──"));
    pass(`App: ${appVersion} (installed: ${manifest.appVersion})`);

    if (manifest.appVersion !== "0.0.0" && manifest.appVersion !== appVersion) {
      warning(`Version mismatch: installed ${manifest.appVersion}, running ${appVersion}. Run 'threadclaw upgrade'.`);
    }

    console.log("");

    // ── Data ──
    console.log(t.dim("── Data ──"));

    // Check new data locations
    const dbChecks = [
      { name: "RAG DB", path: resolve(THREADCLAW_DATA_DIR, "threadclaw.db") },
      { name: "Memory DB", path: resolve(THREADCLAW_DATA_DIR, "memory.db") },
      { name: "Graph DB", path: resolve(THREADCLAW_DATA_DIR, "graph.db") },
    ];
    for (const db of dbChecks) {
      if (existsSync(db.path)) {
        const sizeMb = (statSync(db.path).size / 1024 / 1024).toFixed(1);
        pass(`${db.name}: ${db.path} (${sizeMb} MB)`);
      } else {
        // Check if it's still in legacy location
        const legacy = detectLegacyDbLocations().find((l) => l.name === db.name.split(" ")[0].toLowerCase());
        if (legacy?.exists) {
          warning(`${db.name}: still in legacy location (${legacy.legacyPath}). Run 'threadclaw upgrade' to consolidate.`);
        } else {
          // Check old install-relative path for RAG DB
          const rootDir = resolve(__dirname, "..", "..", "..");
          const oldRagPath = resolve(rootDir, "data", "threadclaw.db");
          if (db.name === "RAG DB" && existsSync(oldRagPath)) {
            const sizeMb = (statSync(oldRagPath).size / 1024 / 1024).toFixed(1);
            warning(`${db.name}: in legacy location (${oldRagPath}, ${sizeMb} MB). Run 'threadclaw upgrade' to consolidate.`);
          } else {
            fail(`${db.name}: not found at ${db.path}`);
          }
        }
      }
    }

    // Check legacy locations
    const legacyDbs = detectLegacyDbLocations().filter((l) => l.exists);
    if (legacyDbs.length > 0) {
      for (const l of legacyDbs) {
        warning(`Legacy ${l.name} DB at ${l.legacyPath} — should be migrated to ${l.newPath}`);
      }
    } else {
      pass("No legacy DB locations detected");
    }

    // DB integrity (if accessible)
    for (const db of dbChecks) {
      const checkPath = existsSync(db.path) ? db.path : null;
      if (checkPath) {
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const conn = new DatabaseSync(checkPath);
          const result = conn.prepare("PRAGMA integrity_check").get() as any;
          if (result?.integrity_check === "ok") {
            pass(`${db.name} integrity: OK`);
          } else {
            fail(`${db.name} integrity: ${result?.integrity_check}`);
          }
          conn.close();
        } catch (e: any) {
          warning(`${db.name} integrity check skipped: ${e.message}`);
        }
      }
    }

    console.log("");

    // ── OpenClaw Integration ──
    console.log(t.dim("── OpenClaw Integration ──"));
    const integration = checkOpenClawIntegration();

    if (!integration.openclawFound) {
      warning("OpenClaw not detected");
    } else {
      pass(`OpenClaw found: ${integration.configPath}`);

      if (integration.ok) {
        pass("Integration: all managed fields correct");
      } else {
        for (const drift of integration.drifts) {
          if (drift.severity === "error") {
            fail(`${drift.field}: expected ${JSON.stringify(drift.expected)}, got ${JSON.stringify(drift.actual)}`);
          } else {
            warning(`${drift.field}: ${JSON.stringify(drift.actual)} (expected absent)`);
          }
        }
        dim("Run 'threadclaw integrate --apply' to fix integration drift.");
      }
    }

    console.log("");

    // ── Services ──
    console.log(t.dim("── Services ──"));
    for (const [name, port] of [["Model server", getModelPort()], ["RAG API", getApiPort()]] as const) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          pass(`${name} (port ${port}): running`);
        } else {
          warning(`${name} (port ${port}): responded but unhealthy (status ${res.status})`);
        }
      } catch {
        warning(`${name} (port ${port}): not running`);
      }
    }

    console.log("");

    // ── Skills ──
    console.log(t.dim("── Skills ──"));
    const ocConfigPath = resolve(homedir(), ".openclaw", "openclaw.json");
    let workspaceDir = resolve(homedir(), ".openclaw", "workspace");
    try {
      if (existsSync(ocConfigPath)) {
        const oc = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
        workspaceDir = oc?.agents?.defaults?.workspace ?? workspaceDir;
      }
    } catch {}

    for (const skill of ["threadclaw-evidence", "threadclaw-knowledge"]) {
      const skillPath = resolve(workspaceDir, "skills", skill, "SKILL.md");
      const rootDir = resolve(__dirname, "..", "..", "..");
      const shippedPath = resolve(rootDir, "skills", skill, "SKILL.md");

      if (!existsSync(skillPath)) {
        fail(`${skill}: not installed at ${skillPath}`);
        continue;
      }

      const installedHash = sha256(readFileSync(skillPath, "utf-8"));
      const manifestHash = manifest.skills?.[`${skill}/SKILL.md`] ?? "";

      if (existsSync(shippedPath)) {
        const shippedHash = sha256(readFileSync(shippedPath, "utf-8"));
        if (installedHash === shippedHash) {
          pass(`${skill}: installed, up to date`);
        } else if (installedHash === manifestHash) {
          warning(`${skill}: outdated (newer version available). Run 'threadclaw upgrade'.`);
        } else {
          warning(`${skill}: user-modified (upgrade will preserve your changes)`);
        }
      } else {
        pass(`${skill}: installed`);
      }
    }

    console.log("");

    // ── Compatibility ──
    console.log(t.dim("── Compatibility ──"));
    const nodeCheck = checkNodeCompat();
    if (nodeCheck.ok) {
      pass(`Node.js: v${nodeCheck.version} (required: ${nodeCheck.required})`);
    } else {
      fail(`Node.js: v${nodeCheck.version} (required: ${nodeCheck.required})`);
    }

    const ocVersion = getOpenClawVersion();
    const compat = checkOpenClawCompat(appVersion, ocVersion);
    if (compat.level === "supported") {
      pass(`OpenClaw: ${ocVersion} (${compat.reason})`);
    } else if (compat.level === "unknown") {
      warning(`OpenClaw: ${compat.reason}`);
    } else {
      fail(`OpenClaw: ${compat.reason}`);
    }

    // ── Manifest ──
    console.log("");
    console.log(t.dim("── Manifest ──"));
    if (existsSync(resolve(THREADCLAW_HOME, "manifest.json"))) {
      pass(`Manifest: ${resolve(THREADCLAW_HOME, "manifest.json")}`);
      if (manifest.features.managedIntegration) {
        pass("Feature: managed integration (check-only startup)");
      } else {
        warning("Feature: legacy integration (auto-fix startup). Run 'threadclaw upgrade' to switch.");
      }
      if (manifest.features.consolidatedData) {
        pass("Feature: consolidated data (~/.threadclaw/data/)");
      } else {
        warning("Feature: legacy data locations. Run 'threadclaw upgrade' to consolidate.");
      }
    } else {
      warning("No manifest found. Run 'threadclaw upgrade' to initialize.");
    }

    // ── Summary ──
    console.log("");
    console.log(t.dim("───────────────────────────────────────"));
    console.log(`  ${t.ok(String(totalPass))} passed, ${t.warn(String(totalWarn))} warnings, ${t.err(String(totalFail))} failures`);
    console.log(t.dim("───────────────────────────────────────"));
    console.log("");

    if (totalFail > 0) {
      process.exit(1);
    }
  });
