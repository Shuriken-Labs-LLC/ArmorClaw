import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  validateStep1,
  validateStep2,
  validateStep3,
  validateStep4,
  validateStep5,
  validateStep6,
} from "../../../onboarding/validators.ts";

// ── Step 1 — Model provider ───────────────────────────────────────────────────

describe("validateStep1", () => {
  it("rejects when no provider is given", () => {
    const result = validateStep1({});
    expect(result.ok).toBe(false);
    expect(result.field).toBe("provider");
    expect(result.message).toMatch(/choose a model provider/i);
  });

  describe("anthropic", () => {
    it("rejects an empty API key", () => {
      const result = validateStep1({ provider: "anthropic", apiKey: "" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
      expect(result.message).toMatch(/api key/i);
    });

    it("rejects a key that does not start with sk-ant-", () => {
      const result = validateStep1({
        provider: "anthropic",
        apiKey: "sk-badprefix-abc123456789012345",
      });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
      expect(result.message).toMatch(/sk-ant-/);
    });

    it("rejects a key that is too short", () => {
      const result = validateStep1({ provider: "anthropic", apiKey: "sk-ant-short" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
      expect(result.message).toMatch(/too short/i);
    });

    it("accepts a valid-looking Anthropic key", () => {
      const result = validateStep1({
        provider: "anthropic",
        apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects undefined API key", () => {
      const result = validateStep1({ provider: "anthropic" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
    });

    it("trims whitespace before checking the key", () => {
      const result = validateStep1({
        provider: "anthropic",
        apiKey: "  sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890  ",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("openai", () => {
    it("rejects an empty API key", () => {
      const result = validateStep1({ provider: "openai", apiKey: "" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
    });

    it("rejects a key that does not start with sk-", () => {
      const result = validateStep1({
        provider: "openai",
        apiKey: "pk-not-an-openai-key-1234567890",
      });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("apiKey");
      expect(result.message).toMatch(/sk-/);
    });

    it("rejects a key that is too short", () => {
      const result = validateStep1({ provider: "openai", apiKey: "sk-short" });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/too short/i);
    });

    it("accepts a valid-looking OpenAI key (sk-)", () => {
      const result = validateStep1({
        provider: "openai",
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz1234",
      });
      expect(result.ok).toBe(true);
    });

    it("accepts a project key format (sk-proj-)", () => {
      const result = validateStep1({
        provider: "openai",
        apiKey: "sk-proj-abcdefghijklmnopqrstuvwxy",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("ollama", () => {
    it("rejects empty ollamaUrl", () => {
      const result = validateStep1({ provider: "ollama", ollamaUrl: "" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("ollamaUrl");
    });

    it("rejects undefined ollamaUrl", () => {
      const result = validateStep1({ provider: "ollama" });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("ollamaUrl");
    });

    it("rejects a non-URL string", () => {
      const result = validateStep1({ provider: "ollama", ollamaUrl: "not a url" });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/valid web address/i);
    });

    it("rejects a non-http/https protocol", () => {
      const result = validateStep1({ provider: "ollama", ollamaUrl: "ftp://localhost:11434" });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/http/i);
    });

    it("accepts a valid http URL", () => {
      const result = validateStep1({ provider: "ollama", ollamaUrl: "http://localhost:11434" });
      expect(result.ok).toBe(true);
    });

    it("accepts a valid https URL", () => {
      const result = validateStep1({
        provider: "ollama",
        ollamaUrl: "https://ollama.myserver.com:11434",
      });
      expect(result.ok).toBe(true);
    });
  });
});

// ── Step 2 — Sandbox directory ────────────────────────────────────────────────

describe("validateStep2", () => {
  it("rejects an empty directory", () => {
    const result = validateStep2({ sandboxDir: "" });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("sandboxDir");
  });

  it("rejects undefined directory", () => {
    const result = validateStep2({});
    expect(result.ok).toBe(false);
  });

  it("rejects a relative path", () => {
    const result = validateStep2({ sandboxDir: "Documents/ArmorClaw" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/folder picker/i);
  });

  it("rejects the filesystem root", () => {
    const result = validateStep2({ sandboxDir: "/" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/system folder/i);
  });

  it("rejects /usr/bin", () => {
    const result = validateStep2({ sandboxDir: "/usr/bin" });
    expect(result.ok).toBe(false);
  });

  it("rejects a path that starts with a forbidden system dir", () => {
    const result = validateStep2({ sandboxDir: "/System/Library/CoreServices" });
    expect(result.ok).toBe(false);
  });

  it("accepts a user home subdirectory", () => {
    const result = validateStep2({ sandboxDir: "/Users/alice/Documents/ArmorClaw" });
    expect(result.ok).toBe(true);
  });

  it("accepts a Windows-style path", () => {
    const result = validateStep2({ sandboxDir: "C:\\Users\\alice\\Documents\\ArmorClaw" });
    expect(result.ok).toBe(true);
  });

  it("rejects Windows Program Files", () => {
    const result = validateStep2({ sandboxDir: "C:\\Program Files\\ArmorClaw" });
    expect(result.ok).toBe(false);
  });

  it("strips trailing slashes before checking forbidden paths", () => {
    const result = validateStep2({ sandboxDir: "/usr/" });
    expect(result.ok).toBe(false);
  });

  describe("rejects paths that ARE or CONTAIN ~/.armorclaw/", () => {
    const armorclawDir = `${homedir()}/.armorclaw`;
    const home = homedir();

    it("rejects exactly ~/.armorclaw", () => {
      const result = validateStep2({ sandboxDir: armorclawDir });
      expect(result.ok).toBe(false);
      expect(result.field).toBe("sandboxDir");
      expect(result.message).toMatch(/\.armorclaw/);
    });

    it("rejects ~/.armorclaw/ with trailing slash", () => {
      const result = validateStep2({ sandboxDir: armorclawDir + "/" });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/\.armorclaw/);
    });

    it("rejects the user's home directory (which contains .armorclaw)", () => {
      const result = validateStep2({ sandboxDir: home });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/\.armorclaw/);
    });

    it("accepts a sibling directory under home (~/Documents/ArmorClaw)", () => {
      const result = validateStep2({ sandboxDir: `${home}/Documents/ArmorClaw` });
      expect(result.ok).toBe(true);
    });

    it("accepts a different directory inside home that is not an ancestor of .armorclaw", () => {
      const result = validateStep2({ sandboxDir: `${home}/SandboxArea` });
      expect(result.ok).toBe(true);
    });
  });
});

// ── Step 3 — Email & calendar ─────────────────────────────────────────────────

describe("validateStep3", () => {
  it("rejects when no providers selected", () => {
    const result = validateStep3({ providers: [], gmailConnected: false, outlookConnected: false });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("providers");
  });

  it("rejects when gmail selected but not connected", () => {
    const result = validateStep3({
      providers: ["gmail"],
      gmailConnected: false,
      outlookConnected: false,
    });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("gmail");
    expect(result.message).toMatch(/gmail/i);
  });

  it("rejects when outlook selected but not connected", () => {
    const result = validateStep3({
      providers: ["outlook"],
      gmailConnected: false,
      outlookConnected: false,
    });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("outlook");
  });

  it("accepts when gmail is selected and connected", () => {
    const result = validateStep3({
      providers: ["gmail"],
      gmailConnected: true,
      outlookConnected: false,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts when both providers are selected and both connected", () => {
    const result = validateStep3({
      providers: ["gmail", "outlook"],
      gmailConnected: true,
      outlookConnected: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects when both selected but only gmail connected", () => {
    const result = validateStep3({
      providers: ["gmail", "outlook"],
      gmailConnected: true,
      outlookConnected: false,
    });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("outlook");
  });

  it("rejects when partial data is given", () => {
    const result = validateStep3({});
    expect(result.ok).toBe(false);
  });
});

// ── Step 4 — Tailscale ────────────────────────────────────────────────────────

describe("validateStep4", () => {
  it("rejects when status is pending", () => {
    const result = validateStep4({ status: "pending" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/waiting/i);
  });

  it("rejects when status is undefined", () => {
    const result = validateStep4({});
    expect(result.ok).toBe(false);
  });

  it("rejects when Tailscale is still installing", () => {
    const result = validateStep4({ status: "installing" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/install/i);
  });

  it("accepts when Tailscale is detected", () => {
    const result = validateStep4({ status: "detected" });
    expect(result.ok).toBe(true);
  });

  it("accepts when Tailscale was deferred (user chose later)", () => {
    const result = validateStep4({ status: "deferred" });
    expect(result.ok).toBe(true);
  });
});

// ── Step 5 — Mobile channel setup ────────────────────────────────────────────

describe("validateStep5", () => {
  it("rejects when no channels connected and Tailscale not deferred", () => {
    const result = validateStep5({ connectedChannels: [], tailscaleDeferred: false });
    expect(result.ok).toBe(false);
    expect(result.field).toBe("channels");
    expect(result.message).toMatch(/messaging app/i);
  });

  it("accepts when Tailscale was deferred (step is greyed out)", () => {
    const result = validateStep5({ connectedChannels: [], tailscaleDeferred: true });
    expect(result.ok).toBe(true);
  });

  it("accepts when at least one channel is connected", () => {
    const result = validateStep5({ connectedChannels: ["telegram"], tailscaleDeferred: false });
    expect(result.ok).toBe(true);
  });

  it("accepts when multiple channels are connected", () => {
    const result = validateStep5({
      connectedChannels: ["telegram", "whatsapp"],
      tailscaleDeferred: false,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts whatsapp alone", () => {
    expect(validateStep5({ connectedChannels: ["whatsapp"], tailscaleDeferred: false }).ok).toBe(
      true,
    );
  });

  it("rejects empty data", () => {
    const result = validateStep5({});
    expect(result.ok).toBe(false);
  });
});

// ── Step 6 — Review ───────────────────────────────────────────────────────────

describe("validateStep6", () => {
  it("rejects when provider is missing", () => {
    const result = validateStep6({ sandboxDir: "/Users/alice/Documents/ArmorClaw" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/provider/i);
  });

  it("rejects when sandboxDir is missing", () => {
    const result = validateStep6({ provider: "anthropic" });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/sandbox/i);
  });

  it("accepts when both required fields are present", () => {
    const result = validateStep6({
      provider: "anthropic",
      sandboxDir: "/Users/alice/Documents/ArmorClaw",
      connectedChannels: ["telegram"],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts with tailscale URL present", () => {
    const result = validateStep6({
      provider: "openai",
      sandboxDir: "/Users/alice/Documents/ArmorClaw",
      tailscaleUrl: "https://mydevice.tail1234.ts.net",
      connectedChannels: [],
    });
    expect(result.ok).toBe(true);
  });
});
