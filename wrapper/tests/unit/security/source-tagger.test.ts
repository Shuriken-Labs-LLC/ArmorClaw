/**
 * Unit tests for wrapper/security/source-tagger.ts.
 *
 * 100% coverage required (lines, branches, functions, statements) — enforced
 * by vitest.config.ts security/**\/*.ts threshold.
 */

import { describe, expect, it, vi } from "vitest";
import { ALL_SOURCE_TAGS, renderForModel, tag } from "../../../lib/source-tag.ts";
import sourceTaggerPlugin, {
  frameToolResult,
  registerSourceTagger,
  TOOL_TO_SOURCE_TAG,
} from "../../../security/source-tagger.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeMockApi() {
  let capturedHookName: string | undefined;
  let capturedHandler: ((event: unknown, ctx: unknown) => unknown) | undefined;

  return {
    on: vi.fn((hookName: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      capturedHookName = hookName;
      capturedHandler = fn;
    }),
    get capturedHookName() {
      return capturedHookName;
    },
    get capturedHandler() {
      return capturedHandler;
    },
  };
}

function textBlock(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

function imageBlock(): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: "AAAA", mimeType: "image/png" };
}

function toolResultMessage(
  toolName: string,
  blocks: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return {
    role: "toolResult" as const,
    toolCallId: "call_test_1",
    toolName,
    content: blocks,
    isError: false,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

function eventFor(toolName: string | undefined, message: unknown) {
  return { toolName, toolCallId: "call_test_1", message };
}

// ── TOOL_TO_SOURCE_TAG ───────────────────────────────────────────────────────

describe("TOOL_TO_SOURCE_TAG", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(TOOL_TO_SOURCE_TAG)).toBe(true);
  });

  it("contains the five expected mappings", () => {
    expect(TOOL_TO_SOURCE_TAG).toEqual({
      web_fetch: "external-web",
      web_search: "external-web",
      browser: "external-web",
      read: "user-file",
      grep: "user-file",
    });
  });

  it("only maps to known SourceTag values", () => {
    for (const tagValue of Object.values(TOOL_TO_SOURCE_TAG)) {
      expect(ALL_SOURCE_TAGS).toContain(tagValue);
    }
  });
});

// ── frameToolResult: gate branches ────────────────────────────────────────────

describe("frameToolResult — gate branches", () => {
  it("returns undefined when toolName is undefined", () => {
    const result = frameToolResult(
      eventFor(undefined, toolResultMessage("read", [textBlock("x")])),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when toolName is the empty string (falsy)", () => {
    const result = frameToolResult(eventFor("", toolResultMessage("read", [textBlock("x")])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when tool is not in the map", () => {
    const result = frameToolResult(
      eventFor("unknown_tool", toolResultMessage("unknown_tool", [textBlock("x")])),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when message is null", () => {
    const result = frameToolResult(eventFor("read", null));
    expect(result).toBeUndefined();
  });

  it("returns undefined when message is undefined", () => {
    const result = frameToolResult(eventFor("read", undefined));
    expect(result).toBeUndefined();
  });

  it("returns undefined when message is a primitive string (not an object)", () => {
    const result = frameToolResult(eventFor("read", "raw text"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when message.role !== 'toolResult'", () => {
    const message = { role: "user", content: [textBlock("x")] };
    const result = frameToolResult(eventFor("read", message));
    expect(result).toBeUndefined();
  });

  it("returns undefined when message.content is not an array", () => {
    const message = { role: "toolResult", content: "string content" };
    const result = frameToolResult(eventFor("read", message));
    expect(result).toBeUndefined();
  });

  it("returns undefined when content is an empty array", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [])));
    expect(result).toBeUndefined();
  });
});

// ── frameToolResult: non-text blocks pass through (isTextBlock branches) ─────

describe("frameToolResult — block-shape branches (isTextBlock coverage)", () => {
  it("returns undefined when content is only image blocks", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [imageBlock()])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when a block is null", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [null])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when a block is a primitive string", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", ["raw text"])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when a block has no type field", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [{ text: "x" }])));
    expect(result).toBeUndefined();
  });

  it("returns undefined when block.type !== 'text'", () => {
    const result = frameToolResult(
      eventFor("read", toolResultMessage("read", [{ type: "thinking", text: "x" }])),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when block.text is not a string", () => {
    const result = frameToolResult(
      eventFor("read", toolResultMessage("read", [{ type: "text", text: 42 }])),
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined when text block exists but is empty string", () => {
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [textBlock("")])));
    expect(result).toBeUndefined();
  });
});

// ── frameToolResult: framing produced for each map entry ─────────────────────

describe("frameToolResult — framing for each map entry", () => {
  it.each(Object.entries(TOOL_TO_SOURCE_TAG))(
    'wraps %s output in <external-content source="%s"> framing',
    (toolName, expectedTag) => {
      const text = `payload from ${toolName}`;
      const result = frameToolResult(
        eventFor(toolName, toolResultMessage(toolName, [textBlock(text)])),
      );
      expect(result).toBeDefined();
      const message = result?.message as { content: Array<{ type: string; text: string }> };
      expect(message.content).toHaveLength(1);
      expect(message.content[0].type).toBe("text");
      expect(message.content[0].text).toContain(`<external-content source="${expectedTag}"`);
      expect(message.content[0].text).toContain(`description="tool=${toolName}"`);
      expect(message.content[0].text).toContain(text);
      expect(message.content[0].text).toContain("</external-content>");
    },
  );

  it("framing matches renderForModel([tag(text, sourceTag, `tool=...`)]) byte-exactly modulo timestamp", () => {
    // We can't pin renderForModel's receivedAt timestamp, so instead test the
    // structural shape: the framed text must equal renderForModel called
    // against a TaggedInput with the same source and description, using the
    // received-at value the source-tagger itself produced.
    const text = "fetched body";
    const result = frameToolResult(
      eventFor("web_fetch", toolResultMessage("web_fetch", [textBlock(text)])),
    );
    expect(result).toBeDefined();
    const framedText = (result!.message as { content: Array<{ text: string }> }).content[0].text;
    const receivedAtMatch = framedText.match(/received-at="([^"]+)"/);
    expect(receivedAtMatch).not.toBeNull();
    const receivedAt = receivedAtMatch![1];
    const expected = renderForModel([
      {
        content: text,
        source: "external-web",
        receivedAt,
        origin: { description: "tool=web_fetch" },
      },
    ]);
    expect(framedText).toBe(expected);
  });
});

// ── frameToolResult: structural preservation ─────────────────────────────────

describe("frameToolResult — structural preservation", () => {
  it("preserves toolCallId, toolName, isError, timestamp on the returned message", () => {
    const result = frameToolResult(
      eventFor(
        "web_fetch",
        toolResultMessage("web_fetch", [textBlock("body")], {
          toolCallId: "call_abc",
          isError: true,
          timestamp: 12345,
        }),
      ),
    );
    const message = result?.message as Record<string, unknown>;
    expect(message.toolCallId).toBe("call_abc");
    expect(message.toolName).toBe("web_fetch");
    expect(message.isError).toBe(true);
    expect(message.timestamp).toBe(12345);
    expect(message.role).toBe("toolResult");
  });

  it("does not mutate the original event.message", () => {
    const block = textBlock("original");
    const original = toolResultMessage("read", [block]);
    const originalContentRef = original.content;
    const originalBlockText = block.text;
    frameToolResult(eventFor("read", original));
    expect(original.content).toBe(originalContentRef);
    expect(block.text).toBe(originalBlockText);
  });

  it("preserves non-text blocks alongside framed text blocks", () => {
    const img = imageBlock();
    const result = frameToolResult(
      eventFor("browser", toolResultMessage("browser", [textBlock("hello"), img])),
    );
    const message = result?.message as { content: unknown[] };
    expect(message.content).toHaveLength(2);
    expect((message.content[0] as { text: string }).text).toContain("<external-content");
    expect(message.content[1]).toBe(img);
  });

  it("frames every non-empty text block when multiple are present", () => {
    const result = frameToolResult(
      eventFor(
        "web_search",
        toolResultMessage("web_search", [
          textBlock("first result"),
          textBlock(""),
          textBlock("third result"),
        ]),
      ),
    );
    expect(result).toBeDefined();
    const blocks = (result!.message as { content: Array<{ type: string; text: string }> }).content;
    expect(blocks).toHaveLength(3);
    expect(blocks[0].text).toContain("<external-content");
    expect(blocks[0].text).toContain("first result");
    expect(blocks[1].text).toBe(""); // empty block left untouched
    expect(blocks[2].text).toContain("<external-content");
    expect(blocks[2].text).toContain("third result");
  });

  it("preserves additional fields on text blocks (e.g. textSignature)", () => {
    const block = { type: "text" as const, text: "body", textSignature: "sig_xyz" };
    const result = frameToolResult(eventFor("read", toolResultMessage("read", [block])));
    expect(result).toBeDefined();
    const out = (result!.message as { content: Array<Record<string, unknown>> }).content[0];
    expect(out.textSignature).toBe("sig_xyz");
    expect(out.type).toBe("text");
    expect(typeof out.text).toBe("string");
    expect(out.text).not.toBe("body");
  });
});

// ── registerSourceTagger ─────────────────────────────────────────────────────

describe("registerSourceTagger", () => {
  it("subscribes to tool_result_persist via api.on", () => {
    const api = makeMockApi();
    registerSourceTagger(api as never);
    expect(api.on).toHaveBeenCalledTimes(1);
    expect(api.capturedHookName).toBe("tool_result_persist");
    expect(typeof api.capturedHandler).toBe("function");
  });

  it("registered handler delegates to frameToolResult and returns the same value", () => {
    const api = makeMockApi();
    registerSourceTagger(api as never);
    const event = eventFor("web_fetch", toolResultMessage("web_fetch", [textBlock("body")]));
    const handlerResult = api.capturedHandler!(event, {});
    const directResult = frameToolResult(event);
    expect(handlerResult).toEqual(directResult);
  });

  it("registered handler returns undefined for unmapped tools", () => {
    const api = makeMockApi();
    registerSourceTagger(api as never);
    const event = eventFor("exec", toolResultMessage("exec", [textBlock("body")]));
    expect(api.capturedHandler!(event, {})).toBeUndefined();
  });
});

// ── default plugin export ────────────────────────────────────────────────────

describe("default plugin export", () => {
  it("declares the expected plugin metadata", () => {
    expect(sourceTaggerPlugin.id).toBe("armorclaw-source-tagger");
    expect(sourceTaggerPlugin.name).toBe("ArmorClaw Source Tagger");
    expect(typeof sourceTaggerPlugin.description).toBe("string");
    expect(sourceTaggerPlugin.description.length).toBeGreaterThan(0);
  });

  it("register() wires the source-tagger via the api", () => {
    const api = makeMockApi();
    sourceTaggerPlugin.register(api as never);
    expect(api.on).toHaveBeenCalledTimes(1);
    expect(api.capturedHookName).toBe("tool_result_persist");
  });
});

// ── tag() integration sanity (description format used by the source-tagger) ──

describe("tag() integration", () => {
  it("framed text uses the description shape `tool=<toolName>`", () => {
    // Independent re-derivation: confirms the source-tagger's description
    // format matches what tests downstream might assert.
    const expected = renderForModel([tag("body", "external-web", "tool=web_fetch")]);
    expect(expected).toContain('description="tool=web_fetch"');
  });
});
