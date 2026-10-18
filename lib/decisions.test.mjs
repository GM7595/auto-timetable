import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Exercise the actual Decisions integration in memory. All credentials, planner
// output, network responses and logs are isolated test doubles, never live data.
const fakeKey = "fake-unit-test-secret-sentinel";
const privateText = "organizer-private-sentinel";
const rawErrorText = "raw-upstream-error-sentinel";
const slot = (id) => ({
  id, title: `Session ${id}`, group: "", kind: "talk", durationMinutes: 10,
  changeoverMinutes: 0, people: [], equipment: [], locked: false,
  status: "planned", energy: 3, notes: "",
});
const state = {
  event: { id: "test", name: privateText, date: "2026-10-18", location: "", startTime: 840, endTime: 960, quietWindows: [] },
  slots: [slot("a"), slot("b")], history: [], revision: 0,
};
const schedule = (value, slots = value.slots) => ({
  rows: slots.map((entry, index) => ({ ...entry, start: 840 + index * 10, end: 850 + index * 10 })),
  violations: [], bufferMinutes: 100,
});
const plan = (id, slots) => ({
  id, title: id, description: "Feasible test candidate", changes: [], tradeoffs: [], score: 100,
  slots, schedule: schedule(state, slots),
});
const candidates = [plan("minimal", state.slots), plan("flow", [...state.slots].reverse())];
const compiled = ts.transpileModule(readFileSync(new URL("./decisions.ts", import.meta.url), "utf8"), {
  fileName: "decisions.ts",
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(fetchResponse, { key = fakeKey, plans = candidates } = {}) {
  const calls = [];
  const logs = [];
  const dependencies = {
    "cloudflare:workers": { env: { OPENAI_API_KEY: key } },
    "@/lib/planner": {
      parseIssue(text) { return { kind: "delay", slotId: "a", minutes: 5, text }; },
      generatePlans() { return structuredClone(plans); },
      computeSchedule: schedule,
    },
    "@/lib/server-store": {
      eventStateSchema: { safeParse(value) { return { success: true, data: value }; } },
      HttpError: class HttpError extends Error {},
    },
  };
  const module = { exports: {} };
  const mockFetch = async (...args) => {
    calls.push(args);
    return typeof fetchResponse === "function" ? fetchResponse(...args) : fetchResponse;
  };
  const mockConsole = Object.fromEntries(["log", "warn", "error", "info", "debug"].map((method) => [method, (...args) => logs.push(args)]));
  new Function("require", "module", "exports", "fetch", "console", compiled)(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected module ${name}`);
      return dependencies[name];
    },
    module, module.exports, mockFetch, mockConsole,
  );
  return { ...module.exports, calls, logs };
}

function assertFallback(result) {
  assert.equal(result.engine, "rules");
  assert.equal(result.aiStatus, "fallback");
  assert.deepEqual(result.plans.map((candidate) => candidate.id), ["minimal", "flow"]);
}

function assertSafeLogs(logs) {
  const serialized = JSON.stringify(logs);
  for (const sentinel of [fakeKey, privateText, rawErrorText]) assert.ok(!serialized.includes(sentinel), "Failure logs leaked sensitive input");
}

test("a valid supplied choice is promoted without modifying candidate content", async () => {
  const api = harness(Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "flow" }] }));
  const original = structuredClone(state);
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "decisions");
  assert.equal(result.aiStatus, "used");
  assert.deepEqual(result.plans.map((candidate) => candidate.id), ["flow", "minimal"]);
  assert.deepEqual(result.plans[0].slots, candidates[1].slots);
  assert.deepEqual(state, original);
  assert.equal(api.calls.length, 1);
  const [url, options] = api.calls[0];
  assert.equal(url, "https://api.openai.com/v1/decisions");
  assert.equal(options.method, "POST");
  const body = JSON.parse(options.body);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.questions[0].type, "choice");
  assert.deepEqual(body.questions[0].choices.map((choice) => choice.value), ["minimal", "flow"]);
  assert.deepEqual(api.logs, []);
});

for (const [status, code] of [[401, "invalid_api_key"], [429, "insufficient_quota"]]) {
  test(`HTTP ${status} falls back and logs only a safe status and allowlisted code`, async () => {
    const api = harness(Response.json({ error: { code, message: `${rawErrorText} ${fakeKey} ${privateText}` } }, { status }));
    assertFallback(await api.proposePlans(state, privateText));
    const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
    assert.ok(entry, "Expected safe failure diagnostic");
    assert.deepEqual(entry[1], { kind: "http", status, code });
    assertSafeLogs(api.logs);
  });
}

test("an unrecognized upstream error code is not echoed into diagnostic logs", async () => {
  const api = harness(Response.json({ error: { code: `${fakeKey} ${privateText}`, message: rawErrorText } }, { status: 400 }));
  assertFallback(await api.proposePlans(state, privateText));
  const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
  assert.ok(entry);
  assert.deepEqual(entry[1], { kind: "http", status: 400, code: "unknown" });
  assertSafeLogs(api.logs);
});

for (const [label, response] of [
  ["malformed JSON", () => new Response("not-json")],
  ["missing answers", () => Response.json({})],
  ["a refusal", () => Response.json({ answers: [{ type: "refusal", name: "recommended_plan" }] })],
  ["a wrong answer name", () => Response.json({ answers: [{ type: "choice", name: "another_question", choice: "flow" }] })],
  ["an unknown plan", () => Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "invented-plan" }] })],
]) {
  test(`${label} cannot introduce unvalidated output`, async () => {
    const api = harness(response());
    assertFallback(await api.proposePlans(state, privateText));
    assertSafeLogs(api.logs);
  });
}

test("transport failures never log exception messages or private context", async () => {
  const api = harness(() => { throw new Error(`${rawErrorText} ${fakeKey} ${privateText}`); });
  assertFallback(await api.proposePlans(state, privateText));
  const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
  assert.ok(entry);
  assertSafeLogs(api.logs);
});

test("an absent key never calls the upstream service", async () => {
  const api = harness(undefined, { key: "" });
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "rules");
  assert.equal(result.aiStatus, "not-configured");
  assert.equal(api.calls.length, 0);
});

test("a single feasible candidate does not require an upstream comparison", async () => {
  const api = harness(undefined, { plans: candidates.slice(0, 1) });
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "rules");
  assert.equal(result.aiStatus, "not-needed");
  assert.equal(api.calls.length, 0);
});
