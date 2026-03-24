import prompts from "prompts";
import ora from "ora";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
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
  console.log(t.warn("  This will completely remove ThreadClaw and revert all changes"));
  console.log(t.warn("  made to OpenClaw. Source files preserved for reinstall.\n"));
  console.log(t.warn("  Will remove: dependencies, Python venv, config, evidence graph DB,"));
  console.log(t.warn("  credentials, global command, model cache, OpenClaw integration.\n"));

  let cancelled = false;
  const onCancel = () => { cancelled = true; };

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: t.err("Are you sure you want to uninstall ThreadClaw?"),
    initial: false,
  }, { onCancel });

  if (!confirm || cancelled) {
    console.log(t.dim("\n  Cancelled.\n"));
    return;
  }

  // Ask about data
  const { deleteData } = await prompts({
    type: "confirm",
    name: "deleteData",
    message: "Delete the database and all ingested documents?",
    initial: false,
  }, { onCancel });

  if (cancelled) {
    console.log(t.dim("\n  Cancelled.\n"));
    return;
  }

  await performUninstall({ deleteData });

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
    resolve(root, "server", "config.json"),
    resolve(root, "logs"),
    resolve(root, ".models.pid"),
    resolve(root, ".threadclaw.pid"),
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

  console.log(t.ok("  OpenClaw has been restored to its original state."));
  console.log(t.ok("  All ThreadClaw dependencies and configuration removed."));
  console.log("");

  // Check if distribution package exists
  const distDir = resolve(homedir(), "Documents", "threadclaw");
  if (existsSync(distDir)) {
    console.log(t.dim("  Installation package preserved at:"));
    console.log(t.path(`  ${distDir}`));
    console.log(t.dim("  Run install.bat / install.sh from there to reinstall.\n"));
  }

  if (!deleteData) {
    console.log(t.dim("  Data preserved. To fully clean up later:"));
    console.log(t.dim("  • HuggingFace model cache:"));
    console.log(t.path(`    ${resolve(homedir(), ".cache", "huggingface", "hub")}`));
    console.log("");
  }
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
