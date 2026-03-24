import chalk from "chalk";
import { getTerminalCapabilities } from "./capabilities.js";

/**
 * ThreadClaw TUI theme.
 * Falls back to ASCII-safe output when the terminal is limited.
 */
export const t = {
  title: chalk.bold.green,
  subtitle: chalk.dim.green,
  brand: chalk.bold.white,
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  info: chalk.blue,
  dim: chalk.dim,
  highlight: chalk.bold.greenBright,
  selected: chalk.green,
  muted: chalk.gray,
  label: chalk.bold,
  value: chalk.white,
  path: chalk.underline.dim,
  code: chalk.italic.gray,
  brandAccent: chalk.hex("#e72d19"),
  tag: chalk.magenta,
};

export function banner(): string {
  const caps = getTerminalCapabilities();
  const r = chalk.hex("#e72d19");
  const w = chalk.bold.white;

  if (!caps.unicode) {
    return [
      "",
      r("  THREADCLAW"),
      w("  Premium RAG for OpenClaw"),
      "",
    ].join("\n");
  }

  return [
    "",
    `              ${r("🦞")} ${w("THREADCLAW")} ${r("🦞")}`,
    `          ${chalk.dim("RSMA So Good It Pinches")}`,
    "",
  ].join("\n");
}

export function section(title: string): string {
  const caps = getTerminalCapabilities();
  const bar = caps.unicode ? "===" : "---";
  return `\n${t.title(`${bar} ${title} ${bar}`)}\n`;
}

export function status(label: string, ok: boolean, detail?: string): string {
  const caps = getTerminalCapabilities();
  const glyph = caps.unicode ? (ok ? "●" : "○") : (ok ? "*" : "o");
  const icon = ok ? t.ok(glyph) : t.err(glyph);
  const det = detail ? t.dim(` ${detail}`) : "";
  return `  ${icon} ${t.label(label)}${det}`;
}

export function kvLine(key: string, value: string): string {
  return `  ${t.dim(key + ":")} ${t.value(value)}`;
}

export function clearScreen(): void {
  const caps = getTerminalCapabilities();
  if (caps.ansi) {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    return;
  }
  console.clear();
}
