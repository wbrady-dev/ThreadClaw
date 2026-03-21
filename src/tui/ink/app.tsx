#!/usr/bin/env node
import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { Banner, Menu, Separator, t, useInterval, type MenuItem } from "./components.js";
import { clearScreen } from "../theme.js";
import { getRootDir, readConfig, getPlatform, getApiPort, getModelPort, getApiBaseUrl, getModelBaseUrl } from "../platform.js";
import { performServiceAction } from "../service-actions.js";
import { checkAutoStartupAsync, detectGpuAsync, isPortReachable } from "../runtime-status.js";
import {
  getTaskSnapshot,
  subscribeTasks,
  startTask,
  updateTask,
  finishTask,
  failTask,
  type UiTask,
} from "../tasks.js";
import { SourcesScreen } from "./screens/sources.js";
import { StatusScreen } from "./screens/status.js";
import { ServicesScreen } from "./screens/services.js";
import { ConfigureScreen } from "./screens/configure.js";

export async function launchInkTui(): Promise<void> {
  while (true) {
    const action = await showInkScreen("home");

    if (action === "exit") {
      process.exit(0);
    }

    if (action === "status") {
      await showInkScreen("status");
      continue;
    }

    if (action === "sources") {
      const subAction = await showInkScreen("sources");
      if (subAction && subAction.startsWith("sources-")) {
        await runSourcesScreenAction(subAction);
      }
      continue;
    }

    if (action === "configure") {
      const subAction = await showInkScreen("configure");
      if (subAction && subAction.startsWith("configure-")) {
        await runConfigureScreenAction(subAction);
      }
      continue;
    }

    if (action === "uninstall") {
      const completed = await runUninstallAction();
      if (completed) {
        process.exit(0);
      }
      continue;
    }

    if (action === "services") {
      const subAction = await showInkScreen("services");
      if (subAction && subAction !== "__back__") {
        await runServicesScreenAction(subAction);
      }
      continue;
    }

    await runLegacyAction(action);
  }
}

function showInkScreen(screen: "home" | "status" | "sources" | "services" | "configure"): Promise<string> {
  return new Promise((resolveAction) => {
    resetStdin();
    clearScreen();

    // Re-activate stdin for Ink rendering — resetStdin pauses it
    process.stdin.resume();
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
    }

    let resolved = false;
    let instance: ReturnType<typeof render> | null = null;

    const onAction = (action: string) => {
      if (resolved) return;
      resolved = true;
      try {
        instance?.unmount();
      } catch {}
      // Let Ink finish its async stdin cleanup before resolving
      setTimeout(() => {
        resetStdin();
        resolveAction(action);
      }, 60);
    };

    let ScreenComponent: React.FC;
    if (screen === "status") {
      ScreenComponent = () => <StatusScreen onBack={() => onAction("__back__")} />;
    } else if (screen === "sources") {
      ScreenComponent = () => (
        <SourcesScreen
          onBack={() => onAction("__back__")}
          onLegacy={(action) => onAction(action)}
        />
      );
    } else if (screen === "services") {
      ScreenComponent = () => (
        <ServicesScreen
          onBack={() => onAction("__back__")}
          onAction={(action) => onAction(action)}
        />
      );
    } else if (screen === "configure") {
      ScreenComponent = () => (
        <ConfigureScreen
          onBack={() => onAction("__back__")}
          onAction={(action) => onAction(action)}
        />
      );
    } else {
      ScreenComponent = () => <HomeScreen onAction={onAction} />;
    }

    instance = render(<ScreenComponent />, {
      exitOnCtrlC: false,
    });
  });
}

async function runLegacyAction(action: string): Promise<void> {
  // Restore normal terminal state for legacy console output
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  process.stdout.write("\x1b[?25h"); // show cursor
  clearScreen();

  try {
    if (action === "configure") {
      const { runConfigure } = await import("../screens/configure.js");
      await runConfigure();
    } else if (action === "services") {
      const { manageServices } = await import("../screens/services.js");
      await manageServices();
    } else if (action === "start" || action === "stop" || action === "restart") {
      await runServiceAction(action);
    }
  } catch (error) {
    console.error(t.err(`\n  Error: ${String(error)}`));
    await sleep(1500);
  }

  resetStdin();
}

async function runSourcesScreenAction(action: string): Promise<void> {
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch {}
  }
  clearScreen();

  try {
    const { runInkSourceAction } = await import("./source-actions.js");
    await runInkSourceAction(action);
  } catch (error) {
    console.error(t.err(`\n  Error: ${String(error)}`));
    await sleep(1500);
  }

  resetStdin();
}

async function runUninstallAction(): Promise<boolean> {
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch {}
  }
  clearScreen();

  try {
    const { runInkUninstall } = await import("./uninstall-actions.js");
    return await runInkUninstall();
  } catch (error) {
    console.error(t.err(`\n  Error: ${String(error)}`));
    await sleep(1500);
    return false;
  } finally {
    resetStdin();
  }
}

async function runConfigureScreenAction(action: string): Promise<void> {
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch {}
  }
  clearScreen();

  try {
    const { runInkConfigureAction } = await import("./configure-actions.js");
    const target = action.replace(/^configure-/, "");
    await runInkConfigureAction(target as import("../screens/configure.js").ConfigureAction);
  } catch (error) {
    console.error(t.err(`\n  Error: ${String(error)}`));
    await sleep(1500);
  }

  resetStdin();
}

async function runServiceAction(action: "start" | "stop" | "restart"): Promise<void> {
  // Ensure terminal is in a clean state for ora spinner output
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch {}
  }
  process.stdout.write("\x1b[?25h"); // show cursor

  const ora = (await import("ora")).default;

  const taskId = `services:${action}:${Date.now()}`;
  const actionLabel = action === "start"
    ? "Starting services"
    : action === "stop"
      ? "Stopping services"
      : "Restarting services";
  startTask(taskId, actionLabel, "Preparing...");

  console.log(""); // blank line before spinner
  const spinner = ora(actionLabel + "...").start();

  try {
    const result = await performServiceAction(action, {
      onStatus: (detail) => {
        const state = detail.startsWith("Waiting") ? "waiting" : "running";
        updateTask(taskId, { state, detail });
        spinner.text = detail;
      },
    });

    if (result.success) {
      finishTask(taskId, result.message);
      spinner.succeed(result.message);
    } else {
      failTask(taskId, result.message);
      spinner.fail(result.message);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failTask(taskId, msg);
    spinner.fail(msg);
  }

  await sleep(1000);
}

async function runServicesScreenAction(action: string): Promise<void> {
  if (action === "services-start") {
    await runServiceAction("start");
    return;
  }
  if (action === "services-stop" || action === "services-game-on") {
    await runServiceAction("stop");
    return;
  }
  if (action === "services-restart" || action === "services-game-off") {
    await runServiceAction("restart");
    return;
  }

  const ora = (await import("ora")).default;
  const {
    getPlatform,
    isAdmin,
    getRootDir,
    stopServices,
    installWindowsServices,
    removeWindowsServices,
    installLinuxServices,
    removeLinuxServices,
    installMacServices,
    removeMacServices,
  } = await import("../platform.js");

  const platform = getPlatform();
  const root = getRootDir();
  const spinner = ora().start();

  if (action === "services-auto-on") {
    if (platform === "windows") {
      if (!isAdmin()) {
        spinner.fail("Administrator privileges are required for Windows services");
        await sleep(1200);
        return;
      }
      const result = installWindowsServices(root);
      result.success ? spinner.succeed("Auto-start enabled") : spinner.fail(result.error ?? "Failed to enable auto-start");
      await sleep(1000);
      return;
    }

    if (platform === "linux") {
      if (!isAdmin()) {
        spinner.fail("sudo/root is required for systemd services");
        await sleep(1200);
        return;
      }
      const result = installLinuxServices(root);
      result.success ? spinner.succeed("Auto-start enabled") : spinner.fail(result.error ?? "Failed to enable auto-start");
      await sleep(1000);
      return;
    }

    const result = installMacServices(root);
    result.success ? spinner.succeed("Auto-start enabled") : spinner.fail(result.error ?? "Failed to enable auto-start");
    await sleep(1000);
    return;
  }

  if (action === "services-auto-off") {
    spinner.text = "Disabling auto-start...";
    stopServices();

    if (platform === "windows") {
      if (!isAdmin()) {
        spinner.fail("Administrator privileges are required for Windows services");
        await sleep(1200);
        return;
      }
      removeWindowsServices();
    } else if (platform === "linux") {
      if (!isAdmin()) {
        spinner.fail("sudo/root is required for systemd services");
        await sleep(1200);
        return;
      }
      removeLinuxServices();
    } else {
      removeMacServices();
    }

    spinner.succeed("Auto-start disabled");
    await sleep(1000);
  }
}

// Module-level cache so re-mounts don't flash red
let cachedModelsUp = false;
let cachedClawcoreUp = false;

function HomeScreen({ onAction }: { onAction: (action: string) => void }) {
  const root = getRootDir();
  const config = readConfig();

  const [modelsUp, setModelsUp] = useState(cachedModelsUp);
  const [clawcoreUp, setClawcoreUp] = useState(cachedClawcoreUp);
  const [gpu, setGpu] = useState({
    detected: false,
    name: "",
    vramUsedMb: 0,
    vramTotalMb: 0,
  });
  const [stats, setStats] = useState<any>(null);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [sources, setSources] = useState<any[]>([]);
  const [autoStart, setAutoStart] = useState(false);
  const [recentTasks, setRecentTasks] = useState<UiTask[]>(getTaskSnapshot());
  const [modelHealth, setModelHealth] = useState<any>(null);

  const refresh = async () => {
    const [
      modelsHealth,
      clawcoreHealth,
      gpuState,
      autoStartState,
      statsResponse,
      sourcesResponse,
      healthResponse,
    ] = await Promise.all([
      isPortReachable(getModelPort()),
      isPortReachable(getApiPort()),
      detectGpuAsync().catch(() => ({
        detected: false,
        name: "",
        vramUsedMb: 0,
        vramTotalMb: 0,
        vramFreeMb: 0,
      })),
      checkAutoStartupAsync().catch(() => false),
      fetch(`${getApiBaseUrl()}/stats`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null),
      fetch(`${getApiBaseUrl()}/sources`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null),
      fetch(`${getModelBaseUrl()}/health`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null),
    ]);

    cachedModelsUp = modelsHealth as boolean;
    cachedClawcoreUp = clawcoreHealth as boolean;
    setModelsUp(cachedModelsUp);
    setClawcoreUp(cachedClawcoreUp);
    setGpu({
      detected: gpuState.detected,
      name: gpuState.name,
      vramUsedMb: gpuState.vramUsedMb,
      vramTotalMb: gpuState.vramTotalMb,
    });
    setAutoStart(autoStartState);

    try {
      const statsData = statsResponse?.ok ? await statsResponse.json() : null;
      setStats(statsData);
      if (statsData) setStatsLoaded(true);
    } catch {
      setStats(null);
    }

    try {
      if (sourcesResponse?.ok) {
        const payload = await sourcesResponse.json() as { sources?: any[] };
        setSources(payload.sources ?? []);
      }
    } catch {}

    try {
      const healthData = healthResponse?.ok ? await healthResponse.json() : null;
      setModelHealth(healthData);
    } catch {
      setModelHealth(null);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => subscribeTasks(() => {
    setRecentTasks(getTaskSnapshot());
    void refresh();
  }), []);

  useInterval(refresh, modelsUp || clawcoreUp ? 3000 : 8000);

  const embedName = config?.embed_model?.split("/").pop() ?? "not configured";
  const rerankName = config?.rerank_model?.split("/").pop() ?? "not configured";

  let deepExtractLabel = t.dim("off");
  let expansionLabel = t.dim("off");
  try {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");

      // Deep extraction model
      const deepEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true";
      if (deepEnabled) {
        const explicitModel = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL=(.+)/)?.[1]?.trim();
        const explicitProvider = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER=(.+)/)?.[1]?.trim();
        if (explicitModel) {
          const providerTag = explicitProvider ? `${explicitProvider}/` : "";
          deepExtractLabel = t.value(`${providerTag}${explicitModel}`);
        } else {
          // Try to read OpenClaw's primary model
          try {
            const ocPath = resolve(root, "..", "..", "openclaw.json");
            if (existsSync(ocPath)) {
              const oc = JSON.parse(readFileSync(ocPath, "utf-8"));
              const ocModel = oc?.agents?.defaults?.model?.primary;
              if (ocModel) {
                deepExtractLabel = t.value(ocModel.split("/").pop()) + t.dim(" (via OpenClaw)");
              } else {
                deepExtractLabel = t.dim("summary model fallback");
              }
            } else {
              deepExtractLabel = t.dim("summary model fallback");
            }
          } catch {
            deepExtractLabel = t.dim("summary model fallback");
          }
        }
      }

      // Query expansion
      const enabled = envContent.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1];
      const model = envContent.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim();
      if (enabled === "true" && model) expansionLabel = t.value(model);
    }
  } catch {}

  const doclingDevice = config?.docling_device ?? "off";
  const doclingLabel = doclingDevice === "off"
    ? t.dim("off")
    : doclingDevice === "cpu"
      ? t.ok("CPU")
      : t.warn("GPU");

  const doclingOk = modelHealth?.models?.docling?.ready === true;
  const ocrInstalled = (() => {
    try {
      execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 3000 });
      return true;
    } catch {
      // Check common Windows install locations
      if (getPlatform() === "windows") {
        for (const p of ["C:\\Program Files\\Tesseract-OCR\\tesseract.exe", "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe"]) {
          try { execFileSync(p, ["--version"], { stdio: "pipe", timeout: 3000 }); return true; } catch {}
        }
      }
      return false;
    }
  })();

  const nerReady = modelHealth?.ner?.ready === true;
  const nerLabel = nerReady ? t.ok("en_core_web_sm") : t.dim("off");

  let watchCount = 0;
  try {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      const raw = envContent.match(/WATCH_PATHS=(.+)/)?.[1]?.trim();
      if (raw) watchCount = raw.split(",").filter(Boolean).length;
    }
  } catch {}
  const watchLabel = watchCount > 0 ? t.ok(`${watchCount} paths`) : t.dim("off");
  const gameModeOn = !modelsUp && !clawcoreUp;

  let gpuLine: string;
  if (gpu.detected && gpu.vramTotalMb > 0) {
    const usedPct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
    const vramColor = usedPct >= 80 ? t.err : usedPct >= 50 ? t.warn : t.ok;
    gpuLine = `${t.dim("GPU:")} ${gpu.name}  ${vramColor(`${gpu.vramUsedMb}/${gpu.vramTotalMb} MB (${usedPct}%)`)}`;
  } else {
    gpuLine = `${t.dim("GPU:")} ${t.err("not detected")}`;
  }

  const anyRunning = modelsUp || clawcoreUp;
  const items: MenuItem[] = [
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
  items.push({ label: "Exit", value: "exit", color: t.dim });

  return (
    <Box flexDirection="column">
      <Banner />

      <Text>{"  " + (modelsUp ? t.ok("●") : t.err("○")) + " Models " + t.dim("|") + " " + (clawcoreUp ? t.ok("●") : t.err("○")) + " ClawCore"}</Text>
      <Text>{"  " + t.dim("Embed:".padEnd(18)) + t.value(embedName)}</Text>
      <Text>{"  " + t.dim("Rerank:".padEnd(18)) + t.value(rerankName)}</Text>
      <Text>{"  " + t.dim("Deep Extract:".padEnd(18)) + deepExtractLabel}</Text>
      <Text>{"  " + t.dim("Query Expansion:".padEnd(18)) + expansionLabel}</Text>
      <Text>{"  " + t.dim("Docling:".padEnd(18)) + (doclingOk ? t.ok(doclingDevice.toUpperCase()) : doclingLabel)}</Text>
      <Text>{"  " + t.dim("OCR:".padEnd(18)) + (ocrInstalled ? t.ok("Tesseract") : t.dim("off"))}</Text>
      <Text>{"  " + t.dim("NER:".padEnd(18)) + nerLabel}</Text>
      <Text>{"  " + t.dim("File Watcher:".padEnd(18)) + watchLabel}</Text>
      <Text>{"  " + t.dim("Auto-Startup:".padEnd(18)) + (autoStart ? t.ok("on") : t.dim("off")) + "    " + t.dim("Game Mode:") + " " + (gameModeOn ? t.warn("on") : t.dim("off"))}</Text>
      <Text>{"  " + gpuLine}</Text>

      {statsLoaded && <Box flexDirection="column" marginTop={1}>
        <Text>{t.title("  --- Knowledge Base ---")}</Text>
        {stats ? (
          <Box flexDirection="column">
            <Text>{"  " + t.dim("Documents:".padEnd(18)) + t.value(String(stats.documents ?? 0)) + t.dim("    Chunks: ") + t.value(String(stats.chunks ?? 0))}</Text>
            <Text>{"  " + t.dim("Collections:".padEnd(18)) + t.value(String(stats.collections ?? 0)) + t.dim("    Size: ") + t.value(((stats.dbSizeMB ?? 0) as number).toFixed(1) + " MB")}</Text>
          </Box>
        ) : (
          <Text>{"  " + t.dim("API offline")}</Text>
        )}
        {(() => {
          const active = sources.filter((source) => source.enabled).length;
          const syncing = sources.filter((source) => source.status?.state === "syncing").length;
          const syncingNames = sources
            .filter((source) => source.status?.state === "syncing")
            .slice(0, 2)
            .map((source) => source.name);
          const errored = sources.filter((source) => source.status?.error).slice(0, 1);
          if (active > 0) {
            const syncingText = syncing > 0 ? t.ok(`  - ${syncing} syncing`) : "";
            return (
              <>
                <Text>{"  " + t.dim("Sources:".padEnd(18)) + t.value(`${active} active`) + syncingText}</Text>
                {syncingNames.length > 0 && (
                  <Text>{"  " + t.dim("Syncing:".padEnd(18)) + t.value(syncingNames.join(", "))}</Text>
                )}
                {errored.map((source) => (
                  <Text key={source.id}>{"  " + t.dim("Source alert:".padEnd(18)) + t.err(`${source.name}: ${source.status.error}`)}</Text>
                ))}
              </>
            );
          }
          return <Text>{"  " + t.dim("Sources:".padEnd(18)) + t.dim("none configured")}</Text>;
        })()}
      </Box>}

      <Box flexDirection="column" marginTop={1}>
        <Text>{t.title("  --- Recent Activity ---")}</Text>
        {recentTasks.length > 0 ? recentTasks.slice(0, 4).map((task) => (
          <Text key={task.id}>{"  " + formatTask(task)}</Text>
        )) : (
          <Text>{"  " + t.dim("No recent activity yet")}</Text>
        )}
      </Box>

      <Separator />

      <Menu items={items} onSelect={onAction} />
    </Box>
  );
}

function formatTask(task: UiTask): string {
  const stateColor = task.state === "error"
    ? t.err
    : task.state === "success"
      ? t.ok
      : t.warn;
  const ageSeconds = Math.max(0, Math.round((Date.now() - task.updatedAt) / 1000));
  const age = ageSeconds < 60 ? `${ageSeconds}s ago` : `${Math.round(ageSeconds / 60)}m ago`;
  const detail = task.detail ? t.dim(` - ${task.detail}`) : "";
  return `${stateColor(`[${task.state}]`)} ${t.value(task.title)}${detail} ${t.dim(`(${age})`)}`;
}

function resetStdin(): void {
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("keypress");
  process.stdin.pause();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  resetStdin();
  process.stdout.write("\x1b[?25h");
  process.exit(0);
});
