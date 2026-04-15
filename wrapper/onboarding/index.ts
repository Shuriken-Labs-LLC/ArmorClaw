/**
 * ArmorClaw onboarding wizard — entry point.
 *
 * Run with:
 *   node wrapper/onboarding/index.ts
 *   node --experimental-strip-types wrapper/onboarding/index.ts
 *   node --import tsx wrapper/onboarding/index.ts
 *
 * The server binds to 127.0.0.1 only and opens the default browser
 * automatically. Ctrl-C exits cleanly.
 */

import { exec } from "node:child_process";
import { startServer } from "./server.ts";

const PREFERRED_PORT = 7391;

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;
  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      process.stderr.write(
        `Could not open browser automatically. Open this URL manually:\n  ${url}\n`,
      );
    }
  });
}

async function main(): Promise<void> {
  process.stderr.write("Starting ArmorClaw onboarding wizard…\n");

  const { port, close } = await startServer(PREFERRED_PORT);
  const url = `http://localhost:${port}`;

  process.stderr.write(`Wizard server running at ${url}\n`);

  await openBrowser(url);

  process.stderr.write("Opening in your browser. Complete setup there.\n");
  process.stderr.write("Press Ctrl-C to exit.\n");

  // Keep alive — the server handles everything from here
  process.on("SIGINT", async () => {
    process.stderr.write("\nShutting down onboarding wizard…\n");
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
  process.stderr.write(`Failed to start onboarding wizard: ${message}\n`);
  process.exit(1);
});
