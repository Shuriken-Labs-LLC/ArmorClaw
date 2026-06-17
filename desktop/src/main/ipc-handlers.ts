import { ipcMain } from "electron";
import {
  listWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  getAppState,
  setActiveContext,
  updateAppState,
  listChats,
  createChat,
  updateChatTitle,
  deleteChat,
  listMessages,
  createMessage,
  listMemories,
  searchMemories,
  approveMemory,
  rejectMemory,
  listCommitments,
  getCommitment,
  createCommitment,
  updateCommitment,
  deleteCommitment,
  listCommitmentRuns,
  listAuditEntries,
  writeAuditEntry,
} from "./repositories";
import type {
  Workspace,
  Project,
  AppState,
  Chat,
  Message,
  Memory,
  Commitment,
  CommitmentRun,
  TriggerType,
  AuditEntry,
  MessageRole,
} from "./repositories";

export function registerIpcHandlers(): void {
  // ---- Workspaces ----
  ipcMain.handle("workspace:list", (): Workspace[] => listWorkspaces());

  ipcMain.handle(
    "workspace:create",
    (_e, name: string, color?: string): Workspace => {
      const ws = createWorkspace(name, color);
      writeAuditEntry("workspace.created", { id: ws.id, name });
      return ws;
    },
  );

  ipcMain.handle(
    "workspace:update",
    (_e, id: string, updates: Partial<Pick<Workspace, "name" | "icon" | "color" | "instructionsMd">>): void => {
      updateWorkspace(id, updates);
    },
  );

  ipcMain.handle("workspace:delete", (_e, id: string): void => {
    writeAuditEntry("workspace.deleted", { id });
    deleteWorkspace(id);
  });

  // ---- Projects ----
  ipcMain.handle(
    "project:list",
    (_e, workspaceId: string): Project[] => listProjects(workspaceId),
  );

  ipcMain.handle(
    "project:get",
    (_e, id: string): Project | undefined => getProject(id),
  );

  ipcMain.handle(
    "project:create",
    (_e, workspaceId: string, name: string, description?: string): Project => {
      const proj = createProject(workspaceId, name, description);
      writeAuditEntry("project.created", { id: proj.id, name }, workspaceId);
      return proj;
    },
  );

  ipcMain.handle(
    "project:update",
    (_e, id: string, updates: Partial<Pick<Project, "name" | "description" | "icon" | "color" | "brainMode" | "instructionsMd">>): void => {
      updateProject(id, updates);
    },
  );

  ipcMain.handle("project:delete", (_e, id: string): void => {
    writeAuditEntry("project.deleted", { id });
    deleteProject(id);
  });

  // ---- App State ----
  ipcMain.handle("app:state", (): AppState => getAppState());

  ipcMain.handle(
    "app:setActiveContext",
    (_e, workspaceId: string, projectId: string): void => {
      setActiveContext(workspaceId, projectId);
    },
  );

  ipcMain.handle(
    "app:updateState",
    (_e, updates: Partial<Pick<AppState, "onboardingState" | "modelProvider" | "personalityMode" | "autonomyDefault" | "missedRunDefault">>): void => {
      updateAppState(updates);
    },
  );

  // ---- Chats ----
  ipcMain.handle(
    "chat:list",
    (_e, projectId: string): Chat[] => listChats(projectId),
  );

  ipcMain.handle(
    "chat:create",
    (_e, projectId: string, title?: string): Chat => createChat(projectId, title),
  );

  ipcMain.handle(
    "chat:updateTitle",
    (_e, id: string, title: string): void => {
      updateChatTitle(id, title);
    },
  );

  ipcMain.handle("chat:delete", (_e, id: string): void => {
    deleteChat(id);
  });

  // ---- Messages ----
  ipcMain.handle(
    "message:list",
    (_e, chatId: string): Message[] => listMessages(chatId),
  );

  ipcMain.handle(
    "message:create",
    (_e, chatId: string, role: MessageRole, content: string, toolCalls?: string): Message =>
      createMessage(chatId, role, content, toolCalls),
  );

  // ---- Memories ----
  ipcMain.handle(
    "memory:list",
    (_e, projectId: string, status?: string): Memory[] =>
      listMemories(projectId, status),
  );

  ipcMain.handle(
    "memory:search",
    (_e, projectId: string, query: string, limit?: number): Memory[] =>
      searchMemories(projectId, query, limit),
  );

  ipcMain.handle("memory:approve", (_e, id: string): void => {
    approveMemory(id);
    writeAuditEntry("memory.approved", { id });
  });

  ipcMain.handle("memory:reject", (_e, id: string): void => {
    rejectMemory(id);
    writeAuditEntry("memory.rejected", { id });
  });

  // ---- Commitments ----
  ipcMain.handle(
    "commitment:list",
    (_e, projectId: string): Commitment[] => listCommitments(projectId),
  );

  ipcMain.handle(
    "commitment:get",
    (_e, id: string): Commitment | undefined => getCommitment(id),
  );

  ipcMain.handle(
    "commitment:create",
    (
      _e,
      workspaceId: string,
      projectId: string,
      description: string,
      triggerType: TriggerType,
      triggerSpec: string,
      actionTemplate: string,
      nextFireAt?: number,
      opts?: Partial<Pick<Commitment, "reversibility" | "autonomy" | "missedRunPolicy">>,
    ): Commitment => {
      const c = createCommitment(workspaceId, projectId, description, triggerType, triggerSpec, actionTemplate, nextFireAt, opts);
      writeAuditEntry("commitment.created", { id: c.id, description }, workspaceId, projectId);
      return c;
    },
  );

  ipcMain.handle(
    "commitment:update",
    (_e, id: string, updates: Partial<Pick<Commitment, "description" | "triggerSpec" | "nextFireAt" | "actionTemplate" | "autonomy" | "status" | "missedRunPolicy">>): void => {
      updateCommitment(id, updates);
    },
  );

  ipcMain.handle("commitment:delete", (_e, id: string): void => {
    writeAuditEntry("commitment.deleted", { id });
    deleteCommitment(id);
  });

  ipcMain.handle(
    "commitment:runs",
    (_e, commitmentId: string, limit?: number): CommitmentRun[] =>
      listCommitmentRuns(commitmentId, limit),
  );

  // ---- Audit ----
  ipcMain.handle(
    "audit:list",
    (_e, limit?: number, projectId?: string): AuditEntry[] =>
      listAuditEntries(limit, projectId),
  );
}
