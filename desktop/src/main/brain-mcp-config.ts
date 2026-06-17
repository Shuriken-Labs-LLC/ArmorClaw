import { app } from "electron";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { logger } from "./logger";

export interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
}

export function writeMcpConfig(projectId: string, workspaceId: string): string {
  const userData = app.getPath("userData");
  const dbPath = join(userData, "armorclaw.db");
  const auditPath = join(userData, "audit.log");
  const configDir = join(userData, "mcp-config");

  mkdirSync(configDir, { recursive: true });

  const brainMcpPath = app.isPackaged
    ? join(process.resourcesPath, "brain-mcp", "index.js")
    : join(__dirname, "../../resources/brain-mcp/index.js");

  const config: McpConfig = {
    mcpServers: {
      "armorclaw-brain": {
        command: "node",
        args: [brainMcpPath],
        env: {
          ARMORCLAW_DB_PATH: dbPath,
          ARMORCLAW_PROJECT_ID: projectId,
          ARMORCLAW_WORKSPACE_ID: workspaceId,
          ARMORCLAW_AUDIT_PATH: auditPath,
        },
      },
    },
  };

  const configPath = join(configDir, "mcp.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  logger.info(`MCP config written to ${configPath}`);
  return configPath;
}

export function writeActiveContext(projectId: string, workspaceId: string): void {
  const userData = app.getPath("userData");
  const activePath = join(userData, "active.json");
  writeFileSync(activePath, JSON.stringify({ projectId, workspaceId }));
}
