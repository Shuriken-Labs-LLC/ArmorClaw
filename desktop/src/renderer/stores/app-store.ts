import { create } from "zustand";
import type { Workspace, Project, Chat, Message, AppState } from "../types";

type View = "chat" | "brain" | "settings" | "commitments";

interface AppStore {
  // App state
  appState: AppState | null;
  version: string;

  // Navigation
  view: View;
  brainPanelOpen: boolean;

  // Workspaces & projects
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  projects: Project[];
  activeProject: Project | null;

  // Chats
  chats: Chat[];
  activeChat: Chat | null;
  messages: Message[];

  // OpenClaw messages (streaming)
  openClawMessages: string[];

  // Loading states
  initializing: boolean;

  // Actions
  initialize: () => Promise<void>;
  setView: (view: View) => void;
  toggleBrainPanel: () => void;

  selectWorkspace: (workspace: Workspace) => Promise<void>;
  createWorkspace: (name: string, color?: string) => Promise<Workspace>;
  deleteWorkspace: (id: string) => Promise<void>;

  selectProject: (project: Project) => Promise<void>;
  createProject: (name: string, description?: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;

  loadChats: () => Promise<void>;
  selectChat: (chat: Chat) => Promise<void>;
  createChat: (title?: string) => Promise<Chat>;
  deleteChat: (id: string) => Promise<void>;

  sendMessage: (content: string) => Promise<void>;
  addOpenClawMessage: (message: string) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  appState: null,
  version: "",
  view: "chat",
  brainPanelOpen: false,
  workspaces: [],
  activeWorkspace: null,
  projects: [],
  activeProject: null,
  chats: [],
  activeChat: null,
  messages: [],
  openClawMessages: [],
  initializing: true,

  initialize: async () => {
    const [version, appState, workspaces] = await Promise.all([
      window.armorClaw.getAppVersion(),
      window.armorClaw.getAppState(),
      window.armorClaw.listWorkspaces(),
    ]);

    let activeWorkspace: Workspace | null = null;
    let activeProject: Project | null = null;
    let projects: Project[] = [];
    let chats: Chat[] = [];

    if (workspaces.length === 0) {
      const ws = await window.armorClaw.createWorkspace("Personal", "#6366f1");
      workspaces.push(ws);
      const proj = await window.armorClaw.createProject(ws.id, "General");
      projects = [proj];
      activeWorkspace = ws;
      activeProject = proj;
      await window.armorClaw.setActiveContext(ws.id, proj.id);
    } else {
      activeWorkspace =
        workspaces.find((w) => w.id === appState.activeWorkspaceId) ??
        workspaces[0] ?? null;

      if (activeWorkspace) {
        projects = await window.armorClaw.listProjects(activeWorkspace.id);
        activeProject =
          projects.find((p) => p.id === appState.activeProjectId) ??
          projects[0] ?? null;

        if (activeProject) {
          await window.armorClaw.setActiveContext(
            activeWorkspace.id,
            activeProject.id,
          );
          chats = await window.armorClaw.listChats(activeProject.id);
        }
      }
    }

    set({
      version,
      appState,
      workspaces,
      activeWorkspace,
      projects,
      activeProject,
      chats,
      initializing: false,
    });
  },

  setView: (view) => set({ view }),
  toggleBrainPanel: () => set((s) => ({ brainPanelOpen: !s.brainPanelOpen })),

  selectWorkspace: async (workspace) => {
    const projects = await window.armorClaw.listProjects(workspace.id);
    const activeProject = projects[0] ?? null;
    let chats: Chat[] = [];
    if (activeProject) {
      await window.armorClaw.setActiveContext(workspace.id, activeProject.id);
      chats = await window.armorClaw.listChats(activeProject.id);
    }
    set({
      activeWorkspace: workspace,
      projects,
      activeProject,
      chats,
      activeChat: null,
      messages: [],
    });
  },

  createWorkspace: async (name, color) => {
    const ws = await window.armorClaw.createWorkspace(name, color);
    set((s) => ({ workspaces: [...s.workspaces, ws] }));
    return ws;
  },

  deleteWorkspace: async (id) => {
    await window.armorClaw.deleteWorkspace(id);
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    if (get().activeWorkspace?.id === id) {
      const next = workspaces[0] ?? null;
      if (next) {
        await get().selectWorkspace(next);
      }
    }
    set({ workspaces });
  },

  selectProject: async (project) => {
    const ws = get().activeWorkspace;
    if (ws) {
      await window.armorClaw.setActiveContext(ws.id, project.id);
    }
    const chats = await window.armorClaw.listChats(project.id);
    set({ activeProject: project, chats, activeChat: null, messages: [] });
  },

  createProject: async (name, description) => {
    const ws = get().activeWorkspace;
    if (!ws) throw new Error("No active workspace");
    const proj = await window.armorClaw.createProject(ws.id, name, description);
    set((s) => ({ projects: [...s.projects, proj] }));
    return proj;
  },

  deleteProject: async (id) => {
    await window.armorClaw.deleteProject(id);
    const projects = get().projects.filter((p) => p.id !== id);
    if (get().activeProject?.id === id) {
      const next = projects[0] ?? null;
      if (next) {
        await get().selectProject(next);
      }
    }
    set({ projects });
  },

  loadChats: async () => {
    const proj = get().activeProject;
    if (!proj) return;
    const chats = await window.armorClaw.listChats(proj.id);
    set({ chats });
  },

  selectChat: async (chat) => {
    const messages = await window.armorClaw.listMessages(chat.id);
    set({ activeChat: chat, messages });
  },

  createChat: async (title) => {
    const proj = get().activeProject;
    if (!proj) throw new Error("No active project");
    const chat = await window.armorClaw.createChat(proj.id, title);
    set((s) => ({ chats: [chat, ...s.chats], activeChat: chat, messages: [] }));
    return chat;
  },

  deleteChat: async (id) => {
    await window.armorClaw.deleteChat(id);
    set((s) => {
      const chats = s.chats.filter((c) => c.id !== id);
      const activeChat = s.activeChat?.id === id ? null : s.activeChat;
      return { chats, activeChat, messages: activeChat ? s.messages : [] };
    });
  },

  sendMessage: async (content) => {
    let chat = get().activeChat;
    if (!chat) {
      chat = await get().createChat();
    }
    const userMsg = await window.armorClaw.createMessage(
      chat.id,
      "user",
      content,
    );
    set((s) => ({ messages: [...s.messages, userMsg] }));
  },

  addOpenClawMessage: (message) => {
    set((s) => ({ openClawMessages: [...s.openClawMessages, message] }));
  },
}));
