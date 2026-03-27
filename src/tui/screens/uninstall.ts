import prompts from "prompts";
import ora from "ora";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { homedir } from "os";
import { section, t, clearScreen } from "../theme.js";
import {
  getPlatform,
  getRootDir,
  findOpenClaw,
  readConfig,
  stopServices,
  removeWindowsServices,
  removeLinuxServices,
  removeMacServices,
  getApiPort,
  getModelPort,
} from "../platform.js";

export async function runUninstall(): Promise<void> {
  clearScreen();
  console.log(section("Uninstall ThreadClaw"));
  console.log(t.warn("  This will remove ThreadClaw runtime and data:"));
  console.log(t.warn("  • All dependencies (node_modules, .venv, dist)"));
  console.log(t.warn("  • All config (.env, config.json, manifest)"));
  console.log(t.warn("  • All data (databases, evidence graph, backups)"));
  console.log(t.warn("  • Downloaded model cache (~2-6 GB)"));
  console.log(t.warn("  • Global command and PATH entry"));
  console.log(t.warn("  • OpenClaw integration\n"));
  console.log(t.dim("  Source code (git repo) will be preserved. You will be shown"));
  console.log(t.dim("  instructions to remove it after uninstall completes.\n"));

  let cancelled = false;
  const onCancel = () => { cancelled = true; };

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: t.err("Are you sure you want to completely uninstall ThreadClaw?"),
    initial: false,
  }, { onCancel });

  if (!confirm || cancelled) {
    console.log(t.dim("\n  Cancelled.\n"));
    return;
  }

  await performUninstall({ deleteData: true });

  // Wait for user to read
  const { selectMenu } = await import("../menu.js");
  await selectMenu([{ label: "Done", value: "done", color: t.dim }]);
}

export async function performUninstall(options: { deleteData: boolean }): Promise<void> {
  const { deleteData } = options;

  const root = getRootDir();
  const plat = getPlatform();
  let sp: ReturnType<typeof ora>;

  // ── 1. Stop services ──
  sp = ora("Stopping services...").start();
  stopServices();
  // Wait for ports to close
  await waitForPortClosed(getApiPort(), 20000);
  await waitForPortClosed(getModelPort(), 30000);
  if (plat === "windows") {
    removeWindowsServices();
  } else if (plat === "linux") {
    try { removeLinuxServices(); } catch {}
  } else if (plat === "mac") {
    try { removeMacServices(); } catch {}
  }
  sp.succeed("Services stopped");

  // ── 2. Revert OpenClaw configuration ──
  const openclawDir = findOpenClaw();
  if (openclawDir) {
    sp = ora("Reverting OpenClaw configuration...").start();
    const revertLog: string[] = [];

    // Remove all shipped skill directories (current + legacy names)
    for (const skillName of ["knowledge", "threadclaw-knowledge", "threadclaw-evidence"]) {
      const dir = resolve(openclawDir, "workspace", "skills", skillName);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        revertLog.push(`Removed ${skillName} skill`);
      }
    }

    // Revert openclaw.json
    const configPath = resolve(openclawDir, "openclaw.json");
    if (existsSync(configPath)) {
      try {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));

        // Remove threadclaw-memory from plugin load paths
        if (oc.plugins?.load?.paths) {
          oc.plugins.load.paths = oc.plugins.load.paths.filter(
            (p: string) => !p.includes("threadclaw")
          );
          if (oc.plugins.load.paths.length === 0) delete oc.plugins.load.paths;
          revertLog.push("Removed threadclaw from plugin load paths");
        }

        // Reset context engine slot — remove threadclaw-memory
        if (oc.plugins?.slots?.contextEngine === "threadclaw-memory") {
          delete oc.plugins.slots.contextEngine;
          revertLog.push("Cleared contextEngine slot");
        }

        // Restore memory slot to default (remove "none" override)
        if (oc.plugins?.slots?.memory === "none") {
          delete oc.plugins.slots.memory;
          revertLog.push("Restored memory slot to default");
        }

        // Clean up empty slots object
        if (oc.plugins?.slots && Object.keys(oc.plugins.slots).length === 0) {
          delete oc.plugins.slots;
        }

        // Re-enable memory-core plugin
        if (oc.plugins?.entries?.["memory-core"]?.enabled === false) {
          oc.plugins.entries["memory-core"].enabled = true;
          revertLog.push("Re-enabled memory-core plugin");
        }

        // Remove threadclaw-memory plugin entry
        if (oc.plugins?.entries?.["threadclaw-memory"]) {
          delete oc.plugins.entries["threadclaw-memory"];
          revertLog.push("Removed threadclaw-memory plugin entry");
        }

        // Remove threadclaw-memory install record
        if (oc.plugins?.installs?.["threadclaw-memory"]) {
          delete oc.plugins.installs["threadclaw-memory"];
          revertLog.push("Removed threadclaw-memory install record");
        }

        // Clean up empty installs object
        if (oc.plugins?.installs && Object.keys(oc.plugins.installs).length === 0) {
          delete oc.plugins.installs;
        }

        // Remove threadclaw-memory from plugins.allow
        if (Array.isArray(oc.plugins?.allow)) {
          oc.plugins.allow = oc.plugins.allow.filter((id: string) => id !== "threadclaw-memory");
          if (oc.plugins.allow.length === 0) delete oc.plugins.allow;
          revertLog.push("Removed threadclaw-memory from plugins.allow");
        }

        // Remove memorySearch if present (belt & suspenders)
        if (oc.agents?.defaults?.memorySearch) {
          delete oc.agents.defaults.memorySearch;
          revertLog.push("Removed memorySearch config");
        }

        writeFileSync(configPath, JSON.stringify(oc, null, 2) + "\n");
      } catch {}
    }

    sp.succeed(`OpenClaw reverted (${revertLog.length} changes)`);
    for (const log of revertLog) {
      console.log(`    ${t.dim("•")} ${log}`);
    }
  }

  // ── 3. Delete data (if confirmed) ──
  if (deleteData) {
    sp = ora("Deleting database and data...").start();
    const dataDir = resolve(root, "data");
    if (existsSync(dataDir)) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    sp.succeed("Data deleted");
  } else {
    console.log(t.dim(`  Data preserved at: ${resolve(root, "data")}`));
  }

  // ── 4. Read model config before deletion (for cache cleanup) ──
  let modelIds: { embed?: string; rerank?: string } = {};
  try {
    const config = readConfig();
    if (config) {
      modelIds = { embed: config.embed_model, rerank: config.rerank_model };
    }
  } catch {}

  // ── 5. Remove ThreadClaw runtime files ──
  sp = ora("Removing ThreadClaw files...").start();
  const toDelete = [
    resolve(root, "node_modules"),
    resolve(root, ".venv"),
    resolve(root, "dist"),
    resolve(root, "memory-engine", "node_modules"),
    resolve(root, ".env"),
    resolve(root, ".env.bak"),
    resolve(root, "server", "config.json"),
    resolve(root, "logs"),
    resolve(root, ".models.pid"),
    resolve(root, ".threadclaw.pid"),
    resolve(root, ".install-complete"),
    resolve(root, "node_modules", ".install-ok"),
  ];
  for (const p of toDelete) {
    if (existsSync(p)) {
      try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }

  if (deleteData) {
    // Remove evidence graph database (check both old and new locations)
    for (const graphDbPath of [
      resolve(homedir(), ".threadclaw", "data", "graph.db"),
      resolve(homedir(), ".openclaw", "threadclaw-graph.db"),
    ]) {
      for (const ext of ["", "-wal", "-shm"]) {
        const p = graphDbPath + ext;
        if (existsSync(p)) {
          try { rmSync(p, { force: true }); } catch {}
        }
      }
    }

    // Remove memory engine database
    for (const memDbPath of [
      resolve(homedir(), ".threadclaw", "data", "memory.db"),
      resolve(homedir(), ".openclaw", "threadclaw-memory.db"),
    ]) {
      for (const ext of ["", "-wal", "-shm"]) {
        const p = memDbPath + ext;
        if (existsSync(p)) {
          try { rmSync(p, { force: true }); } catch {}
        }
      }
    }

    // Remove ~/.threadclaw directory (includes DBs, manifest, backups, credentials)
    const threadclawHome = resolve(homedir(), ".threadclaw");
    if (existsSync(threadclawHome)) {
      try { rmSync(threadclawHome, { recursive: true, force: true }); } catch {}
    }
  } else {
    // Data preserved — only remove runtime config, not DBs or manifest
    const runtimeFiles = [
      resolve(homedir(), ".threadclaw", "relations-terms.json"),
    ];
    for (const p of runtimeFiles) {
      if (existsSync(p)) {
        try { rmSync(p, { force: true }); } catch {}
      }
    }
  }

  // Remove global command
  if (plat === "windows") {
    const cmdDir = resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "ThreadClaw");
    if (existsSync(cmdDir)) {
      try { rmSync(cmdDir, { recursive: true, force: true }); } catch {}
    }
    // Remove ThreadClaw from user PATH registry entry
    try {
      const regOut = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "PATH"], { stdio: "pipe", timeout: 5000 }).toString();
      const match = regOut.match(/PATH\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
      if (match) {
        const currentPath = match[1].trim();
        // Match the exact ThreadClaw directory path, not just a substring
        const tcDir = resolve(process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData", "Local"), "ThreadClaw").toLowerCase();
        const cleaned = currentPath
          .split(";")
          .filter((p) => p.toLowerCase() !== tcDir)
          .join(";");
        if (cleaned !== currentPath) {
          execFileSync("setx", ["PATH", cleaned], { stdio: "pipe", timeout: 5000 });
        }
      }
    } catch {}
  } else {
    const symlink = resolve(homedir(), ".local", "bin", "threadclaw");
    if (existsSync(symlink)) {
      try { rmSync(symlink, { force: true }); } catch {}
    }
  }

  sp.succeed("ThreadClaw files removed");

  // ── 6. Clean up model cache (ThreadClaw-specific models only) ──
  if (deleteData && (modelIds.embed || modelIds.rerank)) {
    const hfHub = process.env.HF_HUB_CACHE
      ?? (process.env.HF_HOME ? resolve(process.env.HF_HOME, "hub") : resolve(homedir(), ".cache", "huggingface", "hub"));
    if (existsSync(hfHub)) {
      const modelDirs: string[] = [];
      for (const id of [modelIds.embed, modelIds.rerank]) {
        if (!id) continue;
        const cacheName = `models--${id.replace(/\//g, "--")}`;
        const cachePath = resolve(hfHub, cacheName);
        if (existsSync(cachePath)) modelDirs.push(cachePath);
      }
      if (modelDirs.length > 0) {
        sp = ora("Removing downloaded model cache...").start();
        for (const dir of modelDirs) {
          try { rmSync(dir, { recursive: true, force: true }); } catch {}
        }
        sp.succeed(`Removed ${modelDirs.length} cached model(s)`);
      }
    }
  }

  // ── 7. Summary ──
  console.log(section("Uninstall Complete"));

  console.log(t.ok("  ThreadClaw has been completely removed."));
  console.log(t.ok("  OpenClaw restored to its original state."));
  if (deleteData) {
    console.log(t.ok("  All data, config, dependencies, and model cache deleted."));
  } else {
    console.log(t.ok("  Config and dependencies removed. Data preserved."));
  }
  console.log("");
  console.log(t.dim("  Source code (git repo) preserved at:"));
  console.log(t.dim(`    ${root}`));
  console.log("");
  console.log(t.dim("  To remove source code completely:"));
  if (plat === "windows") {
    console.log(t.dim(`    rmdir /s /q "${root}"`));
    console.log(t.dim(`    (PowerShell: Remove-Item -Recurse -Force "${root}")`));
  } else {
    console.log(t.dim(`    rm -rf "${root}"`));
  }
  console.log("");
  console.log(t.dim("  To reinstall instead: run install.bat (Windows) or install.sh (Linux/macOS)"));
  console.log("");
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      await new Promise((r) => setTimeout(r, 300));
    } catch {
      return;
    }
  }
}
