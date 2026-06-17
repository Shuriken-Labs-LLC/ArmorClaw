import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/app-store";

export function ChatView(): React.JSX.Element {
  const {
    activeProject,
    activeChat,
    messages,
    openClawMessages,
    sendMessage,
    createChat,
  } = useAppStore();

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, openClawMessages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    await sendMessage(text);
    setSending(false);
  };

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[#8b8b92]">Select a project to start chatting</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-3 border-b border-[#26262c] px-6 py-3">
        <h2 className="text-sm font-medium text-white">
          {activeChat?.title ?? "New conversation"}
        </h2>
        <span className="text-xs text-[#8b8b92]">
          in {activeProject.name}
        </span>
        <div className="flex-1" />
        <button
          className={`rounded-md px-3 py-1 text-xs transition-colors ${
            showRaw
              ? "bg-[#26262c] text-white"
              : "text-[#8b8b92] hover:bg-[#16161a] hover:text-white"
          }`}
          onClick={() => setShowRaw(!showRaw)}
          title="Show raw OpenClaw output"
        >
          Raw
        </button>
        <button
          className="rounded-md px-3 py-1 text-xs text-[#8b8b92] transition-colors hover:bg-[#16161a] hover:text-white"
          onClick={() => void createChat()}
        >
          + New chat
        </button>
      </div>

      {/* Messages + optional raw panel */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 && openClawMessages.length === 0 && (
            <EmptyState projectName={activeProject.name} />
          )}

          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              role={msg.role}
              content={msg.content}
              timestamp={msg.createdAt}
            />
          ))}

          {openClawMessages.map((msg, i) => (
            <MessageBubble
              key={`ocm-${i}`}
              role="assistant"
              content={msg}
              timestamp={Date.now()}
            />
          ))}

          <div ref={messagesEndRef} />
        </div>

        {showRaw && (
          <div className="w-80 overflow-y-auto border-l border-[#26262c] bg-[#0a0a0b] p-4">
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-[#8b8b92]">
              Raw OpenClaw Output
            </h3>
            {openClawMessages.length === 0 ? (
              <p className="text-xs text-[#8b8b92]">No output yet</p>
            ) : (
              <pre className="whitespace-pre-wrap font-mono text-xs text-[#8b8b92]">
                {openClawMessages.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[#26262c] p-4">
        <div className="flex items-end gap-2">
          <textarea
            className="flex-1 resize-none rounded-lg border border-[#26262c] bg-[#16161a] px-4 py-3 text-sm text-white outline-none placeholder:text-[#8b8b92] focus:border-[#d97706]"
            placeholder="Message ArmorClaw..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
          />
          <button
            className="rounded-lg bg-[#d97706] px-4 py-3 text-sm font-medium text-white transition-colors hover:bg-[#b45309] disabled:opacity-50"
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  role,
  content,
  timestamp,
}: {
  role: string;
  content: string;
  timestamp: number;
}): React.JSX.Element {
  const isUser = role === "user";
  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className={`mb-4 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-3 ${
          isUser
            ? "bg-[#d97706] text-white"
            : "bg-[#16161a] text-[#e8e8ea]"
        }`}
      >
        {!isUser && (
          <div className="mb-1 text-xs font-medium text-[#d97706]">
            Emerson
          </div>
        )}
        <div className="whitespace-pre-wrap text-sm">{content}</div>
        <div
          className={`mt-1 text-right text-xs ${
            isUser ? "text-white/60" : "text-[#8b8b92]"
          }`}
        >
          {time}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ projectName }: { projectName: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="text-5xl">🦞</div>
      <h3 className="text-lg font-medium text-white">
        Welcome to {projectName}
      </h3>
      <p className="max-w-md text-sm text-[#8b8b92]">
        I&apos;m Emerson, your AI assistant. I can help you organize information,
        remember important details, and get things done. Start a conversation
        below.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <SuggestionChip text="What can you help me with?" />
        <SuggestionChip text="How does your memory work?" />
        <SuggestionChip text="Set up a daily briefing" />
      </div>
    </div>
  );
}

function SuggestionChip({ text }: { text: string }): React.JSX.Element {
  const sendMessage = useAppStore((s) => s.sendMessage);
  return (
    <button
      className="rounded-full border border-[#26262c] px-4 py-2 text-xs text-[#8b8b92] transition-colors hover:border-[#d97706] hover:text-white"
      onClick={() => void sendMessage(text)}
    >
      {text}
    </button>
  );
}
