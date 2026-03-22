import { execFileSync } from "child_process";
import { release } from "os";

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
  if (process.env.CLAWCORE_TUI_PLAIN === "true") return false;
  if (process.env.NO_COLOR) return false;
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
  if (process.env.CLAWCORE_TUI_ASCII === "true") return false;
  if (!interactive) return false;

  if (process.platform !== "win32") return true;

  return Boolean(
    process.env.WT_SESSION
    || process.env.TERM_PROGRAM
    || process.env.PSModulePath,
  );
}

export function detectTerminalCapabilities(): TerminalCapabilities {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const rawMode = interactive && typeof process.stdin.setRawMode === "function";
  const forceRich = process.env.CLAWCORE_TUI_FORCE_RICH === "1";
  const ansi = forceRich ? true : hasAnsiSupport(interactive);
  const unicode = hasUnicodeSupport(interactive);
  const rich = interactive && rawMode && ansi && process.env.CLAWCORE_TUI_PLAIN !== "true";

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
        timeout: 4000,
      });
      windowsAnsiEnabled = true;
      return true;
    } catch {}
  }

  windowsAnsiEnabled = false;
  return false;
}
