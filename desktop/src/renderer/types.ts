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

export interface Commitment {
  id: string;
  workspaceId: string;
  projectId: string;
  description: string;
  triggerType: "time" | "interval" | "manual";
  triggerSpec: string;
  nextFireAt: number | null;
  actionTemplate: string;
  reversibility: "reversible" | "irreversible";
  autonomy: "gated" | "autonomous";
  status: "active" | "paused" | "done" | "failed";
  doneCondition: string | null;
  missedRunPolicy: "ask" | "skip" | "next_wake";
  lastRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommitmentRun {
  id: string;
  commitmentId: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: "completed" | "awaiting_approval" | "failed" | "skipped";
  detail: string | null;
}

export interface Entity {
  id: string;
  workspaceId: string;
  name: string;
  type: "person" | "project" | "event" | "organization" | "place" | "thing";
  aliases: string[] | null;
  canonicalId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Topic {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface DossierPin {
  id: string;
  topicId: string;
  contentMd: string;
  generatedAt: number;
  isArchived: boolean;
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
      updateMemory: (id: string, updates: Partial<Pick<Memory, "subject" | "value" | "userNotes">>) => Promise<void>;
      deleteMemory: (id: string) => Promise<void>;
      getMemoryCountForProject: (projectId: string) => Promise<number>;
      getLoginItemSettings: () => Promise<{ openAtLogin: boolean }>;
      setLoginItemSettings: (openAtLogin: boolean) => Promise<void>;
      listEntities: (workspaceId: string) => Promise<Entity[]>;
      getEntitiesForMemory: (memoryId: string) => Promise<Entity[]>;
      getMemoriesForEntity: (entityId: string) => Promise<Memory[]>;
      listTopics: (workspaceId: string) => Promise<Topic[]>;
      getTopicForMemory: (memoryId: string) => Promise<Topic | undefined>;
      getMemoriesForTopic: (topicId: string) => Promise<Memory[]>;
      getTopicsForProject: (projectId: string) => Promise<Topic[]>;
      searchEntitiesAcross: (name: string) => Promise<Array<Entity & { workspaceName: string }>>;
      listDossierPins: (topicId: string) => Promise<DossierPin[]>;
      generateDossier: (topicId: string) => Promise<string>;
      createDossierPin: (topicId: string, contentMd: string) => Promise<DossierPin>;
      archiveDossierPin: (id: string) => Promise<void>;
      exportWorkspace: (workspaceId: string) => Promise<string>;
      listCommitments: (projectId: string) => Promise<Commitment[]>;
      getCommitment: (id: string) => Promise<Commitment | undefined>;
      createCommitment: (
        workspaceId: string,
        projectId: string,
        description: string,
        triggerType: string,
        triggerSpec: string,
        actionTemplate: string,
        nextFireAt?: number,
        opts?: Record<string, unknown>,
      ) => Promise<Commitment>;
      updateCommitment: (id: string, updates: Partial<Commitment>) => Promise<void>;
      deleteCommitment: (id: string) => Promise<void>;
      listCommitmentRuns: (commitmentId: string, limit?: number) => Promise<CommitmentRun[]>;
      onCommitmentFired: (callback: (data: Record<string, unknown>) => void) => () => void;
      onCommitmentMissed: (callback: (data: Record<string, unknown>) => void) => () => void;
      openExternal: (url: string) => Promise<void>;
      listAuditEntries: (limit?: number, projectId?: string) => Promise<AuditEntry[]>;
      onDeepLinkAuth: (callback: (data: { token: string }) => void) => () => void;
      onDeepLinkBilling: (callback: (data: { sessionId: string }) => void) => () => void;
    };
  }
}
