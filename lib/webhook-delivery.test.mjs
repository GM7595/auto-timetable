import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("./webhook-delivery.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "webhook-delivery.ts",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const secret = (size = 32, value = 1) => `whsec_${Buffer.alloc(size, value).toString("base64")}`;
const subscription = { id: "sub_fake-test", url: "https://callbacks.chatgpt.com/mcp-events/fake-callback", secret: secret() };
const now = 1792297200000;

function harness({ clock = now, timed = false } = {}) {
  const module = { exports: {} };
  const timers = new Map();
  const logs = [];
  let timerSequence = 0;
  class TestDate extends Date { static now() { return clock; } }
  const fakeSetTimeout = (callback, delay) => {
    assert.ok(delay > 0 && delay <= 5000);
    const id = ++timerSequence;
    timers.set(id, callback);
    return id;
  };
  const fakeClearTimeout = (id) => timers.delete(id);
  const mockConsole = Object.fromEntries(["log", "warn", "error", "info", "debug"].map((name) => [name, (...values) => logs.push(values)]));
  new Function("module", "exports", "crypto", "fetch", "Date", "setTimeout", "clearTimeout", "console", compiled)(
    module, module.exports, webcrypto, () => { throw new Error("A test omitted its fake fetcher"); }, TestDate,
    timed ? fakeSetTimeout : setTimeout, timed ? fakeClearTimeout : clearTimeout, mockConsole,
  );
  return { ...module.exports, logs, timers, fireTimeout() { for (const callback of [...timers.values()]) callback(); } };
}

function expectedSignature(value, eventId, timestamp, body) {
  return `v1,${createHmac("sha256", Buffer.from(value.slice(6), "base64")).update(`${eventId}.${timestamp}.${body}`).digest("base64")}`;
}

test("official HTTPS callback allowlist accepts exact and proper subdomains only", () => {
  const api = harness();
  for (const url of ["https://chatgpt.com/callback", "https://openai.com/callback", "https://callbacks.chatgpt.com:443/path?opaque=token", "https://events.prod.openai.com/path"]) {
    assert.ok(api.validateWebhookUrl(url) instanceof URL);
  }
  for (const url of [
    "http://chatgpt.com/", "https://chatgpt.com:444/", "https://chatgpt.com/#fragment", "https://chatgpt.com/#",
    "https://user:pass@chatgpt.com/", "https://@chatgpt.com/", "https://user@openai.com/",
    "https://chatgpt.com.evil.example/", "https://notchatgpt.com/", "https://openai.com.evil.example/", "https://evilopenai.com/",
    "https://127.0.0.1/", "https://[::1]/", "https://2130706433/", "https://0x7f000001/", "https://169.254.169.254/",
    "https://localhost/", "https://local.chatgpt.com.evil.example/", "https://chatgpt.com./", "https://a..chatgpt.com/",
    "https://-a.chatgpt.com/", "https://a_.chatgpt.com/", " https://chatgpt.com/", "https://chatgpt.com/\n",
    "https://chatgpt.com\\@evil.example/", "https://chatgpt.com/" + "x".repeat(2048), "not a URL", "", null,
  ]) assert.throws(() => api.validateWebhookUrl(url), { message: "Invalid webhook destination" });
});

test("signing secrets require canonical padded base64 encoding of 24 through 64 bytes", () => {
  const api = harness();
  for (const size of [24, 25, 32, 63, 64]) assert.equal(api.validateSigningSecret(secret(size)), true);
  for (const value of [
    secret(23), secret(65), "whsec_", secret().slice(0, -1), secret().replace(/=$/, ""),
    secret().replace("whsec_", ""), `whsec_${"_".repeat(32)}`, `${secret()}\n`, null,
    `whsec_${Buffer.alloc(25, 1).toString("base64").slice(0, -3)}R==`,
  ]) assert.equal(api.validateSigningSecret(value), false);
});

test("delivery signs exactly one serialization with Standard Webhooks HMAC and no plaintext key", async () => {
  const api = harness();
  const calls = [];
  let serializations = 0;
  const payload = { toJSON() { serializations += 1; return { eventId: "evt_fake", data: { text: "開始を10分遅らせる" } }; } };
  const result = await api.signedWebhookRequest(subscription, "evt_fake", payload, async (...args) => {
    calls.push(args); return new Response(null, { status: 202 });
  });
  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal(serializations, 1);
  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, subscription.url);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["webhook-id"], "evt_fake");
  assert.equal(init.headers["webhook-timestamp"], String(now / 1000));
  assert.equal(init.headers["X-MCP-Subscription-Id"], subscription.id);
  assert.equal(init.headers["webhook-signature"], expectedSignature(subscription.secret, "evt_fake", String(now / 1000), init.body));
  assert.equal(init.body, JSON.stringify({ eventId: "evt_fake", data: { text: "開始を10分遅らせる" } }));
  assert.ok(!JSON.stringify({ result, headers: init.headers, logs: api.logs }).includes(subscription.secret));
  assert.deepEqual(api.logs, []);
});

test("every delivery revalidates destination and key; rejected inputs cannot make network requests", async () => {
  const api = harness();
  const fetcher = async () => { assert.fail("Invalid input reached the network"); };
  for (const item of [
    { ...subscription, url: "https://127.0.0.1/" }, { ...subscription, url: "https://chatgpt.com.evil.example/" },
    { ...subscription, secret: "invalid" }, { ...subscription, id: "bad\r\nheader" },
  ]) assert.deepEqual(await api.signedWebhookRequest(item, "evt_fake", {}, fetcher), { ok: false, status: 0 });
  assert.deepEqual(await api.signedWebhookRequest(subscription, "bad\nheader", {}, fetcher), { ok: false, status: 0 });
});

test("payload limit counts serialized UTF-8 bytes and rejects impossible JSON safely", async () => {
  const api = harness();
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response(null, { status: 204 }); };
  assert.deepEqual(await api.signedWebhookRequest(subscription, "evt_max", "x".repeat(256 * 1024 - 2), fetcher), { ok: true, status: 204 });
  for (const value of ["x".repeat(256 * 1024 - 1), "あ".repeat(90_000), undefined, 1n]) {
    assert.deepEqual(await api.signedWebhookRequest(subscription, "evt_too_large", value, fetcher), { ok: false, status: 0 });
  }
  const circular = {}; circular.self = circular;
  assert.deepEqual(await api.signedWebhookRequest(subscription, "evt_circular", circular, fetcher), { ok: false, status: 0 });
  assert.equal(calls, 1);
});

test("only unexpired valid rotation keys produce a second space-separated signature", async () => {
  const api = harness();
  const old = secret(24, 2);
  for (const [fields, expected] of [
    [{ previousSecret: old, previousSecretExpiresAt: now + 60_000 }, 2],
    [{ previousSecret: old, previousSecretExpiresAt: now }, 1],
    [{ previousSecret: old, previousSecretExpiresAt: now - 1 }, 1],
    [{ previousSecret: old }, 1],
    [{ previousSecret: old, previousSecretExpiresAt: Infinity }, 1],
    [{ previousSecret: "bad", previousSecretExpiresAt: now + 60_000 }, 1],
    [{ previousSecret: subscription.secret, previousSecretExpiresAt: now + 60_000 }, 1],
  ]) {
    await api.signedWebhookRequest({ ...subscription, ...fields }, "evt_rotation", { eventId: "evt_rotation" }, async (_url, init) => {
      const signatures = init.headers["webhook-signature"].split(" ");
      assert.equal(signatures.length, expected);
      assert.equal(signatures[0], expectedSignature(subscription.secret, "evt_rotation", init.headers["webhook-timestamp"], init.body));
      if (expected === 2) assert.equal(signatures[1], expectedSignature(old, "evt_rotation", init.headers["webhook-timestamp"], init.body));
      return new Response(null, { status: 200 });
    });
  }
});

test("delivery reports safe status only, never follows redirects, and suppresses transport details", async () => {
  const api = harness();
  for (const status of [200, 204, 302, 410, 413, 503]) {
    const result = await api.signedWebhookRequest(subscription, "evt_response", {}, async (_url, init) => {
      assert.equal(init.redirect, "error"); return new Response(null, { status });
    });
    assert.deepEqual(result, { ok: status >= 200 && status < 300, status });
  }
  const result = await api.signedWebhookRequest(subscription, "evt_response", {}, async () => { throw new Error(`${subscription.url} ${subscription.secret} raw upstream details`); });
  assert.deepEqual(result, { ok: false, status: 0 });
  assert.deepEqual(api.logs, []);
});

test("retrying the same event preserves its identity but creates a fresh timestamp and signature", async () => {
  const requests = [];
  for (const clock of [now, now + 1000]) {
    const api = harness({ clock });
    assert.deepEqual(await api.signedWebhookRequest(subscription, "evt_retry", { eventId: "evt_retry" }, async (_url, init) => {
      requests.push(init); return new Response(null, { status: 202 });
    }), { ok: true, status: 202 });
  }
  assert.equal(requests[0].headers["webhook-id"], requests[1].headers["webhook-id"]);
  assert.equal(requests[0].body, requests[1].body);
  assert.notEqual(requests[0].headers["webhook-timestamp"], requests[1].headers["webhook-timestamp"]);
  assert.notEqual(requests[0].headers["webhook-signature"], requests[1].headers["webhook-signature"]);
});

test("verification sends only fresh signed challenge control data and requires an exact echo", async () => {
  const api = harness();
  const challenges = new Set();
  const ids = new Set();
  for (let index = 0; index < 2; index += 1) {
    const result = await api.verifyWebhookCallback(subscription, async (_url, init) => {
      const payload = JSON.parse(init.body);
      assert.deepEqual(Object.keys(payload).sort(), ["challenge", "type"]);
      assert.equal(payload.type, "verification");
      assert.match(payload.challenge, /^[0-9a-f-]{36}$/);
      assert.ok(!challenges.has(payload.challenge)); challenges.add(payload.challenge);
      assert.ok(!ids.has(init.headers["webhook-id"])); ids.add(init.headers["webhook-id"]);
      assert.equal(init.headers["webhook-signature"], expectedSignature(subscription.secret, init.headers["webhook-id"], init.headers["webhook-timestamp"], init.body));
      assert.equal(init.redirect, "error");
      return Response.json({ challenge: payload.challenge });
    });
    assert.deepEqual(result, { ok: true });
  }
});

test("verification rejects mismatched, malformed, non-2xx, redirected, and oversized responses", async () => {
  const api = harness();
  for (const makeResponse of [
    () => Response.json({ challenge: "incorrect" }), () => Response.json({}), () => Response.json({ challenge: 1 }),
    () => Response.json([]), () => new Response("not JSON"), () => new Response(null, { status: 302 }),
    () => new Response(null, { status: 503 }), () => new Response("x".repeat(8193)),
    () => new Response("{}", { headers: { "content-length": "8193" } }),
    () => new Response("{}", { headers: { "content-length": "invalid" } }),
    () => { const response = Response.json({}); Object.defineProperty(response, "redirected", { value: true }); return response; },
  ]) assert.deepEqual(await api.verifyWebhookCallback(subscription, async () => makeResponse()), { ok: false, reason: "challenge_failed" });
});

test("verification validates URL and secret before any challenge is sent", async () => {
  const api = harness();
  const fetcher = async () => { assert.fail("Invalid verification reached the network"); };
  assert.deepEqual(await api.verifyWebhookCallback({ ...subscription, url: "http://chatgpt.com" }, fetcher), { ok: false, reason: "invalid_destination" });
  assert.deepEqual(await api.verifyWebhookCallback({ ...subscription, secret: "bad" }, fetcher), { ok: false, reason: "invalid_secret" });
});

test("verification accepts at most 8KiB and cancels oversized or stalled response streams", async () => {
  const api = harness();
  assert.deepEqual(await api.verifyWebhookCallback(subscription, async (_url, init) => {
    const challenge = JSON.parse(init.body).challenge;
    const empty = JSON.stringify({ challenge, padding: "" });
    const body = JSON.stringify({ challenge, padding: "x".repeat(8192 - empty.length) });
    assert.equal(Buffer.byteLength(body), 8192);
    return new Response(body);
  }), { ok: true });
  let cancelled = false;
  assert.deepEqual(await api.verifyWebhookCallback(subscription, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; },
  }))), { ok: false, reason: "challenge_failed" });
  assert.equal(cancelled, true);

  const timeoutApi = harness({ timed: true });
  let reading;
  const startedReading = new Promise((resolve) => { reading = resolve; });
  cancelled = false;
  const pending = timeoutApi.verifyWebhookCallback(subscription, async () => new Response(new ReadableStream({
    pull() { reading(); return new Promise(() => {}); }, cancel() { cancelled = true; },
  })));
  await startedReading;
  timeoutApi.fireTimeout();
  assert.deepEqual(await pending, { ok: false, reason: "timeout" });
  assert.equal(cancelled, true);
});

test("verification and delivery hard-timeout even when a fetcher ignores cancellation", async () => {
  for (const verification of [false, true]) {
    const api = harness({ timed: true });
    let reachedFetch;
    const fetchReached = new Promise((resolve) => { reachedFetch = resolve; });
    let signal;
    const fetcher = async (_url, init) => { signal = init.signal; reachedFetch(); return new Promise(() => {}); };
    const pending = verification ? api.verifyWebhookCallback(subscription, fetcher) : api.signedWebhookRequest(subscription, "evt_timeout", {}, fetcher);
    await fetchReached;
    assert.equal(api.timers.size, 1);
    api.fireTimeout();
    assert.deepEqual(await pending, verification ? { ok: false, reason: "timeout" } : { ok: false, status: 0 });
    assert.equal(signal.aborted, true);
    assert.equal(api.timers.size, 0);
  }
});
