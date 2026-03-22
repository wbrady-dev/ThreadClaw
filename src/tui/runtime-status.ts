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
    clawcore: { running: false },
  };

  const [modelsHealthy, clawcoreHealthy] = await Promise.all([
    isPortReachable(getModelPort()),
    isPortReachable(getApiPort()),
  ]);

  if (modelsHealthy) result.models.running = true;
  if (clawcoreHealthy) result.clawcore.running = true;

  const platform = getPlatform();

  if (!result.models.running || !result.clawcore.running) {
    if (platform === "windows") {
      const [modelsState, ragState] = await Promise.all([
        runCommand("schtasks", ["/query", "/tn", "ClawCore_Models", "/fo", "csv", "/nh"]),
        runCommand("schtasks", ["/query", "/tn", "ClawCore_RAG", "/fo", "csv", "/nh"]),
      ]);
      if (!result.models.running) result.models.running = modelsState?.includes('"Running"') ?? false;
      if (!result.clawcore.running) result.clawcore.running = ragState?.includes('"Running"') ?? false;
    } else if (platform === "linux") {
      const [modelsService, clawcoreService] = await Promise.all([
        runCommand("systemctl", ["--user", "is-active", "clawcore-models"]),
        runCommand("systemctl", ["--user", "is-active", "clawcore-rag"]),
      ]);
      if (!result.models.running) result.models.running = modelsService === "active";
      if (!result.clawcore.running) result.clawcore.running = clawcoreService === "active";
    } else {
      const launchctl = await runCommand("launchctl", ["list"]);
      if (!result.models.running) result.models.running = launchctl?.includes("com.clawcore.models") ?? false;
      if (!result.clawcore.running) result.clawcore.running = launchctl?.includes("com.clawcore.rag") ?? false;
    }
  }

  if (!result.models.running) {
    const pid = readPid(resolve(root, ".models.pid"));
    if (pid && isPidAlive(pid)) result.models = { running: true, pid };
  }
  if (!result.clawcore.running) {
    const pid = readPid(resolve(root, ".clawcore.pid"));
    if (pid && isPidAlive(pid)) result.clawcore = { running: true, pid };
  }

  if (!result.models.running) result.models.running = await isPortReachable(getModelPort());
  if (!result.clawcore.running) result.clawcore.running = await isPortReachable(getApiPort());

  return result;
}

export async function checkAutoStartupAsync(): Promise<boolean> {
  const platform = getPlatform();

  if (platform === "windows") {
    const out = await runCommand("schtasks", ["/query", "/tn", "ClawCore_Models"]);
    return out !== null; // task exists = auto-start registered
  }

  if (platform === "linux") {
    const output = await runCommand("systemctl", ["--user", "is-enabled", "clawcore-models"]);
    return output === "enabled";
  }

  return existsSync(resolve(homedir(), "Library", "LaunchAgents", "com.clawcore.models.plist"));
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
