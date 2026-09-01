import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      // `src/index.ts` is NOT excluded: the barrel being invisible to coverage is what let a
      // dropped export line show up as neither a failing test nor a gap. `index.test.ts`
      // imports it, so the exclusion has nothing left to hide.
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
