import { useEffect } from "react";
import { useAppStore } from "./stores/app-store";
import { useNotificationStore } from "./stores/notification-store";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { BrainPanel } from "./components/BrainPanel";
import { SettingsView } from "./components/SettingsView";
import { CommitmentsView } from "./components/CommitmentsView";
import { Onboarding } from "./components/Onboarding";
import "./types";

export function App(): React.JSX.Element {
  const { initialize, initializing, appState, view, brainPanelOpen, addOpenClawMessage, toggleBrainPanel } =
    useAppStore();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const unsubscribe = window.armorClaw.onOpenClawMessage((message) => {
      addOpenClawMessage(message);
    });
    return unsubscribe;
  }, [addOpenClawMessage]);

  useEffect(() => {
    const addNotif = useNotificationStore.getState().add;
    const unsub1 = window.armorClaw.onCommitmentFired((data) => {
      addNotif({
        type: "success",
        eventType: "commitment.fired",
        title: "Commitment fired",
        body: (data["description"] as string) ?? "A scheduled commitment ran.",
        commitmentId: data["commitmentId"] as string,
      });
    });
    const unsub2 = window.armorClaw.onCommitmentMissed((data) => {
      addNotif({
        type: "warning",
        eventType: "commitment.missed",
        title: "Missed commitment",
        body: `"${(data["description"] as string) ?? "A commitment"}" was due while the app was off.`,
        commitmentId: data["commitmentId"] as string,
      });
    });
    return () => { unsub1(); unsub2(); };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "b") {
        e.preventDefault();
        toggleBrainPanel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleBrainPanel]);

  if (initializing) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f10]">
        <div className="text-center">
          <div className="mb-3 text-4xl">🦞</div>
          <p className="text-sm text-[#8b8b92]">Loading ArmorClaw...</p>
        </div>
      </div>
    );
  }

  if (appState?.onboardingState !== "done") {
    return <Onboarding />;
  }

  return (
    <ErrorBoundary>
      <div className="flex h-screen overflow-hidden bg-[#0f0f10]">
        <Sidebar />
        <main className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-hidden">
            {view === "chat" && <ChatView />}
            {view === "brain" && <BrainPanel />}
            {view === "settings" && <SettingsView />}
            {view === "commitments" && <CommitmentsView />}
          </div>

          {brainPanelOpen && view === "chat" && (
            <div className="w-[480px] border-l border-[#26262c] bg-[#0e0e0f]">
              <BrainPanel />
            </div>
          )}
        </main>
      </div>
    </ErrorBoundary>
  );
}
