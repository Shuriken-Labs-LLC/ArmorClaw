import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { Memory } from "../types";

type BrainLayer = "overview" | "project" | "memory-detail";

export function BrainPanel(): React.JSX.Element {
  const { activeWorkspace, activeProject, projects } = useAppStore();
  const [layer, setLayer] = useState<BrainLayer>("overview");
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);

  useEffect(() => {
    if (activeProject && layer === "project") {
      void loadMemories();
    }
  }, [activeProject, layer]);

  const loadMemories = async () => {
    if (!activeProject) return;
    if (searchQuery) {
      const results = await window.armorClaw.searchMemories(
        activeProject.id,
        searchQuery,
      );
      setMemories(results);
    } else {
      const results = await window.armorClaw.listMemories(
        activeProject.id,
        "approved",
      );
      setMemories(results);
    }
  };

  const handleSearch = async () => {
    await loadMemories();
  };

  const handleApprove = async (id: string) => {
    await window.armorClaw.approveMemory(id);
    await loadMemories();
  };

  const handleReject = async (id: string) => {
    await window.armorClaw.rejectMemory(id);
    await loadMemories();
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header with breadcrumbs */}
      <div className="flex items-center gap-2 border-b border-[#26262c] px-4 py-3">
        <span className="text-sm font-medium text-white">Brain</span>
        {layer !== "overview" && (
          <>
            <span className="text-xs text-[#8b8b92]">/</span>
            <button
              className="text-sm text-[#d97706] hover:underline"
              onClick={() => setLayer("overview")}
            >
              {activeWorkspace?.name}
            </button>
          </>
        )}
        {layer === "project" && activeProject && (
          <>
            <span className="text-xs text-[#8b8b92]">/</span>
            <span className="text-sm text-white">{activeProject.name}</span>
          </>
        )}
        {layer === "memory-detail" && selectedMemory && (
          <>
            <span className="text-xs text-[#8b8b92]">/</span>
            <button
              className="text-sm text-[#d97706] hover:underline"
              onClick={() => { setLayer("project"); setSelectedMemory(null); }}
            >
              {activeProject?.name}
            </button>
            <span className="text-xs text-[#8b8b92]">/</span>
            <span className="truncate text-sm text-white">{selectedMemory.subject}</span>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {layer === "overview" && (
          <OverviewLayer
            projects={projects}
            onSelectProject={(p) => {
              void useAppStore.getState().selectProject(p);
              setLayer("project");
            }}
          />
        )}

        {layer === "project" && activeProject && (
          <ProjectLayer
            memories={memories}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onSearch={() => void handleSearch()}
            onSelectMemory={(m) => {
              setSelectedMemory(m);
              setLayer("memory-detail");
            }}
            onApprove={(id) => void handleApprove(id)}
            onReject={(id) => void handleReject(id)}
          />
        )}

        {layer === "memory-detail" && selectedMemory && (
          <MemoryDetailLayer
            memory={selectedMemory}
            onBack={() => { setLayer("project"); setSelectedMemory(null); }}
            onApprove={() => void handleApprove(selectedMemory.id)}
            onReject={() => void handleReject(selectedMemory.id)}
          />
        )}
      </div>
    </div>
  );
}

function OverviewLayer({
  projects,
  onSelectProject,
}: {
  projects: Array<{ id: string; name: string; description: string | null }>;
  onSelectProject: (p: { id: string; name: string; description: string | null; workspaceId: string; icon: string | null; color: string | null; sortOrder: number; brainMode: "smart" | "manual" | "full"; instructionsMd: string | null; createdAt: number; updatedAt: number }) => void;
}): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        Projects
      </h3>
      <div className="grid gap-2">
        {projects.map((p) => (
          <button
            key={p.id}
            className="rounded-lg border border-[#26262c] bg-[#16161a] p-4 text-left transition-colors hover:border-[#d97706]"
            onClick={() => onSelectProject(p as Parameters<typeof onSelectProject>[0])}
          >
            <h4 className="text-sm font-medium text-white">{p.name}</h4>
            {p.description && (
              <p className="mt-1 text-xs text-[#8b8b92]">{p.description}</p>
            )}
          </button>
        ))}
      </div>
      {projects.length === 0 && (
        <p className="text-center text-sm text-[#8b8b92]">
          No projects yet. Create one in the sidebar.
        </p>
      )}
    </div>
  );
}

function ProjectLayer({
  memories,
  searchQuery,
  onSearchChange,
  onSearch,
  onSelectMemory,
  onApprove,
  onReject,
}: {
  memories: Memory[];
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSearch: () => void;
  onSelectMemory: (m: Memory) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}): React.JSX.Element {
  return (
    <div>
      {/* Search */}
      <div className="mb-4 flex gap-2">
        <input
          className="flex-1 rounded-md border border-[#26262c] bg-[#16161a] px-3 py-2 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
          placeholder="Search memories..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearch();
          }}
        />
        <button
          className="rounded-md bg-[#26262c] px-3 py-2 text-sm text-white hover:bg-[#d97706]"
          onClick={onSearch}
        >
          Search
        </button>
      </div>

      {/* Memory list */}
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        Memories ({memories.length})
      </h3>
      <div className="space-y-2">
        {memories.map((m) => (
          <MemoryCard
            key={m.id}
            memory={m}
            onClick={() => onSelectMemory(m)}
            onApprove={() => onApprove(m.id)}
            onReject={() => onReject(m.id)}
          />
        ))}
      </div>
      {memories.length === 0 && (
        <p className="py-8 text-center text-sm text-[#8b8b92]">
          No memories yet. Chat with Emerson and memories will appear here as
          they&apos;re proposed and approved.
        </p>
      )}
    </div>
  );
}

function MemoryCard({
  memory,
  onClick,
  onApprove,
  onReject,
}: {
  memory: Memory;
  onClick: () => void;
  onApprove: () => void;
  onReject: () => void;
}): React.JSX.Element {
  return (
    <div
      className="cursor-pointer rounded-lg border border-[#26262c] bg-[#16161a] p-3 transition-colors hover:border-[#d97706]"
      onClick={onClick}
    >
      <h4 className="text-sm font-medium text-white">{memory.subject}</h4>
      <p className="mt-1 line-clamp-2 text-xs text-[#8b8b92]">
        {memory.summary ?? memory.value}
      </p>
      <div className="mt-2 flex items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            memory.status === "approved"
              ? "bg-[#65a30d]/20 text-[#65a30d]"
              : memory.status === "proposed"
                ? "bg-[#ca8a04]/20 text-[#ca8a04]"
                : "bg-[#dc2626]/20 text-[#dc2626]"
          }`}
        >
          {memory.status}
        </span>
        <span className="text-xs text-[#8b8b92]">
          {Math.round(memory.confidence * 100)}% confidence
        </span>
        {memory.status === "proposed" && (
          <div className="ml-auto flex gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              className="rounded px-2 py-0.5 text-xs text-[#65a30d] hover:bg-[#65a30d]/20"
              onClick={onApprove}
            >
              Approve
            </button>
            <button
              className="rounded px-2 py-0.5 text-xs text-[#dc2626] hover:bg-[#dc2626]/20"
              onClick={onReject}
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MemoryDetailLayer({
  memory,
  onBack,
  onApprove,
  onReject,
}: {
  memory: Memory;
  onBack: () => void;
  onApprove: () => void;
  onReject: () => void;
}): React.JSX.Element {
  return (
    <div>
      <button
        className="mb-4 text-sm text-[#d97706] hover:underline"
        onClick={onBack}
      >
        Back to memories
      </button>

      <div className="rounded-lg border border-[#26262c] bg-[#16161a] p-4">
        <h3 className="text-lg font-medium text-white">{memory.subject}</h3>
        <div className="mt-3 text-sm text-[#e8e8ea]">{memory.value}</div>
        {memory.summary && (
          <div className="mt-3 rounded-md bg-[#0e0e0f] p-3">
            <span className="text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Summary
            </span>
            <p className="mt-1 text-sm text-[#e8e8ea]">{memory.summary}</p>
          </div>
        )}
        <div className="mt-4 flex items-center gap-3 border-t border-[#26262c] pt-3">
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              memory.status === "approved"
                ? "bg-[#65a30d]/20 text-[#65a30d]"
                : memory.status === "proposed"
                  ? "bg-[#ca8a04]/20 text-[#ca8a04]"
                  : "bg-[#dc2626]/20 text-[#dc2626]"
            }`}
          >
            {memory.status}
          </span>
          <span className="text-xs text-[#8b8b92]">
            {Math.round(memory.confidence * 100)}% confidence
          </span>
          <span className="text-xs text-[#8b8b92]">
            Created {new Date(memory.createdAt).toLocaleDateString()}
          </span>
          {memory.status === "proposed" && (
            <div className="ml-auto flex gap-2">
              <button
                className="rounded-md bg-[#65a30d] px-3 py-1.5 text-sm text-white hover:bg-[#4d7c0f]"
                onClick={onApprove}
              >
                Approve
              </button>
              <button
                className="rounded-md bg-[#dc2626] px-3 py-1.5 text-sm text-white hover:bg-[#b91c1c]"
                onClick={onReject}
              >
                Reject
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
