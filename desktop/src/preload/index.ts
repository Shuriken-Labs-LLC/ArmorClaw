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

  // Audit
  listAuditEntries: (limit?: number, projectId?: string) =>
    ipcRenderer.invoke("audit:list", limit, projectId),
} as const;

export type ArmorClawAPI = typeof api;

contextBridge.exposeInMainWorld("armorClaw", api);
