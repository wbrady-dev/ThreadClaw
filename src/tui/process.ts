import { spawn } from "child_process";

export interface StreamedCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Inactivity timeout in ms. Default 120_000. Set 0 to disable. */
  activityTimeoutMs?: number;
  onLine?: (line: string, source: "stdout" | "stderr") => void;
  spawnImpl?: typeof spawn;
}

export interface StreamedCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runStreamedCommand(
  command: string,
  args: string[],
  options: StreamedCommandOptions = {},
): Promise<StreamedCommandResult> {
  return new Promise((resolve, reject) => {
    const spawnImpl = options.spawnImpl ?? spawn;
    // On Windows, .cmd/.bat files need cmd.exe to execute.
    // Node 24 deprecated shell:true for .cmd files (DeprecationWarning + hangs).
    // Instead, spawn cmd.exe directly with /c to avoid shell:true entirely.
    let spawnCmd = command;
    let spawnArgs = args;
    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
      spawnCmd = process.env.COMSPEC ?? "cmd.exe";
      spawnArgs = ["/c", command, ...args];
    }
    const child = spawnImpl(spawnCmd, spawnArgs, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let lastActivity = Date.now();
    let activityCheck: NodeJS.Timeout | null = null;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (activityCheck) clearInterval(activityCheck);
      fn();
    };

    // Kill the process if no stdout/stderr output for activityTimeoutMs (default 120s).
    // Set activityTimeoutMs=0 to disable (e.g. for large model downloads).
    const activityLimit = options.activityTimeoutMs ?? 120_000;
    if (activityLimit > 0) {
      activityCheck = setInterval(() => {
        if (settled) return;
        const idle = Date.now() - lastActivity;
        if (idle > activityLimit) {
          try { child.kill(); } catch {}
          // Follow up with SIGKILL if the process doesn't exit after SIGTERM
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
          finish(() => reject(new Error(`Command stalled: no output for ${Math.round(idle / 1000)}s`)));
        }
      }, 10_000);
    }

    const emitBufferedLines = (chunk: string, source: "stdout" | "stderr", carry: string): string => {
      const combined = carry + chunk;
      // Split on \n, \r\n, or standalone \r so pip/HuggingFace progress bars
      // (which use \r to overwrite) are emitted as individual updates.
      const parts = combined.split(/\r\n|\n|\r/);
      const remainder = parts.pop() ?? "";
      for (const part of parts) {
        const clean = sanitizeCommandLine(part);
        if (clean) options.onLine?.(clean, source);
      }
      return remainder;
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      lastActivity = Date.now();
      stdoutBuffer = emitBufferedLines(text, "stdout", stdoutBuffer);
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      lastActivity = Date.now();
      stderrBuffer = emitBufferedLines(text, "stderr", stderrBuffer);
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      const lastStdout = sanitizeCommandLine(stdoutBuffer);
      const lastStderr = sanitizeCommandLine(stderrBuffer);
      if (lastStdout) options.onLine?.(lastStdout, "stdout");
      if (lastStderr) options.onLine?.(lastStderr, "stderr");

      finish(() => {
        if (code === 0) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const message = lastStderr || lastStdout || `Command failed with exit code ${code ?? "unknown"}`;
        const error = new Error(message) as Error & { exitCode?: number | null };
        error.exitCode = code;
        reject(error);
      });
    });

    if (options.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        try { child.kill(); } catch {}
        // Follow up with SIGKILL if process doesn't exit after SIGTERM
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 3000);
        finish(() => reject(new Error(`Command timed out after ${options.timeoutMs}ms`)));
      }, options.timeoutMs);
    }
  });
}

export function sanitizeCommandLine(line: string): string {
  return line
    // Strip all ANSI escape sequences (SGR, cursor movement, erase, OSC, etc.)
    .replace(/\x1b(?:\[[0-9;]*[A-Za-z]|\][^\x07]*\x07|\(B)/g, "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, 160);
}
