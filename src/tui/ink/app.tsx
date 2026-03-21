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

    // start/stop/restart are handled inside HomeScreen — should not reach here
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

// Module-level service action state — survives HomeScreen re-mounts
let activeServiceAction: {
  label: string;
  detail: string;
  done: boolean;
  success: boolean;
  message: string;
} | null = null;
let serviceActionListeners = new Set<() => void>();

function notifyServiceActionListeners() {
  for (const fn of serviceActionListeners) fn();
}

function fireServiceAction(action: "start" | "stop" | "restart"): void {
  if (activeServiceAction && !activeServiceAction.done) return; // already running

  const label = action === "start" ? "Starting services"
    : action === "stop" ? "Stopping services"
    : "Restarting services";

  activeServiceAction = { label, detail: "Preparing...", done: false, success: false, message: "" };
  notifyServiceActionListeners();

  const taskId = `services:${action}:${Date.now()}`;
  startTask(taskId, label, "Preparing...");

  performServiceAction(action, {
    onStatus: (detail) => {
      if (activeServiceAction) {
        activeServiceAction.detail = detail;
        notifyServiceActionListeners();
      }
      const state = detail.startsWith("Waiting") ? "waiting" as const : "running" as const;
      updateTask(taskId, { state, detail });
    },
  }).then((result) => {
    if (activeServiceAction) {
      activeServiceAction.done = true;
      activeServiceAction.success = result.success;
      activeServiceAction.message = result.message;
      notifyServiceActionListeners();
    }
    result.success ? finishTask(taskId, result.message) : failTask(taskId, result.message);
    // Clear after 4s so the success/fail message is visible
    setTimeout(() => { activeServiceAction = null; notifyServiceActionListeners(); }, 4000);
  }).catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    if (activeServiceAction) {
      activeServiceAction.done = true;
      activeServiceAction.success = false;
      activeServiceAction.message = msg;
      notifyServiceActionListeners();
    }
    failTask(taskId, msg);
    setTimeout(() => { activeServiceAction = null; notifyServiceActionListeners(); }, 4000);
  });
}

async function runServicesScreenAction(action: string): Promise<void> {
  if (action === "services-start") {
    fireServiceAction("start");
    return;
  }
  if (action === "services-stop" || action === "services-game-on") {
    fireServiceAction("stop");
    return;
  }
  if (action === "services-restart" || action === "services-game-off") {
    fireServiceAction("restart");
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
let cachedOcrInstalled: boolean | null = null;

function HomeScreen({ onAction }: { onAction: (action: string) => void }) {
  const root = getRootDir();
  const config = readConfig();

  const [modelsUp, setModelsUp] = useState(cachedModelsUp);
  const [clawcoreUp, setClawcoreUp] = useState(cachedClawcoreUp);
  const [gpu, setGpu] = useState({ detected: false, name: "", vramUsedMb: 0, vramTotalMb: 0 });
  const [stats, setStats] = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [autoStart, setAutoStart] = useState(false);
  const [recentTasks, setRecentTasks] = useState<UiTask[]>(getTaskSnapshot());
  const [modelHealth, setModelHealth] = useState<any>(null);
  const [svcAction, setSvcAction] = useState(activeServiceAction);

  // Subscribe to service action progress
  useEffect(() => {
    const listener = () => setSvcAction(activeServiceAction ? { ...activeServiceAction } : null);
    serviceActionListeners.add(listener);
    return () => { serviceActionListeners.delete(listener); };
  }, []);

  // Detect OCR once (async, not on render)
  const [ocrInstalled, setOcrInstalled] = useState(cachedOcrInstalled ?? false);
  useEffect(() => {
    if (cachedOcrInstalled !== null) return;
    setTimeout(() => {
      let found = false;
      try {
        execFileSync("tesseract", ["--version"], { stdio: "pipe", timeout: 3000 });
        found = true;
      } catch {
        if (getPlatform() === "windows") {
          for (const p of ["C:\\Program Files\\Tesseract-OCR\\tesseract.exe", "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe"]) {
            try { execFileSync(p, ["--version"], { stdio: "pipe", timeout: 3000 }); found = true; break; } catch {}
          }
        }
      }
      cachedOcrInstalled = found;
      setOcrInstalled(found);
    }, 0);
  }, []);

  const refresh = async () => {
    const [mUp, cUp, gpuState, autoStartState, statsRes, sourcesRes, healthRes] = await Promise.all([
      isPortReachable(getModelPort()),
      isPortReachable(getApiPort()),
      detectGpuAsync().catch(() => ({ detected: false, name: "", vramUsedMb: 0, vramTotalMb: 0, vramFreeMb: 0 })),
      checkAutoStartupAsync().catch(() => false),
      fetch(`${getApiBaseUrl()}/stats`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      fetch(`${getApiBaseUrl()}/sources`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      fetch(`${getModelBaseUrl()}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
    ]);

    cachedModelsUp = mUp as boolean;
    cachedClawcoreUp = cUp as boolean;
    setModelsUp(cachedModelsUp);
    setClawcoreUp(cachedClawcoreUp);
    setGpu({ detected: gpuState.detected, name: gpuState.name, vramUsedMb: gpuState.vramUsedMb, vramTotalMb: gpuState.vramTotalMb });
    setAutoStart(autoStartState);

    try {
      setStats(statsRes?.ok ? await statsRes.json() : null);
    } catch { setStats(null); }

    try {
      if (sourcesRes?.ok) {
        const payload = await sourcesRes.json() as { sources?: any[] };
        setSources(payload.sources ?? []);
      }
    } catch {}

    try {
      const hd = healthRes?.ok ? await healthRes.json() : null;
      setModelHealth(hd);
    } catch { setModelHealth(null); }
  };

  useEffect(() => { refresh(); }, []);
  useEffect(() => subscribeTasks(() => { setRecentTasks(getTaskSnapshot()); void refresh(); }), []);
  useInterval(refresh, modelsUp || clawcoreUp ? 3000 : 5000);

  // ── Derive display values (no sync I/O in render) ──

  const embedName = config?.embed_model?.split("/").pop() ?? "not configured";
  const rerankName = config?.rerank_model?.split("/").pop() ?? "not configured";

  // Read .env once for all labels
  let envContent = "";
  try {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) envContent = readFileSync(envPath, "utf-8");
  } catch {}

  const deepEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true";
  let deepExtractLabel = t.dim("off");
  if (deepEnabled) {
    const explicitModel = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL=(.+)/)?.[1]?.trim();
    const explicitProvider = envContent.match(/CLAWCORE_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER=(.+)/)?.[1]?.trim();
    if (explicitModel) {
      deepExtractLabel = t.value(`${explicitProvider ? explicitProvider + "/" : ""}${explicitModel}`);
    } else {
      try {
        const ocPath = resolve(root, "..", "..", "openclaw.json");
        if (existsSync(ocPath)) {
          const ocModel = JSON.parse(readFileSync(ocPath, "utf-8"))?.agents?.defaults?.model?.primary;
          deepExtractLabel = ocModel ? t.value(ocModel.split("/").pop()) + t.dim(" (via OpenClaw)") : t.dim("summary model fallback");
        }
      } catch {}
    }
  }

  let expansionLabel = t.dim("off");
  const qeEnabled = envContent.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1];
  const qeModel = envContent.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim();
  if (qeEnabled === "true" && qeModel) expansionLabel = t.value(qeModel);

  const doclingDevice = config?.docling_device ?? "off";
  const doclingOk = modelHealth?.models?.docling?.ready === true;
  const doclingLabel = doclingOk ? t.ok(doclingDevice.toUpperCase()) : doclingDevice === "off" ? t.dim("off") : t.value(doclingDevice.toUpperCase());

  const nerReady = modelHealth?.ner?.ready === true;

  const watchPaths = envContent.match(/WATCH_PATHS=(.+)/)?.[1]?.trim();
  const watchCount = watchPaths ? watchPaths.split(",").filter(Boolean).length : 0;

  const relationsEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_ENABLED=(\w+)/)?.[1] === "true";
  const awarenessEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_AWARENESS_ENABLED=(\w+)/)?.[1] === "true";
  const claimsEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true";
  const attemptEnabled = envContent.match(/CLAWCORE_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED=(\w+)/)?.[1] === "true";

  let evidenceLabel = t.dim("off");
  if (relationsEnabled) {
    const features = ["entities"];
    if (awarenessEnabled) features.push("awareness");
    if (claimsEnabled) features.push("claims");
    if (attemptEnabled) features.push("attempts");
    if (deepEnabled) features.push("deep");
    evidenceLabel = t.ok(`on (${features.join(", ")})`);
  }

  // Source summary from .env (fast, no API needed)
  const sourceIcons: string[] = [];
  if (watchCount > 0) sourceIcons.push(`${t.ok("●")} Local Files`);
  if (envContent.includes("OBSIDIAN_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Obsidian`);
  if (envContent.includes("GDRIVE_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Google Drive`);
  if (envContent.includes("ONEDRIVE_ENABLED=true")) sourceIcons.push(`${t.ok("●")} OneDrive`);
  if (envContent.includes("NOTION_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Notion`);
  if (envContent.includes("APPLE_NOTES_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Apple Notes`);

  const P = 16; // label padding

  // GPU line
  let gpuLine: string;
  if (gpu.detected && gpu.vramTotalMb > 0) {
    const pct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
    const c = pct >= 80 ? t.err : pct >= 50 ? t.warn : t.ok;
    gpuLine = `${gpu.name}  ${c(`${gpu.vramUsedMb}/${gpu.vramTotalMb} MB (${pct}%)`)}`;
  } else {
    gpuLine = t.dim("not detected");
  }

  // Knowledge base stats (always shown, not gated on API)
  const docCount = stats?.documents ?? 0;
  const chunkCount = stats?.chunks ?? 0;
  const collCount = stats?.collections ?? 0;
  const dbSize = ((stats?.dbSizeMB ?? 0) as number).toFixed(1);

  const anyRunning = modelsUp || clawcoreUp;
  const items: MenuItem[] = [
    { label: "Status & Health", value: "status" },
    { label: "Sources", value: "sources" },
    { label: "Configure", value: "configure" },
    { label: "Services", value: "services" },
  ];
  if (!anyRunning) {
    items.push({ label: "Start Services", value: "start" });
  } else {
    items.push({ label: "Restart Services", value: "restart" });
    items.push({ label: "Stop Services", value: "stop" });
  }
  items.push({ label: "Uninstall", value: "uninstall", color: t.err });
  items.push({ label: "Exit", value: "exit", color: t.dim });

  return (
    <Box flexDirection="column">
      <Banner />

      {/* ── Services ── */}
      <Text>{"  " + (modelsUp ? t.ok("●") : t.err("○")) + " Models " + t.dim("|") + " " + (clawcoreUp ? t.ok("●") : t.err("○")) + " ClawCore" + (autoStart ? t.dim("  (auto-start on)") : "")}</Text>

      {/* ── Models & Processing ── */}
      <Text>{""}</Text>
      <Text>{"  " + t.dim("Embed:".padEnd(P)) + t.value(embedName)}</Text>
      <Text>{"  " + t.dim("Rerank:".padEnd(P)) + t.value(rerankName)}</Text>
      <Text>{"  " + t.dim("Deep Extract:".padEnd(P)) + deepExtractLabel}</Text>
      <Text>{"  " + t.dim("Expansion:".padEnd(P)) + expansionLabel}</Text>
      <Text>{"  " + t.dim("Docling:".padEnd(P)) + doclingLabel + t.dim("  |  ") + t.dim("OCR: ") + (ocrInstalled ? t.ok("on") : t.dim("off")) + t.dim("  |  ") + t.dim("NER: ") + (nerReady ? t.ok("on") : t.dim("off"))}</Text>
      <Text>{"  " + t.dim("GPU:".padEnd(P)) + gpuLine}</Text>

      {/* ── Knowledge Base (always shown) ── */}
      <Text>{""}</Text>
      <Text>{t.title("  --- Knowledge Base ---")}</Text>
      {stats ? (
        <>
          <Text>{"  " + t.dim("Documents:".padEnd(P)) + t.value(String(docCount)) + t.dim("  |  Chunks: ") + t.value(String(chunkCount)) + t.dim("  |  Size: ") + t.value(dbSize + " MB")}</Text>
          <Text>{"  " + t.dim("Collections:".padEnd(P)) + t.value(String(collCount))}</Text>
        </>
      ) : (
        <Text>{"  " + t.dim(clawcoreUp ? "Loading..." : "API offline — start services to see stats")}</Text>
      )}
      <Text>{"  " + t.dim("Sources:".padEnd(P)) + (sourceIcons.length > 0 ? sourceIcons.join(t.dim("  |  ")) : t.dim("none configured"))}</Text>
      <Text>{"  " + t.dim("Watch Paths:".padEnd(P)) + (watchCount > 0 ? t.ok(`${watchCount} paths`) : t.dim("none"))}</Text>
      <Text>{"  " + t.dim("Evidence OS:".padEnd(P)) + evidenceLabel}</Text>

      {/* ── Recent Activity ── */}
      {recentTasks.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{t.title("  --- Activity ---")}</Text>
          {recentTasks.slice(0, 4).map((task) => (
            <Text key={task.id}>{"  " + formatTask(task)}</Text>
          ))}
        </Box>
      )}

      {/* ── Service action progress ── */}
      {svcAction && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{"  " + (svcAction.done
            ? (svcAction.success ? t.ok("✓ ") : t.err("✗ ")) + (svcAction.success ? t.ok(svcAction.message) : t.err(svcAction.message))
            : t.warn("⟳ ") + t.warn(svcAction.label) + t.dim(" — " + svcAction.detail)
          )}</Text>
        </Box>
      )}

      <Separator />
      <Menu items={items} onSelect={(value) => {
        if (value === "start" || value === "stop" || value === "restart") {
          fireServiceAction(value);
          return;
        }
        onAction(value);
      }} />
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
