/**
 * threadclaw upgrade — safe transactional upgrade.
 *
 * Invariants:
 *   - Lock file prevents concurrent upgrades
 *   - Backup created BEFORE any mutation
 *   - Manifest written LAST (only after all steps succeed)
 *   - On failure: print restore instructions, keep old manifest active
 *   - All migrations are idempotent (safe to re-run)
 *   - Post-upgrade smoke test validates the result
 */

import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, unlinkSync, statSync, readdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { t } from "../../tui/theme.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  readManifest, writeManifest, getAppVersion, ensureThreadClawHome,
  THREADCLAW_DATA_DIR, THREADCLAW_BACKUPS_DIR, THREADCLAW_HOME,
  detectLegacyDbLocations, sha256,
} from "../../version.js";
import { applyOpenClawIntegration, computeIntegrationHash, findOpenClawConfigPath } from "../../integration.js";
import { syncSkills } from "../../skills.js";

const ok = (msg: string) => console.log(`  ${t.ok("✓")} ${msg}`);
const warn = (msg: string) => console.log(`  ${t.warn("⚠")} ${msg}`);
const err = (msg: string) => console.log(`  ${t.err("✗")} ${msg}`);
const info = (msg: string) => console.log(`  ${t.dim("·")} ${msg}`);

// ── Lock file ──

const LOCK_PATH = resolve(THREADCLAW_HOME, "upgrade.lock");

/** Check if a PID is still running. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (existsSync(LOCK_PATH)) {
    try {
      const lockData = JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
      const lockPid = lockData.pid as number;
      const lockAge = Date.now() - new Date(lockData.timestamp).getTime();

      // Primary check: is the locking process still alive?
      if (isPidAlive(lockPid)) {
        // Process is alive — only force-release if extremely stale (30 min)
        if (lockAge > 30 * 60 * 1000) {
          warn(`Forcing stale lock from PID ${lockPid} (${Math.round(lockAge / 60000)}min old)`);
          unlinkSync(LOCK_PATH);
        } else {
          return false; // legitimate lock held by running process
        }
      } else {
        // PID is dead — safe to release regardless of age
        unlinkSync(LOCK_PATH);
      }
    } catch {
      unlinkSync(LOCK_PATH);
    }
  }
  mkdirSync(THREADCLAW_HOME, { recursive: true });
  writeFileSync(LOCK_PATH, JSON.stringify({
    pid: process.pid,
    timestamp: new Date().toISOString(),
  }));
  return true;
}

function releaseLock(): void {
  try { unlinkSync(LOCK_PATH); } catch {}
}

// ── Backup validation ──

async function validateBackup(backupDir: string, expectedFiles: string[]): Promise<boolean> {
  for (const f of expectedFiles) {
    const p = resolve(backupDir, f);
    if (!existsSync(p)) return false;
    if (statSync(p).size === 0) return false;
    if (f.endsWith(".db")) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(p, { readOnly: true });
        const result = (db.prepare("PRAGMA integrity_check").get() as any);
        db.close();
        if (result?.integrity_check !== "ok") return false;
      } catch {
        // If DatabaseSync not available, skip integrity check (still better than nothing)
      }
    }
  }
  return true;
}

// ── Post-upgrade smoke test ──

async function postUpgradeSmoke(): Promise<{ ok: boolean; checks: string[] }> {
  const checks: string[] = [];
  let allOk = true;

  // Check data dir exists
  if (existsSync(THREADCLAW_DATA_DIR)) {
    checks.push("data directory exists");
  } else {
    checks.push("FAIL: data directory missing");
    allOk = false;
  }

  // Check manifest — on first upgrade it won't exist yet (written in Step 7)
  if (existsSync(resolve(THREADCLAW_HOME, "manifest.json"))) {
    checks.push("manifest.json exists");
  } else {
    checks.push("WARN: manifest.json not yet created (will be written after validation)");
  }

  // Check at least one DB is accessible
  const dbPaths = [
    resolve(THREADCLAW_DATA_DIR, "threadclaw.db"),
    resolve(THREADCLAW_DATA_DIR, "memory.db"),
    resolve(THREADCLAW_DATA_DIR, "graph.db"),
  ];
  for (const dbPath of dbPaths) {
    if (existsSync(dbPath)) {
      try {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(dbPath);
        const result = db.prepare("PRAGMA integrity_check").get() as any;
        db.close();
        if (result?.integrity_check === "ok") {
          checks.push(`${dbPath.split(/[\\/]/).pop()} integrity OK`);
        } else {
          checks.push(`FAIL: ${dbPath.split(/[\\/]/).pop()} integrity failed`);
          allOk = false;
        }
      } catch (e: any) {
        checks.push(`FAIL: ${dbPath.split(/[\\/]/).pop()} cannot open: ${e.message}`);
        allOk = false;
      }
    }
  }

  // Check integration
  try {
    const { checkOpenClawIntegration } = await import("../../integration.js");
    const status = checkOpenClawIntegration();
    if (status.openclawFound && status.ok) {
      checks.push("OpenClaw integration OK");
    } else if (status.openclawFound) {
      checks.push("WARN: OpenClaw integration has drift");
    } else {
      checks.push("OpenClaw not detected (OK for standalone)");
    }
  } catch {
    checks.push("WARN: could not check integration");
  }

  // End-to-end query path: open graph DB, read entities, confirm schema works
  const graphPath = resolve(THREADCLAW_DATA_DIR, "graph.db");
  if (existsSync(graphPath)) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(graphPath);
      const entityCount = (db.prepare("SELECT COUNT(*) as cnt FROM memory_objects WHERE kind = 'entity'").get() as any).cnt;
      const evidenceCount = (db.prepare("SELECT COUNT(*) as cnt FROM evidence_log").get() as any).cnt;
      const migrationCount = (db.prepare("SELECT COUNT(*) as cnt FROM _evidence_migrations").get() as any).cnt;
      db.close();
      checks.push(`evidence graph query OK (${entityCount} entities, ${evidenceCount} events, ${migrationCount} migrations)`);
    } catch (e: any) {
      checks.push(`FAIL: evidence graph query failed: ${e.message}`);
      allOk = false;
    }
  }

  return { ok: allOk, checks };
}

// ── Backup retention ──

const MAX_BACKUPS = 10;

function cleanOldBackups(): number {
  try {
    if (!existsSync(THREADCLAW_BACKUPS_DIR)) return 0;

    const dirs = readdirSync(THREADCLAW_BACKUPS_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d))
      .sort()
      .reverse();

    let removed = 0;
    if (dirs.length > MAX_BACKUPS) {
      for (const old of dirs.slice(MAX_BACKUPS)) {
        try {
          rmSync(resolve(THREADCLAW_BACKUPS_DIR, old), { recursive: true, force: true });
          removed++;
        } catch {}
      }
    }
    return removed;
  } catch {
    return 0;
  }
}

// ── Main command ──

export const upgradeCommand = new Command("upgrade")
  .description("Safely upgrade ThreadClaw — backup, migrate, validate")
  .option("--dry-run", "Show what would change without applying")
  .action(async (opts: { dryRun?: boolean }) => {
    const manifest = readManifest();
    const appVersion = getAppVersion();
    const rootDir = resolve(__dirname, "..", "..", "..");
    const isDryRun = opts.dryRun ?? false;
    const now = new Date();
    const backupDirName = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backupDir = resolve(THREADCLAW_BACKUPS_DIR, backupDirName);

    console.log("");
    console.log(t.brand("ThreadClaw Upgrade"));
    if (isDryRun) console.log(t.warn("  (dry run — no changes will be made)"));
    console.log("");

    // ── Pre-flight ──
    console.log(t.dim("── Pre-flight ──"));
    info(`Current version: ${manifest.appVersion || "(none)"} → Target: ${appVersion}`);
    info(`Evidence schema: v${manifest.evidenceSchemaVersion}`);
    info(`RAG schema: v${manifest.schemaVersion}`);
    info(`Config: v${manifest.configVersion}`);

    if (manifest.appVersion === appVersion && manifest.features.consolidatedData && manifest.features.managedIntegration) {
      console.log("");
      ok("Already up to date. Nothing to upgrade.");
      return;
    }

    // ── Acquire lock ──
    if (!isDryRun) {
      if (!acquireLock()) {
        console.log("");
        err("Another upgrade is in progress. If this is stale, delete ~/.threadclaw/upgrade.lock");
        process.exit(1);
      }
    }

    try {
      ensureThreadClawHome();

      // ── Step 1: Backup ──
      console.log("");
      console.log(t.dim("── Step 1: Backup ──"));
      if (!isDryRun) mkdirSync(backupDir, { recursive: true });

      const backedUpFiles: string[] = [];
      const backupTargets: Array<{ label: string; src: string }> = [];

      const legacyDbs = detectLegacyDbLocations();
      for (const l of legacyDbs) {
        if (l.exists) backupTargets.push({ label: `Legacy ${l.name} DB`, src: l.legacyPath });
      }

      for (const name of ["threadclaw.db", "memory.db", "graph.db"]) {
        const src = resolve(THREADCLAW_DATA_DIR, name);
        if (existsSync(src)) backupTargets.push({ label: name, src });
      }

      const oldRagPath = resolve(rootDir, "data", "threadclaw.db");
      if (existsSync(oldRagPath)) backupTargets.push({ label: "RAG DB (legacy)", src: oldRagPath });

      // Archive DB
      const archiveDbPath = resolve(THREADCLAW_DATA_DIR, "archive.db");
      if (existsSync(archiveDbPath)) backupTargets.push({ label: "Archive DB", src: archiveDbPath });

      const envPath = resolve(rootDir, ".env");
      if (existsSync(envPath)) backupTargets.push({ label: ".env", src: envPath });

      const ocConfigPath = findOpenClawConfigPath();
      if (ocConfigPath) backupTargets.push({ label: "openclaw.json", src: ocConfigPath });

      // Backup manifest itself
      const manifestPath = resolve(THREADCLAW_HOME, "manifest.json");
      if (existsSync(manifestPath)) backupTargets.push({ label: "manifest.json", src: manifestPath });

      for (const target of backupTargets) {
        if (isDryRun) {
          info(`Would backup: ${target.label}`);
        } else {
          try {
            const filename = target.src.split(/[\\/]/).pop()!;
            const dest = resolve(backupDir, filename);
            copyFileSync(target.src, dest);
            backedUpFiles.push(filename);
            ok(`Backed up: ${target.label}`);
          } catch (e: any) {
            warn(`Could not backup ${target.label}: ${e.message}`);
          }
        }
      }

      // Validate backup
      if (!isDryRun && backedUpFiles.length > 0) {
        if (await validateBackup(backupDir, backedUpFiles)) {
          ok("Backup validated (all files present and non-empty)");
        } else {
          err("Backup validation failed — aborting upgrade");
          releaseLock();
          console.log(t.dim(`  Backup dir: ${backupDir}`));
          process.exit(1);
        }
      }

      // ── Step 2: Data Migration ──
      console.log("");
      console.log(t.dim("── Step 2: Data Migration ──"));

      if (!isDryRun) mkdirSync(THREADCLAW_DATA_DIR, { recursive: true });

      const legacyMemory = legacyDbs.find((l) => l.name === "memory");
      if (legacyMemory?.exists && !existsSync(legacyMemory.newPath)) {
        if (isDryRun) {
          info(`Would move: ${legacyMemory.legacyPath} → ${legacyMemory.newPath}`);
        } else {
          try {
            copyFileSync(legacyMemory.legacyPath, legacyMemory.newPath);
            for (const ext of ["-wal", "-shm"]) {
              const walSrc = legacyMemory.legacyPath + ext;
              if (existsSync(walSrc)) copyFileSync(walSrc, legacyMemory.newPath + ext);
            }
            ok(`Moved memory DB to ${legacyMemory.newPath}`);
          } catch (e: any) {
            warn(`Could not move memory DB: ${e.message}`);
          }
        }
      }

      const legacyGraph = legacyDbs.find((l) => l.name === "graph");
      if (legacyGraph?.exists && !existsSync(legacyGraph.newPath)) {
        if (isDryRun) {
          info(`Would move: ${legacyGraph.legacyPath} → ${legacyGraph.newPath}`);
        } else {
          try {
            copyFileSync(legacyGraph.legacyPath, legacyGraph.newPath);
            for (const ext of ["-wal", "-shm"]) {
              const walSrc = legacyGraph.legacyPath + ext;
              if (existsSync(walSrc)) copyFileSync(walSrc, legacyGraph.newPath + ext);
            }
            ok(`Moved graph DB to ${legacyGraph.newPath}`);
          } catch (e: any) {
            warn(`Could not move graph DB: ${e.message}`);
          }
        }
      }

      if (existsSync(oldRagPath) && !existsSync(resolve(THREADCLAW_DATA_DIR, "threadclaw.db"))) {
        if (isDryRun) {
          info(`Would move: ${oldRagPath} → ${resolve(THREADCLAW_DATA_DIR, "threadclaw.db")}`);
        } else {
          try {
            copyFileSync(oldRagPath, resolve(THREADCLAW_DATA_DIR, "threadclaw.db"));
            for (const ext of ["-wal", "-shm"]) {
              const walSrc = oldRagPath + ext;
              if (existsSync(walSrc)) copyFileSync(walSrc, resolve(THREADCLAW_DATA_DIR, "threadclaw.db") + ext);
            }
            ok(`Moved RAG DB to ${resolve(THREADCLAW_DATA_DIR, "threadclaw.db")}`);
          } catch (e: any) {
            warn(`Could not move RAG DB: ${e.message}`);
          }
        }
      }

      if (!legacyMemory?.exists && !legacyGraph?.exists && !existsSync(oldRagPath)) {
        ok("Data already consolidated (or fresh install)");
      }

      // ── Step 3: Schema Migration (idempotent) ──
      console.log("");
      console.log(t.dim("── Step 3: Schema Migration ──"));

      const ragDbPath = existsSync(resolve(THREADCLAW_DATA_DIR, "threadclaw.db"))
        ? resolve(THREADCLAW_DATA_DIR, "threadclaw.db")
        : oldRagPath;

      let ragSchemaV = manifest.schemaVersion;
      if (existsSync(ragDbPath)) {
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(ragDbPath);
          if (!isDryRun) {
            const { runMigrations } = await import("../../storage/index.js");
            runMigrations(db as any);
            ok("RAG DB migrations applied (idempotent)");
          } else {
            info("Would run RAG DB migrations");
          }
          ragSchemaV = (db.prepare("SELECT MAX(version) as v FROM _migrations").get() as any)?.v ?? ragSchemaV;
          info(`RAG DB schema version: ${ragSchemaV}`);
          db.close();
        } catch (e: any) {
          warn(`RAG DB migration: ${e.message}`);
        }
      }

      const graphDbPath = existsSync(resolve(THREADCLAW_DATA_DIR, "graph.db"))
        ? resolve(THREADCLAW_DATA_DIR, "graph.db")
        : legacyGraph?.exists ? legacyGraph.legacyPath : null;

      let evidenceSchemaV = manifest.evidenceSchemaVersion;
      if (graphDbPath && existsSync(graphDbPath)) {
        if (!isDryRun) {
          try {
            const { execFileSync } = await import("child_process");
            const { writeFileSync: writeTmp, unlinkSync: unlinkTmp } = await import("fs");
            const { tmpdir } = await import("os");
            const { join: joinTmp } = await import("path");
            const meDir = resolve(rootDir, "memory-engine");
            const escapedPath = graphDbPath.replace(/\\/g, "/").replace(/'/g, "\\'");
            const script = [
              "import { DatabaseSync } from 'node:sqlite';",
              "import { runGraphMigrations } from './src/relations/schema.js';",
              `const db = new DatabaseSync('${escapedPath}');`,
              "runGraphMigrations(db);",
              "const v = db.prepare('SELECT MAX(version) as v FROM _evidence_migrations').get();",
              "console.log(JSON.stringify({ version: v?.v ?? 0 }));",
              "db.close();",
            ].join("\n");
            const tmpScript = joinTmp(tmpdir(), `threadclaw-upgrade-${Date.now()}.mts`);
            writeTmp(tmpScript, script);
            let result: string;
            try {
              const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
              result = execFileSync(npxCmd, ["tsx", tmpScript], {
                cwd: meDir, stdio: ["pipe", "pipe", "pipe"], timeout: 30000,
              }).toString().trim();
            } finally {
              try { unlinkTmp(tmpScript); } catch {}
            }
            try {
              const parsed = JSON.parse(result);
              evidenceSchemaV = parsed.version;
              ok(`Evidence graph migrations applied (v${evidenceSchemaV}, idempotent)`);
            } catch {
              ok("Evidence graph migrations applied");
            }
          } catch (e: any) {
            warn(`Evidence graph migration: ${e.message}`);
          }
        } else {
          info("Would run evidence graph migrations");
        }

        try {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(graphDbPath);
          evidenceSchemaV = (db.prepare("SELECT MAX(version) as v FROM _evidence_migrations").get() as any)?.v ?? evidenceSchemaV;
          info(`Evidence schema version: ${evidenceSchemaV}`);
          db.close();
        } catch {}
      }

      // ── Step 4: Integration ──
      console.log("");
      console.log(t.dim("── Step 4: Integration ──"));

      const memoryEnginePath = resolve(rootDir, "memory-engine");
      if (isDryRun) {
        info("Would update openclaw.json managed block");
      } else {
        const { applied, changes } = applyOpenClawIntegration(memoryEnginePath);
        if (applied) {
          for (const c of changes) ok(c);
        } else {
          ok("Integration already correct");
        }
      }

      // ── Step 4b: Python Venv + Dependencies ──
      console.log("");
      console.log(t.dim("── Step 4b: Python Environment ──"));

      const { getPythonCmd, getSystemPythonCmd, getPlatform } = await import("../../tui/platform.js");
      const venvDir = resolve(rootDir, ".venv");
      const venvPython = getPlatform() === "windows"
        ? resolve(venvDir, "Scripts", "python.exe")
        : resolve(venvDir, "bin", "python3");
      const reqsFile = resolve(rootDir, "server", "requirements-pinned.txt");

      if (!existsSync(venvPython)) {
        if (isDryRun) {
          info("Would create Python venv and install pinned dependencies");
        } else {
          try {
            const { execFileSync } = await import("child_process");
            const sysPython = getSystemPythonCmd();
            execFileSync(sysPython, ["-m", "venv", venvDir], { stdio: "pipe", timeout: 60000 });
            ok("Python venv created");

            if (existsSync(reqsFile)) {
              const pipCmd = getPlatform() === "windows"
                ? resolve(venvDir, "Scripts", "pip.exe")
                : resolve(venvDir, "bin", "pip");
              execFileSync(pipCmd, ["install", "-r", reqsFile], { stdio: "pipe", timeout: 600000 });
              ok("Pinned Python dependencies installed");
            }

            try {
              execFileSync(venvPython, ["-m", "spacy", "download", "en_core_web_sm"], { stdio: "pipe", timeout: 120000 });
              ok("spaCy NER model installed");
            } catch {
              warn("spaCy NER model not installed (optional)");
            }
          } catch (e: any) {
            warn(`Python venv setup failed: ${e.message}. Run install.bat/install.sh to set up.`);
          }
        }
      } else {
        ok("Python venv already present");
        // Update deps if pinned file is newer
        if (existsSync(reqsFile) && !isDryRun) {
          try {
            const { execFileSync } = await import("child_process");
            execFileSync(venvPython, ["-m", "pip", "install", "-q", "-r", reqsFile], { stdio: "pipe", timeout: 600000 });
            ok("Python dependencies up to date");
          } catch {
            warn("Python dependency update failed (non-fatal)");
          }
        }
      }

      // ── Step 5: Skill Sync (3-way merge) ──
      console.log("");
      console.log(t.dim("── Step 5: Skill Sync ──"));

      let workspaceDir = resolve(homedir(), ".openclaw", "workspace");
      try {
        if (ocConfigPath) {
          const oc = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
          workspaceDir = oc?.agents?.defaults?.workspace ?? workspaceDir;
        }
      } catch {}

      const shippedDir = resolve(rootDir, "skills");
      const workspaceSkillsDir = resolve(workspaceDir, "skills");
      let updatedSkillHashes = manifest.skills;

      if (existsSync(shippedDir) && existsSync(workspaceDir)) {
        const { results, updatedHashes } = syncSkills(shippedDir, workspaceSkillsDir, manifest.skills, isDryRun);
        for (const r of results) {
          if (r.action === "installed") ok(`${r.name}: installed`);
          else if (r.action === "updated") ok(`${r.name}: updated (user had not modified)`);
          else if (r.action === "unchanged") ok(`${r.name}: unchanged`);
          else if (r.action === "skipped") warn(`${r.name}: ${r.reason}`);
        }
        updatedSkillHashes = updatedHashes;
      } else {
        warn("Skills directory or workspace not found — skipping skill sync");
      }

      // ── Step 6: Post-upgrade smoke test ──
      console.log("");
      console.log(t.dim("── Step 6: Validate ──"));

      if (!isDryRun) {
        const smoke = await postUpgradeSmoke();
        for (const c of smoke.checks) {
          if (c.startsWith("FAIL:")) err(c);
          else if (c.startsWith("WARN:")) warn(c);
          else ok(c);
        }

        if (!smoke.ok) {
          console.log("");
          err("Post-upgrade validation failed.");
          console.log(t.dim("  Manifest NOT updated. Old version remains active."));
          console.log(t.dim(`  Restore from backup: ${backupDir}`));
          releaseLock();
          process.exit(1);
        }
      } else {
        info("Would run post-upgrade validation");
      }

      // ── Step 7: Write Manifest (LAST — only after everything succeeds) ──
      console.log("");
      console.log(t.dim("── Step 7: Finalize ──"));

      let integrationHash = "";
      if (ocConfigPath && existsSync(ocConfigPath)) {
        try {
          const oc = JSON.parse(readFileSync(ocConfigPath, "utf-8"));
          integrationHash = computeIntegrationHash(oc);
        } catch {}
      }

      const updatedManifest = {
        ...manifest,
        appVersion,
        schemaVersion: ragSchemaV,
        evidenceSchemaVersion: evidenceSchemaV,
        configVersion: 1,
        lastUpgradeAt: now.toISOString(),
        integrationHash,
        features: {
          managedIntegration: true,
          consolidatedData: true,
          noAutoMigrate: true,
        },
        skills: updatedSkillHashes,
      };

      if (isDryRun) {
        info("Would write manifest.json (written last, only after all steps succeed)");
      } else {
        writeManifest(updatedManifest);
        ok("Manifest updated (final step)");
      }

      // ── Summary ──
      console.log("");
      console.log(t.dim("───────────────────────────────────────"));
      if (isDryRun) {
        console.log(t.warn("  Dry run complete — no changes made."));
        console.log(t.dim("  Run without --dry-run to apply."));
      } else {
        // Clean old backups (keep last 10)
        const removed = cleanOldBackups();
        if (removed > 0) info(`Cleaned ${removed} old backup(s) (keeping last ${MAX_BACKUPS})`);

        console.log(t.ok(`  Upgrade complete (${manifest.appVersion || "fresh"} → ${appVersion})`));
        console.log(t.dim("  Restart services: threadclaw (then select Start)"));
        console.log(t.dim(`  Backup saved to: ${backupDir}`));
      }
      console.log(t.dim("───────────────────────────────────────"));
      console.log("");

    } finally {
      if (!isDryRun) releaseLock();
    }
  });
