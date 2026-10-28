import { defineConfig } from "vitest/config"

export default defineConfig({
  // Oxc does not resolve TypeScript package exports; tsc still checks the project configs.
  tsconfig: "./node_modules/@wirecat/cli-base/config/tsconfig.base.json",
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    maxWorkers: 4,
    setupFiles: ["@wirecat/cli-base/testing/setup", "src/testing/sandbox.ts"],
    globalSetup: ["src/testing/argv-log.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        // Test setup: the sandbox and the argv log run only under vitest.
        "src/testing/**",
        // The entry point: one line handing argv to run(), which the suite drives directly.
        "src/bin/**",
      ],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        "src/**": { lines: 95, statements: 92, functions: 85, branches: 75, perFile: { lines: 50 } },
      },
    },
  },
})
