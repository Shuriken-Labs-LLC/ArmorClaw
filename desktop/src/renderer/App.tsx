import { useEffect } from "react";
import { useAppStore } from "./stores/app-store";
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
    <div className="flex h-screen overflow-hidden bg-[#0f0f10]">
      <Sidebar />
      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {view === "chat" && <ChatView />}
          {view === "brain" && <BrainPanel />}
          {view === "settings" && <SettingsView />}
          {view === "commitments" && <CommitmentsView />}
        </div>

        {/* Brain side panel (overlay on chat) */}
        {brainPanelOpen && view === "chat" && (
          <div className="w-[480px] border-l border-[#26262c] bg-[#0e0e0f]">
            <BrainPanel />
          </div>
        )}
      </main>
    </div>
  );
}
