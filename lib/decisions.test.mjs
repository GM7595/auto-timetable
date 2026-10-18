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

function harness(fetchResponse, { key = fakeKey, plans = candidates, timeout = false } = {}) {
  const calls = [];
  const logs = [];
  const timers = { delay: null, cleared: false };
  let timeoutCallback;
  const dependencies = {
    "cloudflare:workers": { env: { OPENAI_API_KEY: key } },
    "@/lib/planner": {
      parseIssue(text) { return { kind: "delay", slotId: "a", minutes: 5, text }; },
      generatePlans() { return structuredClone(plans); },
      computeSchedule: schedule,
    },
    "@/lib/server-store": {
      eventStateSchema: { safeParse(value) { return { success: true, data: value }; } },
      HttpError: class HttpError extends Error {
        constructor(status, message, code) { super(message); this.status = status; this.code = code; }
      },
    },
  };
  const module = { exports: {} };
  const mockFetch = async (...args) => {
    calls.push(args);
    const response = typeof fetchResponse === "function" ? fetchResponse(...args) : fetchResponse;
    if (timeout) timeoutCallback();
    return response;
  };
  const mockConsole = Object.fromEntries(["log", "warn", "error", "info", "debug"].map((method) => [method, (...args) => logs.push(args)]));
  new Function("require", "module", "exports", "fetch", "console", "setTimeout", "clearTimeout", compiled)(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected module ${name}`);
      return dependencies[name];
    },
    module, module.exports, mockFetch, mockConsole,
    (callback, delay) => { timeoutCallback = callback; timers.delay = delay; return 1; },
    (id) => { assert.equal(id, 1); timers.cleared = true; },
  );
  return { ...module.exports, calls, logs, timers };
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

function assertSafeDiagnostic(result, failureKind, extras = {}, includeFallback = true) {
  assert.equal(result.decisions.status, "failed");
  assert.equal(result.decisions.model, "gpt-6-luna");
  assert.equal(result.decisions.failureKind, failureKind);
  assert.ok(Number.isInteger(result.decisions.elapsedMs) && result.decisions.elapsedMs >= 0);
  for (const [name, value] of Object.entries(extras)) assert.equal(result.decisions[name], value);
  const serialized = JSON.stringify({ diagnostic: result.decisions, notice: result.notice });
  for (const sentinel of [fakeKey, privateText, rawErrorText]) assert.ok(!serialized.includes(sentinel), "Client diagnostics leaked sensitive input");
  if (includeFallback) assert.match(result.notice, /検証済みの制約計算/);
  else assert.doesNotMatch(result.notice, /順序で表示/);
}

test("a valid supplied choice is promoted without modifying candidate content", async () => {
  const api = harness(Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "flow" }] }));
  const original = structuredClone(state);
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "decisions");
  assert.equal(result.aiStatus, "used");
  assert.equal(result.decisions.status, "used");
  assert.equal(result.decisions.model, "gpt-6-luna");
  assert.ok(Number.isInteger(result.decisions.elapsedMs) && result.decisions.elapsedMs >= 0);
  assert.deepEqual(Object.keys(result.decisions).sort(), ["elapsedMs", "model", "status"]);
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
  assert.deepEqual(api.timers, { delay: 6000, cleared: true });
});

for (const [status, code, kind, notice] of [
  [401, "invalid_api_key", "authentication", /認証に失敗/],
  [429, "insufficient_quota", "quota", /利用枠が不足/],
  [429, "rate_limit_exceeded", "rate-limit", /リクエスト上限/],
  [403, "permission_denied", "permission", /利用権限/],
  [404, "model_not_found", "permission", /利用権限/],
  [500, "invalid_request_error", "upstream", /API側のエラー/],
]) {
  test(`HTTP ${status} falls back and logs only a safe status and allowlisted code`, async () => {
    const api = harness(Response.json({ error: { code, message: `${rawErrorText} ${fakeKey} ${privateText}` } }, { status }));
    const result = await api.proposePlans(state, privateText);
    assertFallback(result);
    assertSafeDiagnostic(result, kind, { httpStatus: status, errorCode: code });
    assert.match(result.notice, notice);
    const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
    assert.ok(entry, "Expected safe failure diagnostic");
    assert.deepEqual(entry[1], { kind: "http", status, code });
    assertSafeLogs(api.logs);
  });
}

test("an unrecognized upstream error code is not echoed into diagnostic logs", async () => {
  const api = harness(Response.json({ error: { code: `${fakeKey} ${privateText}`, message: rawErrorText } }, { status: 400 }));
  const result = await api.proposePlans(state, privateText);
  assertFallback(result);
  assertSafeDiagnostic(result, "upstream", { httpStatus: 400, errorCode: "unknown" });
  const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
  assert.ok(entry);
  assert.deepEqual(entry[1], { kind: "http", status: 400, code: "unknown" });
  assertSafeLogs(api.logs);
});

for (const [status, kind] of [[401, "authentication"], [403, "permission"], [429, "rate-limit"], [503, "upstream"]]) {
  test(`HTTP ${status} is classified even when the body is not JSON`, async () => {
    const api = harness(new Response(`${rawErrorText} ${fakeKey}`, { status }));
    const result = await api.proposePlans(state, privateText);
    assertFallback(result);
    assertSafeDiagnostic(result, kind, { httpStatus: status, errorCode: "unknown" });
    assertSafeLogs(api.logs);
  });
}

for (const [label, response] of [
  ["malformed JSON", () => new Response("not-json")],
  ["missing answers", () => Response.json({})],
  ["a non-array answer envelope", () => Response.json({ answers: {} })],
  ["an oversized response", () => new Response(" ".repeat(64 * 1024 + 1))],
  ["a refusal", () => Response.json({ answers: [{ type: "refusal", name: "recommended_plan" }] })],
  ["a wrong answer name", () => Response.json({ answers: [{ type: "choice", name: "another_question", choice: "flow" }] })],
  ["an unknown plan", () => Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "invented-plan" }] })],
]) {
  test(`${label} cannot introduce unvalidated output`, async () => {
    const api = harness(response());
    const result = await api.proposePlans(state, privateText);
    assertFallback(result);
    assertSafeDiagnostic(result, "invalid-response");
    assert.equal(result.decisions.httpStatus, undefined);
    assert.equal(result.decisions.errorCode, undefined);
    assertSafeLogs(api.logs);
  });
}

test("transport failures never log exception messages or private context", async () => {
  const api = harness(() => { throw new Error(`${rawErrorText} ${fakeKey} ${privateText}`); });
  const result = await api.proposePlans(state, privateText);
  assertFallback(result);
  assertSafeDiagnostic(result, "transport");
  assert.match(result.notice, /接続できません/);
  const entry = api.logs.find(([marker]) => marker === "cue_decisions_failure");
  assert.ok(entry);
  assertSafeLogs(api.logs);
  assert.equal(api.timers.cleared, true);
});

test("an aborted comparison is a timeout rather than an authentication or transport failure", async () => {
  const api = harness((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error(`${rawErrorText} ${fakeKey}`)), { once: true });
  }), { timeout: true });
  const result = await api.proposePlans(state, privateText);
  assertFallback(result);
  assertSafeDiagnostic(result, "timeout");
  assert.match(result.notice, /時間内に完了しません/);
  assert.deepEqual(api.logs, [["cue_decisions_failure", { kind: "timeout" }]]);
  assertSafeLogs(api.logs);
  assert.deepEqual(api.timers, { delay: 6000, cleared: true });
});

test("an absent key never calls the upstream service", async () => {
  const api = harness(undefined, { key: "" });
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "rules");
  assert.equal(result.aiStatus, "not-configured");
  assert.equal(result.decisions, undefined);
  assert.equal(api.calls.length, 0);
  assert.equal(api.timers.delay, null);
});

test("a single feasible candidate does not require an upstream comparison", async () => {
  const api = harness(undefined, { plans: candidates.slice(0, 1) });
  const result = await api.proposePlans(state, privateText);
  assert.equal(result.engine, "rules");
  assert.equal(result.aiStatus, "not-needed");
  assert.equal(result.decisions, undefined);
  assert.equal(api.calls.length, 0);
  assert.equal(api.timers.delay, null);
});

test("no feasible candidate never attempts a comparison", async () => {
  const api = harness(undefined, { plans: [] });
  await assert.rejects(api.proposePlans(state, privateText), /成立する変更案|案が見つかりません/);
  assert.equal(api.calls.length, 0);
  assert.equal(api.timers.delay, null);
  assert.deepEqual(api.logs, []);
});

test("connection check makes a real comparison with only synthetic data", async () => {
  const api = harness(Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "connection-b" }] }));
  const result = await api.checkDecisionsConnection();
  assert.equal(result.configured, true);
  assert.equal(result.aiStatus, "used");
  assert.equal(result.decisions.status, "used");
  assert.equal(result.decisions.model, "gpt-6-luna");
  assert.ok(Number.isInteger(result.decisions.elapsedMs) && result.decisions.elapsedMs >= 0);
  assert.match(result.notice, /接続を確認できました/);
  assert.equal(api.calls.length, 1);
  const body = JSON.parse(api.calls[0][1].body);
  assert.equal(api.calls[0][0], "https://api.openai.com/v1/decisions");
  assert.equal(body.model, "gpt-6-luna");
  assert.deepEqual(body.questions[0].choices.map((choice) => choice.value), ["connection-a", "connection-b"]);
  const input = JSON.parse(body.input);
  assert.equal(input.event.name, "Connection check");
  assert.deepEqual(input.currentProgram, []);
  for (const sentinel of [fakeKey, privateText, rawErrorText]) assert.ok(!body.input.includes(sentinel));
  assert.deepEqual(api.logs, []);
  assert.deepEqual(api.timers, { delay: 6000, cleared: true });
});

test("connection check exposes safe actual authentication failure instead of claiming connected", async () => {
  const api = harness(Response.json({ error: { code: "invalid_api_key", message: `${rawErrorText} ${fakeKey}` } }, { status: 401 }));
  const result = await api.checkDecisionsConnection();
  assert.equal(result.configured, true);
  assert.equal(result.aiStatus, "fallback");
  assertSafeDiagnostic(result, "authentication", { httpStatus: 401, errorCode: "invalid_api_key" }, false);
  assert.match(result.notice, /認証に失敗/);
  assert.equal(api.calls.length, 1);
  assertSafeLogs(api.logs);
});

test("connection check refuses to claim success for an unknown choice", async () => {
  const api = harness(Response.json({ answers: [{ type: "choice", name: "recommended_plan", choice: "invented-plan" }] }));
  const result = await api.checkDecisionsConnection();
  assert.equal(result.configured, true);
  assert.equal(result.aiStatus, "fallback");
  assertSafeDiagnostic(result, "invalid-response", {}, false);
});

test("connection check skips upstream when no key is configured", async () => {
  const api = harness(undefined, { key: "   " });
  const result = await api.checkDecisionsConnection();
  assert.equal(result.configured, false);
  assert.equal(result.aiStatus, "not-configured");
  assert.equal(result.decisions, undefined);
  assert.match(result.notice, /未設定/);
  assert.equal(api.calls.length, 0);
  assert.equal(api.timers.delay, null);
});
