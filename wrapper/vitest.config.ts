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
      include: ["security/**/*.ts"],
      exclude: ["security/**/*.test.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
