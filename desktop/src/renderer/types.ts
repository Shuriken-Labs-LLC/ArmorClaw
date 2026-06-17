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

export interface Chat {
  id: string;
  projectId: string;
  title: string | null;
  createdAt: number;
  lastMsgAt: number;
}

export interface Message {
  id: string;
  chatId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls: string | null;
  createdAt: number;
}

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

export interface AuditEntry {
  id: number;
  workspaceId: string | null;
  projectId: string | null;
  eventType: string;
  payloadJson: string;
  createdAt: number;
}

declare global {
  interface Window {
    armorClaw: {
      getAppVersion: () => Promise<string>;
      onOpenClawMessage: (callback: (message: string) => void) => () => void;
      listWorkspaces: () => Promise<Workspace[]>;
      createWorkspace: (name: string, color?: string) => Promise<Workspace>;
      updateWorkspace: (id: string, updates: Partial<Workspace>) => Promise<void>;
      deleteWorkspace: (id: string) => Promise<void>;
      listProjects: (workspaceId: string) => Promise<Project[]>;
      getProject: (id: string) => Promise<Project | undefined>;
      createProject: (workspaceId: string, name: string, description?: string) => Promise<Project>;
      updateProject: (id: string, updates: Partial<Project>) => Promise<void>;
      deleteProject: (id: string) => Promise<void>;
      getAppState: () => Promise<AppState>;
      setActiveContext: (workspaceId: string, projectId: string) => Promise<void>;
      updateAppState: (updates: Partial<AppState>) => Promise<void>;
      listChats: (projectId: string) => Promise<Chat[]>;
      createChat: (projectId: string, title?: string) => Promise<Chat>;
      updateChatTitle: (id: string, title: string) => Promise<void>;
      deleteChat: (id: string) => Promise<void>;
      listMessages: (chatId: string) => Promise<Message[]>;
      createMessage: (chatId: string, role: string, content: string, toolCalls?: string) => Promise<Message>;
      listMemories: (projectId: string, status?: string) => Promise<Memory[]>;
      searchMemories: (projectId: string, query: string, limit?: number) => Promise<Memory[]>;
      approveMemory: (id: string) => Promise<void>;
      rejectMemory: (id: string) => Promise<void>;
      listAuditEntries: (limit?: number, projectId?: string) => Promise<AuditEntry[]>;
    };
  }
}
