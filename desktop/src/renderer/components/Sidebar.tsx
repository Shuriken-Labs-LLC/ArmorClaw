import { useState } from "react";
import { useAppStore } from "../stores/app-store";
import { NotificationBell, NotificationPanel } from "./NotificationPanel";
import type { Workspace, Project } from "../types";

const WORKSPACE_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4"];

export function Sidebar(): React.JSX.Element {
  const {
    workspaces,
    activeWorkspace,
    projects,
    activeProject,
    chats,
    activeChat,
    view,
    selectWorkspace,
    createWorkspace,
    selectProject,
    createProject,
    selectChat,
    createChat,
    setView,
  } = useAppStore();

  const [showNewWs, setShowNewWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [showNewProj, setShowNewProj] = useState(false);
  const [newProjName, setNewProjName] = useState("");

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim()) return;
    const color = WORKSPACE_COLORS[workspaces.length % WORKSPACE_COLORS.length];
    const ws = await createWorkspace(newWsName.trim(), color);
    setNewWsName("");
    setShowNewWs(false);
    await selectWorkspace(ws);
  };

  const handleCreateProject = async () => {
    if (!newProjName.trim()) return;
    const proj = await createProject(newProjName.trim());
    setNewProjName("");
    setShowNewProj(false);
    await selectProject(proj);
  };

  return (
    <aside className="flex h-full w-60 flex-shrink-0 flex-col border-r border-[#26262c] bg-[#0e0e0f]">
      {/* Workspace selector */}
      <div className="border-b border-[#26262c] p-3">
        <WorkspaceSelector
          workspaces={workspaces}
          active={activeWorkspace}
          onSelect={selectWorkspace}
          onNew={() => setShowNewWs(true)}
        />
        {showNewWs && (
          <div className="mt-2 flex gap-1">
            <input
              className="flex-1 rounded-md border border-[#26262c] bg-[#16161a] px-2 py-1 text-sm text-white outline-none focus:border-[#d97706]"
              placeholder="Workspace name"
              value={newWsName}
              onChange={(e) => setNewWsName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateWorkspace();
                if (e.key === "Escape") setShowNewWs(false);
              }}
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Project list */}
      <div className="border-b border-[#26262c] p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
            Projects
          </span>
          <button
            className="text-xs text-[#8b8b92] hover:text-white"
            onClick={() => setShowNewProj(true)}
          >
            +
          </button>
        </div>
        {projects.map((p) => (
          <ProjectItem
            key={p.id}
            project={p}
            isActive={p.id === activeProject?.id}
            onClick={() => selectProject(p)}
          />
        ))}
        {projects.length === 0 && !showNewProj && (
          <button
            className="w-full rounded-md border border-dashed border-[#26262c] px-3 py-2 text-xs text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
            onClick={() => setShowNewProj(true)}
          >
            + Create your first project
          </button>
        )}
        {showNewProj && (
          <div className="mt-1 flex gap-1">
            <input
              className="flex-1 rounded-md border border-[#26262c] bg-[#16161a] px-2 py-1 text-sm text-white outline-none focus:border-[#d97706]"
              placeholder="Project name"
              value={newProjName}
              onChange={(e) => setNewProjName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateProject();
                if (e.key === "Escape") setShowNewProj(false);
              }}
              autoFocus
            />
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="border-b border-[#26262c] p-3">
        <NavItem
          label="Chat"
          icon="💬"
          active={view === "chat"}
          onClick={() => setView("chat")}
        />
        <NavItem
          label="Brain"
          icon="🧠"
          active={view === "brain"}
          onClick={() => setView("brain")}
        />
        <NavItem
          label="Commitments"
          icon="📋"
          active={view === "commitments"}
          onClick={() => setView("commitments")}
        />
        <NavItem
          label="Settings"
          icon="⚙️"
          active={view === "settings"}
          onClick={() => setView("settings")}
        />
      </nav>

      {/* Chat list */}
      {view === "chat" && (
        <div className="flex-1 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Conversations
            </span>
            <button
              className="text-xs text-[#8b8b92] hover:text-white"
              onClick={() => void createChat()}
            >
              +
            </button>
          </div>
          {chats.map((c) => (
            <button
              key={c.id}
              className={`mb-1 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                c.id === activeChat?.id
                  ? "bg-[#26262c] text-white"
                  : "text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
              }`}
              onClick={() => void selectChat(c)}
            >
              {c.title ?? "New conversation"}
            </button>
          ))}
          {chats.length === 0 && (
            <p className="text-center text-xs text-[#8b8b92]">
              No conversations yet
            </p>
          )}
        </div>
      )}

      {/* Version footer + notifications */}
      <div className="flex items-center justify-between border-t border-[#26262c] p-3">
        <VersionFooter />
        <div className="relative">
          <NotificationBell />
          <NotificationPanel />
        </div>
      </div>
    </aside>
  );
}

function WorkspaceSelector({
  workspaces,
  active,
  onSelect,
  onNew,
}: {
  workspaces: Workspace[];
  active: Workspace | null;
  onSelect: (ws: Workspace) => void;
  onNew: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-white hover:bg-[#16161a]"
        onClick={() => setOpen(!open)}
      >
        {active && (
          <span
            className="inline-block h-3 w-3 rounded-full"
            style={{ backgroundColor: active.color ?? "#6366f1" }}
          />
        )}
        <span className="flex-1 truncate">{active?.name ?? "Select workspace"}</span>
        <span className="text-[#8b8b92]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full rounded-md border border-[#26262c] bg-[#16161a] py-1 shadow-xl">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                ws.id === active?.id
                  ? "bg-[#26262c] text-white"
                  : "text-[#e8e8ea] hover:bg-[#26262c]"
              }`}
              onClick={() => {
                onSelect(ws);
                setOpen(false);
              }}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: ws.color ?? "#6366f1" }}
              />
              {ws.name}
            </button>
          ))}
          <button
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-[#8b8b92] hover:bg-[#26262c] hover:text-white"
            onClick={() => {
              onNew();
              setOpen(false);
            }}
          >
            + New workspace
          </button>
        </div>
      )}
    </div>
  );
}

function ProjectItem({
  project,
  isActive,
  onClick,
}: {
  project: Project;
  isActive: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`mb-0.5 w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
        isActive
          ? "bg-[#26262c] text-white"
          : "text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
      }`}
      onClick={onClick}
    >
      {project.name}
    </button>
  );
}

function NavItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
        active
          ? "bg-[#26262c] text-white"
          : "text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
      }`}
      onClick={onClick}
    >
      <span className="text-base">{icon}</span>
      {label}
    </button>
  );
}

function VersionFooter(): React.JSX.Element {
  const version = useAppStore((s) => s.version);
  return (
    <p className="text-xs text-[#8b8b92]">
      ArmorClaw {version ? `v${version}` : ""}
    </p>
  );
}
