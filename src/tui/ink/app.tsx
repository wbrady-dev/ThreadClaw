#!/usr/bin/env node
import React, { useEffect, useState, useRef } from "react";
import { render, Box, Text } from "ink";
import { execFile } from "child_process";
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
import { DocumentsScreen } from "./screens/documents.js";
import { EvidenceOsScreen } from "./screens/evidence-os.js";
import { SearchScreen } from "./screens/search.js";

export async function launchInkTui(): Promise<void> {
  while (true) {
    const action = await showInkScreen("home");

    if (action === "exit" || action === "__confirm_exit__") {
      process.exit(0);
    }

    if (action === "search") {
      await showInkScreen("search");
      continue;
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
      // Loop: stay in configure until user selects Back/Escape
      let subAction = await showInkScreen("configure");
      while (subAction && subAction.startsWith("configure-")) {
        await runConfigureScreenAction(subAction);
        subAction = await showInkScreen("configure");
      }
      continue;
    }

    if (action === "documents") {
      await showInkScreen("documents");
      continue;
    }

    if (action === "evidence-os") {
      await showInkScreen("evidence-os");
      continue;
    }
    if (action === "reset-kb") {
      await runResetKnowledgeBase();
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

function showInkScreen(screen: "home" | "status" | "sources" | "services" | "configure" | "documents" | "evidence-os" | "search"): Promise<string> {
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
      }, 150);
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
    } else if (screen === "documents") {
      ScreenComponent = () => <DocumentsScreen onBack={() => onAction("__back__")} />;
    } else if (screen === "evidence-os") {
      ScreenComponent = () => <EvidenceOsScreen onBack={() => onAction("__back__")} />;
    } else if (screen === "search") {
      ScreenComponent = () => <SearchScreen onBack={() => onAction("__back__")} />;
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

async function runResetKnowledgeBase(): Promise<void> {
  process.stdin.resume();
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch {}
  }
  clearScreen();

  try {
    const { promptMenu } = await import("./prompts.js");
    const ora = (await import("ora")).default;

    // Step 1: What to reset
    const scope = await promptMenu({
      title: "Reset Knowledge Base",
      message: "This will permanently delete documents, chunks, collections, and embeddings.\nThis cannot be undone. What would you like to reset?",
      items: [
        { label: "Reset knowledge base only", value: "kb-only", description: "Delete all documents and embeddings. Keep Evidence OS graph." },
        { label: "Reset KB + Evidence OS", value: "full", description: "Delete all documents, embeddings, AND Evidence OS graph data." },
        { label: "FULL WIPE (everything)", value: "nuke", description: "Delete ALL data: KB + Evidence OS + conversation memory + summaries." },
        { label: "Cancel", value: "__back__" },
      ],
    });

    if (!scope || scope === "__back__") return;

    // Step 2: Final confirmation
    if (scope === "nuke") {
      // Extra-dangerous: require typing confirmation
      const { promptText } = await import("./prompts.js");
      console.log(t.err("\n  ⚠  WARNING: FULL WIPE — THIS WILL PERMANENTLY DELETE ALL DATA"));
      console.log(t.err("  This includes: documents, embeddings, Evidence OS graph,"));
      console.log(t.err("  ALL conversation history, summaries, and memory."));
      console.log(t.err("  This cannot be undone.\n"));
      const typed = await promptText({ title: "Confirm Full Wipe", message: 'Type "DELETE EVERYTHING" to confirm:', label: "Confirmation", placeholder: "DELETE EVERYTHING" });
      if (typed?.trim() !== "DELETE EVERYTHING") {
        console.log(t.dim("\n  Reset cancelled.\n"));
        return;
      }
    } else {
      const confirm = await promptMenu({
        title: "Are you sure?",
        message: scope === "full"
          ? "ALL documents, chunks, embeddings, entities, and claims will be permanently deleted."
          : "ALL documents, chunks, and embeddings will be permanently deleted.\nEvidence OS graph data (entities, claims) will be preserved.",
        items: [
          { label: "Yes, reset now", value: "yes", description: "This cannot be undone" },
          { label: "No, go back", value: "__back__" },
        ],
      });

      if (!confirm || confirm === "__back__") return;
    }

    // Step 3: Execute reset — works with or without services running
    const clearGraph = scope === "full" || scope === "nuke";
    const clearMemory = scope === "nuke";
    const sp = ora(clearMemory ? "Full wipe in progress..." : "Resetting knowledge base...").start();
    try {
      // Try API first (if services running), fall back to direct DB access
      let data: any = null;
      try {
        const res = await fetch(`${getApiBaseUrl()}/reset`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clearGraph, clearMemory }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) data = await res.json();
      } catch {}

      if (!data) {
        // Direct DB access — services not needed
        const { resolve } = await import("path");
        const { getDb } = await import("../../storage/index.js");
        const { resetKnowledgeBase } = await import("../../storage/collections.js");
        const { config: appConfig } = await import("../../config.js");
        const dbPath = resolve(appConfig.dataDir, "threadclaw.db");
        const db = getDb(dbPath);
        const stats = resetKnowledgeBase(db);
        data = { ...stats, graphCleared: false };

        if (clearGraph && appConfig.relations?.graphDbPath) {
          try {
            const { getGraphDb } = await import("../../storage/graph-sqlite.js");
            const { clearAllGraphTables } = await import("../../relations/ingest-hook.js");
            const graphDb = getGraphDb(appConfig.relations.graphDbPath);
            clearAllGraphTables(graphDb);
            data.graphCleared = true;
          } catch {}
        }

        if (clearMemory) {
          try {
            const { DatabaseSync } = await import("node:sqlite");
            const memPath = resolve(appConfig.dataDir, "memory.db");
            const memDb = new DatabaseSync(memPath);
            // Count before deleting
            const safeCount = (tbl: string) => { try { return (memDb.prepare(`SELECT COUNT(*) as c FROM ${tbl}`).get() as any)?.c ?? 0; } catch { return 0; } };
            data.memoryStats = {
              conversations: safeCount("conversations"),
              messages: safeCount("messages"),
              summaries: safeCount("summaries"),
              contextItems: safeCount("context_items"),
            };
            const memTables = ["context_items", "summary_parents", "summary_messages", "message_parts", "large_files", "summaries", "messages", "conversations"];
            for (const tbl of memTables) { try { memDb.exec(`DELETE FROM ${tbl}`); } catch {} }
            try { memDb.exec("DELETE FROM messages_fts"); } catch {}
            try { memDb.exec("DELETE FROM summaries_fts"); } catch {}
            try { memDb.exec("VACUUM"); } catch {}
            memDb.close();
            data.memoryCleared = true;
          } catch {}
        }
      }

      sp.succeed("Reset complete.");
      console.log("");
      console.log(t.ok(`  RAG Knowledge Base: ${data.documentsDeleted ?? 0} documents, ${data.chunksDeleted ?? 0} chunks, ${data.collectionsDeleted ?? 0} collections deleted`));
      if (data.graphCleared) console.log(t.ok("  Evidence OS Graph: claims, decisions, loops, entities, relations — all cleared"));
      else if (clearGraph) console.log(t.dim("  Evidence OS Graph: not found or already empty"));
      else console.log(t.dim("  Evidence OS Graph: preserved"));
      if (data.memoryCleared && data.memoryStats) {
        const ms = data.memoryStats;
        console.log(t.err(`  Conversation Memory: ${ms.conversations} conversations, ${ms.messages} messages, ${ms.summaries} summaries, ${ms.contextItems} context items — all wiped`));
      } else if (data.memoryCleared) {
        console.log(t.err("  Conversation Memory: all wiped"));
      } else if (clearMemory) {
        console.log(t.dim("  Conversation Memory: not found or already empty"));
      } else {
        console.log(t.dim("  Conversation Memory: preserved"));
      }
    } catch (err) {
      sp.fail(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log("");
    await sleep(2000);
  } catch (error) {
    console.error(t.err(`\n  Error: ${String(error)}`));
    await sleep(1500);
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
const serviceActionListeners = new Set<() => void>();

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
    getRootDir,
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

    if (platform === "windows") {
      removeWindowsServices();
    } else if (platform === "linux") {
      removeLinuxServices();
    } else {
      removeMacServices();
    }

    spinner.succeed("Auto-start disabled (running services are not affected)");
    await sleep(1000);
  }
}

// Module-level cache so re-mounts don't flash or lose data
let cachedModelsUp = false;
let cachedThreadclawUp = false;
let cachedOcrInstalled: boolean | null = null;
let cachedStats: any = null;
let cachedSources: any[] = [];
let cachedModelHealth: any = null;
let cachedGpu = { detected: false, name: "", vramUsedMb: 0, vramTotalMb: 0 };
let cachedAutoStart = false;
let cachedEnvContent = "";
let envNeedsReload = true;  // true on first load, set true after config actions
/** Call after any config action that modifies .env to trigger a re-read on next poll */
export function markEnvDirty() { envNeedsReload = true; }
let cachedParsedEnv = {
  deepEnabled: false,
  relationsEnabled: false,
  awarenessEnabled: false,
  claimsEnabled: false,
  attemptEnabled: false,
  qeEnabled: "",
  qeModel: "",
  watchCount: 0,
  watchPaths: "",
  sourceIcons: [] as string[],
  audioEnabled: false,
  whisperModel: "base",
};

function HomeScreen({ onAction }: { onAction: (action: string) => void }) {
  const root = getRootDir();
  const config = readConfig();

  const [modelsUp, setModelsUp] = useState(cachedModelsUp);
  const [threadclawUp, setThreadclawUp] = useState(cachedThreadclawUp);
  const [gpu, setGpu] = useState(cachedGpu);
  const [stats, setStats] = useState<any>(cachedStats);
  const [sources, setSources] = useState<any[]>(cachedSources);
  const [autoStart, setAutoStart] = useState(cachedAutoStart);
  const [recentTasks, setRecentTasks] = useState<UiTask[]>(getTaskSnapshot());
  const [modelHealth, setModelHealth] = useState<any>(cachedModelHealth);
  const [svcAction, setSvcAction] = useState(activeServiceAction);

  // Subscribe to service action progress
  useEffect(() => {
    const listener = () => setSvcAction(activeServiceAction ? { ...activeServiceAction } : null);
    serviceActionListeners.add(listener);
    return () => { serviceActionListeners.delete(listener); };
  }, []);

  // Detect OCR once (truly async — no event loop blocking)
  const [ocrInstalled, setOcrInstalled] = useState(cachedOcrInstalled ?? false);
  useEffect(() => {
    if (cachedOcrInstalled !== null) return;
    let cancelled = false;
    const tryExec = (cmd: string): Promise<boolean> =>
      new Promise((res) => execFile(cmd, ["--version"], { timeout: 3000 }, (err) => res(!err)));

    (async () => {
      let found = await tryExec("tesseract");
      if (!found && getPlatform() === "windows") {
        for (const p of ["C:\\Program Files\\Tesseract-OCR\\tesseract.exe", "C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe"]) {
          found = await tryExec(p);
          if (found) break;
        }
      }
      if (!cancelled) {
        cachedOcrInstalled = found;
        setOcrInstalled(found);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = async () => { try {
    const [mUp, cUp, gpuState, autoStartState, statsRes, sourcesRes, healthRes] = await Promise.all([
      isPortReachable(getModelPort()),
      isPortReachable(getApiPort()),
      detectGpuAsync().catch(() => ({ detected: false, name: "", vramUsedMb: 0, vramTotalMb: 0, vramFreeMb: 0 })),
      checkAutoStartupAsync().catch(() => null),
      fetch(`${getApiBaseUrl()}/stats`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      fetch(`${getApiBaseUrl()}/sources`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      fetch(`${getModelBaseUrl()}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
    ]);

    // Read .env only on first load or after a config action marks it dirty
    if (envNeedsReload) {
      try {
        const envPath = resolve(root, ".env");
        if (existsSync(envPath)) cachedEnvContent = readFileSync(envPath, "utf-8");
      } catch {}
      envNeedsReload = false;
    }
    const ec = cachedEnvContent;
    const watchPaths = ec.match(/WATCH_PATHS=(.+)/)?.[1]?.trim() ?? "";
    const sourceIcons: string[] = [];
    if (watchPaths) sourceIcons.push(`${t.ok("●")} Local Files`);
    if (ec.includes("OBSIDIAN_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Obsidian`);
    if (ec.includes("GDRIVE_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Google Drive`);
    if (ec.includes("ONEDRIVE_ENABLED=true")) sourceIcons.push(`${t.ok("●")} OneDrive`);
    if (ec.includes("NOTION_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Notion`);
    if (ec.includes("APPLE_NOTES_ENABLED=true")) sourceIcons.push(`${t.ok("●")} Apple Notes`);
    cachedParsedEnv = {
      deepEnabled: ec.match(/THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true",
      relationsEnabled: ec.match(/THREADCLAW_RELATIONS_ENABLED=(\w+)/)?.[1] === "true" || ec.match(/THREADCLAW_MEMORY_RELATIONS_ENABLED=(\w+)/)?.[1] === "true",
      awarenessEnabled: ec.match(/THREADCLAW_MEMORY_RELATIONS_AWARENESS_ENABLED=(\w+)/)?.[1] === "true",
      claimsEnabled: ec.match(/THREADCLAW_MEMORY_RELATIONS_CLAIM_EXTRACTION_ENABLED=(\w+)/)?.[1] === "true",
      attemptEnabled: ec.match(/THREADCLAW_MEMORY_RELATIONS_ATTEMPT_TRACKING_ENABLED=(\w+)/)?.[1] === "true",
      qeEnabled: ec.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1] ?? "",
      qeModel: ec.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim() ?? "",
      watchCount: watchPaths ? watchPaths.split(",").filter(Boolean).length : 0,
      watchPaths,
      sourceIcons,
      audioEnabled: ec.match(/AUDIO_TRANSCRIPTION_ENABLED=(\w+)/)?.[1] === "true",
      whisperModel: ec.match(/WHISPER_MODEL=(\w+)/)?.[1] ?? "base",
    };

    // Service status: always update (port unreachable = service is down)
    cachedModelsUp = mUp as boolean;
    cachedThreadclawUp = cUp as boolean;
    setModelsUp(cachedModelsUp);
    setThreadclawUp(cachedThreadclawUp);

    // GPU and auto-start: only update on success, keep old data on failure
    if (gpuState.detected) {
      cachedGpu = { detected: gpuState.detected, name: gpuState.name, vramUsedMb: gpuState.vramUsedMb, vramTotalMb: gpuState.vramTotalMb };
      setGpu(cachedGpu);
    }
    if (autoStartState !== null) {
      cachedAutoStart = autoStartState;
      setAutoStart(cachedAutoStart);
    }

    // Update on success; clear when service is confirmed down (not just a timeout)
    try {
      if (statsRes?.ok) { cachedStats = await statsRes.json(); setStats(cachedStats); }
      else if (!cachedThreadclawUp) { cachedStats = null; setStats(null); }
    } catch {}

    try {
      if (sourcesRes?.ok) {
        const payload = await sourcesRes.json() as { sources?: any[] };
        cachedSources = payload.sources ?? [];
        setSources(cachedSources);
      }
    } catch {}

    try {
      if (healthRes?.ok) { cachedModelHealth = await healthRes.json(); setModelHealth(cachedModelHealth); }
      else if (!cachedModelsUp) { cachedModelHealth = null; setModelHealth(null); }
    } catch {}
  } catch {} };

  useEffect(() => { refresh(); }, []);

  // Subscribe to task changes with debounced refresh (prevents spam during service actions)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = subscribeTasks(() => {
      setRecentTasks(getTaskSnapshot());
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => { void refresh(); }, 500);
    });
    return unsub; // cleanup on unmount
  }, []);

  useInterval(refresh, modelsUp || threadclawUp ? 3000 : 5000);

  // ── Derive display values (no sync I/O in render) ──

  const embedName = config?.embed_model?.split("/").pop() ?? "not configured";
  const rerankName = config?.rerank_model?.split("/").pop() ?? "not configured";

  // Use pre-parsed env values from refresh() — no regex in render path
  const { deepEnabled, relationsEnabled, awarenessEnabled, claimsEnabled, attemptEnabled, watchCount, sourceIcons } = cachedParsedEnv;
  const envContent = cachedEnvContent;

  let deepExtractLabel = t.dim("off");
  if (deepEnabled) {
    const explicitModel = envContent.match(/THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_MODEL=(.+)/)?.[1]?.trim();
    const explicitProvider = envContent.match(/THREADCLAW_MEMORY_RELATIONS_DEEP_EXTRACTION_PROVIDER=(.+)/)?.[1]?.trim();
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
  if (cachedParsedEnv.qeEnabled === "true" && cachedParsedEnv.qeModel) expansionLabel = t.value(cachedParsedEnv.qeModel);

  const doclingDevice = config?.docling_device ?? "off";
  const doclingOk = modelHealth?.models?.docling?.ready === true;
  const doclingLabel = doclingOk ? t.ok(doclingDevice.toUpperCase()) : doclingDevice === "off" ? t.dim("off") : t.warn(doclingDevice.toUpperCase() + " (not loaded)");

  const nerReady = modelHealth?.models?.ner?.ready === true;
  const audioEnabled = cachedParsedEnv.audioEnabled;

  // GPU
  let gpuLine: string;
  if (gpu.detected && gpu.vramTotalMb > 0) {
    const gpuNameLower = gpu.name.toLowerCase();
    if (gpuNameLower.includes("apple") || /\bm[1-4]\b/.test(gpuNameLower)) {
      gpuLine = `${gpu.name}  ${t.dim(`shared memory — ${Math.round(gpu.vramTotalMb / 1024)} GB`)}`;
    } else {
      const pct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
      const c = pct >= 80 ? t.err : pct >= 50 ? t.warn : t.ok;
      gpuLine = `${gpu.name}  ${c(`${gpu.vramUsedMb}/${gpu.vramTotalMb} MB (${pct}%)`)}`;
    }
  } else {
    gpuLine = t.dim("not detected");
  }

  // Knowledge base stats
  const docCount = stats?.documents ?? 0;
  const chunkCount = stats?.chunks ?? 0;
  const collCount = stats?.collections ?? 0;
  const dbSize = ((stats?.dbSizeMB ?? 0) as number).toFixed(1);

  const anyRunning = modelsUp || threadclawUp;
  const sepLine = t.dim("  " + "\u2500".repeat(Math.min((process.stdout.columns || 80) - 4, 50)));

  // ── Menu items grouped with separators ──
  const items: MenuItem[] = [
    { label: "\u2500\u2500 Actions \u2500\u2500", value: "__sep_actions" },
    { label: "Search", value: "search" },
    { label: "Sources", value: "sources" },
    { label: "Documents", value: "documents", description: docCount > 0 ? `${docCount} documents` : undefined },
    { label: "\u2500\u2500 System \u2500\u2500", value: "__sep_system" },
    { label: "Status & Health", value: "status" },
    { label: "Evidence OS", value: "evidence-os", description: relationsEnabled && stats?.graphStats ? `${stats.graphStats.entities} entities` : undefined },
    { label: "Configure", value: "configure" },
    { label: "Services", value: "services" },
  ];
  if (!anyRunning) {
    items.push({ label: "Start Services", value: "start" });
  } else {
    items.push({ label: "Restart Services", value: "restart" });
    items.push({ label: "Stop Services", value: "stop" });
  }
  items.push({ label: "\u2500\u2500 Danger Zone \u2500\u2500", value: "__sep_danger" });
  items.push({ label: "Reset Knowledge Base", value: "reset-kb", color: t.err });
  items.push({ label: "Uninstall", value: "uninstall", color: t.err });
  items.push({ label: "Exit", value: "exit", color: t.dim });

  // Banner subtitle: show data summary instead of joke tagline
  const bannerSub = `Local RAG \u00b7 ${docCount} docs \u00b7 ${chunkCount} chunks`;

  return (
    <Box flexDirection="column">
      <Banner subtitle={bannerSub} />
      <Text>{"  " + (modelsUp ? t.ok("\u25cf") : t.err("\u25cb")) + " Models " + t.dim("|") + " " + (threadclawUp ? t.ok("\u25cf") : t.err("\u25cb")) + " ThreadClaw" + (autoStart ? t.dim("  (auto-start on)") : "")}</Text>

      {/* ── Models ── */}
      <Text>{t.title("  Models")}</Text>
      <Text>{t.dim("  Local AI models powering search and extraction")}</Text>
      <Text>{"  " + t.dim("Embed: ") + t.value(embedName)}</Text>
      <Text>{"  " + t.dim("Rerank: ") + t.value(rerankName)}</Text>
      <Text>{"  " + t.dim("Deep Extract: ") + deepExtractLabel}</Text>
      <Text>{"  " + t.dim("Query Expansion: ") + expansionLabel}</Text>
      <Text>{"  " + t.dim("GPU: ") + gpuLine}</Text>

      <Text>{sepLine}</Text>

      {/* ── Document Intelligence ── */}
      <Text>{t.title("  Document Intelligence")}</Text>
      <Text>{t.dim("  Parsing and processing capabilities")}</Text>
      {(process.stdout.columns || 120) < 100 ? (
        <>
          <Text>{"  " + t.dim("Docling: ") + doclingLabel + "    " + t.dim("OCR: ") + (ocrInstalled ? t.ok("\u25cf") : t.err("\u25cb"))}</Text>
          <Text>{"  " + t.dim("NER: ") + (nerReady ? t.ok("\u25cf") : t.err("\u25cb")) + "    " + t.dim("Whisper: ") + (audioEnabled ? t.ok(cachedParsedEnv.whisperModel) : t.dim("off"))}</Text>
        </>
      ) : (
        <Text>{"  " + t.dim("Docling: ") + doclingLabel + "      " + t.dim("OCR: ") + (ocrInstalled ? t.ok("\u25cf") : t.err("\u25cb")) + "      " + t.dim("NER: ") + (nerReady ? t.ok("\u25cf") : t.err("\u25cb")) + "      " + t.dim("Whisper: ") + (audioEnabled ? t.ok(cachedParsedEnv.whisperModel) : t.dim("off"))}</Text>
      )}

      <Text>{sepLine}</Text>

      {/* ── Knowledge Base ── */}
      <Text>{t.title("  Knowledge Base")}</Text>
      <Text>{t.dim("  Your indexed documents and sources")}</Text>
      <Text>{"  " + t.dim("Sources: ") + (sourceIcons.length > 0 ? sourceIcons.join(t.dim("  |  ")) : t.dim("none configured"))}</Text>
      <Text>{"  " + t.dim("Watch Paths: ") + (watchCount > 0 ? t.ok(`${watchCount} paths`) : t.dim("none"))}</Text>
      {stats ? (
        <>
          <Text>{"  " + t.dim("Documents:   ") + t.value(String(docCount).padEnd(8)) + t.dim("Chunks: ") + t.value(String(chunkCount))}</Text>
          <Text>{"  " + t.dim("Collections: ") + t.value(String(collCount).padEnd(8)) + t.dim("Size: ") + t.value(dbSize + " MB")}</Text>
        </>
      ) : (
        <Text>{"  " + t.dim(threadclawUp ? "Loading..." : "Start services to see stats")}</Text>
      )}

      <Text>{sepLine}</Text>

      {/* ── Evidence OS ── */}
      <Text>{t.title("  Evidence OS")}</Text>
      <Text>{t.dim("  Knowledge graph and entity tracking")}</Text>
      <Text>{"  " + t.dim("Status: ") + (relationsEnabled ? t.ok("\u25cf") : t.err("\u25cb")) + "  " + t.dim("Deep Extraction: ") + (deepEnabled ? t.ok("\u25cf") : t.err("\u25cb")) + "  " + t.dim("Awareness: ") + (awarenessEnabled ? t.ok("\u25cf") : t.err("\u25cb"))}</Text>
      {relationsEnabled && (() => {
        const gs = stats?.graphStats;
        const allZero = !gs || ((gs.entities ?? 0) === 0 && (gs.relations ?? 0) === 0 && (gs.mentions ?? 0) === 0 && (gs.claims ?? 0) === 0 && (gs.evidenceEvents ?? 0) === 0 && (gs.decisions ?? 0) === 0 && (gs.attempts ?? 0) === 0 && (gs.loops ?? 0) === 0);
        if (allZero) {
          return <Text>{"  " + t.dim("No evidence data yet \u2014 ingest documents to populate")}</Text>;
        }
        return (
          <>
            <Text>{"  " + t.dim("Graph: ") + t.value(String(gs.entities ?? 0)) + t.dim(" entities \u00b7 ") + t.value(String(gs.relations ?? 0)) + t.dim(" relations \u00b7 ") + t.value(String(gs.claims ?? 0)) + t.dim(" claims")}</Text>
            <Text>{"  " + t.dim("Activity: ") + t.value(String(gs.evidenceEvents ?? 0)) + t.dim(" evidence \u00b7 ") + t.value(String(gs.decisions ?? 0)) + t.dim(" decisions \u00b7 ") + t.value(String(gs.loops ?? 0)) + t.dim(" loops \u00b7 ") + t.value(String(gs.attempts ?? 0)) + t.dim(" attempts")}</Text>
          </>
        );
      })()}

      {/* ── Onboarding CTA ── */}
      {!anyRunning && sourceIcons.length === 0 && docCount === 0 && (
        <Text>{t.warn("  \u2192 Get started: select 'Sources' to add a folder, then 'Start Services'")}</Text>
      )}

      {/* ── Activity / Service Action ── */}
      {(recentTasks.length > 0 || svcAction) && (
        <Box flexDirection="column">
          <Text>{sepLine}</Text>
          <Text>{t.title("  Activity")}</Text>
          {svcAction && (
            <Text>{"  " + (svcAction.done
              ? (svcAction.success ? t.ok("\u2713 ") : t.err("\u2717 ")) + (svcAction.success ? t.ok(svcAction.message) : t.err(svcAction.message))
              : t.warn("\u27f3 ") + t.warn(svcAction.label) + t.dim(" \u2014 " + svcAction.detail)
            )}</Text>
          )}
          {recentTasks.slice(0, 3).map((task) => (
            <Text key={task.id}>{"  " + formatTask(task)}</Text>
          ))}
        </Box>
      )}

      <Separator />
      <Menu items={items} isRoot onSelect={(value) => {
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
