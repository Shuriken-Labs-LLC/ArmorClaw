import { useEffect, useState } from "react";
import { useAppStore } from "../stores/app-store";
import type { AppState, AuditEntry } from "../types";

type SettingsTab = "account" | "general" | "brain" | "audit";

export function SettingsView(): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>("general");

  return (
    <div className="flex h-full">
      {/* Settings nav */}
      <div className="w-48 border-r border-[#26262c] p-4">
        <h2 className="mb-4 text-sm font-medium text-white">Settings</h2>
        <nav className="space-y-1">
          <SettingsNavItem label="General" active={tab === "general"} onClick={() => setTab("general")} />
          <SettingsNavItem label="Account" active={tab === "account"} onClick={() => setTab("account")} />
          <SettingsNavItem label="Brain" active={tab === "brain"} onClick={() => setTab("brain")} />
          <SettingsNavItem label="Audit Log" active={tab === "audit"} onClick={() => setTab("audit")} />
        </nav>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "general" && <GeneralSettings />}
        {tab === "account" && <AccountSettings />}
        {tab === "brain" && <BrainSettings />}
        {tab === "audit" && <AuditLog />}
      </div>
    </div>
  );
}

function SettingsNavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
        active
          ? "bg-[#26262c] text-white"
          : "text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function GeneralSettings(): React.JSX.Element {
  const appState = useAppStore((s) => s.appState);

  if (!appState) return <p className="text-[#8b8b92]">Loading...</p>;

  const handleUpdate = async (updates: Partial<AppState>) => {
    await window.armorClaw.updateAppState(updates);
    const newState = await window.armorClaw.getAppState();
    useAppStore.setState({ appState: newState });
  };

  return (
    <div className="max-w-lg space-y-6">
      <h3 className="text-lg font-medium text-white">General</h3>

      <SettingsGroup label="Model Provider">
        <select
          className="w-full rounded-md border border-[#26262c] bg-[#16161a] px-3 py-2 text-sm text-white outline-none focus:border-[#d97706]"
          value={appState.modelProvider}
          onChange={(e) => void handleUpdate({ modelProvider: e.target.value as "openai" | "anthropic" })}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </SettingsGroup>

      <SettingsGroup label="Personality Mode">
        <div className="flex gap-2">
          <RadioButton
            label="Standard"
            checked={appState.personalityMode === "standard"}
            onChange={() => void handleUpdate({ personalityMode: "standard" })}
          />
          <RadioButton
            label="Unhinged"
            checked={appState.personalityMode === "unhinged"}
            onChange={() => void handleUpdate({ personalityMode: "unhinged" })}
          />
        </div>
        <p className="mt-1 text-xs text-[#8b8b92]">
          Controls Emerson&apos;s personality intensity. Only affects user-facing chat voice, never outbound content.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Default Autonomy">
        <div className="flex gap-2">
          <RadioButton
            label="Gated"
            checked={appState.autonomyDefault === "gated"}
            onChange={() => void handleUpdate({ autonomyDefault: "gated" })}
          />
          <RadioButton
            label="Autonomous"
            checked={appState.autonomyDefault === "autonomous"}
            onChange={() => void handleUpdate({ autonomyDefault: "autonomous" })}
          />
        </div>
        <p className="mt-1 text-xs text-[#8b8b92]">
          Autonomous lets reversible actions run without approval. Irreversible actions always require approval regardless of this setting.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Missed Run Policy">
        <select
          className="w-full rounded-md border border-[#26262c] bg-[#16161a] px-3 py-2 text-sm text-white outline-none focus:border-[#d97706]"
          value={appState.missedRunDefault}
          onChange={(e) => void handleUpdate({ missedRunDefault: e.target.value as "ask" | "skip" | "next_wake" })}
        >
          <option value="ask">Ask</option>
          <option value="skip">Skip</option>
          <option value="next_wake">Next wake</option>
        </select>
        <p className="mt-1 text-xs text-[#8b8b92]">
          What happens when a scheduled commitment fires while the device was off.
        </p>
      </SettingsGroup>

      <SettingsGroup label="Launch at Login">
        <div className="flex items-center justify-between rounded-md border border-[#26262c] bg-[#16161a] p-3">
          <div>
            <p className="text-sm text-[#e8e8ea]">Open ArmorClaw when you log in</p>
            <p className="text-xs text-[#8b8b92]">
              Keeps the scheduler running so commitments fire on time.
            </p>
          </div>
          <LaunchAtLoginToggle />
        </div>
      </SettingsGroup>

      <SettingsGroup label="OpenClaw Runtime">
        <div className="rounded-md border border-[#26262c] bg-[#16161a] p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-[#e8e8ea]">
              Version: {appState.openclawVersion ?? "Not detected"}
            </span>
            {appState.openclawPath && (
              <span className="text-xs text-[#8b8b92]">
                {appState.openclawPath}
              </span>
            )}
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}

function AccountSettings(): React.JSX.Element {
  const appState = useAppStore((s) => s.appState);
  const activeWorkspace = useAppStore((s) => s.activeWorkspace);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  if (!appState) return <p className="text-[#8b8b92]">Loading...</p>;

  const handleExport = async () => {
    if (!activeWorkspace) return;
    setExporting(true);
    try {
      const path = await window.armorClaw.exportWorkspace(activeWorkspace.id);
      setExportPath(path);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="max-w-lg space-y-6">
      <h3 className="text-lg font-medium text-white">Account</h3>

      <SettingsGroup label="Email">
        <p className="text-sm text-[#e8e8ea]">
          {appState.userEmail ?? "Not signed in"}
        </p>
      </SettingsGroup>

      <SettingsGroup label="Subscription">
        <div className="rounded-md border border-[#26262c] bg-[#16161a] p-4">
          {appState.licenseJwt ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-[#65a30d]/20 px-2 py-0.5 text-xs text-[#65a30d]">
                  Active
                </span>
              </div>
              {appState.licenseExpiresAt && (
                <p className="text-xs text-[#8b8b92]">
                  Validates until {new Date(appState.licenseExpiresAt).toLocaleDateString()}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-[#8b8b92]">No active subscription</p>
              <button className="rounded-md bg-[#d97706] px-4 py-2 text-sm font-medium text-white hover:bg-[#b45309]">
                Start trial
              </button>
            </div>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup label="Export Workspace">
        <div className="space-y-2">
          <p className="text-xs text-[#8b8b92]">
            Export the current workspace as markdown: all projects, chats, memories, and commitments.
          </p>
          <button
            className="rounded-md bg-[#26262c] px-4 py-2 text-sm text-white hover:bg-[#3a3a42] disabled:opacity-50"
            onClick={() => void handleExport()}
            disabled={!activeWorkspace || exporting}
          >
            {exporting ? "Exporting..." : `Export "${activeWorkspace?.name ?? "workspace"}"`}
          </button>
          {exportPath && (
            <p className="text-xs text-[#65a30d]">Saved to {exportPath}</p>
          )}
        </div>
      </SettingsGroup>
    </div>
  );
}

function BrainSettings(): React.JSX.Element {
  const activeProject = useAppStore((s) => s.activeProject);
  const [memoryCount, setMemoryCount] = useState(0);

  useEffect(() => {
    if (activeProject) {
      void window.armorClaw.getMemoryCountForProject(activeProject.id).then(setMemoryCount);
    }
  }, [activeProject?.id]);

  if (!activeProject) {
    return <p className="text-[#8b8b92]">Select a project to configure brain settings.</p>;
  }

  const handleBrainModeChange = async (mode: "smart" | "manual" | "full") => {
    await window.armorClaw.updateProject(activeProject.id, { brainMode: mode });
    const proj = await window.armorClaw.getProject(activeProject.id);
    if (proj) {
      useAppStore.setState({ activeProject: proj });
    }
  };

  const avgTokensPerMemory = 150;
  const tokenEstimates = {
    smart: `~${Math.round(memoryCount * avgTokensPerMemory * 0.15)} tokens/chat`,
    manual: "~0 tokens/chat",
    full: `~${(memoryCount * avgTokensPerMemory).toLocaleString()} tokens/chat`,
  };

  return (
    <div className="max-w-lg space-y-6">
      <h3 className="text-lg font-medium text-white">
        Brain &mdash; {activeProject.name}
      </h3>

      <div className="rounded-md border border-[#26262c] bg-[#16161a] p-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-[#8b8b92]">Approved memories</span>
          <span className="font-medium text-white">{memoryCount}</span>
        </div>
      </div>

      <SettingsGroup label="Access Mode">
        <div className="space-y-2">
          <BrainModeOption
            label="Smart"
            description="Agent searches memory when relevant. Low token cost."
            tokenEstimate={tokenEstimates.smart}
            active={activeProject.brainMode === "smart"}
            onClick={() => void handleBrainModeChange("smart")}
          />
          <BrainModeOption
            label="Manual"
            description="Agent only searches when you explicitly ask. Near-zero token cost."
            tokenEstimate={tokenEstimates.manual}
            active={activeProject.brainMode === "manual"}
            onClick={() => void handleBrainModeChange("manual")}
          />
          <BrainModeOption
            label="Full"
            description="All memories loaded into every chat. Token cost scales with memory count."
            tokenEstimate={tokenEstimates.full}
            active={activeProject.brainMode === "full"}
            onClick={() => void handleBrainModeChange("full")}
          />
        </div>
      </SettingsGroup>
    </div>
  );
}

function BrainModeOption({
  label,
  description,
  tokenEstimate,
  active,
  onClick,
}: {
  label: string;
  description: string;
  tokenEstimate: string;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`w-full rounded-lg border p-3 text-left transition-colors ${
        active
          ? "border-[#d97706] bg-[#d97706]/10"
          : "border-[#26262c] bg-[#16161a] hover:border-[#8b8b92]"
      }`}
      onClick={onClick}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-white">{label}</span>
        <span className="rounded-full bg-[#26262c] px-2 py-0.5 text-xs text-[#8b8b92]">
          {tokenEstimate}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-[#8b8b92]">{description}</p>
    </button>
  );
}

function AuditLog(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadEntries();
  }, []);

  const loadEntries = async () => {
    setLoading(true);
    const result = await window.armorClaw.listAuditEntries(100);
    setEntries(result);
    setLoading(false);
  };

  if (loading) return <p className="text-[#8b8b92]">Loading audit log...</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-white">Audit Log</h3>
        <button
          className="rounded-md px-3 py-1 text-xs text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
          onClick={() => void loadEntries()}
        >
          Refresh
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-[#8b8b92]">No audit entries yet.</p>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-md border border-[#26262c] bg-[#16161a] px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="rounded bg-[#26262c] px-1.5 py-0.5 text-xs font-mono text-[#d97706]">
                  {entry.eventType}
                </span>
                <span className="text-xs text-[#8b8b92]">
                  {new Date(entry.createdAt).toLocaleString()}
                </span>
              </div>
              <pre className="mt-1 overflow-x-auto text-xs text-[#8b8b92]">
                {entry.payloadJson}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <label className="mb-2 block text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
        {label}
      </label>
      {children}
    </div>
  );
}

function LaunchAtLoginToggle(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.armorClaw.getLoginItemSettings().then((settings) => {
      setEnabled(settings.openAtLogin);
      setLoading(false);
    });
  }, []);

  const toggle = async () => {
    const next = !enabled;
    await window.armorClaw.setLoginItemSettings(next);
    setEnabled(next);
  };

  if (loading) return <span className="text-xs text-[#8b8b92]">...</span>;

  return (
    <button
      className={`relative h-6 w-11 rounded-full transition-colors ${
        enabled ? "bg-[#d97706]" : "bg-[#26262c]"
      }`}
      onClick={() => void toggle()}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

function RadioButton({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}): React.JSX.Element {
  return (
    <button
      className={`rounded-md border px-4 py-2 text-sm transition-colors ${
        checked
          ? "border-[#d97706] bg-[#d97706]/10 text-white"
          : "border-[#26262c] bg-[#16161a] text-[#8b8b92] hover:border-[#8b8b92]"
      }`}
      onClick={onChange}
    >
      {label}
    </button>
  );
}
