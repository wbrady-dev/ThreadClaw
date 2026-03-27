import { describe, it, expect } from "vitest";
import { Command } from "commander";

/**
 * CLI tests for threadclaw.
 *
 * We cannot import threadclaw.ts directly because it calls program.parse() and
 * launches the TUI at module scope. Instead we recreate the command tree to
 * verify that subcommands register and parse correctly, and test that key
 * modules import without error.
 */

describe("CLI command structure", () => {
  it("commander is importable", () => {
    expect(Command).toBeDefined();
    expect(typeof Command).toBe("function");
  });

  it("can create a threadclaw-shaped program without error", () => {
    const program = new Command();
    program
      .name("threadclaw")
      .description("State-of-the-art RAG system for OpenClaw")
      .version("0.3.0");

    expect(program.name()).toBe("threadclaw");
    expect(program.description()).toBe("State-of-the-art RAG system for OpenClaw");
  });

  // TODO: This test was a tautology (registers stubs then checks they exist).
  // Rewrite to import actual command registrations from src/cli/ modules once
  // the CLI is refactored to export command builders separately from parse().
  it("registers expected subcommand names (placeholder)", () => {
    const program = new Command();
    program.name("threadclaw").version("0.3.0");

    const expectedCommands = [
      "query",
      "ingest",
      "search",
      "delete",
      "chunks",
      "collections",
      "watch",
      "serve",
      "status",
      "relations",
      "doctor",
      "upgrade",
      "integrate",
      "install",
      "uninstall",
    ];

    // Register stub subcommands — this only tests commander, not our code.
    // See TODO above for the real fix.
    for (const name of expectedCommands) {
      program.addCommand(new Command(name).description(`${name} command`));
    }

    const registeredNames = program.commands.map((c) => c.name());
    for (const name of expectedCommands) {
      expect(registeredNames).toContain(name);
    }
  });

  it("--version outputs version string", () => {
    const program = new Command();
    program.name("threadclaw").version("0.3.0").exitOverride();

    let output = "";
    program.configureOutput({
      writeOut: (str: string) => { output += str; },
      writeErr: (str: string) => { output += str; },
    });

    try {
      program.parse(["--version"], { from: "user" });
    } catch (e: any) {
      // Commander throws on --version with exitOverride
      expect(e.exitCode).toBe(0);
    }
    expect(output).toContain("0.3.0");
  });

  it("--help outputs help text", () => {
    const program = new Command();
    program
      .name("threadclaw")
      .description("State-of-the-art RAG system for OpenClaw")
      .version("0.3.0")
      .exitOverride();

    program.addCommand(new Command("query").description("Query documents"));
    program.addCommand(new Command("ingest").description("Ingest documents"));

    let output = "";
    program.configureOutput({
      writeOut: (str: string) => { output += str; },
      writeErr: (str: string) => { output += str; },
    });

    try {
      program.parse(["--help"], { from: "user" });
    } catch (e: any) {
      expect(e.exitCode).toBe(0);
    }
    expect(output).toContain("threadclaw");
    expect(output).toContain("query");
    expect(output).toContain("ingest");
  });

  it("parses subcommand without executing", () => {
    const program = new Command();
    program.name("threadclaw").version("0.3.0").exitOverride();

    let called = false;
    program.addCommand(
      new Command("status")
        .description("Show status")
        .action(() => { called = true; }),
    );

    program.parse(["status"], { from: "user" });
    expect(called).toBe(true);
  });
});

describe("CLI module imports", () => {
  it("version module exports getAppVersion with a semver-like string", async () => {
    const mod = await import("../../src/version.js");
    expect(typeof mod.getAppVersion).toBe("function");
    const version = mod.getAppVersion();
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("parser index module exports getParser and getSupportedExtensions with real results", async () => {
    const mod = await import("../../src/ingest/parsers/index.js");
    expect(typeof mod.getParser).toBe("function");
    expect(typeof mod.getSupportedExtensions).toBe("function");
    // Strengthen: verify actual extensions are returned
    const exts = mod.getSupportedExtensions();
    expect(exts.length).toBeGreaterThan(0);
    expect(exts).toContain(".txt");
    expect(exts).toContain(".md");
  });
});

// TODO: Zero actual CLI logic tested — the CLI entry point (src/cli/threadclaw.ts)
// calls program.parse() at module scope, making it hard to unit-test.
// Refactor CLI to export a buildProgram() function, then add tests that:
// 1. Verify each subcommand's option parsing (e.g., --collection, --top-k)
// 2. Test actual command handlers with mocked dependencies
// 3. Verify error handling for invalid arguments
