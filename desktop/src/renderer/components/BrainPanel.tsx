import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { Memory, Entity, Topic, Project, DossierPin } from "../types";

type BrainLayer =
  | { kind: "overview" }
  | { kind: "project" }
  | { kind: "topic"; topic: Topic }
  | { kind: "memory-detail"; memory: Memory }
  | { kind: "entity"; entity: Entity };

export function BrainPanel(): React.JSX.Element {
  const { activeWorkspace, activeProject, projects } = useAppStore();
  const [layer, setLayer] = useState<BrainLayer>({ kind: "overview" });

  const breadcrumbs = buildBreadcrumbs(layer, activeWorkspace?.name, activeProject?.name, setLayer);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-[#26262c] px-4 py-3">
        <span className="text-sm font-medium text-white">Brain</span>
        {breadcrumbs.map((b, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-xs text-[#8b8b92]">/</span>
            {b.onClick ? (
              <button className="text-sm text-[#d97706] hover:underline" onClick={b.onClick}>
                {b.label}
              </button>
            ) : (
              <span className="text-sm text-white">{b.label}</span>
            )}
          </span>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {layer.kind === "overview" && (
          <OverviewLayer
            projects={projects}
            onSelectProject={(p) => {
              void useAppStore.getState().selectProject(p);
              setLayer({ kind: "project" });
            }}
          />
        )}
        {layer.kind === "project" && activeProject && (
          <ProjectLayer
            project={activeProject}
            onSelectMemory={(m) => setLayer({ kind: "memory-detail", memory: m })}
            onSelectTopic={(t) => setLayer({ kind: "topic", topic: t })}
            onSelectEntity={(e) => setLayer({ kind: "entity", entity: e })}
          />
        )}
        {layer.kind === "topic" && (
          <TopicLayer
            topic={layer.topic}
            onSelectMemory={(m) => setLayer({ kind: "memory-detail", memory: m })}
            onSelectTopic={(t) => setLayer({ kind: "topic", topic: t })}
          />
        )}
        {layer.kind === "memory-detail" && (
          <MemoryDetailLayer
            memory={layer.memory}
            onBack={() => setLayer({ kind: "project" })}
            onSelectEntity={(e) => setLayer({ kind: "entity", entity: e })}
            onDeleted={() => setLayer({ kind: "project" })}
          />
        )}
        {layer.kind === "entity" && (
          <EntityLayer
            entity={layer.entity}
            onSelectMemory={(m) => setLayer({ kind: "memory-detail", memory: m })}
          />
        )}
      </div>
    </div>
  );
}

function buildBreadcrumbs(
  layer: BrainLayer,
  wsName: string | undefined,
  projName: string | undefined,
  setLayer: (l: BrainLayer) => void,
): Array<{ label: string; onClick?: () => void }> {
  const crumbs: Array<{ label: string; onClick?: () => void }> = [];
  if (layer.kind === "overview") return crumbs;

  crumbs.push({ label: wsName ?? "Workspace", onClick: () => setLayer({ kind: "overview" }) });

  if (layer.kind === "project") {
    crumbs.push({ label: projName ?? "Project" });
  } else if (layer.kind === "topic") {
    crumbs.push({ label: projName ?? "Project", onClick: () => setLayer({ kind: "project" }) });
    crumbs.push({ label: layer.topic.name });
  } else if (layer.kind === "memory-detail") {
    crumbs.push({ label: projName ?? "Project", onClick: () => setLayer({ kind: "project" }) });
    crumbs.push({ label: layer.memory.subject });
  } else if (layer.kind === "entity") {
    crumbs.push({ label: projName ?? "Project", onClick: () => setLayer({ kind: "project" }) });
    crumbs.push({ label: layer.entity.name });
  }
  return crumbs;
}

// ---- Layer 0: Overview ----

function OverviewLayer({
  projects,
  onSelectProject,
}: {
  projects: Project[];
  onSelectProject: (p: Project) => void;
}): React.JSX.Element {
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    void (async () => {
      const result: Record<string, number> = {};
      for (const p of projects) {
        result[p.id] = await window.armorClaw.getMemoryCountForProject(p.id);
      }
      setCounts(result);
    })();
  }, [projects]);

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
            onClick={() => onSelectProject(p)}
          >
            <h4 className="text-sm font-medium text-white">{p.name}</h4>
            {p.description && (
              <p className="mt-1 text-xs text-[#8b8b92]">{p.description}</p>
            )}
            <div className="mt-2 flex items-center gap-3">
              <span className="text-xs text-[#8b8b92]">
                {counts[p.id] ?? 0} memories
              </span>
              <span className="rounded-full bg-[#26262c] px-2 py-0.5 text-xs text-[#8b8b92]">
                {p.brainMode}
              </span>
            </div>
          </button>
        ))}
      </div>
      {projects.length === 0 && (
        <p className="py-8 text-center text-sm text-[#8b8b92]">
          No projects yet. Create one in the sidebar.
        </p>
      )}
    </div>
  );
}

// ---- Layer 1: Project view ----

function ProjectLayer({
  project,
  onSelectMemory,
  onSelectTopic,
  onSelectEntity,
}: {
  project: Project;
  onSelectMemory: (m: Memory) => void;
  onSelectTopic: (t: Topic) => void;
  onSelectEntity: (e: Entity) => void;
}): React.JSX.Element {
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "approved" | "proposed">("approved");

  useEffect(() => {
    void loadData();
  }, [project.id]);

  const loadData = async () => {
    const [mems, tops] = await Promise.all([
      statusFilter === "all"
        ? window.armorClaw.listMemories(project.id)
        : window.armorClaw.listMemories(project.id, statusFilter),
      window.armorClaw.getTopicsForProject(project.id),
    ]);
    setMemories(mems);
    setTopics(tops);
    if (activeWorkspace) {
      const ents = await window.armorClaw.listEntities(activeWorkspace.id);
      setEntities(ents);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      await loadData();
      return;
    }
    const results = await window.armorClaw.searchMemories(project.id, searchQuery);
    setMemories(results);
  };

  const handleApprove = async (id: string) => {
    await window.armorClaw.approveMemory(id);
    await loadData();
  };

  const handleReject = async (id: string) => {
    await window.armorClaw.rejectMemory(id);
    await loadData();
  };

  return (
    <div className="flex gap-4">
      <div className="flex-1">
        {/* Topic chips */}
        {topics.length > 0 && (
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Topics
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {topics.map((t) => (
                <button
                  key={t.id}
                  className="rounded-full border border-[#26262c] bg-[#16161a] px-3 py-1 text-xs text-[#e8e8ea] transition-colors hover:border-[#d97706] hover:text-white"
                  onClick={() => onSelectTopic(t)}
                >
                  {t.name}
                  <span className="ml-1.5 text-[#8b8b92]">{t.useCount}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search + filter */}
        <div className="mb-4 flex gap-2">
          <input
            className="flex-1 rounded-md border border-[#26262c] bg-[#16161a] px-3 py-2 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
            placeholder="Search memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSearch(); }}
          />
          <select
            className="rounded-md border border-[#26262c] bg-[#16161a] px-2 py-2 text-xs text-white outline-none"
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as "all" | "approved" | "proposed");
              void loadData();
            }}
          >
            <option value="approved">Approved</option>
            <option value="proposed">Proposed</option>
            <option value="all">All</option>
          </select>
          <button
            className="rounded-md bg-[#26262c] px-3 py-2 text-sm text-white hover:bg-[#d97706]"
            onClick={() => void handleSearch()}
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
              onApprove={() => void handleApprove(m.id)}
              onReject={() => void handleReject(m.id)}
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

      {/* Entity sidebar */}
      {entities.length > 0 && (
        <div className="w-48 flex-shrink-0">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
            Entities
          </h3>
          <div className="space-y-1">
            {entities.map((e) => (
              <button
                key={e.id}
                className="w-full rounded-md px-2 py-1.5 text-left text-xs text-[#e8e8ea] transition-colors hover:bg-[#26262c]"
                onClick={() => onSelectEntity(e)}
              >
                <span className="mr-1.5">{entityIcon(e.type)}</span>
                {e.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Layer 2: Topic view ----

function TopicLayer({
  topic,
  onSelectMemory,
  onSelectTopic,
}: {
  topic: Topic;
  onSelectMemory: (m: Memory) => void;
  onSelectTopic: (t: Topic) => void;
}): React.JSX.Element {
  const activeProject = useAppStore((s) => s.activeProject);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [relatedTopics, setRelatedTopics] = useState<Topic[]>([]);
  const [pins, setPins] = useState<DossierPin[]>([]);
  const [generatedDossier, setGeneratedDossier] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setGeneratedDossier(null);
      const [mems, pinList] = await Promise.all([
        window.armorClaw.getMemoriesForTopic(topic.id),
        window.armorClaw.listDossierPins(topic.id),
      ]);
      setMemories(mems);
      setPins(pinList);
      if (activeProject) {
        const all = await window.armorClaw.getTopicsForProject(activeProject.id);
        setRelatedTopics(all.filter((t) => t.id !== topic.id));
      }
      setLoading(false);
    })();
  }, [topic.id, activeProject?.id]);

  const handleGenerate = async () => {
    setGenerating(true);
    const content = await window.armorClaw.generateDossier(topic.id);
    setGeneratedDossier(content);
    setGenerating(false);
  };

  const handlePin = async () => {
    if (!generatedDossier) return;
    const pin = await window.armorClaw.createDossierPin(topic.id, generatedDossier);
    setPins((prev) => [pin, ...prev]);
  };

  const handleArchive = async (id: string) => {
    await window.armorClaw.archiveDossierPin(id);
    setPins((prev) => prev.filter((p) => p.id !== id));
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  if (loading) return <p className="text-[#8b8b92]">Loading...</p>;

  return (
    <div>
      <div className="mb-4 rounded-lg border border-[#26262c] bg-[#16161a] p-4">
        <h3 className="text-lg font-medium text-white">{topic.name}</h3>
        {topic.description && (
          <p className="mt-1 text-sm text-[#8b8b92]">{topic.description}</p>
        )}
        <div className="mt-2 flex items-center gap-3 text-xs text-[#8b8b92]">
          <span>{memories.length} memories</span>
          <span>Used {topic.useCount} times</span>
          {topic.lastUsedAt && (
            <span>Last used {new Date(topic.lastUsedAt).toLocaleDateString()}</span>
          )}
        </div>
      </div>

      {/* Dossier section */}
      <div className="mb-4">
        {pins.length > 0 && (
          <div className="mb-3">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Pinned Dossiers
            </h3>
            <div className="space-y-2">
              {pins.map((pin) => (
                <div key={pin.id} className="rounded-lg border border-[#26262c] bg-[#16161a] p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[#8b8b92]">
                      Generated {new Date(pin.generatedAt).toLocaleDateString()}
                    </span>
                    <div className="flex gap-1.5">
                      <button
                        className="rounded px-2 py-0.5 text-xs text-[#8b8b92] hover:bg-[#26262c] hover:text-white"
                        onClick={() => void handleCopy(pin.contentMd)}
                      >
                        Copy
                      </button>
                      <button
                        className="rounded px-2 py-0.5 text-xs text-[#dc2626] hover:bg-[#dc2626]/20"
                        onClick={() => void handleArchive(pin.id)}
                      >
                        Archive
                      </button>
                    </div>
                  </div>
                  <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-[#e8e8ea]">
                    {pin.contentMd}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        )}

        <button
          className="rounded-md border border-[#26262c] px-4 py-2 text-sm text-[#e8e8ea] transition-colors hover:border-[#d97706] hover:text-white disabled:opacity-50"
          onClick={() => void handleGenerate()}
          disabled={generating || memories.length === 0}
        >
          {generating ? "Generating..." : "Generate dossier"}
        </button>

        {generatedDossier && (
          <div className="mt-3 rounded-lg border border-[#d97706]/30 bg-[#16161a] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wider text-[#d97706]">
                Generated Dossier
              </span>
              <div className="flex gap-1.5">
                <button
                  className="rounded px-2 py-1 text-xs text-[#8b8b92] hover:bg-[#26262c] hover:text-white"
                  onClick={() => void handleCopy(generatedDossier)}
                >
                  Copy as markdown
                </button>
                <button
                  className="rounded bg-[#d97706] px-2 py-1 text-xs text-white hover:bg-[#b45309]"
                  onClick={() => void handlePin()}
                >
                  Pin
                </button>
              </div>
            </div>
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap text-sm text-[#e8e8ea]">
              {generatedDossier}
            </pre>
          </div>
        )}
      </div>

      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        Memories in this topic
      </h3>
      <div className="space-y-2">
        {memories.map((m) => (
          <MemoryCard
            key={m.id}
            memory={m}
            onClick={() => onSelectMemory(m)}
          />
        ))}
      </div>
      {memories.length === 0 && (
        <p className="py-4 text-center text-sm text-[#8b8b92]">
          No memories linked to this topic yet.
        </p>
      )}

      {relatedTopics.length > 0 && (
        <div className="mt-6 border-t border-[#26262c] pt-4">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
            Related Topics
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {relatedTopics.map((t) => (
              <button
                key={t.id}
                className="rounded-full border border-[#26262c] bg-[#16161a] px-3 py-1 text-xs text-[#e8e8ea] transition-colors hover:border-[#d97706]"
                onClick={() => onSelectTopic(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Layer 3: Memory detail ----

function MemoryDetailLayer({
  memory: initialMemory,
  onBack,
  onSelectEntity,
  onDeleted,
}: {
  memory: Memory;
  onBack: () => void;
  onSelectEntity: (e: Entity) => void;
  onDeleted: () => void;
}): React.JSX.Element {
  const [memory, setMemory] = useState(initialMemory);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [topic, setTopic] = useState<Topic | undefined>();
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState(memory.subject);
  const [editValue, setEditValue] = useState(memory.value);
  const [crossWalkResults, setCrossWalkResults] = useState<Array<Entity & { workspaceName: string }> | null>(null);

  useEffect(() => {
    void (async () => {
      const [ents, top] = await Promise.all([
        window.armorClaw.getEntitiesForMemory(memory.id),
        window.armorClaw.getTopicForMemory(memory.id),
      ]);
      setEntities(ents);
      setTopic(top);
    })();
  }, [memory.id]);

  const handleSave = async () => {
    await window.armorClaw.updateMemory(memory.id, { subject: editSubject, value: editValue });
    setMemory({ ...memory, subject: editSubject, value: editValue });
    setEditing(false);
  };

  const handleDelete = async () => {
    await window.armorClaw.deleteMemory(memory.id);
    onDeleted();
  };

  const handleApprove = async () => {
    await window.armorClaw.approveMemory(memory.id);
    setMemory({ ...memory, status: "approved" });
  };

  const handleReject = async () => {
    await window.armorClaw.rejectMemory(memory.id);
    setMemory({ ...memory, status: "rejected" });
  };

  const handleFindRelated = async () => {
    const results = await window.armorClaw.searchEntitiesAcross(memory.subject);
    setCrossWalkResults(results);
  };

  return (
    <div>
      <button className="mb-4 text-sm text-[#d97706] hover:underline" onClick={onBack}>
        &larr; Back to memories
      </button>

      <div className="rounded-lg border border-[#26262c] bg-[#16161a] p-4">
        {editing ? (
          <div className="space-y-3">
            <input
              className="w-full rounded-md border border-[#26262c] bg-[#0e0e0f] px-3 py-2 text-sm font-medium text-white outline-none focus:border-[#d97706]"
              value={editSubject}
              onChange={(e) => setEditSubject(e.target.value)}
            />
            <textarea
              className="w-full resize-none rounded-md border border-[#26262c] bg-[#0e0e0f] px-3 py-2 text-sm text-white outline-none focus:border-[#d97706]"
              rows={6}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                className="rounded-md bg-[#d97706] px-3 py-1.5 text-sm text-white hover:bg-[#b45309]"
                onClick={() => void handleSave()}
              >
                Save
              </button>
              <button
                className="rounded-md border border-[#26262c] px-3 py-1.5 text-sm text-[#8b8b92] hover:text-white"
                onClick={() => { setEditing(false); setEditSubject(memory.subject); setEditValue(memory.value); }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between">
              <h3 className="text-lg font-medium text-white">{memory.subject}</h3>
              <div className="flex gap-1.5">
                <button
                  className="rounded px-2 py-1 text-xs text-[#8b8b92] hover:bg-[#26262c] hover:text-white"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </button>
                <button
                  className="rounded px-2 py-1 text-xs text-[#dc2626] hover:bg-[#dc2626]/20"
                  onClick={() => void handleDelete()}
                >
                  Delete
                </button>
              </div>
            </div>
            <div className="mt-3 whitespace-pre-wrap text-sm text-[#e8e8ea]">{memory.value}</div>
          </>
        )}

        {memory.summary && (
          <div className="mt-3 rounded-md bg-[#0e0e0f] p-3">
            <span className="text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Summary
            </span>
            <p className="mt-1 text-sm text-[#e8e8ea]">{memory.summary}</p>
          </div>
        )}

        {/* Entities */}
        {entities.length > 0 && (
          <div className="mt-3 rounded-md bg-[#0e0e0f] p-3">
            <span className="text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Entities
            </span>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {entities.map((e) => (
                <button
                  key={e.id}
                  className="rounded-full border border-[#26262c] px-2.5 py-0.5 text-xs text-[#e8e8ea] transition-colors hover:border-[#d97706]"
                  onClick={() => onSelectEntity(e)}
                >
                  <span className="mr-1">{entityIcon(e.type)}</span>
                  {e.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Topic */}
        {topic && (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-[#8b8b92]">Topic:</span>
            <span className="rounded-full bg-[#26262c] px-2.5 py-0.5 text-xs text-[#e8e8ea]">
              {topic.name}
            </span>
          </div>
        )}

        {/* Footer metadata + actions */}
        <div className="mt-4 flex items-center gap-3 border-t border-[#26262c] pt-3">
          <StatusBadge status={memory.status} />
          <span className="text-xs text-[#8b8b92]">
            {Math.round(memory.confidence * 100)}% confidence
          </span>
          <span className="text-xs text-[#8b8b92]">
            Created {new Date(memory.createdAt).toLocaleDateString()}
          </span>
          <div className="ml-auto flex gap-2">
            {memory.status === "proposed" && (
              <>
                <button
                  className="rounded-md bg-[#65a30d] px-3 py-1.5 text-sm text-white hover:bg-[#4d7c0f]"
                  onClick={() => void handleApprove()}
                >
                  Approve
                </button>
                <button
                  className="rounded-md bg-[#dc2626] px-3 py-1.5 text-sm text-white hover:bg-[#b91c1c]"
                  onClick={() => void handleReject()}
                >
                  Reject
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Cross-walk */}
      <div className="mt-4">
        <button
          className="rounded-md border border-[#26262c] px-3 py-2 text-sm text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
          onClick={() => void handleFindRelated()}
        >
          Find related across all workspaces
        </button>
        {crossWalkResults && (
          <div className="mt-3 rounded-lg border border-[#26262c] bg-[#16161a] p-3">
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Cross-workspace matches ({crossWalkResults.length})
            </h4>
            {crossWalkResults.length === 0 ? (
              <p className="text-xs text-[#8b8b92]">No matches found.</p>
            ) : (
              <div className="space-y-1">
                {crossWalkResults.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs">
                    <span>{entityIcon(e.type)}</span>
                    <span className="text-[#e8e8ea]">{e.name}</span>
                    <span className="text-[#8b8b92]">in {e.workspaceName}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Layer 4: Entity detail ----

function EntityLayer({
  entity,
  onSelectMemory,
}: {
  entity: Entity;
  onSelectMemory: (m: Memory) => void;
}): React.JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const mems = await window.armorClaw.getMemoriesForEntity(entity.id);
      setMemories(mems);
      setLoading(false);
    })();
  }, [entity.id]);

  if (loading) return <p className="text-[#8b8b92]">Loading...</p>;

  return (
    <div>
      <div className="mb-4 rounded-lg border border-[#26262c] bg-[#16161a] p-4">
        <div className="flex items-center gap-2">
          <span className="text-xl">{entityIcon(entity.type)}</span>
          <h3 className="text-lg font-medium text-white">{entity.name}</h3>
        </div>
        <div className="mt-2 flex items-center gap-3 text-xs text-[#8b8b92]">
          <span className="rounded-full bg-[#26262c] px-2 py-0.5">{entity.type}</span>
          <span>{memories.length} related memories</span>
          {entity.aliases && entity.aliases.length > 0 && (
            <span>Also known as: {entity.aliases.join(", ")}</span>
          )}
        </div>
      </div>

      <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        Memories mentioning {entity.name}
      </h3>
      <div className="space-y-2">
        {memories.map((m) => (
          <MemoryCard key={m.id} memory={m} onClick={() => onSelectMemory(m)} />
        ))}
      </div>
      {memories.length === 0 && (
        <p className="py-4 text-center text-sm text-[#8b8b92]">
          No memories linked to this entity.
        </p>
      )}
    </div>
  );
}

// ---- Shared components ----

function MemoryCard({
  memory,
  onClick,
  onApprove,
  onReject,
}: {
  memory: Memory;
  onClick: () => void;
  onApprove?: () => void;
  onReject?: () => void;
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
        <StatusBadge status={memory.status} />
        <span className="text-xs text-[#8b8b92]">
          {Math.round(memory.confidence * 100)}%
        </span>
        {memory.status === "proposed" && onApprove && onReject && (
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

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const colors =
    status === "approved"
      ? "bg-[#65a30d]/20 text-[#65a30d]"
      : status === "proposed"
        ? "bg-[#ca8a04]/20 text-[#ca8a04]"
        : "bg-[#dc2626]/20 text-[#dc2626]";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${colors}`}>
      {status}
    </span>
  );
}

function entityIcon(type: string): string {
  switch (type) {
    case "person": return "👤";
    case "project": return "📁";
    case "event": return "📅";
    case "organization": return "🏢";
    case "place": return "📍";
    case "thing": return "📦";
    default: return "•";
  }
}
