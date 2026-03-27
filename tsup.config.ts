import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    target: "node22",
    // node:sqlite is imported dynamically — the "node:" + "sqlite" pattern
    // prevents tsup from stripping the node: prefix during bundling.
  },
  {
    entry: ["src/cli/threadclaw.ts"],
    format: ["esm"],
    outDir: "dist/cli",
    sourcemap: true,
    target: "node22",
    // node:sqlite is imported dynamically — the "node:" + "sqlite" pattern
    // prevents tsup from stripping the node: prefix during bundling.
  },
]);
