import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { z } from "zod";

// Real generated schema and SQLite statements, isolated from hosted data/API.
const slot = { id: "a", title: "Talk", group: "", kind: "talk", durationMinutes: 10, changeoverMinutes: 0, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "" };
const initial = { event: { id: "event-a", name: "Private", date: "2026-10-18", location: "", startTime: 840, endTime: 960, quietWindows: [] }, slots: [slot], history: [], revision: 4 };
const schedule = state => ({ rows: state.slots.map(entry => ({ ...entry, start: 840, end: 850, changeoverStart: 840, waitMinutes: 0, violations: [] })), endsAt: 850, contentMinutes: 10, changeoverMinutes: 0, violations: [], bufferMinutes: 110 });
const resultFor = (state, text) => ({ plans: [{ id: "minimal", title: "Minimal", description: `Revision ${state.revision}`, slots: state.slots, schedule: schedule(state), changes: [], tradeoffs: [], score: 100 }], issue: { kind: "shorten", minutes: 5, text }, engine: "decisions", aiStatus: "used", elapsedMs: 1 });
const input = { text: "全体を5分短縮", expectedRevision: 4, requestId: "test-request" };
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const isCode = (code, status) => error => error instanceof HttpError && error.code === code && (status === undefined || error.status === status);
function compile(path) { return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText; }
function evaluate(source, dependencies, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), source)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, ...Object.values(globals));
  return module.exports;
}
function harness({ onPlan, beforeWrite } = {}) {
  const db = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  let state = structuredClone(initial);
  const directState = () => db.prepare("INSERT OR REPLACE INTO cue_event_state VALUES ('primary', ?, ?, '2026-10-18T00:00:00Z')").run(state.revision, JSON.stringify(state));
  const setState = next => { state = structuredClone(next); directState(); };
  directState();
  const sql = [], plans = [];
  const adapter = { prepare(statement) {
    sql.push(statement);
    assert.doesNotMatch(statement, /\b(?:UPDATE|DELETE|REPLACE)\s+(?:INTO\s+)?cue_(?:event_state|agent_proposal|change_request)\b/i, "Lifecycle must not change event or immutable receipts");
    return { bind(...args) { return {
      async first() { return db.prepare(statement).get(...args) ?? null; },
      async all() { return { results: db.prepare(statement).all(...args) }; },
      async run() { await beforeWrite?.({ statement, db, setState }); const result = db.prepare(statement).run(...args); return { meta: { changes: Number(result.changes) } }; },
    }; } };
  } };
  const env = { DB: adapter };
  const store = { HttpError, async getEventState() { return structuredClone(state); } };
  const sharedSchema = evaluate(compile("./planning-result-schema.ts"), { zod: { z } });
  const queue = evaluate(compile("./change-requests.ts"), { "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store, "@/lib/planning-result-schema": sharedSchema });
  const api = evaluate(compile("./agent-proposals.ts"), {
    "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store, "@/lib/change-requests": queue,
    "@/lib/planning-result-schema": sharedSchema, "@/lib/planner": { computeSchedule: schedule },
    "@/lib/decisions": { async proposePlans(value, text) { plans.push({ state: value, text }); return await onPlan?.({ state: value, text, db, setState }) ?? resultFor(value, text); } },
  }, { crypto: { randomUUID } });
  return { ...api, ...queue, db, sql, plans, setState, getState: () => structuredClone(state),
    originalRows: () => db.prepare("SELECT * FROM cue_agent_proposal ORDER BY id").all(), viewRows: () => db.prepare("SELECT * FROM cue_proposal_view ORDER BY proposal_id").all() };
}
const action = (proposal, kind, revision = 5) => ({ action: kind, proposalId: proposal.id, eventId: "event-a", expectedRevision: revision });

test("refresh updates one visible card in place and keeps the original receipt and event unchanged", async () => {
  const api = harness();
  const original = (await api.publishAgentProposal(input)).proposal;
  const originalRows = api.originalRows();
  api.setState({ ...initial, revision: 5, slots: [{ ...slot, title: "Updated title" }] });
  const state = api.getState();
  const refreshed = await api.updateAgentProposal(action(original, "refresh"));
  assert.equal(refreshed.applied, false);
  assert.equal(refreshed.proposal.id, original.id);
  assert.equal(refreshed.proposal.baseRevision, 5);
  assert.equal(refreshed.proposal.result.plans[0].slots[0].title, "Updated title");
  assert.ok(refreshed.proposal.updatedAt);
  assert.deepEqual(await api.listAgentProposals("event-a"), [refreshed.proposal]);
  assert.deepEqual((await api.getAgentContext()).proposals, [refreshed.proposal]);
  assert.deepEqual(api.originalRows(), originalRows);
  assert.equal(api.viewRows().length, 1);
  assert.deepEqual(api.getState(), state);
});

test("refresh retries and original request retries retain their distinct immutable contracts", async () => {
  const api = harness();
  const original = (await api.publishAgentProposal(input)).proposal;
  api.setState({ ...initial, revision: 5 });
  const refreshed = await api.updateAgentProposal(action(original, "refresh"));
  const retry = await api.updateAgentProposal(action(original, "refresh"));
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.proposal, refreshed.proposal);
  const originalReplay = await api.publishAgentProposal(input);
  assert.deepEqual(originalReplay.proposal, original);
  assert.equal(originalReplay.replayed, true);
  assert.equal(api.plans.length, 2);
  assert.equal(api.originalRows().length, 1);
});

test("dismiss persists across polling, preserves queue acknowledgement, and restore is reversible", async () => {
  const api = harness();
  const queued = await api.enqueueChangeRequest({ text: input.text, expectedRevision: 4, requestId: randomUUID() });
  const original = (await api.publishAgentProposal({ ...input, requestId: queued.request.requestId })).proposal;
  const rows = api.originalRows();
  const dismissed = await api.updateAgentProposal(action(original, "dismiss", 4));
  assert.equal(dismissed.dismissed, true);
  assert.equal(dismissed.applied, false);
  assert.deepEqual(await api.listAgentProposals("event-a"), []);
  assert.deepEqual((await api.getAgentContext()).proposals, []);
  assert.equal((await api.listChangeRequests("event-a")).pendingCount, 0);
  assert.equal((await api.updateAgentProposal(action(original, "dismiss", 4))).replayed, true);
  await assert.rejects(api.updateAgentProposal(action(original, "refresh", 4)), isCode("proposal_dismissed", 409));
  assert.deepEqual(api.originalRows(), rows);
  assert.deepEqual((await api.publishAgentProposal({ ...input, requestId: queued.request.requestId })).proposal, original);
  assert.deepEqual(await api.listAgentProposals("event-a"), [], "late original retries cannot resurrect a dismissed card");
  assert.equal((await api.updateAgentProposal(action(original, "restore", 4))).dismissed, false);
  assert.equal((await api.listAgentProposals("event-a"))[0].id, original.id);
  assert.equal((await api.updateAgentProposal(action(original, "restore", 4))).replayed, true);
  assert.deepEqual(api.getState(), initial);
});

test("refresh cannot cross event identity or revision before planning", async () => {
  const api = harness();
  const proposal = (await api.publishAgentProposal(input)).proposal;
  for (const invalid of [{ ...action(proposal, "refresh"), eventId: "event-b" }, action(proposal, "refresh", 3)]) {
    await assert.rejects(api.updateAgentProposal(invalid), isCode("proposal_lifecycle_conflict", 409));
  }
  api.setState({ ...initial, event: { ...initial.event, id: "event-b" }, revision: 5 });
  await assert.rejects(api.updateAgentProposal({ ...action(proposal, "dismiss"), eventId: "event-b" }), isCode("proposal_not_found", 404));
  assert.equal(api.plans.length, 1);
  assert.deepEqual(api.viewRows(), []);
});

for (const change of [{ revision: 6 }, { event: { ...initial.event, id: "event-b" } }]) {
  test(`a ${Object.keys(change)[0]} change during refresh prevents overlay storage`, async () => {
    let calls = 0;
    const api = harness({ onPlan({ setState }) { if (++calls > 1) setState({ ...initial, revision: 5, ...change }); } });
    const proposal = (await api.publishAgentProposal(input)).proposal;
    api.setState({ ...initial, revision: 5 });
    await assert.rejects(api.updateAgentProposal(action(proposal, "refresh")), isCode("proposal_lifecycle_conflict", 409));
    assert.deepEqual(api.viewRows(), []);
  });
}

test("atomic revision guard rejects a change after the post-comparison read", async () => {
  const api = harness({ beforeWrite({ statement, setState }) { if (statement.startsWith("INSERT INTO cue_proposal_view")) setState({ ...initial, revision: 6 }); } });
  const proposal = (await api.publishAgentProposal(input)).proposal;
  api.setState({ ...initial, revision: 5 });
  await assert.rejects(api.updateAgentProposal(action(proposal, "refresh")), isCode("proposal_lifecycle_conflict", 409));
  assert.deepEqual(api.viewRows(), []);
});

test("a dismissal during a slow refresh is never resurrected", async () => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const api = harness({ async onPlan() { if (++calls > 1) { entered(); await barrier; } } });
  const proposal = (await api.publishAgentProposal(input)).proposal;
  api.setState({ ...initial, revision: 5 });
  const refreshing = api.updateAgentProposal(action(proposal, "refresh"));
  await waiting;
  await api.updateAgentProposal(action(proposal, "dismiss"));
  release();
  await assert.rejects(refreshing, isCode("proposal_dismissed", 409));
  assert.deepEqual(await api.listAgentProposals("event-a"), []);
  assert.equal(api.viewRows()[0].base_revision, null);
});

test("concurrent refreshes have one stable overlay and return the winner without appending cards", async () => {
  let release, calls = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const api = harness({ async onPlan() { if (++calls > 1) { if (calls === 3) release(); await barrier; } } });
  const proposal = (await api.publishAgentProposal(input)).proposal;
  api.setState({ ...initial, revision: 5 });
  const values = await Promise.all([api.updateAgentProposal(action(proposal, "refresh")), api.updateAgentProposal(action(proposal, "refresh"))]);
  assert.deepEqual(values[0].proposal, values[1].proposal);
  assert.equal(values.filter(value => value.replayed).length, 1);
  assert.equal(api.originalRows().length, 1);
  assert.equal(api.viewRows().length, 1);
});

test("dismiss retries once after a concurrent refresh, retaining its result for undo", async () => {
  let injected = false;
  const api = harness({ beforeWrite({ statement, db }) {
    if (!injected && statement.startsWith("INSERT INTO cue_proposal_view")) {
      injected = true;
      db.prepare("INSERT INTO cue_proposal_view VALUES (?, 'event-a', 5, ?, '2026-10-18T12:00:00Z', NULL, 0)").run(api.originalRows()[0].id, JSON.stringify(resultFor({ ...initial, revision: 5 }, input.text)));
    }
  } });
  const proposal = (await api.publishAgentProposal(input)).proposal;
  api.setState({ ...initial, revision: 5 });
  assert.equal((await api.updateAgentProposal(action(proposal, "dismiss"))).dismissed, true);
  assert.equal(api.viewRows()[0].base_revision, 5);
  await api.updateAgentProposal(action(proposal, "restore"));
  assert.equal((await api.listAgentProposals("event-a"))[0].baseRevision, 5);
  assert.equal(api.plans.length, 1);
});

for (const invalid of [null, {}, { action: "delete", proposalId: "p", eventId: "event-a", expectedRevision: 4 }, { action: "dismiss", proposalId: "p", eventId: "event-a", expectedRevision: 4, text: "replace saved text" }, { action: "refresh", proposalId: "p", eventId: "event-a", expectedRevision: -1 }]) {
  test(`invalid lifecycle action fails before data or planning: ${JSON.stringify(invalid)}`, async () => {
    const api = harness();
    await assert.rejects(api.updateAgentProposal(invalid), isCode("invalid_proposal_action", 422));
    assert.deepEqual(api.sql, []);
    assert.deepEqual(api.plans, []);
  });
}

test("PATCH checks origin/authentication and strict bounded input before lifecycle execution", async () => {
  const calls = [];
  const body = { action: "dismiss", proposalId: "p", eventId: "event-a", expectedRevision: 4 };
  const route = evaluate(compile("../app/api/agent/route.ts"), {
    "@/lib/agent-proposals": { proposalActionSchema: z.object({ action: z.literal("dismiss"), proposalId: z.string(), eventId: z.string(), expectedRevision: z.number() }).strict(), async updateAgentProposal(value) { calls.push(["action", value]); return { applied: false }; } },
    "@/lib/server-store": { checkBrowserOrigin() { calls.push(["origin"]); }, async getPrivateCallerContext() { calls.push(["auth"]); }, async readJsonBody(request, schema, maxBytes) { calls.push(["body", maxBytes]); return schema.parse(await request.json()); }, jsonResponse: value => Response.json(value), errorResponse: error => { throw error; } },
  });
  const response = await route.PATCH(new Request("https://private.test/api/agent", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  assert.deepEqual(await response.json(), { applied: false });
  assert.deepEqual(calls, [["origin"], ["auth"], ["body", 8 * 1024], ["action", body]]);
});
