/**
 * Regression tests for the security hardening sweep.
 *
 * Covers:
 * 1. contentHashBytes determinism (binary dedup fix)
 * 2. Query parameter clamping (DoS prevention)
 * 3. No console.error in production code
 * 4. No unsafe execSync/spawn with shell in source
 * 5. No 0.0.0.0 binds in service files
 */

import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { resolve } from "path";
import { readdirSync, readFileSync, existsSync } from "fs";

const CLAWCORE_ROOT = resolve(__dirname, "..", "..");
const CLAWCORE_SRC = resolve(CLAWCORE_ROOT, "src");
const MEMORY_SRC = resolve(__dirname, "..", "src");

/**
 * Find the Python model server (server/server.py).
 */
function findModelServer(): string | null {
  const p = resolve(CLAWCORE_ROOT, "server", "server.py");
  return existsSync(p) ? p : null;
}

// ── 1. contentHashBytes determinism ──

describe("contentHashBytes", () => {
  it("returns identical hash for identical byte arrays", async () => {
    // Dynamic import to handle ESM (file outside memory-engine rootDir — resolved at runtime)
    // @ts-ignore TS6059: hash.ts is in parent ClawCore src/, not memory-engine
    const { contentHashBytes } = await import("../../src/utils/hash.js");
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xab]);
    const hash1 = await contentHashBytes(data);
    const hash2 = await contentHashBytes(data);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{16}$/); // 16-char hex
  });

  it("returns different hashes for different byte arrays", async () => {
    const { contentHashBytes } = await import("../../src/utils/hash.js");
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([4, 5, 6]);
    expect(await contentHashBytes(a)).not.toBe(await contentHashBytes(b));
  });
});

// ── 2. Query parameter clamping ──

describe("query parameter clamping", () => {
  it("clamps top_k to MAX_TOP_K (100)", async () => {
    // Read the route file and verify constants exist
    const { readFileSync } = await import("fs");
    const routeCode = readFileSync(resolve(CLAWCORE_SRC, "api", "query.routes.ts"), "utf-8");
    expect(routeCode).toContain("MAX_TOP_K = 100");
    expect(routeCode).toContain("MAX_TOKEN_BUDGET = 50000");
    expect(routeCode).toContain("clampTopK(top_k)");
    expect(routeCode).toContain("clampBudget(token_budget)");
  });

  it("pipeline has defense-in-depth clamp", async () => {
    const { readFileSync } = await import("fs");
    const pipelineCode = readFileSync(resolve(CLAWCORE_SRC, "query", "pipeline.ts"), "utf-8");
    expect(pipelineCode).toContain("Math.min(options.topK ?? config.defaults.queryTopK, 100)");
    expect(pipelineCode).toContain("Math.min(options.tokenBudget ?? config.defaults.queryTokenBudget, 50000)");
  });
});

// ── 3. No console.error in production source ──

describe("lint guards", () => {
  it("no console.error in API/ingest/query/storage code (use logger instead)", () => {
    // Only check server-side code where logger should be used.
    // CLI, TUI, and adapters legitimately use console.error for user-facing output.
    const dirs = ["api", "ingest", "query", "storage", "watcher", "utils"].map(
      (d) => `"${resolve(CLAWCORE_SRC, d)}"`,
    );
    const result = execSync(
      `grep -rn "console\\.error" ${dirs.join(" ")} --include="*.ts" || true`,
      { stdio: "pipe" },
    ).toString().trim();

    const violations = result
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => !l.includes(".test.ts"))
      .filter((l) => !l.includes("// "));

    expect(violations).toEqual([]);
  });

  it("no execSync with template literals in src/ (use execFileSync)", () => {
    // Match execSync(` — template literal = shell injection risk
    const result = execSync(
      `grep -rn "execSync(\\\`" "${CLAWCORE_SRC}" --include="*.ts" --include="*.tsx" || true`,
      { stdio: "pipe" },
    ).toString().trim();

    expect(result).toBe("");
  });

  it("no execSync with template literals in memory-engine/src/", () => {
    const result = execSync(
      `grep -rn "execSync(\\\`" "${MEMORY_SRC}" --include="*.ts" || true`,
      { stdio: "pipe" },
    ).toString().trim();

    expect(result).toBe("");
  });
  it("no spawn with { shell: true } in src/ (bypasses execFileSync safety)", () => {
    const result = execSync(
      `grep -rn "shell:\\s*true" "${CLAWCORE_SRC}" --include="*.ts" --include="*.tsx" || true`,
      { stdio: "pipe" },
    ).toString().trim();

    // Filter out comments and test files
    const violations = result
      .split("\n")
      .filter((l) => l.trim())
      .filter((l) => !l.includes(".test.ts"))
      .filter((l) => !l.includes("// "));

    expect(violations).toEqual([]);
  });

  it("no spawn with { shell: true } in memory-engine/src/", () => {
    const result = execSync(
      `grep -rn "shell:\\s*true" "${MEMORY_SRC}" --include="*.ts" || true`,
      { stdio: "pipe" },
    ).toString().trim();

    expect(result).toBe("");
  });
});

// ── 4. No 0.0.0.0 binds in service files ──

describe("network binding", () => {
  it("no hardcoded 0.0.0.0 in Python service files", () => {
    // Check both possible locations for Python service files
    const dirs = [
      resolve(CLAWCORE_ROOT, ".."),         // live install: services/
      resolve(CLAWCORE_ROOT, "server"),      // distribution: server/
    ].filter((d) => existsSync(d));
    let checked = 0;
    for (const dir of dirs) {
      const pyFiles = readdirSync(dir).filter((f) => f.endsWith(".py"));
      for (const f of pyFiles) {
        const content = readFileSync(resolve(dir, f), "utf-8");
        expect(content).not.toContain('host="0.0.0.0"');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("no hardcoded 0.0.0.0 in Node server startup", () => {
    const serverTs = readFileSync(resolve(CLAWCORE_SRC, "server.ts"), "utf-8");
    expect(serverTs).not.toContain('host: "0.0.0.0"');
  });
});

// ── 5. Python server binds to localhost ──

describe("python server binding", () => {
  it("server.py defaults to 127.0.0.1", () => {
    const serverPath = findModelServer();
    expect(serverPath).not.toBeNull();
    const serverPy = readFileSync(serverPath!, "utf-8");
    expect(serverPy).toContain('os.environ.get("MODEL_SERVER_HOST", "127.0.0.1")');
    expect(serverPy).not.toContain('host="0.0.0.0"');
  });
});

// ── 5. Temp file uses UUID (not Date.now) ──

describe("temp file naming", () => {
  it("ingest route uses randomUUID for temp files", async () => {
    const { readFileSync } = await import("fs");
    const ingestCode = readFileSync(resolve(CLAWCORE_SRC, "api", "ingest.routes.ts"), "utf-8");
    expect(ingestCode).toContain("randomUUID()");
    expect(ingestCode).not.toContain("_tmp_${Date.now()}");
  });
});

// ── 6. ePub uses spine order ──

describe("epub spine ordering", () => {
  it("epub parser reads OPF spine for reading order", async () => {
    const { readFileSync } = await import("fs");
    const epubCode = readFileSync(resolve(CLAWCORE_SRC, "ingest", "parsers", "epub.ts"), "utf-8");
    expect(epubCode).toContain("spineOrder");
    expect(epubCode).toContain("itemref");
    expect(epubCode).toContain("manifestItems");
    // Should NOT have shell commands
    expect(epubCode).not.toContain("execSync");
    expect(epubCode).not.toContain("unzip");
    expect(epubCode).not.toContain("Expand-Archive");
  });
});
