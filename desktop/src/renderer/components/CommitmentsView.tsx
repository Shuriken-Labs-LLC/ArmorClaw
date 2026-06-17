import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { Commitment, CommitmentRun } from "../types";

export function CommitmentsView(): React.JSX.Element {
  const activeProject = useAppStore((s) => s.activeProject);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeProject) return;
    const list = await window.armorClaw.listCommitments(activeProject.id);
    setCommitments(list);
  }, [activeProject]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsub1 = window.armorClaw.onCommitmentFired(() => void load());
    const unsub2 = window.armorClaw.onCommitmentMissed(() => void load());
    return () => { unsub1(); unsub2(); };
  }, [load]);

  if (!activeProject || !activeWorkspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[#8b8b92]">Select a project to view commitments</p>
      </div>
    );
  }

  const active = commitments.filter((c) => c.status === "active" && c.nextFireAt);
  const paused = commitments.filter((c) => c.status === "paused");
  const completed = commitments.filter((c) => c.status === "done" || c.status === "failed");

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-[#26262c] px-6 py-3">
        <h2 className="text-sm font-medium text-white">
          Commitments &mdash; {activeProject.name}
        </h2>
        <button
          className="rounded-md bg-[#d97706] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#b45309]"
          onClick={() => setShowCreate(true)}
        >
          + New commitment
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-2xl">
          {showCreate && (
            <CreateCommitmentForm
              workspaceId={activeWorkspace.id}
              projectId={activeProject.id}
              onCreated={() => { setShowCreate(false); void load(); }}
              onCancel={() => setShowCreate(false)}
            />
          )}

          <Section title="Active" items={active} expandedId={expandedId} onToggle={setExpandedId} onUpdate={load} />
          <Section title="Paused" items={paused} expandedId={expandedId} onToggle={setExpandedId} onUpdate={load} />
          {completed.length > 0 && (
            <Section title="Completed" items={completed} expandedId={expandedId} onToggle={setExpandedId} onUpdate={load} />
          )}

          {commitments.length === 0 && !showCreate && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-[#26262c] p-8 text-center">
              <span className="text-4xl">📋</span>
              <h3 className="text-sm font-medium text-white">No commitments yet</h3>
              <p className="max-w-sm text-xs text-[#8b8b92]">
                Commitments are recurring or one-time tasks that Emerson runs
                for you automatically. Try &ldquo;Set up a daily briefing&rdquo;
                in chat, or create one manually.
              </p>
              <button
                className="mt-2 rounded-md bg-[#d97706] px-4 py-2 text-sm font-medium text-white hover:bg-[#b45309]"
                onClick={() => setShowCreate(true)}
              >
                Create your first commitment
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  items,
  expandedId,
  onToggle,
  onUpdate,
}: {
  title: string;
  items: Commitment[];
  expandedId: string | null;
  onToggle: (id: string | null) => void;
  onUpdate: () => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section className="mb-8">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        {title} ({items.length})
      </h3>
      <div className="space-y-2">
        {items.map((c) => (
          <CommitmentCard
            key={c.id}
            commitment={c}
            expanded={expandedId === c.id}
            onToggle={() => onToggle(expandedId === c.id ? null : c.id)}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </section>
  );
}

function CommitmentCard({
  commitment,
  expanded,
  onToggle,
  onUpdate,
}: {
  commitment: Commitment;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: () => void;
}): React.JSX.Element {
  const [runs, setRuns] = useState<CommitmentRun[]>([]);

  useEffect(() => {
    if (expanded) {
      void window.armorClaw.listCommitmentRuns(commitment.id).then(setRuns);
    }
  }, [expanded, commitment.id]);

  const handlePause = async () => {
    await window.armorClaw.updateCommitment(commitment.id, { status: "paused" });
    onUpdate();
  };

  const handleResume = async () => {
    await window.armorClaw.updateCommitment(commitment.id, { status: "active" });
    onUpdate();
  };

  const handleDelete = async () => {
    await window.armorClaw.deleteCommitment(commitment.id);
    onUpdate();
  };

  const nextFire = commitment.nextFireAt
    ? new Date(commitment.nextFireAt).toLocaleString()
    : "—";

  const statusColor = {
    active: "text-emerald-400",
    paused: "text-yellow-400",
    done: "text-[#8b8b92]",
    failed: "text-red-400",
  }[commitment.status];

  return (
    <div className="rounded-lg border border-[#26262c] bg-[#16161a]">
      <button
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        onClick={onToggle}
      >
        <span className={`text-xs font-medium ${statusColor}`}>
          {commitment.status.toUpperCase()}
        </span>
        <span className="flex-1 truncate text-sm text-white">
          {commitment.description}
        </span>
        <span className="text-xs text-[#8b8b92]">{nextFire}</span>
        <span className="text-[#8b8b92]">{expanded ? "▾" : "▸"}</span>
      </button>

      {expanded && (
        <div className="border-t border-[#26262c] px-4 py-3">
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-[#8b8b92]">
            <div>
              Trigger: <span className="text-white">{commitment.triggerType}</span>
            </div>
            <div>
              Autonomy: <span className="text-white">{commitment.autonomy}</span>
            </div>
            <div>
              Missed policy: <span className="text-white">{commitment.missedRunPolicy}</span>
            </div>
            <div>
              Last run:{" "}
              <span className="text-white">
                {commitment.lastRunAt ? new Date(commitment.lastRunAt).toLocaleString() : "Never"}
              </span>
            </div>
          </div>

          <p className="mb-3 text-xs text-[#8b8b92]">
            Action: <span className="text-white">{commitment.actionTemplate}</span>
          </p>

          {runs.length > 0 && (
            <div className="mb-3">
              <h4 className="mb-1 text-xs font-medium text-[#8b8b92]">Recent runs</h4>
              <div className="space-y-1">
                {runs.slice(0, 5).map((r) => (
                  <div key={r.id} className="flex gap-2 text-xs">
                    <span className={r.outcome === "completed" ? "text-emerald-400" : r.outcome === "failed" ? "text-red-400" : "text-yellow-400"}>
                      {r.outcome}
                    </span>
                    <span className="text-[#8b8b92]">
                      {new Date(r.startedAt).toLocaleString()}
                    </span>
                    {r.detail && <span className="truncate text-[#8b8b92]">{r.detail}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            {commitment.status === "active" && (
              <button
                className="rounded-md border border-[#26262c] px-3 py-1 text-xs text-[#8b8b92] hover:text-white"
                onClick={() => void handlePause()}
              >
                Pause
              </button>
            )}
            {commitment.status === "paused" && (
              <button
                className="rounded-md border border-[#26262c] px-3 py-1 text-xs text-[#8b8b92] hover:text-white"
                onClick={() => void handleResume()}
              >
                Resume
              </button>
            )}
            <button
              className="rounded-md border border-[#26262c] px-3 py-1 text-xs text-red-400 hover:text-red-300"
              onClick={() => void handleDelete()}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateCommitmentForm({
  workspaceId,
  projectId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  projectId: string;
  onCreated: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [description, setDescription] = useState("");
  const [triggerType, setTriggerType] = useState<"time" | "interval" | "manual">("interval");
  const [intervalHours, setIntervalHours] = useState("24");
  const [actionTemplate, setActionTemplate] = useState("");

  const handleCreate = async () => {
    if (!description.trim() || !actionTemplate.trim()) return;

    let triggerSpec: string;
    let nextFireAt: number | undefined;

    if (triggerType === "interval") {
      const ms = parseFloat(intervalHours) * 3_600_000;
      triggerSpec = JSON.stringify({ intervalMs: ms });
      nextFireAt = Date.now() + ms;
    } else if (triggerType === "time") {
      triggerSpec = JSON.stringify({ at: Date.now() + 3_600_000 });
      nextFireAt = Date.now() + 3_600_000;
    } else {
      triggerSpec = JSON.stringify({ manual: true });
    }

    await window.armorClaw.createCommitment(
      workspaceId, projectId, description.trim(), triggerType, triggerSpec,
      actionTemplate.trim(), nextFireAt,
    );
    onCreated();
  };

  return (
    <div className="mb-6 rounded-lg border border-[#d97706] bg-[#16161a] p-4">
      <h3 className="mb-3 text-sm font-medium text-white">New commitment</h3>

      <input
        className="mb-2 w-full rounded-md border border-[#26262c] bg-[#0f0f10] px-3 py-2 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
        placeholder="What should the agent do?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        autoFocus
      />

      <textarea
        className="mb-3 w-full rounded-md border border-[#26262c] bg-[#0f0f10] px-3 py-2 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
        placeholder="Action template (instructions for the agent)"
        rows={3}
        value={actionTemplate}
        onChange={(e) => setActionTemplate(e.target.value)}
      />

      <div className="mb-3 flex gap-2">
        {(["interval", "time", "manual"] as const).map((t) => (
          <button
            key={t}
            className={`rounded-md border px-3 py-1.5 text-xs ${
              triggerType === t
                ? "border-[#d97706] bg-[#d97706]/10 text-white"
                : "border-[#26262c] text-[#8b8b92] hover:border-[#8b8b92]"
            }`}
            onClick={() => setTriggerType(t)}
          >
            {t === "interval" ? "Recurring" : t === "time" ? "One-time" : "Manual"}
          </button>
        ))}
      </div>

      {triggerType === "interval" && (
        <div className="mb-3 flex items-center gap-2">
          <span className="text-xs text-[#8b8b92]">Every</span>
          <input
            className="w-20 rounded-md border border-[#26262c] bg-[#0f0f10] px-2 py-1 text-sm text-white outline-none focus:border-[#d97706]"
            type="number"
            min="0.5"
            step="0.5"
            value={intervalHours}
            onChange={(e) => setIntervalHours(e.target.value)}
          />
          <span className="text-xs text-[#8b8b92]">hours</span>
        </div>
      )}

      <div className="flex gap-2">
        <button
          className="rounded-md bg-[#d97706] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#b45309] disabled:opacity-50"
          onClick={() => void handleCreate()}
          disabled={!description.trim() || !actionTemplate.trim()}
        >
          Create
        </button>
        <button
          className="rounded-md border border-[#26262c] px-4 py-1.5 text-xs text-[#8b8b92] hover:text-white"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
