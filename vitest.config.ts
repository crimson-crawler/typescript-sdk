import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      // Public API surface = the hand-written wrapper. The generated
      // layer (src/_generated/) is codegen output mocked by the suites, so it
      // is excluded — counting it would crater the % and mean nothing.
      provider: "v8",
      reporter: ["text", "cobertura"],
      reportsDirectory: "coverage",
      include: ["src/**"],
      exclude: ["src/_generated/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80,
      },
    },
  },
});
