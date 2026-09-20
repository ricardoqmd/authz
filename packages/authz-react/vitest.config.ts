import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A provider and its hooks only run inside a rendered tree, and rendering needs a DOM.
    environment: "jsdom",
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      // `src/index.ts` is NOT excluded: the barrel being invisible to coverage is what let a
      // dropped export line show up as neither a failing test nor a gap. `index.test.ts`
      // imports it, so the exclusion has nothing left to hide.
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      reporter: ["text", "lcov"],
    },
  },
});
