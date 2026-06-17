import { contextBridge, ipcRenderer } from "electron";

const api = {
  getAppVersion: (): Promise<string> =>
    ipcRenderer.invoke("app:version"),
  onOpenClawMessage: (callback: (message: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, message: string) =>
      callback(message);
    ipcRenderer.on("openclaw:message", handler);
    return () => {
      ipcRenderer.removeListener("openclaw:message", handler);
    };
  },

  // Workspaces
  listWorkspaces: () => ipcRenderer.invoke("workspace:list"),
  createWorkspace: (name: string, color?: string) =>
    ipcRenderer.invoke("workspace:create", name, color),
  updateWorkspace: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke("workspace:update", id, updates),
  deleteWorkspace: (id: string) => ipcRenderer.invoke("workspace:delete", id),

  // Projects
  listProjects: (workspaceId: string) =>
    ipcRenderer.invoke("project:list", workspaceId),
  getProject: (id: string) => ipcRenderer.invoke("project:get", id),
  createProject: (workspaceId: string, name: string, description?: string) =>
    ipcRenderer.invoke("project:create", workspaceId, name, description),
  updateProject: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke("project:update", id, updates),
  deleteProject: (id: string) => ipcRenderer.invoke("project:delete", id),

  // App State
  getAppState: () => ipcRenderer.invoke("app:state"),
  setActiveContext: (workspaceId: string, projectId: string) =>
    ipcRenderer.invoke("app:setActiveContext", workspaceId, projectId),
  updateAppState: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke("app:updateState", updates),

  // Chats
  listChats: (projectId: string) => ipcRenderer.invoke("chat:list", projectId),
  createChat: (projectId: string, title?: string) =>
    ipcRenderer.invoke("chat:create", projectId, title),
  updateChatTitle: (id: string, title: string) =>
    ipcRenderer.invoke("chat:updateTitle", id, title),
  deleteChat: (id: string) => ipcRenderer.invoke("chat:delete", id),

  // Messages
  listMessages: (chatId: string) => ipcRenderer.invoke("message:list", chatId),
  createMessage: (chatId: string, role: string, content: string, toolCalls?: string) =>
    ipcRenderer.invoke("message:create", chatId, role, content, toolCalls),

  // Memories
  listMemories: (projectId: string, status?: string) =>
    ipcRenderer.invoke("memory:list", projectId, status),
  searchMemories: (projectId: string, query: string, limit?: number) =>
    ipcRenderer.invoke("memory:search", projectId, query, limit),
  approveMemory: (id: string) => ipcRenderer.invoke("memory:approve", id),
  rejectMemory: (id: string) => ipcRenderer.invoke("memory:reject", id),

  // Login items
  getLoginItemSettings: () => ipcRenderer.invoke("app:getLoginItemSettings"),
  setLoginItemSettings: (openAtLogin: boolean) =>
    ipcRenderer.invoke("app:setLoginItemSettings", openAtLogin),

  // Entities & Topics
  listEntities: (workspaceId: string) =>
    ipcRenderer.invoke("entity:list", workspaceId),
  getEntitiesForMemory: (memoryId: string) =>
    ipcRenderer.invoke("entity:forMemory", memoryId),
  getMemoriesForEntity: (entityId: string) =>
    ipcRenderer.invoke("entity:memoriesFor", entityId),
  listTopics: (workspaceId: string) =>
    ipcRenderer.invoke("topic:list", workspaceId),
  getTopicForMemory: (memoryId: string) =>
    ipcRenderer.invoke("topic:forMemory", memoryId),
  getMemoriesForTopic: (topicId: string) =>
    ipcRenderer.invoke("topic:memoriesFor", topicId),

  // Workspace export
  exportWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke("workspace:export", workspaceId),

  // Commitments
  listCommitments: (projectId: string) =>
    ipcRenderer.invoke("commitment:list", projectId),
  getCommitment: (id: string) => ipcRenderer.invoke("commitment:get", id),
  createCommitment: (
    workspaceId: string,
    projectId: string,
    description: string,
    triggerType: string,
    triggerSpec: string,
    actionTemplate: string,
    nextFireAt?: number,
    opts?: Record<string, unknown>,
  ) =>
    ipcRenderer.invoke(
      "commitment:create",
      workspaceId, projectId, description, triggerType, triggerSpec, actionTemplate, nextFireAt, opts,
    ),
  updateCommitment: (id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke("commitment:update", id, updates),
  deleteCommitment: (id: string) => ipcRenderer.invoke("commitment:delete", id),
  listCommitmentRuns: (commitmentId: string, limit?: number) =>
    ipcRenderer.invoke("commitment:runs", commitmentId, limit),
  onCommitmentFired: (callback: (data: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
      callback(data);
    ipcRenderer.on("commitment:fired", handler);
    return () => { ipcRenderer.removeListener("commitment:fired", handler); };
  },
  onCommitmentMissed: (callback: (data: Record<string, unknown>) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: Record<string, unknown>) =>
      callback(data);
    ipcRenderer.on("commitment:missed", handler);
    return () => { ipcRenderer.removeListener("commitment:missed", handler); };
  },

  // Audit
  listAuditEntries: (limit?: number, projectId?: string) =>
    ipcRenderer.invoke("audit:list", limit, projectId),

  // Deep link events
  onDeepLinkAuth: (callback: (data: { token: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { token: string }) =>
      callback(data);
    ipcRenderer.on("deep-link:auth", handler);
    return () => { ipcRenderer.removeListener("deep-link:auth", handler); };
  },
  onDeepLinkBilling: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) =>
      callback(data);
    ipcRenderer.on("deep-link:billing", handler);
    return () => { ipcRenderer.removeListener("deep-link:billing", handler); };
  },
} as const;

export type ArmorClawAPI = typeof api;

contextBridge.exposeInMainWorld("armorClaw", api);
