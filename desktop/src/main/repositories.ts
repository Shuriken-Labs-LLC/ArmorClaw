import { randomUUID } from "node:crypto";
import { getDb } from "./db";

// ---- Workspaces ----

export interface Workspace {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  instructionsMd: string | null;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceRow {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  sort_order: number;
  instructions_md: string | null;
  created_at: number;
  updated_at: number;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    sortOrder: row.sort_order,
    instructionsMd: row.instructions_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWorkspaces(): Workspace[] {
  const rows = getDb()
    .prepare("SELECT * FROM workspaces ORDER BY sort_order, created_at")
    .all() as WorkspaceRow[];
  return rows.map(mapWorkspace);
}

export function createWorkspace(name: string, color?: string): Workspace {
  const id = randomUUID();
  const now = Date.now();
  const sortOrder = listWorkspaces().length;
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, name, icon, color, sort_order, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(id, name, color ?? null, sortOrder, now, now);
  return {
    id,
    name,
    icon: null,
    color: color ?? null,
    sortOrder,
    instructionsMd: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateWorkspace(
  id: string,
  updates: Partial<Pick<Workspace, "name" | "icon" | "color" | "instructionsMd">>,
): void {
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
  if (updates.icon !== undefined) { sets.push("icon = ?"); params.push(updates.icon); }
  if (updates.color !== undefined) { sets.push("color = ?"); params.push(updates.color); }
  if (updates.instructionsMd !== undefined) { sets.push("instructions_md = ?"); params.push(updates.instructionsMd); }
  params.push(id);
  getDb().prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteWorkspace(id: string): void {
  getDb().prepare("DELETE FROM workspaces WHERE id = ?").run(id);
}

// ---- Projects ----

export interface Project {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sortOrder: number;
  brainMode: "smart" | "manual" | "full";
  instructionsMd: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ProjectRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  sort_order: number;
  brain_mode: string;
  instructions_md: string | null;
  created_at: number;
  updated_at: number;
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    sortOrder: row.sort_order,
    brainMode: row.brain_mode as "smart" | "manual" | "full",
    instructionsMd: row.instructions_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProjects(workspaceId: string): Project[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM projects WHERE workspace_id = ? ORDER BY sort_order, created_at",
    )
    .all(workspaceId) as ProjectRow[];
  return rows.map(mapProject);
}

export function getProject(id: string): Project | undefined {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  return row ? mapProject(row) : undefined;
}

export function createProject(
  workspaceId: string,
  name: string,
  description?: string,
): Project {
  const id = randomUUID();
  const now = Date.now();
  const sortOrder = listProjects(workspaceId).length;
  getDb()
    .prepare(
      `INSERT INTO projects (id, workspace_id, name, description, icon, color, sort_order, brain_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 'smart', ?, ?)`,
    )
    .run(id, workspaceId, name, description ?? null, sortOrder, now, now);
  return {
    id,
    workspaceId,
    name,
    description: description ?? null,
    icon: null,
    color: null,
    sortOrder,
    brainMode: "smart",
    instructionsMd: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateProject(
  id: string,
  updates: Partial<Pick<Project, "name" | "description" | "icon" | "color" | "brainMode" | "instructionsMd">>,
): void {
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  if (updates.name !== undefined) { sets.push("name = ?"); params.push(updates.name); }
  if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
  if (updates.icon !== undefined) { sets.push("icon = ?"); params.push(updates.icon); }
  if (updates.color !== undefined) { sets.push("color = ?"); params.push(updates.color); }
  if (updates.brainMode !== undefined) { sets.push("brain_mode = ?"); params.push(updates.brainMode); }
  if (updates.instructionsMd !== undefined) { sets.push("instructions_md = ?"); params.push(updates.instructionsMd); }
  params.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteProject(id: string): void {
  getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
}

// ---- App State ----

export interface AppState {
  userEmail: string | null;
  licenseJwt: string | null;
  licenseExpiresAt: number | null;
  lastValidatedAt: number | null;
  openclawVersion: string | null;
  openclawPath: string | null;
  modelProvider: "openai" | "anthropic";
  personalityMode: "standard" | "unhinged";
  autonomyDefault: "gated" | "autonomous";
  missedRunDefault: "ask" | "skip" | "next_wake";
  activeWorkspaceId: string | null;
  activeProjectId: string | null;
  onboardingState: string;
}

interface AppStateRow {
  user_email: string | null;
  license_jwt: string | null;
  license_expires_at: number | null;
  last_validated_at: number | null;
  openclaw_version: string | null;
  openclaw_path: string | null;
  model_provider: string;
  personality_mode: string;
  autonomy_default: string;
  missed_run_default: string;
  active_workspace_id: string | null;
  active_project_id: string | null;
  onboarding_state: string;
}

export function getAppState(): AppState {
  const row = getDb()
    .prepare("SELECT * FROM app_state WHERE id = 1")
    .get() as AppStateRow;
  return {
    userEmail: row.user_email,
    licenseJwt: row.license_jwt,
    licenseExpiresAt: row.license_expires_at,
    lastValidatedAt: row.last_validated_at,
    openclawVersion: row.openclaw_version,
    openclawPath: row.openclaw_path,
    modelProvider: row.model_provider as "openai" | "anthropic",
    personalityMode: row.personality_mode as "standard" | "unhinged",
    autonomyDefault: row.autonomy_default as "gated" | "autonomous",
    missedRunDefault: row.missed_run_default as "ask" | "skip" | "next_wake",
    activeWorkspaceId: row.active_workspace_id,
    activeProjectId: row.active_project_id,
    onboardingState: row.onboarding_state,
  };
}

export function setActiveContext(workspaceId: string, projectId: string): void {
  getDb()
    .prepare(
      "UPDATE app_state SET active_workspace_id = ?, active_project_id = ?, updated_at = ? WHERE id = 1",
    )
    .run(workspaceId, projectId, Date.now());
}

export function updateAppState(
  updates: Partial<Pick<AppState, "onboardingState" | "modelProvider" | "personalityMode" | "autonomyDefault" | "missedRunDefault" | "userEmail" | "openclawVersion" | "openclawPath">>,
): void {
  const now = Date.now();
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [now];
  if (updates.onboardingState !== undefined) { sets.push("onboarding_state = ?"); params.push(updates.onboardingState); }
  if (updates.modelProvider !== undefined) { sets.push("model_provider = ?"); params.push(updates.modelProvider); }
  if (updates.personalityMode !== undefined) { sets.push("personality_mode = ?"); params.push(updates.personalityMode); }
  if (updates.autonomyDefault !== undefined) { sets.push("autonomy_default = ?"); params.push(updates.autonomyDefault); }
  if (updates.missedRunDefault !== undefined) { sets.push("missed_run_default = ?"); params.push(updates.missedRunDefault); }
  if (updates.userEmail !== undefined) { sets.push("user_email = ?"); params.push(updates.userEmail); }
  if (updates.openclawVersion !== undefined) { sets.push("openclaw_version = ?"); params.push(updates.openclawVersion); }
  if (updates.openclawPath !== undefined) { sets.push("openclaw_path = ?"); params.push(updates.openclawPath); }
  params.push(1);
  getDb().prepare(`UPDATE app_state SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

// ---- Chats ----

export interface Chat {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  lastMsgAt: number;
}

interface ChatRow {
  id: string;
  project_id: string;
  title: string | null;
  created_at: number;
  last_msg_at: number;
}

function mapChat(row: ChatRow): Chat {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    lastMsgAt: row.last_msg_at,
  };
}

export function listChats(projectId: string): Chat[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM chats WHERE project_id = ? ORDER BY last_msg_at DESC",
    )
    .all(projectId) as ChatRow[];
  return rows.map(mapChat);
}

export function createChat(projectId: string, title?: string): Chat {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO chats (id, project_id, title, created_at, last_msg_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(id, projectId, title ?? null, now, now);
  return { id, projectId, title: title ?? null, createdAt: now, lastMsgAt: now };
}

export function updateChatTitle(id: string, title: string): void {
  getDb().prepare("UPDATE chats SET title = ? WHERE id = ?").run(title, id);
}

export function deleteChat(id: string): void {
  getDb().prepare("DELETE FROM chats WHERE id = ?").run(id);
}

// ---- Messages ----

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  chatId: string;
  role: MessageRole;
  content: string;
  toolCalls: string | null;
  createdAt: number;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: number;
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as MessageRole,
    content: row.content,
    toolCalls: row.tool_calls,
    createdAt: row.created_at,
  };
}

export function listMessages(chatId: string): Message[] {
  const rows = getDb()
    .prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at")
    .all(chatId) as MessageRow[];
  return rows.map(mapMessage);
}

export function createMessage(
  chatId: string,
  role: MessageRole,
  content: string,
  toolCalls?: string,
): Message {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO messages (id, chat_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(id, chatId, role, content, toolCalls ?? null, now);
  getDb()
    .prepare("UPDATE chats SET last_msg_at = ? WHERE id = ?")
    .run(now, chatId);
  return { id, chatId, role, content, toolCalls: toolCalls ?? null, createdAt: now };
}

// ---- Memories ----

export interface Memory {
  id: string;
  projectId: string;
  subject: string;
  value: string;
  summary: string | null;
  confidence: number;
  status: "proposed" | "approved" | "rejected";
  userNotes: string | null;
  createdAt: number;
  approvedAt: number | null;
  updatedAt: number;
}

interface MemoryRow {
  id: string;
  project_id: string;
  subject: string;
  value: string;
  summary: string | null;
  confidence: number;
  status: string;
  user_notes: string | null;
  created_at: number;
  approved_at: number | null;
  updated_at: number;
}

function mapMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    value: row.value,
    summary: row.summary,
    confidence: row.confidence,
    status: row.status as "proposed" | "approved" | "rejected",
    userNotes: row.user_notes,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    updatedAt: row.updated_at,
  };
}

export function listMemories(projectId: string, status?: string): Memory[] {
  const where = status
    ? "WHERE project_id = ? AND status = ?"
    : "WHERE project_id = ?";
  const params = status ? [projectId, status] : [projectId];
  const rows = getDb()
    .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC`)
    .all(...params) as MemoryRow[];
  return rows.map(mapMemory);
}

export function searchMemories(projectId: string, query: string, limit = 8): Memory[] {
  const rows = getDb()
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memories_fts f ON m.rowid = f.rowid
       WHERE m.project_id = ? AND m.status = 'approved' AND memories_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(projectId, query, limit) as MemoryRow[];
  return rows.map(mapMemory);
}

export function createMemory(
  projectId: string,
  subject: string,
  value: string,
  summary?: string,
  confidence = 0.5,
  sourceChatId?: string,
  sourceMessageId?: string,
): Memory {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO memories (id, project_id, subject, value, summary, confidence, source_chat_id, source_message_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
    )
    .run(id, projectId, subject, value, summary ?? null, confidence, sourceChatId ?? null, sourceMessageId ?? null, now, now);
  return {
    id,
    projectId,
    subject,
    value,
    summary: summary ?? null,
    confidence,
    status: "proposed",
    userNotes: null,
    createdAt: now,
    approvedAt: null,
    updatedAt: now,
  };
}

export function approveMemory(id: string): void {
  const now = Date.now();
  getDb()
    .prepare("UPDATE memories SET status = 'approved', approved_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
}

export function rejectMemory(id: string): void {
  const now = Date.now();
  getDb()
    .prepare("UPDATE memories SET status = 'rejected', updated_at = ? WHERE id = ?")
    .run(now, id);
}

// ---- Audit ----

export function writeAuditEntry(
  eventType: string,
  payload: Record<string, unknown>,
  workspaceId?: string,
  projectId?: string,
): void {
  const now = Date.now();
  getDb()
    .prepare(
      "INSERT INTO audit_entries (workspace_id, project_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(workspaceId ?? null, projectId ?? null, eventType, JSON.stringify(payload), now);
}

export interface AuditEntry {
  id: number;
  workspaceId: string | null;
  projectId: string | null;
  eventType: string;
  payloadJson: string;
  createdAt: number;
}

export function listAuditEntries(limit = 100, projectId?: string): AuditEntry[] {
  const where = projectId ? "WHERE project_id = ?" : "";
  const params = projectId ? [projectId, limit] : [limit];
  const rows = getDb()
    .prepare(`SELECT * FROM audit_entries ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as Array<{
    id: number;
    workspace_id: string | null;
    project_id: string | null;
    event_type: string;
    payload_json: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    eventType: r.event_type,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
  }));
}
