import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/fixtures/**", "**/benchmarks/**"],
    passWithNoTests: false,
    environment: "node",
    testTimeout: 10_000,
  },
});
