import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { app } from "electron";
import { logger } from "./logger";
import { buildWrapperContext } from "./wrapper-context";

const COMMON_INSTALL_PATHS = [
  "/usr/local/bin/openclaw",
  "/opt/homebrew/bin/openclaw",
  join(process.env["HOME"] ?? "", ".npm-global/bin/openclaw"),
];

const MIN_OPENCLAW_VERSION = "0.1.0";

let openClawProcess: ChildProcess | undefined;
let messageHandler: ((message: string) => void) | undefined;

export function setMessageHandler(handler: (message: string) => void): void {
  messageHandler = handler;
}

function findOpenClaw(): string | undefined {
  try {
    const pathResult = execFileSync("which", ["openclaw"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (pathResult) return pathResult;
  } catch {
    // not on PATH
  }

  for (const p of COMMON_INSTALL_PATHS) {
    if (existsSync(p)) return p;
  }

  return undefined;
}

function getOpenClawVersion(binaryPath: string): string | undefined {
  try {
    const output = execFileSync(binaryPath, ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const match = /(\d+\.\d+\.\d+)/.exec(output);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export interface OpenClawStatus {
  found: boolean;
  path?: string;
  version?: string;
  meetsMinimum: boolean;
}

export function detectOpenClaw(): OpenClawStatus {
  const path = findOpenClaw();
  if (!path) {
    logger.warn("OpenClaw not found on PATH or common install locations");
    return { found: false, meetsMinimum: false };
  }

  const version = getOpenClawVersion(path);
  const meetsMinimum = version
    ? compareVersions(version, MIN_OPENCLAW_VERSION) >= 0
    : false;

  logger.info(
    `OpenClaw found at ${path}, version ${version ?? "unknown"}, meets minimum: ${meetsMinimum}`,
  );

  return { found: true, path, version, meetsMinimum };
}

export function spawnOpenClaw(
  workspaceName: string,
  projectName: string,
): ChildProcess | undefined {
  const status = detectOpenClaw();

  if (!status.found || !status.path) {
    logger.warn("OpenClaw not available — skipping subprocess spawn");
    emitMessage("OpenClaw is not installed. Install it to enable the AI agent.");
    return undefined;
  }

  if (!status.meetsMinimum) {
    logger.warn(
      `OpenClaw version ${status.version ?? "unknown"} is below minimum ${MIN_OPENCLAW_VERSION}`,
    );
    emitMessage(
      `OpenClaw version ${status.version ?? "unknown"} is below the minimum required (${MIN_OPENCLAW_VERSION}). Please update.`,
    );
    return undefined;
  }

  const auditLogPath = join(app.getPath("userData"), "audit.log");
  const brainDirectoryPath = app.getPath("userData");

  const wrapperContext = buildWrapperContext({
    workspaceName,
    projectName,
    auditLogPath,
    brainDirectoryPath,
  });

  logger.info("Spawning OpenClaw subprocess");

  const child = spawn(status.path, ["--system-prompt", wrapperContext], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString("utf-8").trim();
    if (text) emitMessage(text);
  });

  child.stderr?.on("data", (data: Buffer) => {
    logger.error("OpenClaw stderr:", data.toString("utf-8").trim());
  });

  child.on("exit", (code, signal) => {
    logger.info(`OpenClaw exited with code=${code} signal=${signal}`);
    openClawProcess = undefined;
  });

  child.on("error", (err) => {
    logger.error("OpenClaw spawn error:", err.message);
    openClawProcess = undefined;
  });

  openClawProcess = child;
  return child;
}

function emitMessage(message: string): void {
  if (messageHandler) {
    messageHandler(message);
  }
}

export function killOpenClaw(): void {
  if (openClawProcess) {
    logger.info("Killing OpenClaw subprocess");
    openClawProcess.kill("SIGTERM");
    openClawProcess = undefined;
  }
}
