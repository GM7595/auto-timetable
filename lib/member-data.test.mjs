import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { z } from "zod";

// Actual schemas, planner, routes, and generated SQLite migrations. Every
// record is synthetic and all upstream calls are replaced in memory.
function compile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
function evaluate(source, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", ...Object.keys(globals), source)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, () => assert.fail("No real network call is permitted"), ...Object.values(globals));
  return module.exports;
}
const planner = evaluate(compile("./planner.ts"));
const sharedSchema = evaluate(compile("./planning-result-schema.ts"), { zod: { z } });
const slot = (id, people = []) => ({
  id, title: `Band ${id}`, group: "Band", kind: "live", durationMinutes: 20,
  changeoverMinutes: 0, people, equipment: [], locked: false, status: "planned", energy: 3, notes: "",
});
const initial = () => ({
  event: { id: "member-test", name: "Synthetic member test", date: "2026-10-18", location: "Tokyo", startTime: 840, endTime: 960, quietWindows: [] },
  slots: [slot("a", ["山田", "鈴木"]), slot("b", ["田中"])], history: [], revision: 4,
});
const memberState = () => {
  const state = initial();
  state.slots[0].members = [{ name: "山田", roles: ["Vo.", "Gt."] }, { name: "鈴木", roles: ["Dr.", "部長"] }];
  state.slots[1].members = [{ name: "田中", roles: [], roleNotRequired: true }];
  return state;
};
const text = "全体を5分短縮";
const resultFor = (state, request = text) => ({
  plans: planner.generatePlans(state, planner.parseIssue(request, state)),
  issue: planner.parseIssue(request, state), engine: "decisions", aiStatus: "used", elapsedMs: 1,
});

function harness(seed = initial()) {
  const db = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  db.prepare("INSERT INTO cue_event_state (id, revision, payload, updated_at) VALUES ('primary', ?, ?, '2026-10-18T00:00:00Z')").run(seed.revision, JSON.stringify(seed));
  const adapter = {
    prepare(statement) {
      const make = (args = []) => ({
        statement, args,
        bind(...values) { return make(values); },
        async first() { return db.prepare(statement).get(...args) ?? null; },
        async all() { return { results: db.prepare(statement).all(...args) }; },
        async run() { return { meta: { changes: Number(db.prepare(statement).run(...args).changes) } }; },
      });
      return make();
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const result = statements.map((entry) => ({ meta: { changes: Number(db.prepare(entry.statement).run(...entry.args).changes) } }));
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
  const env = { DB: adapter };
  const store = evaluate(compile("./server-store.ts"), {
    "cloudflare:workers": { env }, zod: { z },
    "@/app/chatgpt-auth": { async getChatGPTUser() { return null; } }, "@/lib/demo": { demoState: initial() },
  });
  const route = evaluate(compile("../app/api/event/route.ts"), { zod: { z }, "@/lib/server-store": store, "@/lib/decisions": { decisionsConfigured: () => false } });
  const queue = evaluate(compile("./change-requests.ts"), { "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store, "@/lib/planning-result-schema": sharedSchema });
  const proposals = evaluate(compile("./agent-proposals.ts"), {
    "cloudflare:workers": { env }, zod: { z }, "@/lib/server-store": store,
    "@/lib/change-requests": queue, "@/lib/planner": planner, "@/lib/planning-result-schema": sharedSchema,
    "@/lib/decisions": { async proposePlans(value, request) { return resultFor(value, request); } },
  }, { crypto: { randomUUID } });
  return { db, store, route, queue, proposals };
}

test("old event snapshots and old proposals without members remain byte-for-byte compatible", () => {
  const api = harness(), legacy = initial(), result = resultFor(legacy);
  assert.deepEqual(api.store.eventStateSchema.parse(legacy), legacy);
  assert.deepEqual(sharedSchema.planningResultSchema.parse(result), result);
  assert.ok(result.plans.every((plan) => plan.slots.every((entry) => !Object.hasOwn(entry, "members"))));
  legacy.slots[0].people = ["山田", "山田"];
  assert.equal(api.store.eventStateSchema.safeParse(legacy).success, true, "do not tighten the existing legacy people contract");
});

test("multiple standard and custom roles, explicit role-free members, and role ordering round-trip through both schemas", () => {
  const api = harness(), state = memberState();
  assert.deepEqual(api.store.eventStateSchema.parse(state), state);
  const result = resultFor(state);
  assert.ok(result.plans.length > 0);
  assert.deepEqual(sharedSchema.planningResultSchema.parse(JSON.parse(JSON.stringify(result))), JSON.parse(JSON.stringify(result)));
});

test("member names and roles are trimmed before uniqueness checks and persisted canonically", () => {
  const api = harness(), state = memberState();
  state.slots[0].people[0] = " 山田 ";
  state.slots[0].members[0] = { name: " 山田 ", roles: [" Vo. ", " Gt. "] };
  const parsed = api.store.eventStateSchema.parse(state);
  assert.deepEqual(parsed.slots[0].members[0], { name: "山田", roles: ["Vo.", "Gt."] });
  assert.equal(parsed.slots[0].people[0], "山田");
});

test("the optional role-free flag preserves true, false, and absence through validation and planning", () => {
  const api = harness(), state = memberState();
  state.slots[0].members[0].roleNotRequired = false;
  assert.deepEqual(api.store.eventStateSchema.parse(state), state);
  assert.equal(Object.hasOwn(state.slots[0].members[1], "roleNotRequired"), false);
  const result = sharedSchema.planningResultSchema.parse(resultFor(state));
  for (const plan of result.plans) {
    for (const entry of [...plan.slots, ...plan.schedule.rows]) {
      assert.deepEqual(entry.members, state.slots.find((original) => original.id === entry.id).members);
    }
  }
});

const invalidChanges = [
  ["duplicate names", (entry) => { entry.members[1].name = entry.members[0].name; entry.people[1] = entry.people[0]; }],
  ["duplicate trimmed names", (entry) => { entry.members[1].name = ` ${entry.members[0].name} `; entry.people[1] = entry.people[0]; }],
  ["empty name", (entry) => { entry.members[0].name = "  "; }],
  ["name longer than 160", (entry) => { entry.members[0].name = "a".repeat(161); }],
  ["missing roles", (entry) => { delete entry.members[0].roles; }],
  ["empty roles without explicit permission", (entry) => { entry.members[0].roles = []; }],
  ["empty roles with false permission", (entry) => { entry.members[0].roles = []; entry.members[0].roleNotRequired = false; }],
  ["selected roles and role-free flag together", (entry) => { entry.members[0].roleNotRequired = true; }],
  ["non-boolean role-free flag", (entry) => { entry.members[0].roleNotRequired = "true"; }],
  ["missing name with explicit role-free flag", (entry) => { entry.members[0] = { name: " ", roles: [], roleNotRequired: true }; }],
  ["empty role", (entry) => { entry.members[0].roles = ["  "]; }],
  ["duplicate role", (entry) => { entry.members[0].roles = ["Vo.", "Vo."]; }],
  ["duplicate trimmed role", (entry) => { entry.members[0].roles = ["Vo.", " Vo. "]; }],
  ["role longer than 40", (entry) => { entry.members[0].roles = ["a".repeat(41)]; }],
  ["more than 12 roles", (entry) => { entry.members[0].roles = Array.from({ length: 13 }, (_, i) => `role-${i}`); }],
  ["non-string role", (entry) => { entry.members[0].roles = [17]; }],
  ["unknown member property", (entry) => { entry.members[0].id = "unexpected"; }],
  ["null members", (entry) => { entry.members = null; }],
  ["more than 30 members", (entry) => { entry.members = Array.from({ length: 31 }, (_, i) => ({ name: `person-${i}`, roles: [], roleNotRequired: true })); entry.people = entry.members.map((member) => member.name); }],
  ["different names from people", (entry) => { entry.members[0].name = "別の人"; }],
  ["different order from people", (entry) => { entry.members.reverse(); }],
  ["different count from people", (entry) => { entry.members.pop(); }],
];
for (const [label, mutate] of invalidChanges) {
  test(`event and saved-result schemas reject ${label} in both program and schedule rows`, () => {
    const api = harness(), state = memberState();
    mutate(state.slots[0]);
    assert.equal(api.store.eventStateSchema.safeParse(state).success, false);
    for (const location of ["slots", "rows"]) {
      const result = resultFor(memberState());
      const entry = location === "slots" ? result.plans[0].slots[0] : result.plans[0].schedule.rows[0];
      mutate(entry);
      assert.equal(sharedSchema.planningResultSchema.safeParse(result).success, false, `${label} in ${location} must not acknowledge intake`);
    }
  });
}

test("maximum supported member and role sizes are accepted without a migration", () => {
  const api = harness(), state = memberState();
  state.slots[0].members = Array.from({ length: 30 }, (_, index) => ({ name: `${index}`.padEnd(160, "a"), roles: Array.from({ length: 12 }, (_, role) => `${role}`.padEnd(40, "b")) }));
  state.slots[0].people = state.slots[0].members.map((member) => member.name);
  assert.deepEqual(api.store.eventStateSchema.parse(state), state);
  assert.equal(sharedSchema.planningResultSchema.safeParse(resultFor(state)).success, true);
});

test("event PUT/GET and archived JSON persist names and roles, preserving revision checks", async () => {
  const api = harness(), state = memberState();
  const response = await api.route.PUT(new Request("https://test.example/api/event", {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: "https://test.example" },
    body: JSON.stringify({ state, expectedRevision: 4 }),
  }));
  assert.equal(response.status, 200);
  const saved = (await response.json()).state;
  assert.deepEqual(saved, { ...state, revision: 5 });
  assert.deepEqual((await (await api.route.GET()).json()).state, saved);
  assert.deepEqual(JSON.parse(api.db.prepare("SELECT payload FROM cue_saved_event WHERE event_id = ?").get(state.event.id).payload), saved);
  const invalid = memberState();
  invalid.slots[0].members[0].name = "does not match people";
  const rejected = await api.route.PUT(new Request("https://test.example/api/event", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: invalid, expectedRevision: 4 }),
  }));
  assert.equal(rejected.status, 422);
  assert.equal((await rejected.json()).code, "invalid_payload");
  assert.deepEqual(await api.store.getEventState(), saved);
});

test("member proposals survive storage and agent context, acknowledge intake only while valid", async () => {
  const state = memberState(), api = harness(state), requestId = randomUUID();
  await api.queue.enqueueChangeRequest({ text, expectedRevision: 4, requestId });
  const published = await api.proposals.publishAgentProposal({ text, expectedRevision: 4, requestId: `change:${requestId}` });
  assert.equal(published.applied, false);
  assert.deepEqual((await api.proposals.listAgentProposals(state.event.id))[0], published.proposal);
  const context = await api.proposals.getAgentContext();
  assert.deepEqual(context.state, state);
  assert.deepEqual(context.proposals[0].result.plans[0].slots[0].members, state.slots[0].members);
  assert.deepEqual(context.schedule.rows[0].members, state.slots[0].members);
  assert.equal((await api.queue.listChangeRequests(state.event.id)).pendingCount, 0);
  const corrupt = structuredClone(published.proposal.result);
  corrupt.plans[0].schedule.rows[0].members[0].roles = ["Vo.", "Vo."];
  api.db.prepare("UPDATE cue_agent_proposal SET result = ? WHERE id = ?").run(JSON.stringify(corrupt), published.proposal.id);
  assert.equal((await api.queue.listChangeRequests(state.event.id)).pendingCount, 1);
  await assert.rejects(api.proposals.listAgentProposals(state.event.id), (error) => error.code === "proposal_storage_invalid");
  assert.deepEqual(await api.store.getEventState(), state, "proposal and intake work never change the actual event");
});

test("old stored proposals still decode without inventing role metadata", async () => {
  const state = initial(), api = harness(state);
  const published = await api.proposals.publishAgentProposal({ text, expectedRevision: 4, requestId: randomUUID() });
  const reopened = (await api.proposals.listAgentProposals(state.event.id))[0];
  assert.deepEqual(reopened, published.proposal);
  assert.ok(reopened.result.plans.every((plan) => [...plan.slots, ...plan.schedule.rows].every((entry) => !Object.hasOwn(entry, "members"))));
});

test("refreshing a legacy proposal uses the latest member roles without appending another card", async () => {
  const api = harness();
  const original = await api.proposals.publishAgentProposal({ text, expectedRevision: 4, requestId: randomUUID() });
  const saved = (await api.store.saveEventState(memberState(), 4)).state;
  const refreshed = await api.proposals.updateAgentProposal({ action: "refresh", proposalId: original.proposal.id, eventId: saved.event.id, expectedRevision: 5 });
  assert.equal(refreshed.applied, false);
  assert.equal(refreshed.proposal.id, original.proposal.id);
  assert.equal(refreshed.proposal.baseRevision, 5);
  for (const plan of refreshed.proposal.result.plans) {
    for (const entry of [...plan.slots, ...plan.schedule.rows]) {
      assert.deepEqual(entry.members, saved.slots.find((value) => value.id === entry.id).members);
    }
  }
  assert.equal((await api.proposals.listAgentProposals(saved.event.id)).length, 1);
  assert.equal(api.db.prepare("SELECT COUNT(*) AS count FROM cue_agent_proposal").get().count, 1);
  assert.deepEqual(await api.store.getEventState(), saved);
});

test("delay, availability, shortening, reordering, and JSON serialization preserve members without sharing mutable roles", () => {
  const state = memberState(), original = structuredClone(state);
  for (const issue of [
    { kind: "delay", slotId: "a", minutes: 5, text: "delay" },
    { kind: "unavailable", slotId: "a", until: 875, text: "unavailable" },
    { kind: "shorten", minutes: 5, text },
  ]) {
    const plans = planner.generatePlans(state, issue);
    assert.ok(plans.length > 0);
    for (const [planIndex, plan] of plans.entries()) {
      for (const entry of [...plan.slots, ...plan.schedule.rows]) {
        assert.deepEqual(entry.members, original.slots.find((value) => value.id === entry.id).members);
      }
      const serialized = JSON.parse(JSON.stringify({ ...state, slots: plan.slots }));
      assert.deepEqual(planner.computeSchedule(serialized).rows.map((entry) => entry.members), plan.schedule.rows.map((entry) => entry.members));
      const sentinel = `edited only in candidate ${planIndex}`;
      plan.slots[0].members[0].roles.push(sentinel);
      assert.deepEqual(state, original);
      assert.ok(!plans.filter((other) => other !== plan).some((other) => other.slots.some((entry) => entry.members.some((member) => member.roles.includes(sentinel)))));
    }
  }
  const reversed = planner.computeSchedule(state, [...state.slots].reverse());
  assert.deepEqual(reversed.rows[0].members, state.slots[1].members);
});

test("performer warnings use person names rather than musical roles", () => {
  const state = memberState();
  state.slots[1].members = [{ name: "田中", roles: ["Vo.", "Gt."] }];
  assert.equal(planner.computeSchedule(state).violations.some((entry) => entry.code === "performer-rest"), false);
  state.slots[1].people = ["山田"];
  state.slots[1].members = [{ name: "山田", roles: ["Dr."] }];
  const warning = planner.computeSchedule(state).violations.find((entry) => entry.code === "performer-rest");
  assert.ok(warning);
  assert.match(warning.message, /山田/);
});

test("Decisions receives member roles in its current program and finite candidate projections", async () => {
  const state = memberState(), calls = [], api = harness(state);
  // The integration evaluator shadows fetch. Replace only that test-local
  // evaluator argument, never the process environment or a real credential.
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", compile("./decisions.ts"))((name) => ({
    "cloudflare:workers": { env: { OPENAI_API_KEY: "synthetic-unit-test-key" } },
    "@/lib/server-store": api.store, "@/lib/planner": planner,
  })[name], module, module.exports, async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: body.questions[0].choices[0].value }] });
  });
  const result = await module.exports.proposePlans(state, text);
  assert.equal(result.aiStatus, "used");
  assert.equal(calls.length, 1);
  const input = JSON.parse(calls[0].input);
  assert.deepEqual(input.currentProgram[0].members, state.slots[0].members);
  for (const candidate of input.candidates) {
    for (const entry of candidate.program) {
      const source = state.slots.find((value) => value.title === entry.title);
      assert.deepEqual(entry.members, source.members);
      assert.deepEqual(entry.people, source.people);
    }
  }
});
