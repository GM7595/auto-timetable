import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

// Execute generated migrations and actual queue/proposal SQL in isolated
// in-memory SQLite. No network, credential, live event, or dot is involved.
const slot = { id: "a", title: "Talk", group: "", kind: "talk", durationMinutes: 10, changeoverMinutes: 0, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "" };
const initial = { event: { id: "event-a", name: "Private", date: "2026-10-18", location: "", startTime: 840, endTime: 960, quietWindows: [] }, slots: [slot], history: [], revision: 4 };
const schedule = (state) => ({ rows: state.slots.map((entry) => ({ ...entry, start: 840, end: 850, changeoverStart: 840, waitMinutes: 0, violations: [] })), endsAt: 850, contentMinutes: 10, changeoverMinutes: 0, violations: [], bufferMinutes: 110 });
const resultFor = (state, text, aiStatus = "used") => ({ plans: [{ id: "minimal", title: "Minimal", description: "Feasible", slots: state.slots, schedule: schedule(state), changes: [], tradeoffs: [], score: 100 }], issue: { kind: "shorten", minutes: 5, text }, engine: aiStatus === "used" ? "decisions" : "rules", aiStatus, elapsedMs: 1 });
const input = () => ({ text: "全体を5分短縮", expectedRevision: 4, requestId: randomUUID() });
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const isCode = (code, status) => (error) => error instanceof HttpError && error.code === code && (status === undefined || status === error.status);
function compile(path) { return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText; }
function evaluate(source, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", ...Object.keys(globals), source)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, () => assert.fail("Queue must not make extra network requests"), ...Object.values(globals));
  return module.exports;
}
const queueSource = compile("./change-requests.ts");
const proposalSource = compile("./agent-proposals.ts");
function harness({ onPlan, beforeWrite, databaseUnavailable = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  let state = structuredClone(initial);
  const syncState = () => db.prepare("INSERT OR REPLACE INTO cue_event_state (id, revision, payload, updated_at) VALUES ('primary', ?, ?, '2026-10-18T00:00:00Z')").run(state.revision, JSON.stringify(state));
  syncState();
  const sql = [], plans = [];
  const adapter = { prepare(statement) {
    sql.push(statement);
    assert.doesNotMatch(statement, /\b(?:CREATE|DROP|DELETE|UPDATE|REPLACE)\b/i, "Queue/proposal runtime is append-only and must never mutate the event");
    return { bind(...args) { return {
      async first() { return db.prepare(statement).get(...args) ?? null; },
      async all() { return { results: db.prepare(statement).all(...args) }; },
      async run() { await beforeWrite?.({ statement, state: structuredClone(state), setState, db }); const result = db.prepare(statement).run(...args); return { meta: { changes: Number(result.changes) } }; },
    }; } };
  } };
  function setState(next) { state = structuredClone(next); syncState(); }
  const store = { HttpError, async getEventState() { return structuredClone(state); } };
  const env = { DB: databaseUnavailable ? undefined : adapter };
  const sharedSchema = evaluate(compile("./planning-result-schema.ts"), { zod: { z } });
  const queue = evaluate(queueSource, { "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store, "@/lib/planning-result-schema": sharedSchema });
  const proposals = evaluate(proposalSource, {
    "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store,
    "@/lib/change-requests": queue, "@/lib/planner": { computeSchedule: schedule },
    "@/lib/planning-result-schema": sharedSchema,
    "@/lib/decisions": { async proposePlans(value, text) { plans.push(text); return await onPlan?.({ state: value, text, setState, db }) ?? resultFor(value, text); } },
  }, { crypto: { randomUUID } });
  return { ...queue, ...proposals, db, sql, plans, setState, getState: () => structuredClone(state), queueRows: () => db.prepare("SELECT * FROM cue_change_request").all(), proposalRows: () => db.prepare("SELECT * FROM cue_agent_proposal").all() };
}

test("enqueue persists one pending request, without a plan or an event update", async () => {
  const api = harness(), value = input();
  const response = await api.enqueueChangeRequest({ ...value, text: ` ${value.text} ` });
  assert.deepEqual({ ...response.request, createdAt: undefined }, { id: value.requestId, eventId: "event-a", baseRevision: 4, text: value.text, createdAt: undefined, status: "pending", requestId: `change:${value.requestId}` });
  assert.equal(response.applied, false);
  assert.equal(api.queueRows().length, 1);
  assert.deepEqual(api.getState(), initial);
  assert.deepEqual(api.plans, []);
  assert.deepEqual(api.proposalRows(), []);
});

test("enqueue retries remain idempotent after the saved event advances", async () => {
  const api = harness(), value = input();
  const first = await api.enqueueChangeRequest(value);
  api.setState({ ...initial, revision: 5 });
  const second = await api.enqueueChangeRequest(value);
  assert.deepEqual(second.request, first.request);
  assert.equal(second.replayed, true);
  assert.equal(api.queueRows().length, 1);
});

for (const difference of [{ text: "different" }, { expectedRevision: 5 }]) {
  test(`enqueue rejects conflicting retry ${Object.keys(difference)[0]}`, async () => {
    const api = harness(), value = input();
    await api.enqueueChangeRequest(value);
    await assert.rejects(api.enqueueChangeRequest({ ...value, ...difference }), isCode("change_request_conflict", 409));
    assert.equal(api.queueRows().length, 1);
  });
}

test("a stale enqueue never writes and atomic INSERT prevents a later revision race", async () => {
  const stale = harness();
  await assert.rejects(stale.enqueueChangeRequest({ ...input(), expectedRevision: 3 }), isCode("change_revision_conflict", 409));
  assert.equal(stale.queueRows().length, 0);
  const raced = harness({ beforeWrite: ({ setState }) => setState({ ...initial, revision: 5 }) });
  await assert.rejects(raced.enqueueChangeRequest(input()), isCode("change_revision_conflict", 409));
  assert.equal(raced.queueRows().length, 0);
});

test("concurrent identical intake leaves exactly one durable request", async () => {
  const api = harness(), value = input();
  const responses = await Promise.all([api.enqueueChangeRequest(value), api.enqueueChangeRequest(value)]);
  assert.equal(api.queueRows().length, 1);
  assert.equal(responses.filter((entry) => entry.replayed).length, 1);
  assert.deepEqual(responses[0].request, responses[1].request);
});

test("queue reads, retries and deterministic proposal IDs are isolated by event", async () => {
  const api = harness(), value = input();
  await api.enqueueChangeRequest(value);
  api.setState({ ...initial, event: { ...initial.event, id: "event-b" } });
  assert.deepEqual(await api.listChangeRequests("event-b"), { requests: [], pendingRequests: [], pendingCount: 0 });
  await assert.rejects(api.enqueueChangeRequest(value), isCode("change_request_conflict", 409));
  await assert.rejects(api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` }), isCode("change_request_mismatch", 409));
  assert.equal(api.plans.length, 0);
  assert.equal(api.queueRows().length, 1);
});

for (const invalid of [null, {}, { ...input(), text: " " }, { ...input(), text: "x".repeat(2001) }, { ...input(), requestId: "not-a-uuid" }, { ...input(), expectedRevision: -1 }, { ...input(), expectedRevision: 1.2 }, { ...input(), expectedRevision: Number.MAX_SAFE_INTEGER }, { ...input(), status: "proposed" }]) {
  test(`strict invalid enqueue is rejected before storage: ${JSON.stringify(invalid)?.slice(0, 60)}`, async () => {
    const api = harness();
    await assert.rejects(api.enqueueChangeRequest(invalid), isCode("invalid_change_request", 422));
    assert.deepEqual(api.sql, []);
  });
}

test("the 100-per-event cap is bounded, append-only, and preserves existing retries", async () => {
  const api = harness(), first = input();
  await api.enqueueChangeRequest(first);
  for (let index = 1; index < 100; index++) await api.enqueueChangeRequest({ ...input(), text: String(index) });
  await assert.rejects(api.enqueueChangeRequest(input()), isCode("change_capacity", 409));
  assert.equal((await api.enqueueChangeRequest(first)).replayed, true);
  const list = await api.listChangeRequests("event-a");
  assert.equal(list.requests.length, 20);
  assert.equal(list.pendingCount, 100);
  assert.equal((await api.listPendingChangeRequests("event-a")).length, 100);
  assert.equal(api.queueRows().length, 100);
});

test("the intake cap is atomic when another request fills the final slot", async () => {
  let inserted = false;
  const api = harness({ beforeWrite: ({ db }) => {
    if (!inserted && db.prepare("SELECT COUNT(*) AS count FROM cue_change_request").get().count === 99) {
      inserted = true;
      db.prepare("INSERT INTO cue_change_request VALUES (?, 'event-a', 4, 'raced', '2026-10-18T00:00:00Z')").run(randomUUID());
    }
  } });
  for (let index = 0; index < 99; index++) await api.enqueueChangeRequest(input());
  await assert.rejects(api.enqueueChangeRequest(input()), isCode("change_capacity", 409));
  assert.equal(api.queueRows().length, 100);
});

test("successful queued publication acknowledges exactly one request without changing the event", async () => {
  const api = harness(), value = input();
  await api.enqueueChangeRequest(value);
  const queued = (await api.getAgentContext()).pendingChangeRequests;
  assert.equal(queued.length, 1);
  const publish = { text: queued[0].text, requestId: queued[0].requestId, expectedRevision: 4 };
  const response = await api.publishAgentProposal(publish);
  assert.equal(response.applied, false);
  assert.deepEqual(api.getState(), initial);
  assert.equal(api.proposalRows().length, 1);
  assert.deepEqual(await api.listPendingChangeRequests("event-a"), []);
  const list = await api.listChangeRequests("event-a");
  assert.equal(list.pendingCount, 0);
  assert.equal(list.requests[0].status, "proposed");
  assert.equal(list.requests[0].proposalId, response.proposal.id);
  assert.equal((await api.publishAgentProposal(publish)).replayed, true);
  assert.equal(api.plans.length, 1);
});

test("older intake uses the latest revision, and a successful replay survives a later revision", async () => {
  const api = harness(), value = input();
  await api.enqueueChangeRequest(value);
  api.setState({ ...initial, revision: 5 });
  const publish = { text: value.text, requestId: `change:${value.requestId}`, expectedRevision: 5 };
  await api.publishAgentProposal(publish);
  api.setState({ ...initial, revision: 6 });
  assert.equal((await api.publishAgentProposal(publish)).replayed, true);
  assert.equal((await api.listChangeRequests("event-a")).pendingCount, 0);
  assert.equal(api.plans.length, 1);
});

test("pendingRequests includes old items outside the latest twenty proposed records", async () => {
  const api = harness(), older = input();
  await api.enqueueChangeRequest(older);
  api.db.prepare("UPDATE cue_change_request SET created_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(older.requestId);
  for (let index = 0; index < 21; index++) {
    const value = input();
    await api.enqueueChangeRequest(value);
    await api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` });
  }
  const response = await api.listChangeRequests("event-a");
  assert.equal(response.requests.length, 20);
  assert.ok(response.requests.every((entry) => entry.status === "proposed"));
  assert.equal(response.pendingCount, 1);
  assert.equal(response.pendingRequests[0].id, older.requestId);
});

for (const corrupt of ["not-json", JSON.stringify({ aiStatus: "used" }), JSON.stringify({ ...resultFor(initial, "data"), plans: [] })]) {
  test(`corrupt saved proposals never acknowledge intake: ${corrupt.slice(0, 35)}`, async () => {
    const api = harness(), value = input();
    await api.enqueueChangeRequest(value);
    api.db.prepare("INSERT INTO cue_agent_proposal VALUES ('bad', 'event-a', ?, 4, ?, '2026-10-18T00:00:00Z', ?)").run(`change:${value.requestId}`, value.text, corrupt);
    assert.equal((await api.listChangeRequests("event-a")).pendingCount, 1);
    assert.equal((await api.listPendingChangeRequests("event-a")).length, 1);
  });
}

for (const variant of ["wrong text", "unknown id", "invalid uuid", "before intake revision"]) {
  test(`queue request IDs cannot acknowledge ${variant}`, async () => {
    const api = harness(), value = input();
    await api.enqueueChangeRequest(value);
    const publish = { text: value.text, requestId: `change:${value.requestId}`, expectedRevision: 4 };
    if (variant === "wrong text") publish.text = "unrelated change";
    if (variant === "unknown id") publish.requestId = `change:${randomUUID()}`;
    if (variant === "invalid uuid") publish.requestId = "change:invalid";
    if (variant === "before intake revision") publish.expectedRevision = 3;
    await assert.rejects(api.publishAgentProposal(publish), isCode("change_request_mismatch", 409));
    assert.equal(api.plans.length, 0);
    assert.equal((await api.listChangeRequests("event-a")).pendingCount, 1);
  });
}

for (const aiStatus of ["fallback", "not-configured"]) {
  test(`queued ${aiStatus} remains pending without a misleading saved recommendation`, async () => {
    const api = harness({ onPlan: ({ state, text }) => resultFor(state, text, aiStatus) }), value = input();
    await api.enqueueChangeRequest(value);
    await assert.rejects(api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` }), isCode("change_comparison_unavailable", 503));
    assert.equal(api.proposalRows().length, 0);
    assert.equal((await api.listChangeRequests("event-a")).pendingCount, 1);
  });
}

test("a single feasible candidate explicitly marked not-needed can be saved without pretending API usage", async () => {
  const api = harness({ onPlan: ({ state, text }) => resultFor(state, text, "not-needed") }), value = input();
  await api.enqueueChangeRequest(value);
  const response = await api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` });
  assert.equal(response.proposal.result.aiStatus, "not-needed");
  assert.equal((await api.listChangeRequests("event-a")).pendingCount, 0);
});

test("queued result size is capped at 256KiB while ordinary proposal capacity remains 1MiB", async () => {
  const api = harness({ onPlan: ({ state, text }) => resultFor({ ...state, slots: Array.from({ length: 80 }, (_, index) => ({ ...slot, id: `slot-${index}`, notes: "n".repeat(2000) })) }, text) });
  const value = input();
  await api.enqueueChangeRequest(value);
  await assert.rejects(api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` }), isCode("proposal_too_large", 413));
  assert.equal((await api.listChangeRequests("event-a")).pendingCount, 1);
  const regular = await api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: "ordinary-large" });
  assert.equal(regular.proposal.result.plans[0].slots.length, 80);
});

test("a revision race during queued comparison leaves intake pending and retryable", async () => {
  const api = harness({ onPlan: ({ setState }) => setState({ ...initial, revision: 5 }) }), value = input();
  await api.enqueueChangeRequest(value);
  await assert.rejects(api.publishAgentProposal({ text: value.text, expectedRevision: 4, requestId: `change:${value.requestId}` }), isCode("proposal_revision_conflict", 409));
  assert.equal(api.proposalRows().length, 0);
  assert.equal((await api.listChangeRequests("event-a")).pendingCount, 1);
});

test("empty inbox context does not plan, publish or insert a queue record", async () => {
  const api = harness();
  assert.deepEqual((await api.getAgentContext()).pendingChangeRequests, []);
  assert.deepEqual(api.plans, []);
  assert.deepEqual(api.queueRows(), []);
  assert.deepEqual(api.proposalRows(), []);
  assert.ok(api.sql.every((statement) => /^SELECT/.test(statement)));
});

test("both original get_event and added context expose the same pending inbox without writes or comparison", async () => {
  const api = harness(), value = input();
  await api.enqueueChangeRequest(value);
  api.sql.length = 0;
  const route = evaluate(compile("../app/mcp/route.ts"), {
    zod: { z },
    "@/lib/change-requests": api,
    "@/lib/mcp-events": {},
    "@/lib/agent-proposals": api,
    "@/lib/decisions": { proposePlans() { assert.fail("Reading inbox must not call the API"); } },
    "@/lib/planner": { computeSchedule: schedule },
    "@/lib/proposal-review-link": { createProposalReviewUrl() { assert.fail("Readers must not manufacture links or plans"); } },
    "@/lib/server-store": {
      HttpError, checkBrowserOrigin() {}, async getPrivateCallerContext() {},
      async readJsonBody(request, schema) { return schema.parse(await request.json()); },
      async getEventState() { return api.getState(); }, jsonResponse: Response.json.bind(Response),
    },
  });
  const results = [];
  for (const name of ["get_event", "get_agent_context"]) {
    const response = await route.POST(new Request("https://private.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) }));
    results.push(JSON.parse((await response.json()).result.content[0].text));
  }
  assert.deepEqual(results[0].pendingChangeRequests, results[1].pendingChangeRequests);
  assert.equal(results[0].pendingChangeRequests[0].id, value.requestId);
  assert.ok(api.sql.every((statement) => /^SELECT/.test(statement)));
  assert.deepEqual(api.plans, []);
  assert.deepEqual(api.getState(), initial);
});

test("the new generated migration is schema-only and leaves historical migrations intact", () => {
  const sql = readFileSync(new URL("../drizzle/0002_clear_famine.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `cue_change_request`/);
  assert.match(sql, /CREATE INDEX `cue_change_request_event_created`/);
  assert.doesNotMatch(sql, /\b(?:ALTER|DROP|DELETE|UPDATE|INSERT)\b/);
});

function routeHarness({ authError = false, writerError = false, onList } = {}) {
  const service = harness(), calls = [], logs = [], deliveryEventIds = [];
  const store = evaluate(compile("./server-store.ts"), { "cloudflare:workers": { env: {} }, zod: { z }, "@/app/chatgpt-auth": { async getChatGPTUser() { return null; } }, "@/lib/demo": { demoState: initial } }, { console: { error: (...args) => logs.push(args) } });
  const route = evaluate(compile("../app/api/changes/route.ts"), {
    "cloudflare:workers": { waitUntil(promise) { void promise; } },
    "@/lib/mcp-events": { async prepareChangeRequestEvent() {}, async dispatchChangeRequestEvent() {}, async getEventDeliveryStatus(eventId) { deliveryEventIds.push(eventId); return { activeSubscriptions: 0, pendingDeliveries: 0, lastDeliveredAt: null, lastFailure: null }; } },
    "@/lib/change-requests": {
      enqueueChangeSchema: service.enqueueChangeSchema,
      async enqueueChangeRequest(body) { calls.push(["enqueue", body]); if (writerError) throw new Error("private-writer-error"); return service.enqueueChangeRequest(body); },
      async listChangeRequests(eventId) { calls.push(["list", eventId]); const result = await service.listChangeRequests(eventId); onList?.({ eventId, service }); return result; },
    },
    "@/lib/server-store": {
      checkBrowserOrigin(request) { calls.push(["origin"]); return store.checkBrowserOrigin(request); },
      async getPrivateCallerContext() { calls.push(["auth"]); if (authError) throw new store.HttpError(403, "認可されていません。", "forbidden"); },
      async getEventState() { calls.push(["state"]); return service.getState(); },
      async readJsonBody(request, schema, maxBytes) { calls.push(["body", maxBytes]); return store.readJsonBody(request, schema, maxBytes); },
      jsonResponse: store.jsonResponse, errorResponse: store.errorResponse,
    },
  });
  return { ...route, service, calls, logs, deliveryEventIds };
}
const request = (value = input(), headers = {}) => new Request("https://private.test/api/changes", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });

test("changes endpoint authenticates GET and lists only the saved current event", async () => {
  const api = routeHarness();
  const response = await api.GET();
  assert.deepEqual(await response.json(), { requests: [], pendingRequests: [], pendingCount: 0, eventId: "event-a", events: { activeSubscriptions: 0, pendingDeliveries: 0, lastDeliveredAt: null, lastFailure: null } });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(api.calls, [["auth"], ["state"], ["list", "event-a"]]);
});

test("changes POST checks origin, auth, then strict 32 KiB body before enqueue", async () => {
  const api = routeHarness(), value = input();
  const response = await api.POST(request(value));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.applied, false);
  assert.equal(body.eventId, body.request.eventId);
  assert.equal(body.eventId, "event-a");
  assert.deepEqual(api.calls, [["origin"], ["auth"], ["body", 32 * 1024], ["enqueue", value], ["list", "event-a"]]);
  assert.deepEqual(api.service.plans, []);
  assert.deepEqual(api.service.getState(), initial);
});

test("changes GET labels empty inbox and subscription metadata with the event actually read", async () => {
  const api = routeHarness();
  api.service.setState({ ...initial, event: { ...initial.event, id: "event-b" }, revision: 5 });
  const body = await (await api.GET()).json();
  assert.equal(body.eventId, "event-b");
  assert.deepEqual(body.requests, []);
  assert.deepEqual(api.deliveryEventIds, ["event-b"]);
});

for (const method of ["GET", "POST"]) {
  test(`changes ${method} metadata retains its event identity if the shared active event changes mid-response`, async () => {
    const api = routeHarness({ onList({ service }) { service.setState({ ...initial, event: { ...initial.event, id: "event-b" }, revision: 5 }); } });
    const response = method === "GET" ? await api.GET() : await api.POST(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(api.service.getState().event.id, "event-b");
    assert.equal(body.eventId, "event-a");
    assert.deepEqual(api.deliveryEventIds, ["event-a"]);
    if (method === "POST") {
      assert.equal(body.request.eventId, body.eventId);
      assert.ok(body.requests.every(entry => entry.eventId === body.eventId));
    }
  });
}

test("HTTP retries return the persisted pending count instead of incrementing it", async () => {
  const api = routeHarness(), value = input();
  const first = await (await api.POST(request(value))).json();
  const second = await (await api.POST(request(value))).json();
  assert.equal(first.pendingCount, 1);
  assert.equal(second.pendingCount, 1);
  assert.equal(second.pendingRequests.length, 1);
  assert.equal(second.replayed, true);
});

for (const headers of [{ Origin: "https://untrusted.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
  test(`changes POST rejects cross-site ${Object.keys(headers)[0]} before auth/body`, async () => {
    const api = routeHarness(), response = await api.POST(request(input(), headers));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "origin_rejected");
    assert.deepEqual(api.calls, [["origin"]]);
    assert.deepEqual(api.service.queueRows(), []);
  });
}

test("changes auth rejection prevents all body, database and planner work", async () => {
  const api = routeHarness({ authError: true });
  assert.equal((await api.POST(request())).status, 403);
  assert.deepEqual(api.calls, [["origin"], ["auth"]]);
  assert.deepEqual(api.service.sql, []);
});

for (const [label, value, headers, status, code] of [
  ["caller status", { ...input(), status: "proposed" }, {}, 422, "invalid_payload"],
  ["non-uuid id", { ...input(), requestId: "not-uuid" }, {}, 422, "invalid_payload"],
  ["text type", input(), { "Content-Type": "text/plain" }, 415, "unsupported_media_type"],
  ["declared body size", input(), { "Content-Length": String(32769) }, 413, "body_too_large"],
  ["streamed body size", { ...input(), text: "x".repeat(32769) }, {}, 413, "body_too_large"],
]) {
  test(`changes strict HTTP input rejects ${label}`, async () => {
    const api = routeHarness(), response = await api.POST(request(value, headers));
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
    assert.deepEqual(api.service.sql, []);
  });
}

test("changes HTTP rejects malformed JSON and sanitizes unexpected failures", async () => {
  const api = routeHarness();
  const malformed = await api.POST(new Request("https://private.test/api/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" }));
  assert.equal(malformed.status, 400);
  const failing = routeHarness({ writerError: true });
  const response = await failing.POST(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify({ result: await response.json(), logs: failing.logs }), /private-writer-error|全体を5分短縮/);
});
