import { useState } from "react";
import { useAppStore } from "../stores/app-store";

const ONBOARDING_STATES = [
  "welcome",
  "email_sent",
  "email_verified",
  "payment_captured",
  "openclaw_ready",
  "model_key_saved",
  "safety_acknowledged",
  "workspace_created",
  "integrations_offered",
  "done",
] as const;

type OnboardingState = (typeof ONBOARDING_STATES)[number];

const WORKSPACE_SUGGESTIONS = [
  { name: "Work", color: "#6366f1" },
  { name: "Personal", color: "#f59e0b" },
  { name: "Side projects", color: "#10b981" },
  { name: "Household", color: "#ef4444" },
];

export function Onboarding(): React.JSX.Element {
  const appState = useAppStore((s) => s.appState);
  const initialize = useAppStore((s) => s.initialize);
  const step = (appState?.onboardingState ?? "welcome") as OnboardingState;

  const advance = async (nextState: OnboardingState) => {
    await window.armorClaw.updateAppState({ onboardingState: nextState });
    if (nextState === "done") {
      await initialize();
    } else {
      const newState = await window.armorClaw.getAppState();
      useAppStore.setState({ appState: newState });
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-[#0f0f10]">
      <div className="w-full max-w-md px-6">
        {step === "welcome" && <WelcomeStep onNext={() => void advance("email_sent")} />}
        {step === "email_sent" && <EmailStep onNext={() => void advance("email_verified")} />}
        {step === "email_verified" && <CheckInboxStep onNext={() => void advance("payment_captured")} />}
        {step === "payment_captured" && <TrialStep onNext={() => void advance("openclaw_ready")} />}
        {step === "openclaw_ready" && <OpenClawStep onNext={() => void advance("model_key_saved")} />}
        {step === "model_key_saved" && <ModelKeyStep onNext={() => void advance("safety_acknowledged")} />}
        {step === "safety_acknowledged" && <SafetyStep onNext={() => void advance("workspace_created")} />}
        {step === "workspace_created" && <WorkspaceStep onNext={() => void advance("integrations_offered")} />}
        {step === "integrations_offered" && <IntegrationsStep onNext={() => void advance("done")} />}
      </div>
    </div>
  );
}

function StepShell({
  children,
  progress,
}: {
  children: React.ReactNode;
  progress: number;
}): React.JSX.Element {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <span className="text-3xl">🦞</span>
        <div className="h-1.5 flex-1 rounded-full bg-[#26262c]">
          <div
            className="h-full rounded-full bg-[#d97706] transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-xs text-[#8b8b92]">{progress}%</span>
      </div>
      {children}
    </div>
  );
}

function WelcomeStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <StepShell progress={0}>
      <div className="space-y-4 text-center">
        <div className="text-6xl">🦞</div>
        <h1 className="text-2xl font-bold text-white">Hi, I&apos;m Emerson.</h1>
        <p className="text-sm leading-relaxed text-[#8b8b92]">
          Your local-first AI agent with a real memory. I live on your machine,
          I remember what matters, and I don&apos;t forget the things you ask me
          to do.
        </p>
        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={onNext}
        >
          Get started
        </button>
      </div>
    </StepShell>
  );
}

function EmailStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const handleSend = async () => {
    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError("Please enter a valid email address.");
      return;
    }
    setSending(true);
    setError("");
    // In production, this would call the license worker's /auth/magic-link
    // For now, advance directly since we don't have the worker deployed
    await window.armorClaw.updateAppState({ userEmail: trimmed });
    onNext();
  };

  return (
    <StepShell progress={11}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          What email should we use for your account?
        </h2>
        <input
          type="email"
          className="w-full rounded-lg border border-[#26262c] bg-[#16161a] px-4 py-3 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSend(); }}
          autoFocus
        />
        {error && <p className="text-xs text-[#dc2626]">{error}</p>}
        <p className="text-xs text-[#8b8b92]">
          We&apos;ll send you a magic link to sign in. No password.
        </p>
        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309] disabled:opacity-50"
          onClick={() => void handleSend()}
          disabled={sending}
        >
          {sending ? "Sending..." : "Send magic link"}
        </button>
      </div>
    </StepShell>
  );
}

function CheckInboxStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const appState = useAppStore((s) => s.appState);
  // In production, this would listen for the deep-link callback
  // For now, provide a manual advance button
  return (
    <StepShell progress={22}>
      <div className="space-y-4 text-center">
        <div className="text-4xl">📬</div>
        <h2 className="text-lg font-medium text-white">Check your inbox.</h2>
        <p className="text-sm text-[#8b8b92]">
          We sent a sign-in link to{" "}
          <strong className="text-white">{appState?.userEmail ?? "your email"}</strong>.
          Click it to come back.
        </p>
        <p className="text-xs text-[#8b8b92]">
          Didn&apos;t receive it? Check spam or{" "}
          <button className="text-[#d97706] hover:underline">resend</button>.
        </p>
        {/* Dev bypass — in production this auto-advances via deep link */}
        <button
          className="w-full rounded-lg border border-[#26262c] py-3 text-sm text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
          onClick={onNext}
        >
          Continue (dev bypass)
        </button>
      </div>
    </StepShell>
  );
}

function TrialStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <StepShell progress={33}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          Start your 30-day free trial.
        </h2>
        <p className="text-sm text-[#8b8b92]">
          $19.99 per month after. We need a payment method to start the trial,
          but we won&apos;t charge until day 31.
        </p>
        <p className="text-xs text-[#8b8b92]">
          Cancel anytime in the app. Full refund in one click if you cancel
          within 7 days of your first charge.
        </p>
        {/* In production, this opens Stripe Checkout in system browser */}
        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={onNext}
        >
          Add payment method
        </button>
      </div>
    </StepShell>
  );
}

function OpenClawStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const appState = useAppStore((s) => s.appState);
  const detected = !!appState?.openclawVersion;

  return (
    <StepShell progress={44}>
      <div className="space-y-4">
        {detected ? (
          <>
            <div className="text-center text-4xl">✅</div>
            <h2 className="text-center text-lg font-medium text-white">
              OpenClaw detected.
            </h2>
            <p className="text-center text-sm text-[#8b8b92]">
              Version {appState?.openclawVersion}. You&apos;re good to go.
            </p>
          </>
        ) : (
          <>
            <h2 className="text-lg font-medium text-white">
              ArmorClaw needs the OpenClaw runtime.
            </h2>
            <p className="text-sm text-[#8b8b92]">
              We&apos;ll install it for you. About 30 seconds.
            </p>
            <div className="rounded-lg border border-[#26262c] bg-[#16161a] p-3">
              <p className="text-xs text-[#8b8b92]">
                OpenClaw is not yet available. This step will work once the
                runtime is published.
              </p>
            </div>
          </>
        )}
        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={onNext}
        >
          {detected ? "Continue" : "Continue anyway"}
        </button>
      </div>
    </StepShell>
  );
}

function ModelKeyStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<"anthropic" | "openai">("anthropic");
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!key.trim()) {
      setError("Please enter an API key.");
      return;
    }
    // In production: validate with a test call, store in keychain
    await window.armorClaw.updateAppState({ modelProvider: provider });
    onNext();
  };

  return (
    <StepShell progress={55}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          One last key to get Emerson thinking.
        </h2>
        <p className="text-sm text-[#8b8b92]">
          Paste your API key. Emerson uses it to run. It&apos;s stored in your OS
          keychain and never leaves your machine. Costs go to your provider
          account, not us.
        </p>

        <div className="flex gap-2">
          <button
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              provider === "anthropic"
                ? "border-[#d97706] bg-[#d97706]/10 text-white"
                : "border-[#26262c] text-[#8b8b92] hover:border-[#8b8b92]"
            }`}
            onClick={() => setProvider("anthropic")}
          >
            Anthropic
          </button>
          <button
            className={`flex-1 rounded-md border px-3 py-2 text-sm ${
              provider === "openai"
                ? "border-[#d97706] bg-[#d97706]/10 text-white"
                : "border-[#26262c] text-[#8b8b92] hover:border-[#8b8b92]"
            }`}
            onClick={() => setProvider("openai")}
          >
            OpenAI
          </button>
        </div>

        <input
          type="password"
          className="w-full rounded-lg border border-[#26262c] bg-[#16161a] px-4 py-3 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
          placeholder={provider === "anthropic" ? "sk-ant-..." : "sk-..."}
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); }}
        />
        {error && <p className="text-xs text-[#dc2626]">{error}</p>}

        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={() => void handleSave()}
        >
          Save key and continue
        </button>
      </div>
    </StepShell>
  );
}

function SafetyStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <StepShell progress={66}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          A few things to know before you start
        </h2>

        <div className="space-y-3">
          <SafetyItem
            title="The agent can be tricked."
            body="AI agents trust the text they read. If a webpage or email contains hidden instructions, the agent might follow them. We protect you with approval prompts on irreversible actions. Read them. Don't approve on autopilot."
          />
          <SafetyItem
            title="Everything the agent does is logged."
            body="In plain text, at ~/Library/Application Support/ArmorClaw/audit.log. Check it after big tasks."
          />
          <SafetyItem
            title="Model API costs come out of your account."
            body="ArmorClaw uses your API key. Long agent tasks can run up cost. Set a spending limit in your provider's dashboard."
          />
          <SafetyItem
            title="Third-party integrations run code on your machine."
            body="Gmail and Google Calendar use APIs we trust. If you later install MCP servers from outside our curated gallery, read the source first."
          />
        </div>

        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={onNext}
        >
          Got it
        </button>
      </div>
    </StepShell>
  );
}

function SafetyItem({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[#26262c] bg-[#16161a] p-3">
      <h4 className="text-sm font-bold text-white">{title}</h4>
      <p className="mt-1 text-xs leading-relaxed text-[#8b8b92]">{body}</p>
    </div>
  );
}

function WorkspaceStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const selectWorkspace = useAppStore((s) => s.selectWorkspace);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const suggestion = WORKSPACE_SUGGESTIONS.find((s) => s.name === trimmed);
    const ws = await createWorkspace(trimmed, suggestion?.color ?? "#6366f1");
    await selectWorkspace(ws);
    // Also create a default project
    await window.armorClaw.createProject(ws.id, "General");
    const projects = await window.armorClaw.listProjects(ws.id);
    useAppStore.setState({ projects });
    if (projects[0]) {
      await useAppStore.getState().selectProject(projects[0]);
    }
    onNext();
  };

  return (
    <StepShell progress={77}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          Create your first workspace.
        </h2>
        <p className="text-sm text-[#8b8b92]">
          Workspaces are containers for related chats, notes, and memories. The
          agent&apos;s memory is scoped to whichever workspace you&apos;re in.
        </p>

        <input
          className="w-full rounded-lg border border-[#26262c] bg-[#16161a] px-4 py-3 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
          placeholder="Workspace name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
          autoFocus
        />

        <div className="flex flex-wrap gap-2">
          {WORKSPACE_SUGGESTIONS.map((s) => (
            <button
              key={s.name}
              className="rounded-full border border-[#26262c] px-3 py-1 text-xs text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
              onClick={() => setName(s.name)}
            >
              {s.name}
            </button>
          ))}
        </div>

        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309] disabled:opacity-50"
          onClick={() => void handleCreate()}
          disabled={!name.trim()}
        >
          Create workspace
        </button>
      </div>
    </StepShell>
  );
}

function IntegrationsStep({ onNext }: { onNext: () => void }): React.JSX.Element {
  return (
    <StepShell progress={88}>
      <div className="space-y-4">
        <h2 className="text-lg font-medium text-white">
          Connect Gmail and Google Calendar?
        </h2>
        <p className="text-sm text-[#8b8b92]">
          Most people start here. The agent will be able to search your inbox,
          draft emails, check your schedule, and suggest meeting times. Sending
          and modifying still require your approval.
        </p>
        <p className="text-xs text-[#8b8b92]">
          One Google sign-in. Tokens stored in your OS keychain.
        </p>

        {/* In production, this triggers Google OAuth */}
        <button
          className="w-full rounded-lg bg-[#d97706] py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309]"
          onClick={onNext}
        >
          Connect with Google
        </button>
        <button
          className="w-full rounded-lg border border-[#26262c] py-3 text-sm text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
          onClick={onNext}
        >
          Skip for now
        </button>
      </div>
    </StepShell>
  );
}
