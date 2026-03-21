#!/usr/bin/env node

import ora from "ora";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import { banner, t, clearScreen } from "./theme.js";
import { detectTerminalCapabilities, setTerminalCapabilities } from "./capabilities.js";
import { selectMenu } from "./menu.js";
import { getRootDir, readConfig, checkServices, getPlatform, getModelBaseUrl, getApiBaseUrl } from "./platform.js";
import { performServiceAction } from "./service-actions.js";
import { detectGpu } from "./models.js";
import { showStatus } from "./screens/status.js";
import { runInstall } from "./screens/install.js";
import { runConfigure } from "./screens/configure.js";
import { manageServices } from "./screens/services.js";
import { showSources } from "./screens/sources.js";
import { runUninstall } from "./screens/uninstall.js";

async function launchLegacyTui(): Promise<void> {
  let root = getRootDir();
  let hasNodeModules = existsSync(resolve(root, "node_modules"));

  if (!readConfig(root) && !hasNodeModules) {
    await runInstall();
    root = getRootDir();
    hasNodeModules = existsSync(resolve(root, "node_modules"));
    if (!readConfig(root) && !hasNodeModules) return;
  }

  let autoStart = checkAutoStartup();

  while (true) {
    root = getRootDir();
    const config = readConfig(root);

    clearScreen();
    console.log(banner());

    const svc = await checkServicesFast();
    const gpu = detectGpu();
    const modelsIcon = svc.models ? t.ok("●") : t.err("○");
    const clawcoreIcon = svc.clawcore ? t.ok("●") : t.err("○");
    const embedName = config?.embed_model?.split("/").pop() ?? "not configured";
    const rerankName = config?.rerank_model?.split("/").pop() ?? "not configured";

    console.log(`  ${modelsIcon} Models ${t.dim("|")} ${clawcoreIcon} ClawCore`);
    console.log(`  ${t.dim("Embed:")} ${t.value(embedName)}`);
    console.log(`  ${t.dim("Rerank:")} ${t.value(rerankName)}`);

    let envContent = "";
    try {
      const envPath = resolve(root, ".env");
      if (existsSync(envPath)) envContent = readFileSync(envPath, "utf-8");
    } catch {}

    const deepExEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true";
    if (deepExEnabled) {
      const explicitModel = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL=(.+)/)?.[1]?.trim();
      const explicitProvider = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER=(.+)/)?.[1]?.trim();
      let deepModelLabel: string;

      if (explicitModel) {
        const providerTag = explicitProvider ? `${explicitProvider}/` : "";
        deepModelLabel = t.value(`${providerTag}${explicitModel}`);
      } else {
        let openclawModel = "";
        try {
          const openclawConfigPath = resolve(root, "..", "..", "openclaw.json");
          if (existsSync(openclawConfigPath)) {
            const openclawConfig = JSON.parse(readFileSync(openclawConfigPath, "utf-8"));
            openclawModel = openclawConfig?.agents?.defaults?.model?.primary ?? "";
          }
        } catch {}

        if (openclawModel) {
          const shortName = openclawModel.split("/").pop() ?? openclawModel;
          deepModelLabel = t.value(shortName) + t.dim(" (via OpenClaw)");
        } else {
          deepModelLabel = t.dim("summary model fallback");
        }
      }

      console.log(`  ${t.dim("Deep Extract:")} ${deepModelLabel}`);
    }

    let expansionLabel = t.dim("off");
    const expansionEnabled = envContent.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1];
    const expansionModel = envContent.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim();
    if (expansionEnabled === "true" && expansionModel) expansionLabel = t.value(expansionModel);
    console.log(`  ${t.dim("Query Expansion:")} ${expansionLabel}`);

    const doclingDevice = config?.docling_device ?? "off";
    const doclingLabel = doclingDevice === "off"
      ? t.dim("off")
      : doclingDevice === "cpu"
        ? t.ok("o CPU")
        : t.warn("o GPU");
    console.log(`  ${t.dim("OCR/Docling:")} ${doclingLabel}`);

    const watchPaths = envContent.match(/WATCH_PATHS=(.+)/)?.[1]?.trim();
    const watchCount = watchPaths ? watchPaths.split(",").filter(Boolean).length : 0;
    const watchLabel = watchCount > 0 ? t.ok(`${watchCount} paths`) : t.dim("off");
    console.log(`  ${t.dim("File Watcher:")} ${watchLabel}`);

    const sourceLines: string[] = [];
    if (watchCount > 0) sourceLines.push(`${t.ok("●")} Local Files`);
    if (envContent.match(/OBSIDIAN_ENABLED=true/)) sourceLines.push(`${t.ok("●")} Obsidian`);
    if (envContent.match(/GDRIVE_ENABLED=true/)) sourceLines.push(`${t.ok("●")} Google Drive`);
    if (envContent.match(/ONEDRIVE_ENABLED=true/)) sourceLines.push(`${t.ok("●")} OneDrive`);
    if (envContent.match(/NOTION_ENABLED=true/)) sourceLines.push(`${t.ok("●")} Notion`);
    if (envContent.match(/APPLE_NOTES_ENABLED=true/)) sourceLines.push(`${t.ok("●")} Apple Notes`);

    if (sourceLines.length > 0) {
      console.log(`  ${t.dim("Sources:")} ${sourceLines.join(t.dim("  |  "))}`);
    } else {
      console.log(`  ${t.dim("Sources:")} ${t.dim("none configured")}`);
    }

    let evidenceLabel = t.dim("off");
    const relationsEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_ENABLED=(\w+)/)?.[1];
    const awarenessEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED=(\w+)/)?.[1];
    const claimsEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED=(\w+)/)?.[1];
    const attemptEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED=(\w+)/)?.[1];
    if (relationsEnabled === "true") {
      const features = ["entities"];
      if (awarenessEnabled === "true") features.push("awareness");
      if (claimsEnabled === "true") features.push("claims");
      if (attemptEnabled === "true") features.push("attempts");
      if (deepExEnabled) features.push("deep");
      evidenceLabel = t.ok(`on (${features.join(", ")})`);
    }

    let evidenceDbInfo = "";
    try {
      const graphPath = resolve(homedir(), ".clawcore", "data", "graph.db");
      if (existsSync(graphPath)) {
        const size = statSync(graphPath).size;
        try {
          const { getGraphDb } = await import("../storage/graph-sqlite.js");
          const db = getGraphDb(graphPath);
          const entities = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as { c: number }).c;
          const claims = (db.prepare("SELECT COUNT(*) as c FROM claims WHERE status='active'").get() as { c: number }).c;
          const loops = (db.prepare("SELECT COUNT(*) as c FROM open_loops WHERE status IN ('open','blocked')").get() as { c: number }).c;
          const parts: string[] = [`${(size / 1024 / 1024).toFixed(1)} MB`];
          if (entities > 0) parts.push(`${entities} entities`);
          if (claims > 0) parts.push(`${claims} claims`);
          if (loops > 0) parts.push(`${loops} loops`);
          evidenceDbInfo = t.dim(` ${parts.join("  ")}`);
        } catch {
          evidenceDbInfo = t.dim(` ${(size / 1024 / 1024).toFixed(1)} MB`);
        }
      }
    } catch {}
    console.log(`  ${t.dim("Evidence OS:")} ${evidenceLabel}${evidenceDbInfo}`);

    try {
      const trackerFile = resolve(homedir(), ".clawcore", "token-counts.json");
      if (existsSync(trackerFile)) {
        const counts = JSON.parse(readFileSync(trackerFile, "utf-8"));
        const total = (counts.ingest ?? 0) + (counts.embed ?? 0) + (counts.rerank ?? 0) + (counts.queryExpansion ?? 0);
        if (total > 0) {
          const format = (value: number) => value.toLocaleString();
          console.log(
            `  ${t.dim("Tokens:")} ${t.dim("Ingest")} ${t.value(format(counts.ingest ?? 0))}  ${t.dim("Embed")} ${t.value(format(counts.embed ?? 0))}  ${t.dim("Rerank")} ${t.value(format(counts.rerank ?? 0))}  ${t.dim("QE")} ${t.value(format(counts.queryExpansion ?? 0))}  ${t.dim("Total")} ${t.value(format(total))}`,
          );
        } else {
          console.log(`  ${t.dim("Tokens:")} ${t.dim("0 (counters reset)")}`);
        }
      } else {
        console.log(`  ${t.dim("Tokens:")} ${t.dim("no data yet")}`);
      }
    } catch {
      console.log(`  ${t.dim("Tokens:")} ${t.dim("no data yet")}`);
    }

    const gameModeOn = !svc.models && !svc.clawcore;
    console.log(`  ${t.dim("Auto-Startup:")} ${autoStart ? t.ok("on") : t.dim("off")}  ${t.dim("Game Mode:")} ${gameModeOn ? t.warn("on") : t.dim("off")}`);

    if (gpu.detected) {
      const usedPct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
      const vramColor = usedPct >= 80 ? t.err : usedPct >= 50 ? t.warn : t.ok;
      console.log(`  ${t.dim("GPU:")} ${gpu.name}  ${vramColor(`${gpu.vramUsedMb}/${gpu.vramTotalMb} MB (${usedPct}%)`)}`);
    } else {
      console.log(`  ${t.dim("GPU:")} ${t.err("not detected")}`);
    }

    console.log(t.dim("\n  ----------------------------------\n"));

    const anyRunning = svc.models || svc.clawcore;
    const items: { label: string; value: string; color?: (value: string) => string }[] = [
      { label: "Status & Health", value: "status" },
      { label: "Sources", value: "sources" },
      { label: "Configure", value: "configure" },
      { label: "Services", value: "services" },
    ];

    if (anyRunning) {
      items.push({ label: "Stop", value: "stop" });
      items.push({ label: "Restart", value: "restart" });
    }
    items.push({ label: "Start", value: "start" });
    items.push({ label: "Uninstall", value: "uninstall", color: t.err });
    items.push({ label: "Exit", value: "exit" });

    const action = await selectMenu(items);

    if (!action || action === "exit") {
      console.log(t.dim("\n  Goodbye.\n"));
      exitLegacyTui();
    }

    switch (action) {
      case "start":
      case "stop":
      case "restart": {
        const actionLabel = action === "start"
          ? "Starting services..."
          : action === "stop"
            ? "Stopping services..."
            : "Restarting services...";
        const spinner = ora(actionLabel).start();
        const result = await performServiceAction(action, {
          root,
          onStatus: (detail) => {
            spinner.text = detail;
          },
        });
        if (result.success) spinner.succeed(result.message);
        else spinner.fail(result.message);
        break;
      }

      case "status":
        clearScreen();
        await showStatus();
        break;

      case "configure":
        clearScreen();
        await runConfigure();
        break;

      case "sources":
        clearScreen();
        await showSources();
        break;

      case "services":
        clearScreen();
        await manageServices();
        autoStart = checkAutoStartup();
        break;

      case "uninstall":
        clearScreen();
        await runUninstall();
        if (!existsSync(resolve(root, "node_modules"))) {
          console.log(t.dim("\n  Goodbye.\n"));
          process.exit(0);
        }
        break;
    }
  }
}

async function launchTui(): Promise<void> {
  const capabilities = detectTerminalCapabilities();
  setTerminalCapabilities(capabilities);
  const forceLegacy = process.env.CLAWCORE_TUI_LEGACY === "1";
  const installed = Boolean(readConfig()) || existsSync(resolve(getRootDir(), "node_modules"));

  if (!installed && capabilities.rich && !forceLegacy) {
    const { runInkInstall } = await import("./ink/install-actions.js");
    const completed = await runInkInstall();
    if (!completed) return;
  }

  if (!readConfig() && !existsSync(resolve(getRootDir(), "node_modules"))) {
    await runInstall();
    if (!readConfig() && !existsSync(resolve(getRootDir(), "node_modules"))) {
      return;
    }
  }

  if (capabilities.rich && !forceLegacy) {
    try {
      const { launchInkTui } = await import("./ink/app.js");
      await launchInkTui();
      return;
    } catch (error) {
      console.warn(t.warn(`\nFalling back to legacy TUI: ${error instanceof Error ? error.message : String(error)}\n`));
    }
  }

  await launchLegacyTui();
}

function checkAutoStartup(): boolean {
  const plat = getPlatform();

  if (plat === "windows") {
    try {
      execFileSync("schtasks", ["/query", "/tn", "ClawCore_Models"], { stdio: "pipe", timeout: 5000 });
      return true; // task exists = auto-start registered
    } catch {
      return false;
    }
  }

  if (plat === "linux") {
    try {
      const output = execFileSync("systemctl", ["is-enabled", "clawcore-models"], { stdio: "pipe" }).toString().trim();
      return output === "enabled";
    } catch {
      return false;
    }
  }

  try {
    const plistPath = resolve(homedir(), "Library", "LaunchAgents", "com.clawcore.models.plist");
    return existsSync(plistPath);
  } catch {
    return false;
  }
}

async function checkServicesFast(): Promise<{ models: boolean; clawcore: boolean }> {
  const [models, clawcore] = await Promise.all([
    fetch(`${getModelBaseUrl()}/health`, { signal: AbortSignal.timeout(800) })
      .then((response) => response.ok)
      .catch(() => false),
    fetch(`${getApiBaseUrl()}/health`, { signal: AbortSignal.timeout(800) })
      .then((response) => response.ok)
      .catch(() => false),
  ]);

  if (models || clawcore) return { models, clawcore };

  const services = checkServices();
  return {
    models: services.models.running,
    clawcore: services.clawcore.running,
  };
}

launchTui().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : "";
  console.error(t.err(`\nFatal error: ${message}\n`));
  if (stack) console.error(t.dim(stack));
  console.error(t.dim("\nIf this is a fresh install, try running: npm install && npx tsx src/tui/index.ts"));
  // Keep terminal open briefly so user can read the error
  setTimeout(() => process.exit(1), 5000);
});

function exitLegacyTui(): never {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("keypress");
  process.stdin.pause();
  process.stdout.write("\x1b[?25h");
  process.exit(0);
}
