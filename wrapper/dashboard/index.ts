/**
 * ArmorClaw Dashboard — entry point.
 *
 * Run with:
 *   node --experimental-strip-types wrapper/dashboard/index.ts
 *
 * Binds to 127.0.0.1:7390 and opens the browser automatically.
 * Ctrl-C exits cleanly.
 */

import { exec } from "node:child_process";
import { startServer, DASHBOARD_PORT } from "./server.ts";

function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  exec(command, (err) => {
    if (err) {
      process.stderr.write(`Could not open browser automatically. Open manually:\n  ${url}\n`);
    }
  });
}

async function main(): Promise<void> {
  process.stderr.write("Starting ArmorClaw dashboard…\n");

  const { port, close } = await startServer(DASHBOARD_PORT);
  const url = `http://localhost:${port}`;

  process.stderr.write(`Dashboard running at ${url}\n`);
  openBrowser(url);
  process.stderr.write("Press Ctrl-C to exit.\n");

  process.on("SIGINT", async () => {
    process.stderr.write("\nShutting down dashboard…\n");
    await close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Failed to start dashboard: ${message}\n`);
  process.exit(1);
});
