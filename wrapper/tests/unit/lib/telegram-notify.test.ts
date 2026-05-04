/**
 * Unit tests for wrapper/lib/telegram-notify.ts.
 *
 * 100% coverage required (statements / branches / functions / lines).
 * All deps injected — no real network or filesystem I/O.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendTelegramApprovalNotification,
  type TelegramNotifyDeps,
} from "../../../lib/telegram-notify.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  body: { chat_id: string | number; text: string; disable_notification: boolean };
}

function makeCapturingFetch(
  response: { ok: boolean; status?: number } = { ok: true, status: 200 },
): { fn: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(init.body as string) as CapturedCall["body"])
      : ({ chat_id: "", text: "", disable_notification: false } as CapturedCall["body"]);
    calls.push({ url, body });
    return new Response("{}", { status: response.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeDeps(over: Partial<TelegramNotifyDeps> = {}): TelegramNotifyDeps {
  return {
    readEnvKey: () => "BOT_TOKEN_123",
    readOpenclaw: () => ({ channels: { telegram: { defaultTo: "555" } } }),
    fetchFn: makeCapturingFetch().fn,
    ...over,
  };
}

// ── happy path ───────────────────────────────────────────────────────────────

describe("sendTelegramApprovalNotification — happy path", () => {
  it("calls sendMessage with chat_id and message containing toolName", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      { url: "https://example.com" },
      makeDeps({ fetchFn: fetchSpy.fn }),
    );

    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].url).toBe("https://api.telegram.org/botBOT_TOKEN_123/sendMessage");
    expect(fetchSpy.calls[0].body.chat_id).toBe("555");
    expect(fetchSpy.calls[0].body.disable_notification).toBe(false);
    expect(fetchSpy.calls[0].body.text).toContain("browser");
    expect(fetchSpy.calls[0].body.text).toContain("https://example.com");
  });

  it("includes the dashboard URL and the 5-minute warning in the text", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification("any_tool", {}, makeDeps({ fetchFn: fetchSpy.fn }));

    expect(fetchSpy.calls[0].body.text).toContain("http://localhost:7390");
    expect(fetchSpy.calls[0].body.text).toContain("auto-reject in 5 minutes");
  });
});

// ── token resolution ────────────────────────────────────────────────────────

describe("sendTelegramApprovalNotification — token resolution", () => {
  it("silently no-ops when readEnvKey returns undefined (no token)", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({ readEnvKey: () => undefined, fetchFn: fetchSpy.fn }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });
});

// ── chat_id resolution ──────────────────────────────────────────────────────

describe("sendTelegramApprovalNotification — chat_id resolution", () => {
  it("silently no-ops when no defaultTo in flat config", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({ channels: { telegram: { enabled: true } } }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("uses an account-level defaultTo when flat is absent (multi-account)", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({
          channels: {
            telegram: {
              accounts: {
                main: { defaultTo: "999" },
                other: { defaultTo: "888" },
              },
            },
          },
        }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].body.chat_id).toBe("999");
  });

  it("accepts a numeric defaultTo at the flat level", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({ channels: { telegram: { defaultTo: 42 } } }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].body.chat_id).toBe(42);
  });

  it("accepts a numeric defaultTo at the account level", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({
          channels: { telegram: { accounts: { main: { defaultTo: 17 } } } },
        }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].body.chat_id).toBe(17);
  });

  it("skips accounts without a defaultTo and uses the next one that has one", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({
          channels: {
            telegram: {
              accounts: {
                empty: {},
                blank: { defaultTo: "   " },
                primary: { defaultTo: "777" },
              },
            },
          },
        }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].body.chat_id).toBe("777");
  });

  it("ignores non-record account entries", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({
          channels: { telegram: { accounts: { weird: "string-not-record" } } },
        }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("silently no-ops when openclaw is malformed (not an object)", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({ readOpenclaw: () => "garbage", fetchFn: fetchSpy.fn }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("silently no-ops when channels is malformed", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({ readOpenclaw: () => ({ channels: "garbage" }), fetchFn: fetchSpy.fn }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("silently no-ops when telegram is malformed", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "browser",
      {},
      makeDeps({
        readOpenclaw: () => ({ channels: { telegram: "garbage" } }),
        fetchFn: fetchSpy.fn,
      }),
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });
});

// ── failure modes ───────────────────────────────────────────────────────────

describe("sendTelegramApprovalNotification — failure modes", () => {
  it("resolves cleanly when readOpenclaw throws", async () => {
    const fetchSpy = makeCapturingFetch();
    await expect(
      sendTelegramApprovalNotification(
        "browser",
        {},
        makeDeps({
          readOpenclaw: () => {
            throw new Error("boom");
          },
          fetchFn: fetchSpy.fn,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("resolves cleanly when fetch returns 4xx", async () => {
    const fetchSpy = makeCapturingFetch({ ok: false, status: 401 });
    await expect(
      sendTelegramApprovalNotification("browser", {}, makeDeps({ fetchFn: fetchSpy.fn })),
    ).resolves.toBeUndefined();
    // We still attempted the call — non-2xx is silently ignored.
    expect(fetchSpy.calls).toHaveLength(1);
  });

  it("resolves cleanly when fetch throws", async () => {
    const throwingFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      sendTelegramApprovalNotification("browser", {}, makeDeps({ fetchFn: throwingFetch })),
    ).resolves.toBeUndefined();
  });

  it("resolves cleanly when readEnvKey throws (outer guard)", async () => {
    const fetchSpy = makeCapturingFetch();
    await expect(
      sendTelegramApprovalNotification(
        "browser",
        {},
        makeDeps({
          readEnvKey: () => {
            throw new Error("env explode");
          },
          fetchFn: fetchSpy.fn,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fetchSpy.calls).toHaveLength(0);
  });
});

// ── message body ────────────────────────────────────────────────────────────

describe("sendTelegramApprovalNotification — message body", () => {
  it("omits the Params line when toolParams is empty", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification("any_tool", {}, makeDeps({ fetchFn: fetchSpy.fn }));
    expect(fetchSpy.calls[0].body.text).not.toContain("Params:");
  });

  it("includes a JSON-stringified Params line when toolParams has values", async () => {
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "fetcher",
      { url: "https://example.com", retries: 3 },
      makeDeps({ fetchFn: fetchSpy.fn }),
    );
    expect(fetchSpy.calls[0].body.text).toContain("Params:");
    expect(fetchSpy.calls[0].body.text).toContain('"url": "https://example.com"');
    expect(fetchSpy.calls[0].body.text).toContain('"retries": 3');
  });
});

// ── default readEnvKey (.env parser) ────────────────────────────────────────

describe("sendTelegramApprovalNotification — default readEnvKey", () => {
  let tmpRoot: string;
  let savedRepoRoot: string | undefined;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "armorclaw-tg-notify-"));
    savedRepoRoot = process.env["ARMORCLAW_REPO_ROOT"];
    process.env["ARMORCLAW_REPO_ROOT"] = tmpRoot;
  });

  afterEach(() => {
    if (savedRepoRoot === undefined) {
      delete process.env["ARMORCLAW_REPO_ROOT"];
    } else {
      process.env["ARMORCLAW_REPO_ROOT"] = savedRepoRoot;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns undefined silently when .env is missing", async () => {
    // No .env in tmpRoot, readEnvKey hits its catch and returns undefined →
    // sendTelegramApprovalNotification no-ops without throwing.
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "any_tool",
      {},
      { readOpenclaw: () => ({}), fetchFn: fetchSpy.fn },
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("parses the key when .env contains it (with quotes)", async () => {
    writeFileSync(
      join(tmpRoot, ".env"),
      [
        "# a comment",
        "",
        "NOT_AN_ASSIGNMENT_LINE",
        "OTHER_KEY=other-value",
        'TELEGRAM_BOT_TOKEN="quoted-token"',
      ].join("\n"),
    );
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "any_tool",
      {},
      {
        readOpenclaw: () => ({ channels: { telegram: { defaultTo: "555" } } }),
        fetchFn: fetchSpy.fn,
      },
    );
    expect(fetchSpy.calls).toHaveLength(1);
    expect(fetchSpy.calls[0].url).toContain("botquoted-token");
  });

  it("parses the key when .env contains it (unquoted)", async () => {
    writeFileSync(join(tmpRoot, ".env"), "TELEGRAM_BOT_TOKEN=raw-token-456\n");
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "any_tool",
      {},
      {
        readOpenclaw: () => ({ channels: { telegram: { defaultTo: "555" } } }),
        fetchFn: fetchSpy.fn,
      },
    );
    expect(fetchSpy.calls[0].url).toContain("botraw-token-456");
  });

  it("returns undefined when the key is not present in .env", async () => {
    writeFileSync(join(tmpRoot, ".env"), "OTHER_KEY=other-value\n");
    const fetchSpy = makeCapturingFetch();
    await sendTelegramApprovalNotification(
      "any_tool",
      {},
      { readOpenclaw: () => ({}), fetchFn: fetchSpy.fn },
    );
    expect(fetchSpy.calls).toHaveLength(0);
  });

  it("falls back to the import.meta.dirname-relative .env when ARMORCLAW_REPO_ROOT is unset", async () => {
    // The fallback path lives at wrapper/lib/../../.env (repo root). We can't
    // safely overwrite that file in CI, but exercising this branch only needs
    // the env var to be unset — readEnvKey will hit the fallback path and
    // either find a token or hit the catch. Either ends in a clean resolve.
    delete process.env["ARMORCLAW_REPO_ROOT"];
    const fetchSpy = makeCapturingFetch();
    await expect(
      sendTelegramApprovalNotification(
        "any_tool",
        {},
        { readOpenclaw: () => ({}), fetchFn: fetchSpy.fn },
      ),
    ).resolves.toBeUndefined();
  });
});

// ── default fallbacks for readOpenclaw / fetchFn ────────────────────────────

describe("sendTelegramApprovalNotification — default readOpenclaw / fetchFn", () => {
  it("uses defaultReadOpenclaw when deps omits readOpenclaw (clean resolve regardless of machine state)", async () => {
    // This exercises the `?? defaultReadOpenclaw` branch. The default reader
    // hits ~/.openclaw/openclaw.json — present or absent, the inner try/catch
    // means the function resolves cleanly either way. Test asserts no throw,
    // not a specific call count.
    const fetchSpy = makeCapturingFetch();
    await expect(
      sendTelegramApprovalNotification(
        "any_tool",
        {},
        { readEnvKey: () => "TOKEN_ABC", fetchFn: fetchSpy.fn },
      ),
    ).resolves.toBeUndefined();
  });

  it("uses global fetch when deps omits fetchFn", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    try {
      await sendTelegramApprovalNotification(
        "any_tool",
        {},
        {
          readEnvKey: () => "TOKEN_ABC",
          readOpenclaw: () => ({ channels: { telegram: { defaultTo: "555" } } }),
        },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toContain("api.telegram.org/botTOKEN_ABC");
    } finally {
      spy.mockRestore();
    }
  });
});
