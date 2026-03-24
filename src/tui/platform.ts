import { execFileSync, spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from "fs";
import { resolve, dirname } from "path";
import { platform, homedir } from "os";

/**
 * Cross-platform service management and system detection.
 */

export type Platform = "windows" | "linux" | "mac";

/* ── Port & URL constants ─────────────────────────────────────────── */

/** Default ports — override via THREADCLAW_PORT / RERANKER_URL in .env */
export const DEFAULT_API_PORT = 18800;
export const DEFAULT_MODEL_PORT = 8012;

export function getApiPort(): number {
  return parseInt(process.env.THREADCLAW_PORT ?? String(DEFAULT_API_PORT), 10);
}

export function getModelPort(): number {
  const url = process.env.RERANKER_URL;
  if (url) {
    const m = url.match(/:(\d+)/);
    if (m) return parseInt(m[1], 10);
  }
  return DEFAULT_MODEL_PORT;
}

export function getApiBaseUrl(): string {
  return `http://127.0.0.1:${getApiPort()}`;
}

export function getModelBaseUrl(): string {
  return process.env.RERANKER_URL ?? `http://127.0.0.1:${getModelPort()}`;
}

/* ── End port constants ───────────────────────────────────────────── */

let rootDirOverride = process.env.THREADCLAW_ROOT
  ? resolve(process.env.THREADCLAW_ROOT)
  : null;

export function getPlatform(): Platform {
  const p = platform();
  if (p === "win32") return "windows";
  if (p === "darwin") return "mac";
  return "linux";
}

export function getRootDir(): string {
  if (rootDirOverride) return rootDirOverride;
  return resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "../..");
}

export function setRootDirOverride(root: string | null): void {
  rootDirOverride = root ? resolve(root) : null;
  if (rootDirOverride) process.env.THREADCLAW_ROOT = rootDirOverride;
  else delete process.env.THREADCLAW_ROOT;
}

export function getDataDir(root = getRootDir()): string {
  return resolve(root, "data");
}

export function getPythonCmd(): string {
  // Check project venv first — isolated, no global pollution
  try {
    const root = getRootDir();
    const venvPython = getPlatform() === "windows"
      ? resolve(root, ".venv", "Scripts", "python.exe")
      : resolve(root, ".venv", "bin", "python3");
    if (existsSync(venvPython)) return venvPython;
  } catch {}

  // Fallback to system Python — resolve full path for Task Scheduler compatibility
  if (getPlatform() === "windows") {
    try {
      const fullPath = execFileSync("where", ["python"], { stdio: "pipe", timeout: 5000 }).toString().trim().split("\n")[0].trim();
      if (fullPath && existsSync(fullPath)) return fullPath;
    } catch {}
    try {
      execFileSync("python", ["--version"], { stdio: "pipe", timeout: 5000 });
      return "python";
    } catch {}
  }
  try {
    const fullPath = execFileSync("which", ["python3"], { stdio: "pipe", timeout: 5000 }).toString().trim();
    if (fullPath && existsSync(fullPath)) return fullPath;
  } catch {}
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe", timeout: 5000 });
    return "python3";
  } catch {}
  try {
    execFileSync("python", ["--version"], { stdio: "pipe", timeout: 5000 });
    return "python";
  } catch {}
  return "python";
}

/** Get the system Python (ignoring venv) for venv creation. */
export function getSystemPythonCmd(): string {
  if (getPlatform() === "windows") {
    try {
      execFileSync("python", ["--version"], { stdio: "pipe", timeout: 5000 });
      return "python";
    } catch {}
  }
  try {
    execFileSync("python3", ["--version"], { stdio: "pipe", timeout: 5000 });
    return "python3";
  } catch {}
  return "python";
}

export function getNodeCmd(): string {
  return process.execPath;
}

export function getNpmCmd(): string {
  return getPlatform() === "windows" ? "npm.cmd" : "npm";
}

export function findOpenClaw(): string | null {
  const candidates = [
    resolve(homedir(), ".openclaw"),
    resolve(homedir(), ".clawd"),  // alternate OpenClaw install location
  ];

  for (const dir of candidates) {
    if (existsSync(resolve(dir, "openclaw.json"))) {
      return dir;
    }
  }
  return null;
}

// ========================================
// Config Management
// ========================================

export interface ThreadClawConfig {
  embed_model: string;
  rerank_model: string;
  trust_remote_code: boolean;
  docling_device: string;
}

function getConfigCandidates(root = getRootDir()): string[] {
  return [
    resolve(root, "server", "config.json"),
    resolve(root, "..", "config.json"), // parent dir (services/config.json)
    resolve(root, "config.json"),
  ];
}

export function getConfigPath(root = getRootDir()): string {
  // Return existing config path, or default to server/config.json for new installs
  for (const candidate of getConfigCandidates(root)) {
    if (existsSync(candidate)) return candidate;
  }
  return resolve(root, "server", "config.json");
}

export function readConfig(root = getRootDir()): ThreadClawConfig | null {
  for (const configPath of getConfigCandidates(root)) {
    if (existsSync(configPath)) {
      try {
        return JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {}
    }
  }
  return null;
}

export function writeConfig(config: ThreadClawConfig, root = getRootDir()): void {
  const configPath = getConfigPath(root);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

// ========================================
// Service Management (Cross-Platform)
// ========================================

export interface ServiceStatus {
  models: { running: boolean; pid?: number };
  threadclaw: { running: boolean; pid?: number };
}

// ── Windows Task Scheduler helpers (uses schtasks.exe — instant, no PowerShell) ──

const TASK_MODELS = "ThreadClaw_Models";
const TASK_RAG = "ThreadClaw_RAG";

/** Run schtasks.exe and return stdout. */
function schtasks(...args: string[]): string {
  return execFileSync("schtasks", args, { stdio: "pipe", timeout: 10000 }).toString().trim();
}

/** Check if a Windows scheduled task is currently running. */
function isTaskRunning(taskName: string): boolean {
  try {
    const out = schtasks("/query", "/tn", taskName, "/fo", "csv", "/nh");
    // CSV format: "TaskName","Next Run Time","Status"
    return out.includes('"Running"');
  } catch {
    return false;
  }
}

/** Start a Windows scheduled task (no admin required). */
function startTask(taskName: string): { success: boolean; error?: string } {
  try {
    schtasks("/run", "/tn", taskName);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Stop a Windows scheduled task (no admin required). */
function endTask(taskName: string): { success: boolean; error?: string } {
  try {
    schtasks("/end", "/tn", taskName);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Delete a Windows scheduled task. */
function deleteTask(taskName: string): { success: boolean } {
  try {
    schtasks("/delete", "/tn", taskName, "/f");
  } catch {}
  return { success: true };
}

/** Escape XML special characters for safe interpolation into XML/plist documents. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Ensure both Windows tasks are registered.
 * Uses schtasks.exe (native, instant) instead of PowerShell.
 */
function ensureWindowsTasks(root: string): { success: boolean; error?: string } {
  const binDir = resolve(root, "bin");
  const logsDir = resolve(root, "logs");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const pythonCmd = getPythonCmd();
  const modelsScript = findModelsScript(root);
  const nodeCmd = getNodeCmd();
  const entryArgs = findApiEntryArgs(root);

  // Use XML task definitions so we can set WorkingDirectory and run the
  // executable directly (not via cmd.exe). This way schtasks /end kills
  // the actual python/node process, not just a cmd.exe wrapper.
  const escXml = escapeXml;

  // Write XML as UTF-16LE with BOM — required by schtasks /xml on Windows
  const writeXml = (path: string, content: string) => {
    const bom = Buffer.from([0xFF, 0xFE]);
    const body = Buffer.from(content, "utf16le");
    writeFileSync(path, Buffer.concat([bom, body]));
  };

  const modelsXml = resolve(binDir, `${TASK_MODELS}.xml`);
  writeXml(modelsXml, `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT30S</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escXml(pythonCmd)}</Command>
      <Arguments>"${escXml(modelsScript)}"</Arguments>
      <WorkingDirectory>${escXml(dirname(modelsScript))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`);

  const ragXml = resolve(binDir, `${TASK_RAG}.xml`);
  const ragArgs = entryArgs.map(a => `"${escXml(a)}"`).join(" ");
  writeXml(ragXml, `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT30S</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escXml(nodeCmd)}</Command>
      <Arguments>${ragArgs}</Arguments>
      <WorkingDirectory>${escXml(root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`);

  try {
    schtasks("/create", "/tn", TASK_MODELS, "/xml", modelsXml, "/f");
    schtasks("/create", "/tn", TASK_RAG, "/xml", ragXml, "/f");
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// ── End Windows Task Scheduler helpers ──

export function checkServices(): ServiceStatus {
  const result: ServiceStatus = {
    models: { running: false },
    threadclaw: { running: false },
  };

  const plat = getPlatform();

  if (plat === "windows") {
    // Check via Task Scheduler
    result.models.running = isTaskRunning(TASK_MODELS);
    result.threadclaw.running = isTaskRunning(TASK_RAG);
  } else {
    // Check systemd services (Linux)
    if (plat === "linux") {
      try {
        const out = execFileSync("systemctl", ["--user", "is-active", "threadclaw-models"], { stdio: "pipe", timeout: 5000 }).toString().trim();
        if (out === "active") result.models.running = true;
      } catch {}
      try {
        const out = execFileSync("systemctl", ["--user", "is-active", "threadclaw-rag"], { stdio: "pipe", timeout: 5000 }).toString().trim();
        if (out === "active") result.threadclaw.running = true;
      } catch {}
    }

    // Check launchd services (Mac)
    if (plat === "mac") {
      try {
        const out = execFileSync("launchctl", ["list"], { stdio: "pipe", timeout: 5000 }).toString();
        if (out.includes("com.threadclaw.models")) result.models.running = true;
        if (out.includes("com.threadclaw.rag")) result.threadclaw.running = true;
      } catch {}
    }

    // Check PID files (fallback for direct process launch)
    const root = getRootDir();
    if (!result.models.running) {
      try {
        if (existsSync(resolve(root, ".models.pid"))) {
          const pid = parseInt(readFileSync(resolve(root, ".models.pid"), "utf-8").trim(), 10);
          if (Number.isFinite(pid) && pid > 0) {
            try { process.kill(pid, 0); result.models = { running: true, pid }; } catch {}
          }
        }
      } catch {}
    }
    if (!result.threadclaw.running) {
      try {
        if (existsSync(resolve(root, ".threadclaw.pid"))) {
          const pid = parseInt(readFileSync(resolve(root, ".threadclaw.pid"), "utf-8").trim(), 10);
          if (Number.isFinite(pid) && pid > 0) {
            try { process.kill(pid, 0); result.threadclaw = { running: true, pid }; } catch {}
          }
        }
      } catch {}
    }
  }

  // Port check as final fallback (covers all platforms)
  if (!result.models.running) {
    result.models.running = isPortOpen(getModelPort());
  }
  if (!result.threadclaw.running) {
    result.threadclaw.running = isPortOpen(getApiPort());
  }

  return result;
}

function isPortOpen(port: number): boolean {
  try {
    if (getPlatform() === "windows") {
      const out = execFileSync("netstat", ["-an"], { stdio: "pipe", timeout: 5000 }).toString();
      // Check each line individually — port AND LISTENING must be on the same line
      return out.split("\n").some((line) => line.includes(`:${port}`) && line.includes("LISTENING"));
    } else {
      execFileSync("lsof", ["-i", `:${port}`, "-sTCP:LISTEN"], { stdio: "pipe", timeout: 5000 });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Find ThreadClaw API entry point — prefers built dist, falls back to tsx dev mode.
 * Returns [args] to pass to node.
 */
function findApiEntryArgs(root: string): string[] {
  const distIndex = resolve(root, "dist", "index.js");
  if (existsSync(distIndex)) return [distIndex];
  const tsxCli = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
  return [tsxCli, resolve(root, "src", "index.ts")];
}

export function findModelsScript(root: string): string {
  return resolve(root, "server", "server.py");
}

/**
 * Start the model server (embeddings + reranking).
 * On Windows: uses Task Scheduler (no admin, no visible window, always stoppable).
 * On Unix: detached spawn (systemd/launchd handled separately via auto-start).
 */
export function startModelServer(): { success: boolean; error?: string } {
  if (isPortOpen(getModelPort())) return { success: true }; // already running

  const root = getRootDir();
  const plat = getPlatform();

  // Windows: Task Scheduler — no admin, no EPERM, no visible window
  if (plat === "windows") {
    const tasks = ensureWindowsTasks(root);
    if (!tasks.success) return { success: false, error: tasks.error };
    return startTask(TASK_MODELS);
  }

  // Unix: detached spawn
  try {
    const pythonCmd = getPythonCmd();
    const modelsScript = findModelsScript(root);
    const logsDir = resolve(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    const modelsLog = openSync(resolve(logsDir, "models.log"), "a");
    const modelsProcess = spawn(pythonCmd, [modelsScript], {
      cwd: dirname(modelsScript),
      detached: true,
      stdio: ["ignore", modelsLog, modelsLog],
      windowsHide: true,
    });
    modelsProcess.unref();
    try { closeSync(modelsLog); } catch {}
    if (modelsProcess.pid) writeFileSync(resolve(root, ".models.pid"), String(modelsProcess.pid));
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Start the ThreadClaw RAG API server.
 * On Windows: uses Task Scheduler.
 * On Unix: detached spawn.
 * Call AFTER model server is ready.
 */
export function startThreadClawApi(): { success: boolean; error?: string } {
  if (isPortOpen(getApiPort())) return { success: true }; // already running

  const root = getRootDir();
  const plat = getPlatform();

  // Windows: Task Scheduler
  if (plat === "windows") {
    const tasks = ensureWindowsTasks(root);
    if (!tasks.success) return { success: false, error: tasks.error };
    return startTask(TASK_RAG);
  }

  // Unix: detached spawn
  try {
    const entryArgs = findApiEntryArgs(root);
    const logsDir = resolve(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    const clawLog = openSync(resolve(logsDir, "threadclaw.log"), "a");
    const tal = spawn(process.execPath, entryArgs, {
      cwd: root,
      detached: true,
      stdio: ["ignore", clawLog, clawLog],
      windowsHide: true,
    });
    tal.unref();
    try { closeSync(clawLog); } catch {}
    if (tal.pid) writeFileSync(resolve(root, ".threadclaw.pid"), String(tal.pid));
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/** Start both services (convenience wrapper). Model server starts first. */
export function startServices(): { success: boolean; error?: string } {
  const r1 = startModelServer();
  if (!r1.success) return r1;
  const r2 = startThreadClawApi();
  return r2;
}

/**
 * Send stop signals to services. Returns immediately — does NOT block
 * waiting for processes to die. The caller (performServiceAction) handles
 * async port-closed verification.
 */
export function stopServices(): { success: boolean; error?: string } {
  const plat = getPlatform();
  const root = getRootDir();

  try {
    // 1. HTTP shutdown: works from any terminal, no permissions needed
    try {
      const http = require("http") as typeof import("http");
      for (const port of [getApiPort(), getModelPort()]) {
        const req = http.request({ hostname: "127.0.0.1", port, path: "/shutdown", method: "POST", timeout: 2000 });
        req.on("error", () => {});
        req.end();
      }
    } catch {}

    // 2. Platform service manager (non-blocking on Windows)
    if (plat === "windows") {
      try { endTask(TASK_RAG); } catch {}
      try { endTask(TASK_MODELS); } catch {}
    } else if (plat === "linux") {
      try { execFileSync("systemctl", ["--user", "stop", "threadclaw-rag"], { stdio: "pipe", timeout: 10000 }); } catch {}
      try { execFileSync("systemctl", ["--user", "stop", "threadclaw-models"], { stdio: "pipe", timeout: 10000 }); } catch {}
    } else if (plat === "mac") {
      try { execFileSync("launchctl", ["stop", "com.threadclaw.rag"], { stdio: "pipe", timeout: 10000 }); } catch {}
      try { execFileSync("launchctl", ["stop", "com.threadclaw.models"], { stdio: "pipe", timeout: 10000 }); } catch {}
    }

    // 3. Clean up PID files (don't try to kill — HTTP shutdown handles it)
    for (const pidFile of [".threadclaw.pid", ".models.pid"]) {
      const pidPath = resolve(root, pidFile);
      try { if (existsSync(pidPath)) unlinkSync(pidPath); } catch {}
    }

    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Async force-kill: used by performServiceAction when ports are still open
 * after the graceful stop attempt. Runs taskkill/kill without blocking the
 * event loop (uses child_process.exec instead of execFileSync).
 */
export async function forceKillByPort(port: number): Promise<void> {
  // Validate port is a safe integer to prevent command injection
  const safePort = Math.floor(Number(port));
  if (!Number.isFinite(safePort) || safePort < 1 || safePort > 65535) return;

  const { exec } = await import("child_process");
  const plat = getPlatform();

  return new Promise((resolve) => {
    if (plat === "windows") {
      exec(`for /f "tokens=5" %a in ('netstat -ano ^| findstr :${safePort} ^| findstr LISTENING') do taskkill /F /PID %a`,
        { shell: "cmd.exe", timeout: 8000 },
        () => resolve());
    } else {
      exec(`lsof -ti :${safePort} | xargs kill -9 2>/dev/null`,
        { timeout: 5000 },
        () => resolve());
    }
  });
}

/** Install Windows scheduled tasks for ThreadClaw services (no admin required). */
export function installWindowsServices(root: string): { success: boolean; error?: string } {
  if (getPlatform() !== "windows") {
    return { success: false, error: "Windows services only available on Windows" };
  }
  return ensureWindowsTasks(root);
}

/** Remove Windows scheduled tasks for ThreadClaw services. */
export function removeWindowsServices(): { success: boolean } {
  deleteTask(TASK_RAG);
  deleteTask(TASK_MODELS);
  return { success: true };
}

// ── Linux: systemd service installer ──

export function installLinuxServices(root: string): { success: boolean; error?: string } {
  const pythonCmd = getPythonCmd();
  const nodeCmd = getNodeCmd();
  const entryArgs = findApiEntryArgs(root);
  const logsDir = resolve(root, "logs");
  mkdirSync(logsDir, { recursive: true });

  const userUnitDir = resolve(homedir(), ".config", "systemd", "user");
  mkdirSync(userUnitDir, { recursive: true });

  const modelsScript = findModelsScript(root);
  const modelsUnit = `[Unit]
Description=ThreadClaw Models (Embed + Rerank)
After=default.target

[Service]
Type=simple
WorkingDirectory=${dirname(modelsScript)}
ExecStart="${pythonCmd}" "${modelsScript}"
Restart=on-failure
RestartSec=5
StandardOutput=append:${resolve(logsDir, "models.log")}
StandardError=append:${resolve(logsDir, "models.log")}

[Install]
WantedBy=default.target
`;

  const ragUnit = `[Unit]
Description=ThreadClaw RAG (Search API)
After=default.target threadclaw-models.service
Requires=threadclaw-models.service

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart="${nodeCmd}" ${entryArgs.map(a => `"${a}"`).join(" ")}
Restart=on-failure
RestartSec=5
StandardOutput=append:${resolve(logsDir, "threadclaw.log")}
StandardError=append:${resolve(logsDir, "threadclaw.log")}

[Install]
WantedBy=default.target
`;

  try {
    writeFileSync(resolve(userUnitDir, "threadclaw-models.service"), modelsUnit);
    writeFileSync(resolve(userUnitDir, "threadclaw-rag.service"), ragUnit);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe", timeout: 10000 });
    execFileSync("systemctl", ["--user", "enable", "threadclaw-models", "threadclaw-rag"], { stdio: "pipe", timeout: 10000 });
    execFileSync("systemctl", ["--user", "start", "threadclaw-models"], { stdio: "pipe", timeout: 10000 });
    execFileSync("systemctl", ["--user", "start", "threadclaw-rag"], { stdio: "pipe", timeout: 10000 });
    // Enable lingering so user services survive logout
    try { execFileSync("loginctl", ["enable-linger"], { stdio: "pipe", timeout: 10000 }); } catch {}
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export function removeLinuxServices(): { success: boolean } {
  try {
    execFileSync("systemctl", ["--user", "stop", "threadclaw-rag", "threadclaw-models"], { stdio: "pipe", timeout: 10000 });
  } catch {}
  try {
    execFileSync("systemctl", ["--user", "disable", "threadclaw-rag", "threadclaw-models"], { stdio: "pipe", timeout: 10000 });
  } catch {}
  const userUnitDir = resolve(homedir(), ".config", "systemd", "user");
  try { unlinkSync(resolve(userUnitDir, "threadclaw-rag.service")); } catch {}
  try { unlinkSync(resolve(userUnitDir, "threadclaw-models.service")); } catch {}
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "pipe", timeout: 10000 });
  } catch {}
  return { success: true };
}

// ── macOS: launchd plist installer ──

export function installMacServices(root: string): { success: boolean; error?: string } {
  const pythonCmd = getPythonCmd();
  const nodeCmd = getNodeCmd();
  const entryArgs = findApiEntryArgs(root);
  const logsDir = resolve(root, "logs");
  const plistDir = resolve(homedir(), "Library", "LaunchAgents");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(plistDir, { recursive: true });

  const macModelsScript = findModelsScript(root);
  const modelsPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.threadclaw.models</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(pythonCmd)}</string>
    <string>${escapeXml(macModelsScript)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(dirname(macModelsScript))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(resolve(logsDir, "models.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(logsDir, "models.log"))}</string>
</dict>
</plist>
`;

  const ragPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.threadclaw.rag</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodeCmd)}</string>
${entryArgs.map(a => `    <string>${escapeXml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapeXml(resolve(logsDir, "threadclaw.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(logsDir, "threadclaw.log"))}</string>
</dict>
</plist>
`;

  try {
    const modelsPath = resolve(plistDir, "com.threadclaw.models.plist");
    const ragPath = resolve(plistDir, "com.threadclaw.rag.plist");
    writeFileSync(modelsPath, modelsPlist);
    writeFileSync(ragPath, ragPlist);
    // Unload first to handle reinstall case
    try { execFileSync("launchctl", ["unload", modelsPath], { stdio: "pipe", timeout: 10000 }); } catch {}
    try { execFileSync("launchctl", ["unload", ragPath], { stdio: "pipe", timeout: 10000 }); } catch {}
    execFileSync("launchctl", ["load", modelsPath], { stdio: "pipe", timeout: 10000 });
    execFileSync("launchctl", ["load", ragPath], { stdio: "pipe", timeout: 10000 });
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

export function removeMacServices(): { success: boolean } {
  const plistDir = resolve(homedir(), "Library", "LaunchAgents");
  const modelsPath = resolve(plistDir, "com.threadclaw.models.plist");
  const ragPath = resolve(plistDir, "com.threadclaw.rag.plist");
  try { execFileSync("launchctl", ["unload", ragPath], { stdio: "pipe", timeout: 10000 }); } catch {}
  try { execFileSync("launchctl", ["unload", modelsPath], { stdio: "pipe", timeout: 10000 }); } catch {}
  try { unlinkSync(ragPath); } catch {}
  try { unlinkSync(modelsPath); } catch {}
  return { success: true };
}

export function isAdmin(): boolean {
  if (getPlatform() !== "windows") return process.getuid?.() === 0;
  try {
    execFileSync("net", ["session"], { stdio: "pipe", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
