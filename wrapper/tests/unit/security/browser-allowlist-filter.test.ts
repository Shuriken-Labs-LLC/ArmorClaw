import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../security/audit-logger.ts", () => ({
  writeAuditEntry: vi.fn(),
}));

vi.mock("../../../security/browser-allowlist.ts", () => ({
  isDomainAllowed: vi.fn(),
  extractHost: vi.fn(),
}));

import { writeAuditEntry } from "../../../security/audit-logger.ts";
import { registerBrowserAllowlistFilter } from "../../../security/browser-allowlist-filter.ts";
import { extractHost, isDomainAllowed } from "../../../security/browser-allowlist.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeMockApi() {
  let captured: Handler = () => undefined;
  return {
    on: vi.fn((_name: string, fn: Handler) => {
      captured = fn;
    }),
    get handler(): Handler {
      return captured;
    },
  };
}

beforeEach(() => {
  vi.mocked(writeAuditEntry).mockReset();
  vi.mocked(isDomainAllowed).mockReset();
  vi.mocked(extractHost).mockReset();
  // Default extractHost: hand back the URL's apparent host for messages
  vi.mocked(extractHost).mockImplementation((url: string) => {
    try {
      return new URL(url).hostname || null;
    } catch {
      return null;
    }
  });
});

describe("registerBrowserAllowlistFilter — registration", () => {
  it("subscribes to before_tool_call", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });
});

describe("registerBrowserAllowlistFilter — pass-through cases", () => {
  it("returns undefined for non-browser tools", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler({ toolName: "read", params: { url: "https://attacker.com/" } }, {});
    expect(result).toBeUndefined();
    expect(isDomainAllowed).not.toHaveBeenCalled();
  });

  it("returns undefined when params is missing or wrong type", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    expect(api.handler({ toolName: "browser" }, {})).toBeUndefined();
    expect(api.handler({ toolName: "browser", params: null }, {})).toBeUndefined();
    expect(api.handler({ toolName: "browser", params: "not-an-object" }, {})).toBeUndefined();
    expect(api.handler({ toolName: "browser", params: ["url"] }, {})).toBeUndefined();
    expect(isDomainAllowed).not.toHaveBeenCalled();
  });

  it("returns undefined for non-navigation actions even if a URL is present", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    for (const action of [
      "status",
      "start",
      "stop",
      "tabs",
      "snapshot",
      "screenshot",
      "console",
      "pdf",
      "upload",
      "dialog",
      "act",
      "focus",
      "close",
    ]) {
      const result = api.handler(
        { toolName: "browser", params: { action, url: "https://attacker.com/" } },
        {},
      );
      expect(result).toBeUndefined();
    }
    expect(isDomainAllowed).not.toHaveBeenCalled();
  });

  it("returns undefined when action is missing", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      { toolName: "browser", params: { url: "https://attacker.com/" } },
      {},
    );
    expect(result).toBeUndefined();
    expect(isDomainAllowed).not.toHaveBeenCalled();
  });

  it("returns undefined when navigation action has no URL params", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    expect(api.handler({ toolName: "browser", params: { action: "open" } }, {})).toBeUndefined();
  });

  it("returns undefined when url params are empty strings", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    expect(
      api.handler({ toolName: "browser", params: { action: "open", url: "", targetUrl: "" } }, {}),
    ).toBeUndefined();
  });

  it("returns undefined when url params are non-string", () => {
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      { toolName: "browser", params: { action: "navigate", url: 42, targetUrl: null } },
      {},
    );
    expect(result).toBeUndefined();
  });
});

describe("registerBrowserAllowlistFilter — allowed", () => {
  it("returns undefined when url passes allowlist check (open action)", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(true);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      { toolName: "browser", params: { action: "open", url: "https://github.com/" } },
      {},
    );
    expect(result).toBeUndefined();
    expect(isDomainAllowed).toHaveBeenCalledWith("https://github.com/");
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("returns undefined when targetUrl passes (navigate action)", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(true);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      {
        toolName: "browser",
        params: { action: "navigate", targetUrl: "https://github.com/" },
      },
      {},
    );
    expect(result).toBeUndefined();
    expect(isDomainAllowed).toHaveBeenCalledWith("https://github.com/");
  });

  it("checks both targetUrl and url; both must pass", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(true);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      {
        toolName: "browser",
        params: {
          action: "open",
          targetUrl: "https://github.com/a",
          url: "https://github.com/b",
        },
      },
      {},
    );
    expect(result).toBeUndefined();
    expect(isDomainAllowed).toHaveBeenCalledWith("https://github.com/a");
    expect(isDomainAllowed).toHaveBeenCalledWith("https://github.com/b");
  });
});

describe("registerBrowserAllowlistFilter — blocked", () => {
  it("blocks when url is not allowlisted (open)", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(false);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      { toolName: "browser", params: { action: "open", url: "https://attacker.com/x" } },
      {},
    );
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("attacker.com"),
    });
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("Settings → Browser allowlist"),
    });
  });

  it("blocks when targetUrl is not allowlisted (navigate)", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(false);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      {
        toolName: "browser",
        params: { action: "navigate", targetUrl: "https://attacker.com/y" },
      },
      {},
    );
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("attacker.com"),
    });
  });

  it("blocks when one of url/targetUrl is allowed but the other isn't", () => {
    // First call (targetUrl) allowed, second call (url) not allowed
    vi.mocked(isDomainAllowed).mockReturnValueOnce(true).mockReturnValueOnce(false);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      {
        toolName: "browser",
        params: {
          action: "open",
          targetUrl: "https://github.com/ok",
          url: "https://attacker.com/bad",
        },
      },
      {},
    );
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("attacker.com"),
    });
  });

  it("writes an audit entry on block with the right fields", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(false);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    api.handler(
      {
        toolName: "browser",
        params: { action: "open", url: "https://attacker.com/x" },
      },
      {},
    );
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.skill).toBe("browser-allowlist");
    expect(entry.outcome).toBe("rejected");
    expect(entry.permissionsUsed).toEqual([]);
    expect(entry.durationMs).toBe(0);
    expect(entry.inputSummary).toContain("attacker.com");
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("inputSummary truncates to 80 chars", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(false);
    // Force a very long synthetic host
    const longHost = "a".repeat(200) + ".example.com";
    vi.mocked(extractHost).mockReturnValue(longHost);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    api.handler(
      {
        toolName: "browser",
        params: { action: "open", url: `https://${longHost}/` },
      },
      {},
    );
    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.inputSummary.length).toBeLessThanOrEqual(80);
  });

  it("uses 'unparseable URL' when host extraction fails", () => {
    vi.mocked(isDomainAllowed).mockReturnValue(false);
    vi.mocked(extractHost).mockReturnValue(null);
    const api = makeMockApi();
    registerBrowserAllowlistFilter(api as never);
    const result = api.handler(
      { toolName: "browser", params: { action: "navigate", url: "garbage" } },
      {},
    );
    expect(result).toEqual({
      block: true,
      blockReason: expect.stringContaining("unparseable URL"),
    });
    const entry = vi.mocked(writeAuditEntry).mock.calls[0][0];
    expect(entry.inputSummary).toContain("unparseable URL");
  });
});
