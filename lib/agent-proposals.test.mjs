import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";

// Real proposal logic with an isolated D1 double; never use live event data,
// credentials, the network, or an actual dot in unit tests.
const slot = (id) => ({ id, title: id, group: "", kind: "talk", durationMinutes: 10, changeoverMinutes: 0, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "" });
const initial = {
  event: { id: "event-a", name: "Private event", date: "2026-10-18", location: "", startTime: 840, endTime: 960, quietWindows: [] },
  slots: [slot("a"), slot("b")], history: Array.from({ length: 12 }, (_, index) => ({ id: String(index), at: "2026-10-18T00:00:00Z", title: String(index), detail: "", kind: "edit" })), revision: 4,
};
const schedule = (value) => ({ rows: value.slots.map((entry, index) => ({ ...entry, start: 840 + index * 10, end: 850 + index * 10, changeoverStart: 840 + index * 10, waitMinutes: 0, violations: [] })), endsAt: 860, contentMinutes: 20, changeoverMinutes: 0, violations: [], bufferMinutes: 100 });
const resultFor = (state, text) => ({ plans: [{ id: "minimal", title: "Minimal", description: "Feasible", slots: structuredClone(state.slots), schedule: schedule(state), changes: [], tradeoffs: [], score: 100 }], issue: { kind: "delay", minutes: 5, text }, engine: "rules", aiStatus: "not-configured", elapsedMs: 1 });
const input = { text: "全体が5分押しています", expectedRevision: 4, requestId: "request-a" };
class HttpError extends Error {
  constructor(status, message, code = "request_error") { super(message); this.status = status; this.code = code; }
}

function compile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
const compiled = compile("./agent-proposals.ts");

function evaluate(source, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), source)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}

function harness({ onPlan, beforeInsert, seed = [], state: startingState = initial } = {}) {
  let state = structuredClone(startingState);
  let ids = 0;
  const rows = structuredClone(seed);
  const sql = [];
  const plans = [];
  const reads = [];
  const db = {
    prepare(statement) {
      sql.push(statement);
      assert.doesNotMatch(statement, /\b(?:CREATE|DROP|DELETE|UPDATE)\b/i, "Agent storage must never mutate the event or erase proposal history");
      return { bind(...args) {
        return {
          async first() {
            if (statement.includes("COUNT(*) AS count")) return { count: rows.filter((row) => row.event_id === args[0]).length };
            assert.match(statement, /WHERE event_id = \? AND request_id = \?/);
            return rows.find((row) => row.event_id === args[0] && row.request_id === args[1]) ?? null;
          },
          async all() {
            assert.match(statement, /WHERE event_id = \? ORDER BY created_at DESC, id DESC LIMIT \?/);
            return { results: rows.filter((row) => row.event_id === args[0]).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)).slice(0, args[1]) };
          },
          async run() {
            assert.match(statement, /INSERT OR IGNORE INTO cue_agent_proposal/);
            assert.match(statement, /FROM cue_event_state/);
            assert.match(statement, /json_extract\(payload, '\$\.event.id'\) = \?/);
            assert.match(statement, /SELECT COUNT\(\*\) FROM cue_agent_proposal WHERE event_id = \?/);
            beforeInsert?.({ setState: (next) => { state = structuredClone(next); }, state: structuredClone(state), rows, args });
            const [id, event_id, request_id, base_revision, request_text, created_at, result, primary, revision, currentId, countId, capacity] = args;
            assert.equal(primary, "primary");
            assert.equal(countId, event_id);
            if (state.revision !== revision || state.event.id !== currentId || rows.some((row) => row.event_id === event_id && row.request_id === request_id) || rows.filter((row) => row.event_id === countId).length >= capacity) return { meta: { changes: 0 } };
            rows.push({ id, event_id, request_id, base_revision, request_text, created_at, result });
            return { meta: { changes: 1 } };
          },
        };
      } };
    },
  };
  const api = evaluate(compiled, {
    "cloudflare:workers": { env: { DB: db } },
    zod: { z },
    "@/lib/decisions": { async proposePlans(value, text) {
      plans.push([structuredClone(value), text]);
      const result = await onPlan?.({ state: value, text, setState: (next) => { state = structuredClone(next); } });
      return result ?? resultFor(value, text);
    } },
    "@/lib/planner": { computeSchedule: schedule },
    "@/lib/server-store": { HttpError, async getEventState() { reads.push(state.revision); return structuredClone(state); } },
  }, { crypto: { randomUUID: () => `proposal-${++ids}` } });
  return { ...api, rows, sql, plans, reads, getState: () => structuredClone(state), setState(next) { state = structuredClone(next); } };
}

const isCode = (code, status) => (error) => error instanceof HttpError && error.code === code && (status === undefined || error.status === status);

test("an agent publishes a validated proposal without updating the actual event", async () => {
  const api = harness();
  const original = api.getState();
  const response = await api.publishAgentProposal(input);
  assert.equal(response.applied, false);
  assert.equal(response.proposal.eventId, initial.event.id);
  assert.equal(response.proposal.baseRevision, 4);
  assert.equal(response.proposal.text, input.text);
  assert.deepEqual(response.proposal.result, resultFor(initial, input.text));
  assert.equal(api.rows.length, 1);
  assert.deepEqual(api.getState(), original);
  assert.equal(api.plans.length, 1);
  assert.deepEqual(api.reads, [4, 4]);
});

test("identical retries reuse the saved result even after the event advances", async () => {
  const api = harness();
  const first = await api.publishAgentProposal(input);
  api.setState({ ...initial, revision: 5 });
  const retry = await api.publishAgentProposal({ ...input, text: ` ${input.text} `, requestId: ` ${input.requestId} ` });
  assert.deepEqual(retry.proposal, first.proposal);
  assert.equal(retry.replayed, true);
  assert.equal(retry.applied, false);
  assert.equal(api.rows.length, 1);
  assert.equal(api.plans.length, 1);
});

for (const difference of [{ text: "全体が10分押しています" }, { expectedRevision: 5 }]) {
  test(`reusing a request ID with ${Object.keys(difference)[0]} changed is a conflict`, async () => {
    const api = harness();
    await api.publishAgentProposal(input);
    await assert.rejects(api.publishAgentProposal({ ...input, ...difference }), isCode("proposal_request_conflict", 409));
    assert.equal(api.rows.length, 1);
    assert.equal(api.plans.length, 1);
  });
}

test("a stale starting revision never invokes planning", async () => {
  const api = harness();
  await assert.rejects(api.publishAgentProposal({ ...input, expectedRevision: 3 }), isCode("proposal_revision_conflict", 409));
  assert.equal(api.plans.length, 0);
  assert.equal(api.rows.length, 0);
});

for (const change of [{ revision: 5 }, { event: { ...initial.event, id: "event-b" } }]) {
  test(`an event ${Object.keys(change)[0]} change while planning prevents storage`, async () => {
    const api = harness({ onPlan: ({ setState }) => { setState({ ...initial, ...change }); } });
    await assert.rejects(api.publishAgentProposal(input), isCode("proposal_revision_conflict", 409));
    assert.equal(api.rows.length, 0);
  });
}

test("the atomic INSERT guards a revision race after the post-await read", async () => {
  const api = harness({ beforeInsert: ({ setState }) => setState({ ...initial, revision: 5 }) });
  await assert.rejects(api.publishAgentProposal(input), isCode("proposal_revision_conflict", 409));
  assert.equal(api.rows.length, 0);
});

test("concurrent identical requests leave one stored card with one replay", async () => {
  let waiting = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const api = harness({ async onPlan() { if (++waiting === 2) release(); await barrier; } });
  const values = await Promise.all([api.publishAgentProposal(input), api.publishAgentProposal(input)]);
  assert.equal(api.rows.length, 1);
  assert.deepEqual(values[0].proposal, values[1].proposal);
  assert.equal(values.filter((value) => value.replayed).length, 1);
});

test("a late duplicate replays the already-saved result after the organizer advances the event", async () => {
  let api;
  api = harness({ onPlan: ({ setState }) => {
    api.rows.push({ ...stored(0), request_id: input.requestId });
    setState({ ...initial, revision: 5 });
  } });
  const response = await api.publishAgentProposal(input);
  assert.equal(response.replayed, true);
  assert.equal(response.proposal.id, stored(0).id);
  assert.equal(api.rows.length, 1);
});

test("same request IDs in another event are isolated and do not expose old cards", async () => {
  const api = harness();
  await api.publishAgentProposal(input);
  api.setState({ ...initial, event: { ...initial.event, id: "event-b" } });
  assert.deepEqual(await api.listAgentProposals("event-b"), []);
  const second = await api.publishAgentProposal(input);
  assert.equal(second.proposal.eventId, "event-b");
  assert.equal(api.rows.length, 2);
  const context = await api.getAgentContext();
  assert.equal(context.proposals.length, 1);
  assert.equal(context.proposals[0].eventId, "event-b");
});

test("agent context provides recent history and explicit proposal-only boundaries", async () => {
  const api = harness();
  const context = await api.getAgentContext();
  assert.equal(context.revision, 4);
  assert.deepEqual(context.recentHistory, initial.history.slice(0, 10));
  assert.equal(context.boundaries.proposalOnly, true);
  assert.equal(context.boundaries.appliesAutomatically, false);
  assert.equal(context.boundaries.identityVerified, false);
  assert.equal(context.boundaries.maxProposalsPerEvent, 100);
  assert.deepEqual(api.getState(), initial);
});

for (const invalid of [null, {}, { ...input, text: " " }, { ...input, text: "a".repeat(2001) }, { ...input, requestId: " " }, { ...input, requestId: "a".repeat(121) }, { ...input, expectedRevision: -1 }, { ...input, expectedRevision: 1.5 }, { ...input, expectedRevision: Number.MAX_SAFE_INTEGER }, { ...input, extra: true }]) {
  test(`invalid publish input is rejected before database or planning: ${JSON.stringify(invalid)?.slice(0, 75)}`, async () => {
    const api = harness();
    await assert.rejects(api.publishAgentProposal(invalid), isCode("invalid_proposal", 422));
    assert.deepEqual(api.sql, []);
    assert.deepEqual(api.plans, []);
  });
}

function stored(index, eventId = "event-a") {
  return { id: `saved-${String(index).padStart(3, "0")}`, event_id: eventId, request_id: `saved-request-${index}`, base_revision: 4, request_text: input.text, created_at: new Date(Date.UTC(2026, 9, 18, 0, 0, index)).toISOString(), result: JSON.stringify(resultFor(initial, input.text)) };
}

test("only the latest five current-event proposals are returned by default, with a bounded optional limit", async () => {
  const api = harness({ seed: [...Array.from({ length: 30 }, (_, index) => stored(index)), stored(90, "foreign-event")] });
  assert.deepEqual((await api.listAgentProposals("event-a")).map((value) => value.id), [29, 28, 27, 26, 25].map((index) => stored(index).id));
  assert.equal((await api.listAgentProposals("event-a", 5000)).length, 20);
  assert.equal((await api.listAgentProposals("event-a", -1)).length, 1);
});

test("the 100-proposal cap rejects new work without pruning data or losing retry idempotency", async () => {
  const api = harness({ seed: Array.from({ length: 100 }, (_, index) => stored(index)) });
  await assert.rejects(api.publishAgentProposal(input), isCode("proposal_capacity", 409));
  assert.equal(api.plans.length, 0);
  assert.equal(api.rows.length, 100);
  const existing = await api.publishAgentProposal({ ...input, requestId: "saved-request-0" });
  assert.equal(existing.replayed, true);
  assert.equal(api.rows.length, 100);
});

test("the 100-proposal cap is atomic for concurrent inserts", async () => {
  const api = harness({ seed: Array.from({ length: 99 }, (_, index) => stored(index)), beforeInsert: ({ rows }) => rows.push(stored(99)) });
  await assert.rejects(api.publishAgentProposal(input), isCode("proposal_capacity", 409));
  assert.equal(api.rows.length, 100);
});

test("invalid stored JSON fails safely rather than exposing raw storage content", async () => {
  const api = harness({ seed: [{ ...stored(0), result: "private-corrupt-storage" }] });
  await assert.rejects(api.listAgentProposals("event-a"), (error) => isCode("proposal_storage_invalid", 503)(error) && !error.message.includes("private-corrupt-storage"));
});

test("large computed results are rejected before inserting a D1 row", async () => {
  const api = harness({ onPlan({ state, text }) {
    const largeState = { ...state, slots: Array.from({ length: 80 }, (_, index) => ({ ...slot(String(index)), notes: "n".repeat(2000), people: Array.from({ length: 30 }, () => "p".repeat(160)), equipment: Array.from({ length: 30 }, () => "e".repeat(160)) })) };
    const result = resultFor(largeState, text);
    result.plans = Array.from({ length: 3 }, (_, index) => ({ ...result.plans[0], id: `large-${index}` }));
    return result;
  } });
  await assert.rejects(api.publishAgentProposal(input), isCode("proposal_too_large", 413));
  assert.equal(api.rows.length, 0);
});

test("migration creates only the separate indexed proposal table", () => {
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  const migration = readFileSync(new URL(`../drizzle/${journal.entries.at(-1).tag}.sql`, import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `cue_agent_proposal`/);
  assert.match(migration, /CREATE UNIQUE INDEX `cue_agent_proposal_event_request`/);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|ALTER|UPDATE)\b/);
});

test("MCP exposes the original read-only tools and labels proposal publication as a non-destructive write", async () => {
  const server = { checkBrowserOrigin() {}, async getPrivateCallerContext() {}, HttpError, jsonResponse: (value, status = 200) => Response.json(value, { status }), async readJsonBody(request, schema) { return schema.parse(await request.json()); }, async getEventState() { return initial; } };
  const proposals = [];
  const route = evaluate(compile("../app/mcp/route.ts"), {
    zod: { z }, "@/lib/decisions": { proposePlans: async (state, text) => resultFor(state, text) }, "@/lib/planner": { computeSchedule: schedule }, "@/lib/server-store": server,
    "@/lib/agent-proposals": { getAgentContext: async () => ({ revision: 4 }), publishAgentProposal: async (value) => { proposals.push(value); return { proposal: { id: "new" }, applied: false }; } },
  });
  const rpc = (method, params) => route.POST(new Request("https://private.test/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }));
  const tools = (await (await rpc("tools/list")).json()).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["get_event", "list_open_issues", "propose_change", "get_agent_context", "publish_change_proposal"]);
  assert.ok(tools.slice(0, 4).every((tool) => tool.annotations.readOnlyHint));
  assert.equal(tools.at(-1).annotations.readOnlyHint, false);
  assert.equal(tools.at(-1).annotations.destructiveHint, false);
  const response = await (await rpc("tools/call", { name: "publish_change_proposal", arguments: input })).json();
  assert.deepEqual(proposals, [input]);
  assert.equal(JSON.parse(response.result.content[0].text).applied, false);
});

test("browser agent endpoint authenticates before listing only the current event", async () => {
  const calls = [];
  const route = evaluate(compile("../app/api/agent/route.ts"), {
    "@/lib/agent-proposals": { async listAgentProposals(eventId) { calls.push(["list", eventId]); return [{ createdAt: "2026-10-18T00:00:00Z" }]; } },
    "@/lib/server-store": { async getPrivateCallerContext() { calls.push(["auth"]); }, async getEventState() { calls.push(["state"]); return initial; }, jsonResponse: Response.json.bind(Response), errorResponse(error) { throw error; } },
  });
  assert.deepEqual(await (await route.GET()).json(), { proposals: [{ createdAt: "2026-10-18T00:00:00Z" }], latestContactAt: "2026-10-18T00:00:00Z" });
  assert.deepEqual(calls, [["auth"], ["state"], ["list", "event-a"]]);
  assert.equal(typeof route.POST, "function");
});

function agentPostHarness({ authError = false, writerError = false } = {}) {
  const service = harness();
  const calls = [];
  const logs = [];
  const store = evaluate(compile("./server-store.ts"), {
    "cloudflare:workers": { env: {} }, zod: { z },
    "@/app/chatgpt-auth": { async getChatGPTUser() { return null; } },
    "@/lib/demo": { demoState: initial },
  }, { console: { error: (...args) => logs.push(args) } });
  const route = evaluate(compile("../app/api/agent/route.ts"), {
    "@/lib/agent-proposals": {
      publishProposalSchema: service.publishProposalSchema,
      async publishAgentProposal(body) {
        calls.push(["publish", body]);
        if (writerError) throw new Error("private-error-body-sentinel");
        return service.publishAgentProposal(body);
      },
      listAgentProposals() { assert.fail("POST must not delegate to the reader"); },
    },
    "@/lib/server-store": {
      checkBrowserOrigin(request) { calls.push(["origin"]); return store.checkBrowserOrigin(request); },
      async getPrivateCallerContext() { calls.push(["auth"]); if (authError) throw new store.HttpError(403, "認可されていません。", "forbidden"); return { callerKind: "platform-service-or-preview" }; },
      async readJsonBody(request, schema, limit) { calls.push(["body", limit]); return store.readJsonBody(request, schema, limit); },
      jsonResponse: store.jsonResponse,
      errorResponse(error) { calls.push(["error"]); return store.errorResponse(error); },
      getEventState() { assert.fail("POST must not write or load event state outside the shared proposal writer"); },
    },
  });
  return { ...route, service, calls, logs };
}

function postRequest(value = input, headers = {}) {
  return new Request("https://private.test/api/agent", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) });
}

test("agent POST checks origin then authentication then a strict 32 KiB schema before the shared proposal-only writer", async () => {
  const api = agentPostHarness();
  const original = api.service.getState();
  const response = await api.POST(postRequest({ ...input, text: ` ${input.text} ` }));
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.applied, false);
  assert.equal(value.proposal.baseRevision, 4);
  assert.equal(value.proposal.text, input.text);
  assert.deepEqual(api.calls, [["origin"], ["auth"], ["body", 32 * 1024], ["publish", input]]);
  assert.deepEqual(api.service.getState(), original);
  assert.equal(api.service.rows.length, 1);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

for (const headers of [{ Origin: "https://untrusted.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
  test(`agent POST rejects a cross-site browser before authentication or reading the body: ${Object.keys(headers)[0]}`, async () => {
    const api = agentPostHarness();
    const response = await api.POST(postRequest(input, headers));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "origin_rejected");
    assert.deepEqual(api.calls, [["origin"], ["error"]]);
    assert.equal(api.service.rows.length, 0);
    assert.equal(api.service.plans.length, 0);
  });
}

test("agent POST authentication failure prevents body parsing, planning, and proposal writes", async () => {
  const api = agentPostHarness({ authError: true });
  const response = await api.POST(postRequest());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "forbidden");
  assert.deepEqual(api.calls, [["origin"], ["auth"], ["error"]]);
  assert.equal(api.service.rows.length, 0);
  assert.equal(api.service.plans.length, 0);
});

for (const [label, value, headers, expectedStatus, expectedCode] of [
  ["extra caller-supplied plans", { ...input, result: resultFor(initial, input.text) }, {}, 422, "invalid_payload"],
  ["negative revision", { ...input, expectedRevision: -1 }, {}, 422, "invalid_payload"],
  ["blank request ID", { ...input, requestId: " " }, {}, 422, "invalid_payload"],
  ["non-JSON content type", input, { "Content-Type": "text/plain" }, 415, "unsupported_media_type"],
  ["declared oversized body", input, { "Content-Length": String(32 * 1024 + 1) }, 413, "body_too_large"],
  ["streamed oversized body", { ...input, text: "x".repeat(32 * 1024 + 1) }, {}, 413, "body_too_large"],
]) {
  test(`agent POST rejects ${label} before proposal generation`, async () => {
    const api = agentPostHarness();
    const response = await api.POST(postRequest(value, headers));
    assert.equal(response.status, expectedStatus);
    assert.equal((await response.json()).code, expectedCode);
    assert.deepEqual(api.calls, [["origin"], ["auth"], ["body", 32 * 1024], ["error"]]);
    assert.equal(api.service.rows.length, 0);
    assert.equal(api.service.plans.length, 0);
  });
}

test("agent POST sanitizes unexpected writer failures without leaking input or error text", async () => {
  const api = agentPostHarness({ writerError: true });
  const response = await api.POST(postRequest());
  assert.equal(response.status, 500);
  const value = await response.json();
  assert.equal(value.code, "server_error");
  assert.doesNotMatch(JSON.stringify({ value, logs: api.logs }), /private-error-body-sentinel|全体が5分押しています/);
  assert.equal(api.service.rows.length, 0);
  assert.equal(api.service.plans.length, 0);
});

test("agent POST rejects malformed JSON before the proposal-only writer", async () => {
  const api = agentPostHarness();
  const response = await api.POST(new Request("https://private.test/api/agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{not-json" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_json");
  assert.deepEqual(api.calls, [["origin"], ["auth"], ["body", 32 * 1024], ["error"]]);
  assert.equal(api.service.rows.length, 0);
  assert.equal(api.service.plans.length, 0);
});
