import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import { detectGpuAsyncImpl, type GpuInfo } from "./models.js";
import { getPlatform, getRootDir, getModelPort, getApiPort, type ServiceStatus } from "./platform.js";

const execFileAsync = promisify(execFile);

export async function checkServicesAsync(root = getRootDir()): Promise<ServiceStatus> {
  const result: ServiceStatus = {
    models: { running: false },
    threadclaw: { running: false },
  };

  const [modelsHealthy, threadclawHealthy] = await Promise.all([
    isPortReachable(getModelPort()),
    isPortReachable(getApiPort()),
  ]);

  if (modelsHealthy) result.models.running = true;
  if (threadclawHealthy) result.threadclaw.running = true;

  const platform = getPlatform();

  // If port check didn't find a service, fall back to OS service manager queries.
  // Note: On Windows, Task Scheduler may report "Running" before the port is open
  // (process starting up) or after the port closes (graceful shutdown lag).
  // The port check above is the source of truth for "healthy"; the task query
  // below catches the "starting" state so the TUI shows activity.
  if (!result.models.running || !result.threadclaw.running) {
    if (platform === "windows") {
      const [modelsState, ragState] = await Promise.all([
        runCommand("schtasks", ["/query", "/tn", "ThreadClaw_Models", "/fo", "csv", "/nh"]),
        runCommand("schtasks", ["/query", "/tn", "ThreadClaw_RAG", "/fo", "csv", "/nh"]),
      ]);
      if (!result.models.running) result.models.running = modelsState?.includes('"Running"') ?? false;
      if (!result.threadclaw.running) result.threadclaw.running = ragState?.includes('"Running"') ?? false;
    } else if (platform === "linux") {
      const [modelsService, threadclawService] = await Promise.all([
        runCommand("systemctl", ["--user", "is-active", "threadclaw-models"]),
        runCommand("systemctl", ["--user", "is-active", "threadclaw-rag"]),
      ]);
      if (!result.models.running) result.models.running = modelsService === "active";
      if (!result.threadclaw.running) result.threadclaw.running = threadclawService === "active";
    } else {
      const launchctl = await runCommand("launchctl", ["list"]);
      if (!result.models.running) result.models.running = launchctl?.includes("com.threadclaw.models") ?? false;
      if (!result.threadclaw.running) result.threadclaw.running = launchctl?.includes("com.threadclaw.rag") ?? false;
    }
  }

  if (!result.models.running) {
    const pid = readPid(resolve(root, ".models.pid"));
    if (pid && isPidAlive(pid)) result.models = { running: true, pid };
  }
  if (!result.threadclaw.running) {
    const pid = readPid(resolve(root, ".threadclaw.pid"));
    if (pid && isPidAlive(pid)) result.threadclaw = { running: true, pid };
  }

  // Final port reachability check — intentionally redundant with the initial check.
  // Covers race conditions where a service started between the first port check and
  // the PID file / service manager queries above.
  if (!result.models.running) result.models.running = await isPortReachable(getModelPort());
  if (!result.threadclaw.running) result.threadclaw.running = await isPortReachable(getApiPort());

  return result;
}

export async function checkAutoStartupAsync(): Promise<boolean> {
  const platform = getPlatform();

  if (platform === "windows") {
    const out = await runCommand("schtasks", ["/query", "/tn", "ThreadClaw_Models"]);
    return out !== null; // task exists = auto-start registered
  }

  if (platform === "linux") {
    const output = await runCommand("systemctl", ["--user", "is-enabled", "threadclaw-models"]);
    return output === "enabled";
  }

  return existsSync(resolve(homedir(), "Library", "LaunchAgents", "com.threadclaw.models.plist"));
}

export async function detectGpuAsync(): Promise<GpuInfo> {
  return detectGpuAsyncImpl();
}

/** TCP connect check — fast and reliable, no HTTP overhead or rate limiting. */
export async function isPortReachable(port: number, timeoutMs = 2000): Promise<boolean> {
  const { createConnection } = await import("net");
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function runCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 3000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function readPid(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as NodeJS.ErrnoException).code)
      : "";
    return code === "EPERM";
  }
}
