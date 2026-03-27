import chalk from "chalk";
import { getTerminalCapabilities } from "./capabilities.js";

/**
 * ThreadClaw TUI theme.
 * Falls back to ASCII-safe / plain output when the terminal is limited.
 * When caps.plain is true, all color functions become identity (passthrough).
 */

const identity = (s: string) => s;

function buildTheme() {
  const caps = getTerminalCapabilities();
  if (caps.plain) {
    // No ANSI colors — return identity functions for every slot
    return {
      title: identity, subtitle: identity, brand: identity, ok: identity,
      warn: identity, err: identity, info: identity, dim: identity,
      highlight: identity, selected: identity, muted: identity, label: identity,
      value: identity, path: identity, code: identity, brandAccent: identity, tag: identity,
    };
  }
  return {
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
}

// Lazy-init: theme is built on first access so capabilities are resolved.
let _theme: ReturnType<typeof buildTheme> | null = null;
export const t = new Proxy({} as ReturnType<typeof buildTheme>, {
  get(_target, prop: string) {
    if (!_theme) _theme = buildTheme();
    return (_theme as any)[prop];
  },
});

// Module-level chalk instances for banner() — avoids recreating on every call.
const bannerRed = chalk.hex("#e72d19");
const bannerWhite = chalk.bold.white;

export function banner(): string {
  const caps = getTerminalCapabilities();

  if (!caps.unicode) {
    return [
      "",
      bannerRed("  THREADCLAW"),
      bannerWhite("  Premium RAG for OpenClaw"),
      "",
    ].join("\n");
  }

  return [
    "",
    `              ${bannerRed("🦞")} ${bannerWhite("THREADCLAW")} ${bannerRed("🦞")}`,
    `          ${chalk.dim("RSMA So Good It Pinches")}`,
    "",
  ].join("\n");
}

export function section(title: string): string {
  const caps = getTerminalCapabilities();
  // Use Unicode box-drawing character for unicode terminals, ASCII dashes otherwise
  const bar = caps.unicode ? "\u2550\u2550\u2550" : "---";
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
