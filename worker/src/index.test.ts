/**
 * Unit tests for the ArmorClaw billing Worker.
 *
 * Avoids @cloudflare/vitest-pool-workers (heavy install) and instead mocks
 * the KVNamespace, ExecutionContext, and fetch surfaces directly. Web Crypto
 * is available in modern Node, so signature verification runs unmocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, type InstallRecord, verifyStripeSignature, __test } from "./index.ts";

// ── Mock KV ───────────────────────────────────────────────────────────────────

interface FakeKV extends KVNamespace {
  _store: Map<string, string>;
}

function makeKV(): FakeKV {
  const store = new Map<string, string>();
  const kv = {
    _store: store,
    async get(key: string, opts?: { type?: "json" | "text" }) {
      const raw = store.get(key);
      if (raw === undefined) {
        return null;
      }
      if (opts?.type === "json") {
        return JSON.parse(raw);
      }
      return raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
  } as unknown as FakeKV;
  return kv;
}

// ── Mock ExecutionContext ─────────────────────────────────────────────────────

function makeCtx(): ExecutionContext & { _waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      waited.push(p);
    },
    passThroughOnException() {},
    _waited: waited,
  } as ExecutionContext & { _waited: Promise<unknown>[] };
}

async function flushCtx(ctx: ExecutionContext & { _waited: Promise<unknown>[] }): Promise<void> {
  await Promise.all(ctx._waited);
}

// ── Stripe signature helper (real HMAC, no mocking) ──────────────────────────

const SECRET = "whsec_test_secret_value";

async function signPayload(payload: string, ts: number, secret = SECRET): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}.${payload}`));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${ts},v1=${hex}`;
}

// ── Env factory ───────────────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env & { KV: FakeKV } {
  return {
    KV: makeKV(),
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_WEBHOOK_SECRET: SECRET,
    ...overrides,
  } as Env & { KV: FakeKV };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const INSTALL_ID = "11111111-1111-1111-1111-111111111111";
const SUB_ID = "sub_TEST123";
const CUS_ID = "cus_TEST456";

function checkoutCompletedEvent(): string {
  return JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        client_reference_id: INSTALL_ID,
        customer: CUS_ID,
        subscription: SUB_ID,
      },
    },
  });
}

function subscriptionDeletedEvent(): string {
  return JSON.stringify({
    id: "evt_2",
    type: "customer.subscription.deleted",
    data: {
      object: { id: SUB_ID, customer: CUS_ID, status: "canceled" },
    },
  });
}

function subscriptionUpdatedEvent(status: string): string {
  return JSON.stringify({
    id: "evt_3",
    type: "customer.subscription.updated",
    data: {
      object: { id: SUB_ID, customer: CUS_ID, status },
    },
  });
}

// ── Stripe API fetch mock ─────────────────────────────────────────────────────

let fetchCalls: { url: string; init: RequestInit | undefined }[] = [];

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockStripeFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, init });
    return impl(url, init);
  });
}

// ── Helpers to drive the router ──────────────────────────────────────────────

async function postWebhook(env: Env, body: string, signature: string): Promise<Response> {
  const ctx = makeCtx();
  const req = new Request("https://billing.armorclaw.app/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature,
    },
    body,
  });
  const res = await worker.fetch(req, env, ctx);
  await flushCtx(ctx);
  return res;
}

async function postValidate(env: Env, body: unknown): Promise<Response> {
  const ctx = makeCtx();
  const req = new Request("https://billing.armorclaw.app/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env, ctx);
}

async function postValidateEmail(env: Env, body: unknown): Promise<Response> {
  const ctx = makeCtx();
  const req = new Request("https://billing.armorclaw.app/validate-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env, ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyStripeSignature", () => {
  it("accepts a valid signature within tolerance", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const payload = '{"id":"evt_1"}';
    const header = await signPayload(payload, ts);
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true);
  });

  it("rejects a forged signature", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `t=${ts},v1=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    expect(await verifyStripeSignature('{"id":"evt_1"}', header, SECRET)).toBe(false);
  });

  it("rejects when secret differs", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const payload = '{"id":"evt_1"}';
    const header = await signPayload(payload, ts, "different_secret");
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  it("rejects a stale timestamp (outside tolerance)", async () => {
    const longAgo = Math.floor(Date.now() / 1000) - 3600;
    const payload = '{"id":"evt_1"}';
    const header = await signPayload(payload, longAgo);
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false);
  });

  it("rejects a malformed header", async () => {
    expect(await verifyStripeSignature("payload", "not-a-real-header", SECRET)).toBe(false);
  });

  it("rejects a header with no v1 entries", async () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(await verifyStripeSignature("payload", `t=${ts}`, SECRET)).toBe(false);
  });
});

describe("POST /webhook — signature gate", () => {
  it("returns 400 when Stripe-Signature header is missing", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/webhook", {
      method: "POST",
      body: checkoutCompletedEvent(),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid signature", async () => {
    const env = makeEnv();
    const body = checkoutCompletedEvent();
    const ts = Math.floor(Date.now() / 1000);
    const bad = `t=${ts},v1=00`;
    const res = await postWebhook(env, body, bad);
    expect(res.status).toBe(400);
  });

  it("returns 200 for a valid signature", async () => {
    const env = makeEnv();
    const body = checkoutCompletedEvent();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    const res = await postWebhook(env, body, sig);
    expect(res.status).toBe(200);
  });
});

describe("POST /webhook — checkout.session.completed", () => {
  it("writes install:<id> with active status", async () => {
    const env = makeEnv();
    const body = checkoutCompletedEvent();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const stored = env.KV._store.get(__test.installKey(INSTALL_ID));
    expect(stored).toBeDefined();
    const record = JSON.parse(stored as string) as InstallRecord;
    expect(record.status).toBe("active");
    expect(record.subscriptionId).toBe(SUB_ID);
    expect(record.customerId).toBe(CUS_ID);
    expect(record.activatedAt).toMatch(/^\d{4}-/);
  });

  it("writes the reverse sub:<id> → installId mapping", async () => {
    const env = makeEnv();
    const body = checkoutCompletedEvent();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const reverse = env.KV._store.get(__test.subKey(SUB_ID));
    expect(reverse).toBe(INSTALL_ID);
  });

  it("ignores events without client_reference_id", async () => {
    const env = makeEnv();
    const body = JSON.stringify({
      id: "evt_x",
      type: "checkout.session.completed",
      data: {
        object: { id: "cs_x", client_reference_id: null, customer: "cus_x", subscription: "sub_x" },
      },
    });
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    const res = await postWebhook(env, body, sig);
    expect(res.status).toBe(200);
    expect(env.KV._store.size).toBe(0);
  });
});

describe("POST /webhook — customer.subscription.deleted", () => {
  it("flips the install record to canceled", async () => {
    const env = makeEnv();
    // Seed an active install.
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));
    env.KV._store.set(__test.subKey(SUB_ID), INSTALL_ID);

    const body = subscriptionDeletedEvent();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const updated = JSON.parse(
      env.KV._store.get(__test.installKey(INSTALL_ID)) as string,
    ) as InstallRecord;
    expect(updated.status).toBe("canceled");
  });
});

describe("POST /webhook — customer.subscription.updated", () => {
  it("keeps active status when Stripe says active", async () => {
    const env = makeEnv();
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));
    env.KV._store.set(__test.subKey(SUB_ID), INSTALL_ID);

    const body = subscriptionUpdatedEvent("active");
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const updated = JSON.parse(
      env.KV._store.get(__test.installKey(INSTALL_ID)) as string,
    ) as InstallRecord;
    expect(updated.status).toBe("active");
  });

  it("flips to canceled when Stripe reports unpaid", async () => {
    const env = makeEnv();
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));
    env.KV._store.set(__test.subKey(SUB_ID), INSTALL_ID);

    const body = subscriptionUpdatedEvent("unpaid");
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const updated = JSON.parse(
      env.KV._store.get(__test.installKey(INSTALL_ID)) as string,
    ) as InstallRecord;
    expect(updated.status).toBe("canceled");
  });
});

describe("POST /validate — installId path", () => {
  it("returns active:true for an active KV entry confirmed by Stripe", async () => {
    const env = makeEnv();
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));

    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "active", customer: CUS_ID }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    const res = await postValidate(env, { installId: INSTALL_ID });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(true);
    expect(body.subscriptionId).toBe(SUB_ID);
    expect(body.customerId).toBe(CUS_ID);
    expect(fetchCalls[0]?.url).toContain(`/v1/subscriptions/${SUB_ID}`);
  });

  it("returns active:false for an unknown installId", async () => {
    const env = makeEnv();
    mockStripeFetch(() => new Response("{}", { status: 200 }));
    const res = await postValidate(env, { installId: "unknown-id" });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(false);
    expect(fetchCalls.length).toBe(0); // no Stripe call when KV miss
  });

  it("returns active:false when Stripe fetch fails (fallback)", async () => {
    const env = makeEnv();
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "active",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));

    mockStripeFetch(() => {
      throw new Error("network down");
    });

    const res = await postValidate(env, { installId: INSTALL_ID });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(false);
  });

  it("returns active:false when KV says canceled (no Stripe call needed)", async () => {
    const env = makeEnv();
    const seeded: InstallRecord = {
      customerId: CUS_ID,
      subscriptionId: SUB_ID,
      status: "canceled",
      activatedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    env.KV._store.set(__test.installKey(INSTALL_ID), JSON.stringify(seeded));

    mockStripeFetch(() => new Response("{}", { status: 200 }));
    const res = await postValidate(env, { installId: INSTALL_ID });
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(fetchCalls.length).toBe(0);
  });
});

describe("POST /validate — legacy subscriptionId fallback", () => {
  it("validates directly with Stripe when only subscriptionId is given", async () => {
    const env = makeEnv();
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "active", customer: CUS_ID }), {
          status: 200,
        }),
    );
    const res = await postValidate(env, { subscriptionId: SUB_ID });
    const body = await res.json();
    expect(body.active).toBe(true);
  });

  it("returns active:false when Stripe is unreachable", async () => {
    const env = makeEnv();
    mockStripeFetch(() => {
      throw new Error("offline");
    });
    const res = await postValidate(env, { subscriptionId: SUB_ID });
    const body = await res.json();
    expect(body.active).toBe(false);
  });
});

describe("POST /validate — empty body", () => {
  it("returns active:false when neither installId nor subscriptionId is given", async () => {
    const env = makeEnv();
    const res = await postValidate(env, {});
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(false);
  });

  it("returns active:false on invalid JSON", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.active).toBe(false);
  });
});

describe("CORS", () => {
  it("preflights OPTIONS with allowed origin", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/validate", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:7390" },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:7390");
  });

  it("falls back to armorclaw.app for unknown origins", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/validate", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://armorclaw.app");
  });
});

describe("router", () => {
  it("returns 404 for unknown paths", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/nope", { method: "POST" });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });
});

// ── Email-fallback webhook path ──────────────────────────────────────────────

const EMAIL = "Buyer@Example.COM";
const EMAIL_LOWER = "buyer@example.com";

function checkoutCompletedNoRefEmail(): string {
  return JSON.stringify({
    id: "evt_email_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_email_1",
        client_reference_id: null,
        customer: CUS_ID,
        subscription: SUB_ID,
        customer_email: EMAIL,
      },
    },
  });
}

function checkoutCompletedNoRefNoEmail(): string {
  return JSON.stringify({
    id: "evt_email_2",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_email_2",
        client_reference_id: null,
        customer: CUS_ID,
        subscription: SUB_ID,
      },
    },
  });
}

describe("POST /webhook — email fallback (no client_reference_id)", () => {
  it("writes email:<lowercase> record using session.customer_email", async () => {
    const env = makeEnv();
    const body = checkoutCompletedNoRefEmail();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    const stored = env.KV._store.get(__test.emailKey(EMAIL_LOWER));
    expect(stored).toBeDefined();
    const record = JSON.parse(stored as string);
    expect(record.tier).toBe("active");
    expect(record.subscriptionId).toBe(SUB_ID);
    expect(record.customerId).toBe(CUS_ID);
    // No install binding should have been written.
    expect(env.KV._store.get(__test.subKey(SUB_ID))).toBeUndefined();
  });

  it("lowercases the email key (case-insensitive lookup)", async () => {
    const env = makeEnv();
    const body = checkoutCompletedNoRefEmail();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    expect(env.KV._store.has(__test.emailKey(EMAIL_LOWER))).toBe(true);
    expect(env.KV._store.has(__test.emailKey(EMAIL))).toBe(true); // same lowercased key
  });

  it("falls back to Stripe Customer fetch when customer_email is absent", async () => {
    const env = makeEnv();
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: CUS_ID, email: EMAIL_LOWER }), {
          status: 200,
        }),
    );
    const body = checkoutCompletedNoRefNoEmail();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    await postWebhook(env, body, sig);

    expect(fetchCalls[0]?.url).toContain(`/v1/customers/${CUS_ID}`);
    const stored = env.KV._store.get(__test.emailKey(EMAIL_LOWER));
    expect(stored).toBeDefined();
  });

  it("drops the event when no email can be resolved", async () => {
    const env = makeEnv();
    mockStripeFetch(() => new Response("{}", { status: 200 }));
    const body = checkoutCompletedNoRefNoEmail();
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    const res = await postWebhook(env, body, sig);
    expect(res.status).toBe(200);
    expect(env.KV._store.size).toBe(0);
  });

  it("still ignores events with no customer or subscription id", async () => {
    const env = makeEnv();
    const body = JSON.stringify({
      id: "evt_x",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_x",
          client_reference_id: null,
          customer: null,
          subscription: null,
          customer_email: EMAIL,
        },
      },
    });
    const sig = await signPayload(body, Math.floor(Date.now() / 1000));
    const res = await postWebhook(env, body, sig);
    expect(res.status).toBe(200);
    expect(env.KV._store.size).toBe(0);
  });
});

describe("POST /validate-email", () => {
  function seedEmailRecord(env: Env & { KV: FakeKV }, email: string): void {
    env.KV._store.set(
      __test.emailKey(email),
      JSON.stringify({
        customerId: CUS_ID,
        subscriptionId: SUB_ID,
        tier: "active",
      }),
    );
  }

  it("returns active:true with ids when Stripe confirms active", async () => {
    const env = makeEnv();
    seedEmailRecord(env, EMAIL_LOWER);
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "active", customer: CUS_ID }), {
          status: 200,
        }),
    );

    const res = await postValidateEmail(env, { email: EMAIL });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.active).toBe(true);
    expect(body.subscriptionId).toBe(SUB_ID);
    expect(body.customerId).toBe(CUS_ID);
  });

  it("matches case-insensitively (uppercase email finds lowercase record)", async () => {
    const env = makeEnv();
    seedEmailRecord(env, EMAIL_LOWER);
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "trialing", customer: CUS_ID }), {
          status: 200,
        }),
    );
    const res = await postValidateEmail(env, { email: "BUYER@EXAMPLE.com" });
    const body = await res.json();
    expect(body.active).toBe(true);
  });

  it("trims whitespace before lookup", async () => {
    const env = makeEnv();
    seedEmailRecord(env, EMAIL_LOWER);
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "active", customer: CUS_ID }), {
          status: 200,
        }),
    );
    const res = await postValidateEmail(env, { email: `  ${EMAIL}  ` });
    const body = await res.json();
    expect(body.active).toBe(true);
  });

  it("returns active:false when the email has no KV record", async () => {
    const env = makeEnv();
    mockStripeFetch(() => new Response("{}", { status: 200 }));
    const res = await postValidateEmail(env, { email: "unknown@example.com" });
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(fetchCalls.length).toBe(0); // no Stripe call on KV miss
  });

  it("returns active:false when Stripe says canceled", async () => {
    const env = makeEnv();
    seedEmailRecord(env, EMAIL_LOWER);
    mockStripeFetch(
      () =>
        new Response(JSON.stringify({ id: SUB_ID, status: "canceled", customer: CUS_ID }), {
          status: 200,
        }),
    );
    const res = await postValidateEmail(env, { email: EMAIL });
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(body.subscriptionId).toBe(SUB_ID);
  });

  it("returns active:false on Stripe network error", async () => {
    const env = makeEnv();
    seedEmailRecord(env, EMAIL_LOWER);
    mockStripeFetch(() => {
      throw new Error("offline");
    });
    const res = await postValidateEmail(env, { email: EMAIL });
    const body = await res.json();
    expect(body.active).toBe(false);
    expect(body.error).toBe("stripe_unreachable");
  });

  it("returns active:false when email is missing or empty", async () => {
    const env = makeEnv();
    const res1 = await postValidateEmail(env, {});
    expect((await res1.json()).active).toBe(false);
    const res2 = await postValidateEmail(env, { email: "   " });
    expect((await res2.json()).active).toBe(false);
  });

  it("returns active:false on invalid JSON", async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request("https://billing.armorclaw.app/validate-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect((await res.json()).active).toBe(false);
  });
});
