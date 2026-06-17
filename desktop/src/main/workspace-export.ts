import { app } from "electron";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { logger } from "./logger";
import {
  listProjects,
  listChats,
  listMessages,
  listMemories,
  listCommitments,
  type Workspace,
} from "./repositories";

export function exportWorkspace(workspace: Workspace): string {
  const exportDir = join(
    app.getPath("documents"),
    "ArmorClaw Exports",
    sanitize(workspace.name),
  );
  mkdirSync(exportDir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# ${workspace.name}`);
  lines.push("");
  lines.push(`Exported: ${new Date().toISOString()}`);
  if (workspace.instructionsMd) {
    lines.push("");
    lines.push("## Workspace Instructions");
    lines.push("");
    lines.push(workspace.instructionsMd);
  }

  const projects = listProjects(workspace.id);
  for (const project of projects) {
    lines.push("");
    lines.push(`## Project: ${project.name}`);
    if (project.description) lines.push(`> ${project.description}`);
    if (project.instructionsMd) {
      lines.push("");
      lines.push("### Instructions");
      lines.push("");
      lines.push(project.instructionsMd);
    }

    const memories = listMemories(project.id, "approved");
    if (memories.length > 0) {
      lines.push("");
      lines.push("### Memories");
      lines.push("");
      for (const m of memories) {
        lines.push(`- **${m.subject}**: ${m.value}`);
      }
    }

    const commitments = listCommitments(project.id);
    if (commitments.length > 0) {
      lines.push("");
      lines.push("### Commitments");
      lines.push("");
      for (const c of commitments) {
        lines.push(`- [${c.status}] ${c.description} (${c.triggerType})`);
      }
    }

    const chats = listChats(project.id);
    for (const chat of chats) {
      lines.push("");
      lines.push(`### Chat: ${chat.title ?? "Untitled"}`);
      lines.push("");
      const messages = listMessages(chat.id);
      for (const msg of messages) {
        const role = msg.role === "user" ? "You" : "Emerson";
        lines.push(`**${role}** (${new Date(msg.createdAt).toLocaleString()}):`);
        lines.push(msg.content);
        lines.push("");
      }
    }
  }

  const filePath = join(exportDir, "export.md");
  writeFileSync(filePath, lines.join("\n"), "utf-8");
  logger.info(`Workspace exported to ${filePath}`);
  return filePath;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "export";
}
