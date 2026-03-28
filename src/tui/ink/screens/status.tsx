/**
 * Status & Health Screen — live-updating system overview.
 */
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { execFile } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { Section, KV, StatusDot, Menu, t, useInterval, type MenuItem } from "../components.js";
import { readConfig, getRootDir, getDataDir, findOpenClaw, getPlatform, getApiPort, getModelPort, getApiBaseUrl, getModelBaseUrl, type ServiceStatus } from "../../platform.js";
import { checkAutoStartupAsync, detectGpuAsync, isPortReachable } from "../../runtime-status.js";
import { subscribeTasks } from "../../tasks.js";
import type { GpuInfo } from "../../models.js";

// Module-level cache for status screen so re-mounts don't flash
let cachedSvc: ServiceStatus = { models: { running: false }, threadclaw: { running: false } };
let cachedAutoStart = false;
let cachedGpu: GpuInfo = { name: "None detected", vramTotalMb: 0, vramUsedMb: 0, vramFreeMb: 0, detected: false };

export function StatusScreen({ onBack }: { onBack: () => void }) {
  const [tick, setTick] = useState(0);
  const [svc, setSvc] = useState<ServiceStatus>(cachedSvc);
  const [autoStart, setAutoStart] = useState(cachedAutoStart);
  const [gpu, setGpu] = useState<GpuInfo>(cachedGpu);

  const [gpuTick, setGpuTick] = useState(0);
  useInterval(() => setTick((n: number) => n + 1), 3000);
  useInterval(() => setGpuTick((n: number) => n + 1), 10000);

  const [config] = useState(() => readConfig());
  const [root] = useState(() => getRootDir());

  const [modelHealth, setModelHealth] = useState<any>(null);
  const [apiStats, setApiStats] = useState<any>(null);
  const [collections, setCollections] = useState<any[]>([]);

  // GPU refresh on separate slower interval
  useEffect(() => {
    let cancelled = false;
    detectGpuAsync().then((gpuState) => {
      if (!cancelled) { cachedGpu = gpuState; setGpu(gpuState); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [gpuTick]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Use fast TCP port checks for service status
      const [modelsUp, threadclawUp, autoStartState, modelResponse, statsResponse, collectionsResponse] = await Promise.all([
        isPortReachable(getModelPort()),
        isPortReachable(getApiPort()),
        checkAutoStartupAsync(),
        fetch(`${getModelBaseUrl()}/health`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
        fetch(`${getApiBaseUrl()}/stats`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
        fetch(`${getApiBaseUrl()}/collections`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      ]);

      if (cancelled) return;

      const serviceState: ServiceStatus = {
        models: { running: modelsUp },
        threadclaw: { running: threadclawUp },
      };
      cachedSvc = serviceState;
      cachedAutoStart = autoStartState;
      setSvc(serviceState);
      setAutoStart(autoStartState);

      try {
        setModelHealth(modelResponse?.ok ? await modelResponse.json() : null);
      } catch {
        setModelHealth(null);
      }

      try {
        setApiStats(statsResponse?.ok ? await statsResponse.json() : null);
      } catch {
        setApiStats(null);
      }

      try {
        const data = collectionsResponse?.ok ? await collectionsResponse.json() as any : null;
        setCollections(data?.collections ?? []);
      } catch {
        setCollections([]);
      }
    })();

    return () => { cancelled = true; };
  }, [tick]);

  // Immediately fetch on mount to clear stale module-level caches
  useEffect(() => { setTick((v) => v + 1); setGpuTick((v) => v + 1); }, []);

  useEffect(() => subscribeTasks(() => {
    setTick((value) => value + 1);
  }), []);

  // Model indicators: prefer health check data when available, fall back to port check
  const embedOk = modelHealth ? (modelHealth.models?.embed?.ready === true) : svc.models.running;
  const rerankOk = modelHealth ? (modelHealth.models?.rerank?.ready === true) : svc.models.running;
  const doclingOk = modelHealth?.models?.docling?.ready === true;
  const doclingDevice = config?.docling_device ?? "off";

  // OCR detection — async to avoid blocking render
  const [ocrDetected, setOcrDetected] = useState(false);
  useEffect(() => {
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
      if (!cancelled) setOcrDetected(found);
    })();
    return () => { cancelled = true; };
  }, []);

  const embedName = config?.embed_model ?? "not configured";
  const rerankName = config?.rerank_model ?? "not configured";

  const gameModeOn = !svc.models.running;

  // Read .env once for all config values
  let envContent = "";
  try {
    const envPath = resolve(root, ".env");
    if (existsSync(envPath)) envContent = readFileSync(envPath, "utf-8");
  } catch {}

  // Query expansion
  let expansionLabel = t.dim("off");
  const expEnabled = envContent.match(/QUERY_EXPANSION_ENABLED=(\w+)/)?.[1];
  const expModel = envContent.match(/QUERY_EXPANSION_MODEL=(.+)/)?.[1]?.trim();
  if (expEnabled === "true" && expModel) expansionLabel = t.value(expModel);

  // Database
  const dbPath = resolve(getDataDir(), "threadclaw.db");
  const dbExists = existsSync(dbPath);
  const dbSize = dbExists ? (statSync(dbPath).size / 1024 / 1024).toFixed(2) : "0";

  // Network
  const tPort = envContent.match(/THREADCLAW_PORT=(\d+)/)?.[1] ?? String(getApiPort());
  const mPort = envContent.match(/RERANKER_URL=.*:(\d+)/)?.[1] ?? String(getModelPort());

  const ocDir = findOpenClaw();

  return (
    <Box flexDirection="column">
      <Section title="Services" />
      <StatusDot ok={svc.models.running} label="Models" detail={`port ${getModelPort()}`} />
      <StatusDot ok={svc.threadclaw.running} label="ThreadClaw RAG API" detail={`port ${getApiPort()}`} />
      <StatusDot ok={autoStart} label="Auto-Startup" />
      <KV label="Game Mode" value={gameModeOn ? t.warn("on (VRAM freed)") : t.dim("off")} />

      <Section title="Models" />
      <Text>{"  " + (embedOk ? t.ok("●") : t.err("○")) + " " + t.label("Embed") + "   " + t.value(embedName)}</Text>
      <Text>{"  " + (rerankOk ? t.ok("●") : t.err("○")) + " " + t.label("Rerank") + "  " + t.value(rerankName)}</Text>
      <Text>{"  " + (doclingOk ? t.ok("●") : t.dim("○")) + " " + t.label("Docling") + " " + (doclingOk ? t.value(doclingDevice.toUpperCase()) : doclingDevice === "off" ? t.dim("off") : t.warn(doclingDevice.toUpperCase() + " (not loaded)"))}</Text>
      <Text>{"  " + (ocrDetected ? t.ok("●") : t.dim("○")) + " " + t.label("OCR") + "     " + (ocrDetected ? t.value("Tesseract") : t.dim("off"))}</Text>
      <Text>{"  " + (modelHealth?.models?.ner?.ready === true ? t.ok("●") : t.dim("○")) + " " + t.label("NER") + "     " + (modelHealth?.models?.ner?.ready === true ? t.value("en_core_web_sm") : t.dim("off"))}</Text>
      <Text>{"  " + (expEnabled === "true" && expModel ? t.ok("●") : t.dim("○")) + " " + t.label("Query Expansion") + " " + expansionLabel}</Text>

      <Section title="GPU" />
      {gpu.detected ? (
        <Box flexDirection="column">
          <KV label="GPU" value={gpu.name} />
          <KV label="VRAM" value={(() => {
            const usedPct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
            const color = usedPct >= 80 ? t.err : usedPct >= 50 ? t.warn : t.ok;
            return color(`${gpu.vramUsedMb} / ${gpu.vramTotalMb} MB (${usedPct}%)`);
          })()} />
          <KV label="Free" value={`${gpu.vramFreeMb} MB`} />
        </Box>
      ) : (
        <KV label="GPU" value={t.err("not detected")} />
      )}

      <Section title="Database" />
      {dbExists ? (
        <Box flexDirection="column">
          <KV label="Size" value={`${dbSize} MB`} />
          {apiStats && (
            <>
              <KV label="Collections" value={String(apiStats.collections)} />
              <KV label="Documents" value={String(apiStats.documents)} />
              <KV label="Chunks" value={String(apiStats.chunks)} />
              <KV label="Tokens" value={apiStats.tokens?.toLocaleString() ?? "0"} />
            </>
          )}
        </Box>
      ) : (
        <Text>{t.dim("  No database yet. Ingest documents to create one.")}</Text>
      )}

      {collections.length > 0 && (
        <>
          <Section title="Collections" />
          {collections.map((c: any) => (
            <Text key={c.name}>{"    " + t.selected(c.name.padEnd(20)) + " " + t.dim(c.id?.slice(0, 8) + "...")}</Text>
          ))}
        </>
      )}

      <Section title="Network" />
      <KV label="ThreadClaw API" value={`http://localhost:${tPort}`} />
      <KV label="Model Server" value={`http://localhost:${mPort}`} />
      {ocDir && <KV label="OpenClaw" value={t.ok(`detected at ${ocDir}`)} />}

      <Text> </Text>
      <Menu
        items={[
          { label: "Refresh", value: "refresh" },
          { label: "Back", value: "__back__", color: t.dim },
        ] as MenuItem[]}
        onSelect={(value) => {
          if (value === "refresh") setTick((v) => v + 1);
          else onBack();
        }}
      />
    </Box>
  );
}
