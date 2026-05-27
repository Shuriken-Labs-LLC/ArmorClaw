import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

type LogLevel = "info" | "warn" | "error" | "debug";

let logFilePath: string | undefined;

function getLogPath(): string {
  if (!logFilePath) {
    const userDataPath = app.getPath("userData");
    mkdirSync(userDataPath, { recursive: true });
    logFilePath = join(userDataPath, "armorclaw.log");
  }
  return logFilePath;
}

function formatLine(level: LogLevel, msg: string): string {
  return `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
}

function write(level: LogLevel, msg: string, ...args: unknown[]): void {
  const parts = [msg, ...args.map((a) => (typeof a === "string" ? a : JSON.stringify(a)))];
  const line = formatLine(level, parts.join(" "));

  if (app.isReady()) {
    try {
      appendFileSync(getLogPath(), line);
    } catch {
      // best effort
    }
  }

  switch (level) {
    case "error":
      process.stderr.write(line);
      break;
    case "warn":
      process.stderr.write(line);
      break;
    default:
      process.stdout.write(line);
      break;
  }
}

export const logger = {
  info: (msg: string, ...args: unknown[]) => write("info", msg, ...args),
  warn: (msg: string, ...args: unknown[]) => write("warn", msg, ...args),
  error: (msg: string, ...args: unknown[]) => write("error", msg, ...args),
  debug: (msg: string, ...args: unknown[]) => write("debug", msg, ...args),

  initLogFile(): void {
    try {
      writeFileSync(getLogPath(), formatLine("info", "ArmorClaw starting"));
    } catch {
      // best effort
    }
  },
};
