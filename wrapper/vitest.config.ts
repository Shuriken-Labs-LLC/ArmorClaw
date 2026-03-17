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
      include: [
        "security/**/*.ts",
        "lib/**/*.ts",
        "token-tracker/**/*.ts",
        "digest/**/*.ts",
        "undo/**/*.ts",
        "onboarding/**/*.ts",
        "dashboard/**/*.ts",
      ],
      exclude: [
        "security/**/*.test.ts",
        "lib/**/*.test.ts",
        "token-tracker/**/*.test.ts",
        "digest/**/*.test.ts",
        "undo/**/*.test.ts",
        "onboarding/**/*.test.ts",
        "onboarding/index.ts",
        "onboarding/server.ts",
        "onboarding/tailscale.ts",
        "dashboard/**/*.test.ts",
        "dashboard/index.ts",
        "dashboard/server.ts",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
        // Per-file overrides: security/, lib/, and undo/ stay at 100%
        "security/**/*.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "lib/**/*.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        "undo/**/*.ts": { lines: 100, functions: 100, branches: 100, statements: 100 },
        // Onboarding validators target: 75% minimum
        "onboarding/validators.ts": { lines: 75, functions: 75, branches: 75, statements: 75 },
      },
    },
  },
});
