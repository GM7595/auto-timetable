import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, webcrypto } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

const initial = { event: { id: "event-a" }, slots: [], history: [], revision: 4 };
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const replacement = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
const subscription = (changes = {}) => ({ name: "change_request.created", arguments: { eventId: "event-a" }, delivery: { mode: "webhook", url: "https://chatgpt.com/callback/a", secret }, cursor: null, ...changes });
const unsubscribe = (value) => ({ name: value.name, arguments: value.arguments, delivery: { mode: "webhook", url: value.delivery.url } });
function compile(path) { return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText; }
function evaluate(source, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), source)((name) => { assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`); return dependencies[name]; }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
function harness({ verify = { ok: true }, response = { ok: true, status: 204 }, beforeWrite, send } = {}) {
  const db = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  let state = structuredClone(initial);
  const setState = (next) => { state = structuredClone(next); db.prepare("INSERT OR REPLACE INTO cue_event_state VALUES ('primary', ?, ?, '2026-10-18T00:00:00Z')").run(state.revision, JSON.stringify(state)); };
  setState(initial);
  const queries = [], deliveries = [], verifications = [], sleeps = [], logs = [];
  const adapter = { prepare(sql) { queries.push(sql); assert.doesNotMatch(sql, /\b(?:DELETE|DROP|CREATE)\b/i); assert.doesNotMatch(sql, /UPDATE cue_event_state/i); return { bind(...args) { return {
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { await beforeWrite?.({ sql, args, db, setState }); return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
  }; } }; } };
  const store = { HttpError, async getEventState() { return structuredClone(state); }, checkBrowserOrigin() {}, async getPrivateCallerContext() {}, async readJsonBody(request, schema) { return schema.parse(await request.json()); }, jsonResponse: Response.json.bind(Response), errorResponse(error) { throw error; } };
  const api = evaluate(compile("./mcp-events.ts"), {
    zod: { z }, "cloudflare:workers": { env: { DB: adapter } }, "@/lib/server-store": store,
    "@/lib/webhook-delivery": {
      validateSigningSecret(value) { return value.startsWith("whsec_") && Buffer.from(value.slice(6), "base64").length >= 24; },
      validateWebhookUrl(value) { const url = new URL(value); if (url.protocol !== "https:" || !["chatgpt.com", "openai.com"].includes(url.hostname) || url.username || url.password) throw new Error("invalid"); return url; },
      async verifyWebhookCallback(value) { verifications.push(structuredClone(value)); return typeof verify === "function" ? verify(value) : verify; },
      async signedWebhookRequest(sub, eventId, payload) { deliveries.push({ sub: structuredClone(sub), eventId, payload: structuredClone(payload) }); return send ? send({ sub, eventId, payload, db, setState, attempt: deliveries.length }) : response; },
    },
  }, { crypto: webcrypto, setTimeout(callback, ms) { sleeps.push(ms); callback(); }, console: { error: (...args) => logs.push(args) } });
  const route = evaluate(compile("../app/mcp/route.ts"), {
    zod: { z }, "@/lib/mcp-events": api, "@/lib/server-store": store,
    "@/lib/change-requests": { async listPendingChangeRequests() { return []; } },
    "@/lib/agent-proposals": { async getAgentContext() { return { state }; }, async publishAgentProposal() { return { applied: false }; } },
    "@/lib/planner": { computeSchedule() { return { violations: [] }; } },
    "@/lib/decisions": { async proposePlans() { return {}; } }, "@/lib/proposal-review-link": { createProposalReviewUrl() { return "https://site.test/"; } },
  });
  const rpc = async (method, params, principal = "owner-a") => (await (await route.POST(new Request("https://site.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...(principal ? { "oai-authenticated-user-id": principal } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params !== undefined ? { params } : {}) }) }))).json());
  const change = (extra = {}) => ({ id: randomUUID(), eventId: "event-a", baseRevision: 4, text: "private-user-authored-text", createdAt: new Date(Date.now() + 1).toISOString(), status: "pending", requestId: "unused", ...extra });
  return { ...api, db, store, queries, deliveries, verifications, sleeps, logs, rpc, change, setState, getState: () => structuredClone(state), rows: () => db.prepare("SELECT * FROM cue_event_subscription").all(), outbox: () => db.prepare("SELECT * FROM cue_event_delivery").all() };
}

test("discovery advertises MCP2 complete tools+events and one filtered minimal event", async () => {
  const api = harness();
  const discovery = (await api.rpc("server/discover")).result;
  assert.equal(discovery.resultType, "complete");
  assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discovery.capabilities, { tools: {}, events: {} });
  const list = (await api.rpc("events/list", { cursor: null })).result.events;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "change_request.created");
  assert.deepEqual(list[0].delivery, ["webhook"]);
  assert.deepEqual(list[0].inputSchema.required, ["eventId"]);
  assert.deepEqual(list[0].payloadSchema.required, ["eventId", "changeRequestId", "revision"]);
  assert.deepEqual(api.queries, []);
});

test("subscription verifies callback before durable activation and exposes no callback or secret", async () => {
  const api = harness();
  const response = await api.rpc("events/subscribe", subscription());
  assert.ok(response.result.id.startsWith("sub_"));
  assert.equal(response.result.cursor, null);
  assert.equal(response.result.truncated, false);
  assert.equal(api.verifications.length, 1);
  assert.equal(api.rows()[0].active, 1);
  assert.equal(api.rows()[0].principal, "owner-a");
  assert.doesNotMatch(JSON.stringify(response), /whsec_|callback|owner-a/);
  assert.deepEqual(api.getState(), initial);
});

test("identical refreshes have a deterministic ID and bounded verification cache", async () => {
  const api = harness();
  const first = await api.subscribeMcpEvent("owner-a", subscription());
  const second = await api.subscribeMcpEvent("owner-a", subscription({ arguments: { eventId: "event-a" } }));
  assert.equal(first.id, second.id);
  assert.equal(api.rows().length, 1);
  assert.equal(api.verifications.length, 1);
  api.db.prepare("UPDATE cue_event_subscription SET verified_at = ?").run(new Date(Date.now() - 300001).toISOString());
  await api.subscribeMcpEvent("owner-a", subscription());
  assert.equal(api.verifications.length, 2);
});

test("secret rotation reverifies and signs with the previous key for at most five minutes", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  await api.subscribeMcpEvent("owner-a", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/a", secret: replacement } }));
  assert.equal(api.verifications.length, 2);
  const row = api.rows()[0];
  assert.equal(row.secret, replacement);
  assert.equal(row.previous_secret, secret);
  assert.ok(row.previous_secret_until <= Date.now() + 300000);
  assert.equal(api.verifications[1].previousSecret, secret);
});

for (const ttl of [1000, 60000, 15 * 86400000, null, undefined]) {
  test(`requested subscription lifetime is finite and never exceeds request: ${ttl}`, async () => {
    const api = harness(), start = Date.now();
    const result = await api.subscribeMcpEvent("owner-a", subscription(ttl === undefined ? {} : { ttlMs: ttl }));
    assert.ok(Date.parse(result.refreshBefore) > start);
    const granted = Date.parse(result.refreshBefore) - Date.parse(api.rows()[0].updated_at);
    assert.ok(granted > 0);
    assert.ok(granted <= Math.min(ttl ?? 86400000, 7 * 86400000));
  });
}

for (const [label, value, principal, code] of [
  ["missing principal", subscription(), null, -32001],
  ["blank principal", subscription(), "bad principal", -32001],
  ["different event", subscription({ arguments: { eventId: "other" } }), "owner-a", -32602],
  ["invalid secret", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/a", secret: "invalid" } }), "owner-a", -32602],
  ["private callback", subscription({ delivery: { mode: "webhook", url: "https://127.0.0.1/callback", secret } }), "owner-a", -32015],
  ["unsupported replay", subscription({ cursor: "saved-cursor" }), "owner-a", -32602],
  ["caller controlled payload", { ...subscription(), payload: { text: "ignored" } }, "owner-a", -32602],
]) {
  test(`invalid subscription rejects ${label} without activation`, async () => {
    const api = harness(), result = await api.rpc("events/subscribe", value, principal);
    assert.equal(result.error.code, code);
    assert.equal(api.rows().length, 0);
    assert.equal(api.verifications.length, 0);
  });
}

test("failed callback challenge returns categorized -32015 and never activates", async () => {
  const api = harness({ verify: { ok: false, reason: "challenge_failed" } });
  const result = await api.rpc("events/subscribe", subscription());
  assert.deepEqual(result.error.data, { reason: "challenge_failed" });
  assert.equal(result.error.code, -32015);
  assert.equal(api.rows().length, 0);
});

test("ten active subscriptions per current event are bounded, but refresh remains idempotent", async () => {
  const api = harness();
  for (let index = 0; index < 10; index++) await api.subscribeMcpEvent("owner-a", subscription({ delivery: { mode: "webhook", url: `https://chatgpt.com/callback/${index}`, secret } }));
  const result = await api.rpc("events/subscribe", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/overflow", secret } }));
  assert.equal(result.error.code, -32000);
  await api.subscribeMcpEvent("owner-a", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/0", secret } }));
  assert.equal(api.rows().length, 10);
});

test("the active subscription cap is atomic if another subscriber fills the final slot", async () => {
  let race = false;
  const api = harness({ beforeWrite: ({ sql, db }) => {
    if (race && sql.startsWith("INSERT INTO cue_event_subscription")) {
      race = false;
      db.prepare(`INSERT INTO cue_event_subscription SELECT 'raced', principal, event_id, event_name, callback_url, secret, previous_secret, previous_secret_until, active, expires_at, verified_at, updated_at, active_since FROM cue_event_subscription LIMIT 1`).run();
    }
  } });
  for (let index = 0; index < 9; index++) await api.subscribeMcpEvent("owner-a", subscription({ delivery: { mode: "webhook", url: `https://chatgpt.com/callback/${index}`, secret } }));
  race = true;
  const result = await api.rpc("events/subscribe", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/final", secret } }));
  assert.equal(result.error.code, -32000);
  assert.equal(api.rows().length, 10);
});

test("unsubscribe is authenticated, identity-scoped, idempotent, and retains inactive history", async () => {
  const api = harness();
  const first = await api.subscribeMcpEvent("owner-a", subscription());
  await api.unsubscribeMcpEvent("owner-b", unsubscribe(subscription()));
  assert.equal(api.rows()[0].active, 1);
  const result = await api.rpc("events/unsubscribe", unsubscribe(subscription()));
  assert.deepEqual(result.result, {});
  await api.unsubscribeMcpEvent("owner-a", unsubscribe(subscription()));
  assert.equal(api.rows()[0].active, 0);
  assert.equal(api.rows()[0].id, first.id);
});

test("durable outbox creates one stable minimal event per subscription and replay does not redeliver accepted events", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await api.prepareChangeRequestEvent(change);
  assert.equal(api.outbox().length, 1);
  assert.equal(api.outbox()[0].status, "pending");
  assert.equal(api.deliveries.length, 0);
  await api.dispatchChangeRequestEvent(change);
  await api.prepareChangeRequestEvent(change);
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 1);
  const { payload, eventId } = api.deliveries[0];
  assert.equal(payload.eventId, eventId);
  assert.equal(payload.name, "change_request.created");
  assert.equal(payload.timestamp, change.createdAt);
  assert.deepEqual(payload.data, { eventId: "event-a", changeRequestId: change.id, revision: 4 });
  assert.doesNotMatch(JSON.stringify(payload), /private-user-authored-text|whsec_|callback|owner-a/);
  assert.deepEqual(api.getState(), initial);
  const status = await api.getEventDeliveryStatus("event-a");
  assert.equal(status.activeSubscriptions, 1);
  assert.equal(status.pendingDeliveries, 0);
  assert.ok(status.lastDeliveredAt);
  assert.doesNotMatch(JSON.stringify(status), /whsec_|callback|owner-a/);
});

test("concurrent dispatchers atomically claim at most one attempt", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await Promise.all([api.prepareChangeRequestEvent(change), api.prepareChangeRequestEvent(change)]);
  await Promise.all([api.dispatchChangeRequestEvent(change), api.dispatchChangeRequestEvent(change)]);
  assert.equal(api.outbox().length, 1);
  assert.equal(api.deliveries.length, 1);
});

test("refresh preserves the original active epoch so retry preparation cannot lose accepted events", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  const activeSince = api.rows()[0].active_since;
  const change = api.change({ createdAt: activeSince });
  await api.subscribeMcpEvent("owner-a", subscription({ delivery: { mode: "webhook", url: "https://chatgpt.com/callback/a", secret: replacement } }));
  api.db.prepare("UPDATE cue_event_subscription SET verified_at = ?").run(new Date(Date.now() + 60000).toISOString());
  assert.equal(api.rows()[0].active_since, activeSince);
  await api.prepareChangeRequestEvent(change);
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 1);
  assert.equal(api.deliveries[0].sub.secret, replacement);
});

test("a durable interrupted claim is recovered after its lease with the same event ID", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await api.prepareChangeRequestEvent(change);
  const id = api.outbox()[0].id;
  api.db.prepare("UPDATE cue_event_delivery SET status = 'delivering', attempts = 1, updated_at = ?").run(new Date(Date.now() - 30001).toISOString());
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 1);
  assert.equal(api.deliveries[0].eventId, id);
  assert.equal(api.outbox()[0].attempts, 2);
  assert.equal(api.outbox()[0].status, "delivered");
});

test("fresh claims are not stolen and exhausted crashed claims become visible failures", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await api.prepareChangeRequestEvent(change);
  api.db.prepare("UPDATE cue_event_delivery SET status = 'delivering', attempts = 1").run();
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 0);
  api.db.prepare("UPDATE cue_event_delivery SET attempts = 3, updated_at = ?").run(new Date(Date.now() - 30001).toISOString());
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 0);
  assert.equal(api.outbox()[0].status, "failed");
  const status = await api.getEventDeliveryStatus("event-a");
  assert.equal(status.lastFailure, "attempt_limit");
  assert.equal(status.failedDeliveries, 1);
});

test("transient retries preserve event ID, re-sign each attempt, and stop after three attempts", async () => {
  const api = harness({ response: { ok: false, status: 503 } });
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await api.prepareChangeRequestEvent(change);
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 3);
  assert.equal(new Set(api.deliveries.map((entry) => entry.eventId)).size, 1);
  assert.deepEqual(api.sleeps, [250, 500]);
  assert.equal(api.outbox()[0].status, "failed");
  assert.equal(api.outbox()[0].last_failure, "http_5xx");
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 3);
});

for (const code of [410, 413, 400]) {
  test(`permanent callback ${code} is not retried`, async () => {
    const api = harness({ response: { ok: false, status: code } });
    await api.subscribeMcpEvent("owner-a", subscription());
    const change = api.change();
    await api.prepareChangeRequestEvent(change);
    await api.dispatchChangeRequestEvent(change);
    assert.equal(api.deliveries.length, 1);
    assert.equal(api.outbox()[0].status, "failed");
    if (code === 410) assert.equal(api.rows()[0].active, 0);
  });
}

for (const variant of ["unsubscribe", "expire", "different current event"]) {
  test(`delivery rechecks ${variant} before sending any data`, async () => {
    const api = harness();
    await api.subscribeMcpEvent("owner-a", subscription());
    const change = api.change();
    await api.prepareChangeRequestEvent(change);
    if (variant === "unsubscribe") await api.unsubscribeMcpEvent("owner-a", unsubscribe(subscription()));
    if (variant === "expire") api.db.prepare("UPDATE cue_event_subscription SET expires_at = '2020-01-01T00:00:00Z'").run();
    if (variant === "different current event") api.setState({ ...initial, event: { id: "other" } });
    await api.dispatchChangeRequestEvent(change);
    assert.equal(api.deliveries.length, 0);
    assert.equal(api.outbox()[0].status, "failed");
  });
}

test("revocation during a transient retry stops the next attempt", async () => {
  const api = harness({ send: ({ db }) => { db.prepare("UPDATE cue_event_subscription SET active = 0").run(); return { ok: false, status: 500 }; } });
  await api.subscribeMcpEvent("owner-a", subscription());
  const change = api.change();
  await api.prepareChangeRequestEvent(change);
  await api.dispatchChangeRequestEvent(change);
  assert.equal(api.deliveries.length, 1);
  assert.equal(api.outbox()[0].last_failure, "inactive");
});

test("nonmatching events, expired subscribers and pre-subscription records produce no outbox event", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  await api.prepareChangeRequestEvent(api.change({ eventId: "different" }));
  await api.prepareChangeRequestEvent(api.change({ createdAt: "2020-01-01T00:00:00Z" }));
  api.db.prepare("UPDATE cue_event_subscription SET expires_at = '2020-01-01T00:00:00Z'").run();
  await api.prepareChangeRequestEvent(api.change());
  assert.deepEqual(api.outbox(), []);
  assert.deepEqual(api.deliveries, []);
});

test("tool reads and proposal publication never emit change-request feedback events", async () => {
  const api = harness();
  await api.subscribeMcpEvent("owner-a", subscription());
  for (const [name, args] of [["get_event", {}], ["get_agent_context", {}], ["list_open_issues", {}], ["publish_change_proposal", { text: "sample", expectedRevision: 4, requestId: "test" }]]) await api.rpc("tools/call", { name, arguments: args });
  assert.deepEqual(api.outbox(), []);
  assert.deepEqual(api.deliveries, []);
});

test("the append-only event migration contains only indexed new tables", () => {
  const sql = readFileSync(new URL("../drizzle/0003_clumsy_marvel_apes.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `cue_event_subscription`/);
  assert.match(sql, /CREATE TABLE `cue_event_delivery`/);
  assert.match(sql, /CREATE UNIQUE INDEX `cue_event_delivery_request_subscription`/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
  const epochMigration = readFileSync(new URL("../drizzle/0004_grey_rhodey.sql", import.meta.url), "utf8");
  assert.match(epochMigration, /ADD `active_since` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL/);
  assert.doesNotMatch(epochMigration, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/);
});

test("inbox HTTP awaits durable outbox preparation before acknowledgement, while delivery uses waitUntil", async () => {
  const calls = [], pending = [], change = harness().change();
  let finishDelivery;
  const delivery = new Promise((resolve) => { finishDelivery = resolve; });
  const route = evaluate(compile("../app/api/changes/route.ts"), {
    "cloudflare:workers": { waitUntil(promise) { calls.push("waitUntil"); pending.push(promise); } },
    "@/lib/change-requests": { enqueueChangeSchema: z.any(), async enqueueChangeRequest() { calls.push("enqueue"); return { request: change, applied: false }; }, async listChangeRequests() { return { requests: [change], pendingRequests: [change], pendingCount: 1 }; } },
    "@/lib/mcp-events": { async prepareChangeRequestEvent() { await Promise.resolve(); calls.push("outbox-durable"); }, async dispatchChangeRequestEvent() { calls.push("deliver"); await delivery; }, async getEventDeliveryStatus() { return { activeSubscriptions: 1, pendingDeliveries: 1, lastDeliveredAt: null }; } },
    "@/lib/server-store": { checkBrowserOrigin() {}, async getPrivateCallerContext() {}, async readJsonBody() { return {}; }, jsonResponse(value) { calls.push("respond"); return Response.json(value); }, errorResponse(error) { throw error; } },
  });
  const response = await route.POST(new Request("https://site.test/api/changes", { method: "POST" }));
  assert.equal(response.status, 200);
  assert.ok(calls.indexOf("outbox-durable") < calls.indexOf("respond"));
  assert.ok(calls.includes("waitUntil"));
  assert.equal(pending.length, 1);
  finishDelivery();
  await Promise.all(pending);
});
