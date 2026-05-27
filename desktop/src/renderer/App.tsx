import { useEffect, useState } from "react";

declare global {
  interface Window {
    armorClaw: {
      getAppVersion: () => Promise<string>;
      onOpenClawMessage: (callback: (message: string) => void) => () => void;
    };
  }
}

export function App(): React.JSX.Element {
  const [version, setVersion] = useState("");
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    window.armorClaw.getAppVersion().then(setVersion);

    const unsubscribe = window.armorClaw.onOpenClawMessage((message) => {
      setMessages((prev) => [...prev, message]);
    });
    return unsubscribe;
  }, []);

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-3xl font-bold text-white">ArmorClaw</h1>
      {version && (
        <p className="text-sm text-neutral-400">v{version}</p>
      )}
      <div className="mt-4 w-full max-w-xl space-y-2">
        {messages.map((msg, i) => (
          <div
            key={i}
            className="rounded-lg bg-neutral-800 px-4 py-3 text-sm text-neutral-200"
          >
            {msg}
          </div>
        ))}
        {messages.length === 0 && (
          <p className="text-center text-neutral-500">
            Waiting for OpenClaw...
          </p>
        )}
      </div>
    </div>
  );
}
