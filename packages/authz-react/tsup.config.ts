import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // The build config excludes the tests; the plain tsconfig.json includes them so
  // that `typecheck` covers them too. Two questions, two files.
  tsconfig: "tsconfig.build.json",
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
