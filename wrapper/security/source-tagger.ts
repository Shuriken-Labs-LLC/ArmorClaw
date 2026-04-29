// @ts-ignore — openclaw/plugin-sdk has no type declarations
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { renderForModel, tag, type SourceTag } from "../lib/source-tag.ts";

// ── Tool → SourceTag map ─────────────────────────────────────────────────────

/**
 * Allowlist mapping of OpenClaw bundled tool names to the source tag for
 * their result content. Tools NOT in this map pass through unchanged.
 *
 * Only tools known to deliver external content the model READS are mapped.
 * Internal/utility tools (cron, message, sessions_*, exec) produce no
 * external content and need no framing.
 *
 * Discovery: Phase 1c pre-flight (2026-04-29) enumerated bundled tools in
 * src/agents/tools/*.ts and node_modules/.../pi-coding-agent/dist/core/tools/.
 * web_fetch / web_search / browser already wrap their output with OpenClaw's
 * own external-content markers (src/security/external-content.ts) — the
 * source-tagger adds an outer ArmorClaw provenance layer that records the
 * source tag the Phase 2 classifier will consume. Double framing is intentional
 * scaffolding until Phase 2 unifies the wrapping.
 *
 * Update this map when OpenClaw adds new external-content tools.
 */
export const TOOL_TO_SOURCE_TAG: Readonly<Record<string, SourceTag>> = Object.freeze({
  // External web content
  web_fetch: "external-web",
  web_search: "external-web",
  browser: "external-web",
  // File content read from disk
  read: "user-file",
  grep: "user-file",
});

// ── Hook handler ─────────────────────────────────────────────────────────────

type ToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  message: unknown;
  isSynthetic?: boolean;
};

type ToolResultPersistResult = {
  message?: unknown;
};

type TextContentBlock = { type: "text"; text: string } & Record<string, unknown>;

function isTextBlock(block: unknown): block is TextContentBlock {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
}

/**
 * Compute the framed-message replacement for a tool_result_persist event.
 *
 * Returns `{ message }` when the tool maps to a source tag and at least one
 * non-empty text block exists. Returns `undefined` otherwise (unmapped tool,
 * missing toolName, non-toolResult message, or no non-empty text blocks).
 *
 * Image / non-text content blocks pass through untouched. Multi-modal
 * handling is Phase 2 work.
 *
 * Every entry in TOOL_TO_SOURCE_TAG maps to an untrusted SourceTag, so
 * `renderForModel` always produces framing distinct from the raw text. If a
 * future entry maps to a trusted tag, framing becomes a no-op and the
 * `mutated` guard below quietly returns undefined — but Phase 2's classifier
 * will still observe the source tag via the same map.
 */
export function frameToolResult(
  event: ToolResultPersistEvent,
): ToolResultPersistResult | undefined {
  const toolName = event.toolName;
  if (!toolName) {
    return undefined;
  }
  const sourceTag = TOOL_TO_SOURCE_TAG[toolName];
  if (!sourceTag) {
    return undefined;
  }
  const message = event.message as { role?: string; content?: unknown } | null | undefined;
  if (
    !message ||
    typeof message !== "object" ||
    message.role !== "toolResult" ||
    !Array.isArray(message.content)
  ) {
    return undefined;
  }

  let mutated = false;
  const nextContent = message.content.map((block) => {
    if (!isTextBlock(block)) {
      return block;
    }
    if (block.text.length === 0) {
      return block;
    }
    const framed = renderForModel([tag(block.text, sourceTag, `tool=${toolName}`)]);
    mutated = true;
    return { ...block, text: framed };
  });

  if (!mutated) {
    return undefined;
  }
  return { message: { ...message, content: nextContent } };
}

// ── Hook registration ─────────────────────────────────────────────────────────

/**
 * Register the source-tagger on `tool_result_persist`.
 *
 * Synchronous hook; runs in the session-transcript append hot path. Mutation
 * is performed by returning a new message object — `event.message` is never
 * mutated in place.
 */
export function registerSourceTagger(api: OpenClawPluginApi): void {
  api.on("tool_result_persist", (event: unknown, _ctx: unknown) => {
    return frameToolResult(event as ToolResultPersistEvent);
  });
}

// ── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: "armorclaw-source-tagger",
  name: "ArmorClaw Source Tagger",
  description:
    "Frames external tool-result content with provenance metadata before it enters the model's next-turn context",
  register(api: OpenClawPluginApi): void {
    registerSourceTagger(api);
  },
};
