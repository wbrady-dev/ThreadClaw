import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 15000,
    include: ["test/**/*.test.ts"],
    // NOTE: TUI tests use a custom harness (test/tui/run.ts) and are run
    // separately via `npm run test:tui`. See TODO in test/tui/run.ts about
    // migrating to vitest.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/tui/**"],
      reporter: ["text", "lcov"],
    },
  },
});
