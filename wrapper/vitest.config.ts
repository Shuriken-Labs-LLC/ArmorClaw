import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { pluginSdkSubpaths } from "../scripts/lib/plugin-sdk-entries.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  resolve: {
    alias: [
      ...pluginSdkSubpaths.map((subpath) => ({
        find: `openclaw/plugin-sdk/${subpath}`,
        replacement: path.join(repoRoot, "src", "plugin-sdk", `${subpath}.ts`),
      })),
      {
        find: "openclaw/plugin-sdk",
        replacement: path.join(repoRoot, "src", "plugin-sdk", "index.ts"),
      },
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "security/**/*.test.ts"],
    root: path.dirname(fileURLToPath(import.meta.url)),
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      all: true,
      include: ["security/**/*.ts", "lib/**/*.ts", "token-tracker/**/*.ts", "digest/**/*.ts"],
      exclude: [
        "security/**/*.test.ts",
        "lib/**/*.test.ts",
        "token-tracker/**/*.test.ts",
        "digest/**/*.test.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
        // Per-file overrides: security/ and lib/ stay at 100%
        "security/**/*.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "lib/**/*.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
      },
    },
  },
});
