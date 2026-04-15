/**
 * Agent status — shared state for pause/resume.
 *
 * Extracted from dashboard/server.ts so both the dashboard server and the
 * security layer can import it without creating a circular dependency.
 *
 * This module owns the single source of truth for agent status. It is the
 * only place that declares the mutable `agentStatus` variable.
 */

export type AgentStatus = "running" | "paused" | "error";

let agentStatus: AgentStatus = "running";

export function getAgentStatus(): AgentStatus {
  return agentStatus;
}

export function setAgentStatus(s: AgentStatus): void {
  agentStatus = s;
}
