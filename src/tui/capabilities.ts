import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir, release } from "os";
import { resolve } from "path";

export interface TerminalCapabilities {
  interactive: boolean;
  rawMode: boolean;
  ansi: boolean;
  unicode: boolean;
  rich: boolean;
  plain: boolean;
}

const DEFAULT_CAPABILITIES: TerminalCapabilities = {
  interactive: false,
  rawMode: false,
  ansi: false,
  unicode: false,
  rich: false,
  plain: true,
};

let currentCapabilities: TerminalCapabilities = DEFAULT_CAPABILITIES;
let windowsAnsiEnabled = false;
let windowsAnsiTried = false;

function hasAnsiSupport(interactive: boolean): boolean {
  if (process.env.THREADCLAW_TUI_PLAIN === "true") return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (process.stdout.isTTY !== true) return false;

  if (process.platform !== "win32") {
    return true;
  }

  if (hasNodeColorSupport()) {
    return true;
  }

  if (process.env.WT_SESSION
    || process.env.ANSICON
    || process.env.ConEmuANSI === "ON"
    || process.env.TERM_PROGRAM
    || process.env.TERM) {
    return true;
  }

  if (enableWindowsAnsiIfPossible()) {
    return true;
  }

  // PowerShell 5.x often lacks the usual ANSI env hints even on modern
  // Windows consoles that can still render Ink and ANSI output correctly.
  if (interactive && isPowerShellHost() && isModernWindowsConsole()) {
    return true;
  }

  return false;
}

function hasUnicodeSupport(interactive: boolean): boolean {
  if (process.env.THREADCLAW_TUI_ASCII === "true") return false;
  if (!interactive) return false;

  if (process.platform !== "win32") return true;

  // Heuristic: Windows Terminal, VS Code, and PowerShell hosts all set at
  // least one of these env vars. This isn't perfect — a user with a unicode-
  // capable console that sets none of these would get ASCII fallback.
  return Boolean(
    process.env.WT_SESSION
    || process.env.TERM_PROGRAM
    || process.env.PSModulePath,
  );
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  const forceRich = process.env.THREADCLAW_TUI_FORCE_RICH === "1";
  const interactive = forceRich ? true : (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const rawMode = forceRich ? true : (interactive && typeof process.stdin.setRawMode === "function");
  const ansi = forceRich ? true : hasAnsiSupport(interactive);
  const unicode = hasUnicodeSupport(interactive);
  const rich = interactive && rawMode && ansi && process.env.THREADCLAW_TUI_PLAIN !== "true";

  return {
    interactive,
    rawMode,
    ansi,
    unicode,
    rich,
    plain: !rich,
  };
}

export function setTerminalCapabilities(capabilities: TerminalCapabilities): void {
  currentCapabilities = capabilities;
}

export function getTerminalCapabilities(): TerminalCapabilities {
  return currentCapabilities;
}

function hasNodeColorSupport(): boolean {
  const stream = process.stdout as NodeJS.WriteStream & {
    hasColors?: (...args: unknown[]) => boolean;
    getColorDepth?: (...args: unknown[]) => number;
  };

  try {
    if (typeof stream.hasColors === "function" && stream.hasColors()) {
      return true;
    }
  } catch {}

  try {
    if (typeof stream.getColorDepth === "function" && stream.getColorDepth() > 1) {
      return true;
    }
  } catch {}

  return false;
}

function isPowerShellHost(): boolean {
  return process.platform === "win32" && Boolean(process.env.PSModulePath);
}

function isModernWindowsConsole(): boolean {
  if (process.platform !== "win32") return false;
  const [major = 0, , build = 0] = release().split(".").map((value) => parseInt(value, 10) || 0);
  return major > 10 || (major === 10 && build >= 10586);
}

function enableWindowsAnsiIfPossible(): boolean {
  if (process.platform !== "win32") return false;
  if (windowsAnsiTried) return windowsAnsiEnabled;

  windowsAnsiTried = true;

  // Check file-based cache to avoid spawning PowerShell synchronously on every launch.
  // Cache is valid for 24 hours — console capabilities rarely change.
  const cacheDir = resolve(homedir(), ".threadclaw");
  try { mkdirSync(cacheDir, { recursive: true }); } catch {}
  const cacheFile = resolve(cacheDir, "ansi-cache.json");
  try {
    if (existsSync(cacheFile)) {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      if (cached && typeof cached.result === "boolean" && Date.now() - cached.ts < 86400000) {
        windowsAnsiEnabled = cached.result;
        return windowsAnsiEnabled;
      }
    }
  } catch {}

  const command = [
    "$signature = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class NativeMethods {",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr hConsoleHandle, out int lpMode);",
    "  [DllImport(\"kernel32.dll\", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr hConsoleHandle, int dwMode);",
    "}",
    "'@",
    "Add-Type -TypeDefinition $signature -ErrorAction Stop | Out-Null",
    "$enabled = $false",
    "foreach ($id in @(-11, -12)) {",
    "  $handle = [NativeMethods]::GetStdHandle($id)",
    "  $mode = 0",
    "  if ([NativeMethods]::GetConsoleMode($handle, [ref]$mode)) {",
    "    if ([NativeMethods]::SetConsoleMode($handle, ($mode -bor 0x0004))) { $enabled = $true }",
    "  }",
    "}",
    "if ($enabled) { exit 0 }",
    "exit 1",
  ].join("\n");

  for (const shell of ["powershell", "pwsh"]) {
    try {
      execFileSync(shell, ["-NoProfile", "-Command", command], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 1500,
      });
      windowsAnsiEnabled = true;
      try { writeFileSync(cacheFile, JSON.stringify({ result: true, ts: Date.now() })); } catch {}
      return true;
    } catch {}
  }

  windowsAnsiEnabled = false;
  try { writeFileSync(cacheFile, JSON.stringify({ result: false, ts: Date.now() })); } catch {}
  return false;
}
