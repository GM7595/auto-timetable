import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";

// Pure fragment and real MCP-route tests. No live credential, network, DB or dot.
function compile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
function evaluate(source, dependencies) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", source)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports, () => assert.fail("Review-link bridge must not add a network call"));
  return module.exports;
}
const links = evaluate(compile("./proposal-review-link.ts"), {});
const { createProposalReviewUrl, parseProposalReviewHash } = links;
const intent = { eventId: "イベント-一", revision: 0, text: "全体が5分押しています。\nトーク＋ライブ & Q&A #1" };
const hashFor = (changes = {}) => `#${new URLSearchParams({ review: "1", event: intent.eventId, revision: "0", text: intent.text, ...changes })}`;

test("Unicode, multiline and reserved characters round-trip without becoming query data or executable plans", () => {
  const url = new URL(createProposalReviewUrl("https://tool.example.test", intent));
  assert.equal(url.origin, "https://tool.example.test");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.deepEqual(parseProposalReviewHash(url.hash), intent);
  assert.deepEqual([...new URLSearchParams(url.hash.slice(1)).keys()], ["review", "event", "revision", "text"]);
});

test("the link accepts only HTTP(S) origins, never credentials, private paths or token queries", () => {
  for (const origin of ["not-a-url", "/relative", "javascript:alert(1)", "data:text/html,test", "file:///tmp/event", "ftp://tool.example.test", "https://user:password@tool.example.test", "https://tool.example.test/private-event", "https://tool.example.test?token=private-token", "https://tool.example.test#private-note"]) {
    assert.throws(() => createProposalReviewUrl(origin, intent), undefined, origin);
  }
  assert.equal(new URL(createProposalReviewUrl("http://tool.example.test:8080/", intent)).origin, "http://tool.example.test:8080");
});

test("maximum bounded text, event ID and safe revision survive a fragment round-trip", () => {
  const maximum = { eventId: "界".repeat(120), revision: Number.MAX_SAFE_INTEGER, text: "界".repeat(2000) };
  const url = new URL(createProposalReviewUrl("https://tool.example.test", maximum));
  assert.ok(url.hash.length <= 24_000);
  assert.deepEqual(parseProposalReviewHash(url.hash), maximum);
});

for (const [name, change] of [
  ["blank event", { eventId: " " }], ["long event", { eventId: "x".repeat(121) }], ["control event", { eventId: "event\nother" }],
  ["blank text", { text: " \n\t" }], ["long text", { text: "x".repeat(2001) }], ["control text", { text: "hello\u0000there" }],
  ["negative revision", { revision: -1 }], ["fraction revision", { revision: 0.5 }], ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
  ["non-number revision", { revision: "0" }], ["lone surrogate event", { eventId: "\ud800" }], ["lone surrogate text", { text: "\udc00" }],
  ["caller-supplied plan", { plans: [{ id: "untrusted" }] }],
]) {
  test(`invalid review-link creation is rejected: ${name}`, () => assert.throws(() => createProposalReviewUrl("https://tool.example.test", { ...intent, ...change })));
}

for (const [name, hash] of [
  ["missing fragment marker", hashFor().slice(1)], ["whole URL", `https://tool.example.test/${hashFor()}`], ["empty", ""],
  ["unsupported version", hashFor({ review: "2" })], ["missing version", `#event=a&revision=0&text=test`],
  ["duplicate version", `${hashFor()}&review=1`], ["duplicate text", `${hashFor()}&text=other`],
  ["unknown key", `${hashFor()}&plans=untrusted`], ["substituted key", hashFor().replace("event=", "plan=")], ["empty extra key", `${hashFor()}&`],
  ["blank event", hashFor({ event: " " })], ["long event", hashFor({ event: "x".repeat(121) })], ["control event", hashFor({ event: "x\u0000" })],
  ["blank text", hashFor({ text: "\n " })], ["long text", hashFor({ text: "x".repeat(2001) })], ["control text", hashFor({ text: "x\u0001" })],
  ["negative revision", hashFor({ revision: "-1" })], ["fraction revision", hashFor({ revision: "1.5" })],
  ["exponent revision", hashFor({ revision: "1e2" })], ["padded revision", hashFor({ revision: "00" })],
  ["plus revision", hashFor({ revision: "+1" })], ["unsafe revision", hashFor({ revision: "9007199254740992" })],
  ["malformed escape", "#review=1&event=a&revision=0&text=%zz"], ["incomplete escape", "#review=1&event=a&revision=0&text=%"],
  ["invalid UTF-8", "#review=1&event=a&revision=0&text=%ED%A0%80"], ["huge hash", `#${"x".repeat(24_000)}`],
]) {
  test(`untrusted fragment returns null: ${name}`, () => assert.equal(parseProposalReviewHash(hash), null));
}

const eventState = { event: { id: "event-a", name: "Private unit event" }, slots: [{ id: "slot-a" }], history: [], revision: 4 };
const planResult = { engine: "decisions", aiStatus: "used", plans: [{ id: "flow", title: "Compared candidate", slots: [{ id: "slot-a" }] }] };
class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
function mcpHarness() {
  const state = structuredClone(eventState);
  const calls = [];
  const route = evaluate(compile("../app/mcp/route.ts"), {
    zod: { z },
    "@/lib/proposal-review-link": links,
    "@/lib/change-requests": { async listPendingChangeRequests() { return []; } },
    "@/lib/mcp-events": {},
    "@/lib/decisions": { async proposePlans(value, text) { calls.push(["compare", structuredClone(value), text]); return structuredClone(planResult); } },
    "@/lib/planner": { computeSchedule(value) { calls.push(["schedule"]); return { rows: value.slots, violations: [], bufferMinutes: 40 }; } },
    "@/lib/agent-proposals": { getAgentContext() { assert.fail("Old tools must not require added context tools"); }, publishAgentProposal() { assert.fail("Old read-only tools must not write any proposal"); } },
    "@/lib/server-store": {
      HttpError,
      checkBrowserOrigin() { calls.push(["origin"]); },
      async getPrivateCallerContext() { calls.push(["auth"]); },
      async readJsonBody(request, schema, limit) { calls.push(["body", limit]); return schema.parse(await request.json()); },
      async getEventState() { calls.push(["read-event"]); return state; },
      jsonResponse: (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } }),
    },
  });
  async function rpc(method, params, url = "https://deployed.example.test:8443/mcp/private?token=query-token#private-fragment") {
    const response = await route.POST(new Request(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-Host": "untrusted.example.test" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) }));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    return (await response.json()).result;
  }
  return { calls, state, rpc };
}

test("original three tool schemas, descriptions and read-only annotations stay exactly compatible", async () => {
  const api = mcpHarness();
  const { tools } = await api.rpc("tools/list");
  assert.deepEqual(tools.slice(0, 3), [
    { name: "get_event", description: "タイテ作成ツールに保存されたイベント、現在の進行表、未解決の制約を読み取ります。変更は行いません。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "list_open_issues", description: "現在の進行表の時間・出演条件の制約違反と注意点を確認します。", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "propose_change", description: "進行上の変更を日本語で伝え、保存済みイベントに対する成立する変更案を比較します。提案のみで、進行表には適用しません。例：全体が10分押しています。", inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: 2000, description: "変更対象と時刻・分数がわかる依頼" } }, required: ["text"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true } },
  ]);
  assert.deepEqual(tools.slice(3).map((tool) => tool.name), ["get_agent_context", "publish_change_proposal"]);
  assert.deepEqual(api.state, eventState);
});

test("old propose_change returns its compared result plus a trusted-origin, bounded review intent without writes", async () => {
  const api = mcpHarness();
  const result = await api.rpc("tools/call", { name: "propose_change", arguments: { text: ` ${intent.text} ` } });
  assert.equal(result.isError, false);
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value.plans, planResult.plans);
  assert.equal(value.engine, "decisions");
  assert.equal(value.revision, 4);
  assert.equal(value.applied, false);
  assert.match(value.reviewNotice, /保存済み提案ではなく/);
  assert.match(value.reviewNotice, /最新条件/);
  assert.match(value.reviewNotice, /主催者の承認/);
  const url = new URL(value.reviewUrl);
  assert.equal(url.origin, "https://deployed.example.test:8443");
  assert.equal(url.pathname, "/");
  assert.equal(url.search, "");
  assert.doesNotMatch(value.reviewUrl, /query-token|private-fragment|private\/|untrusted|slots|Compared/);
  assert.deepEqual(parseProposalReviewHash(url.hash), { eventId: "event-a", revision: 4, text: intent.text });
  assert.deepEqual(api.calls, [["origin"], ["auth"], ["body", 32 * 1024], ["read-event"], ["compare", eventState, intent.text]]);
  assert.deepEqual(api.state, eventState);
});

test("request origins remain per-call, with no mutable global origin", async () => {
  const api = mcpHarness();
  const origins = ["https://first.example.test", "https://second.example.test"];
  const results = await Promise.all(origins.map((origin) => api.rpc("tools/call", { name: "propose_change", arguments: { text: intent.text } }, `${origin}/mcp`)));
  assert.deepEqual(results.map((result) => new URL(JSON.parse(result.content[0].text).reviewUrl).origin), origins);
  assert.equal(api.calls.filter(([name]) => name === "compare").length, 2);
  assert.deepEqual(api.state, eventState);
});

test("an old review URL preserves replayable intent rather than embedding revision-bound candidates", async () => {
  const api = mcpHarness();
  const first = JSON.parse((await api.rpc("tools/call", { name: "propose_change", arguments: { text: intent.text } })).content[0].text);
  const originalHash = new URL(first.reviewUrl).hash;
  api.state.revision += 1;
  api.state.slots[0].newCondition = "later server condition";
  const next = JSON.parse((await api.rpc("tools/call", { name: "propose_change", arguments: { text: intent.text } })).content[0].text);
  assert.deepEqual(parseProposalReviewHash(originalHash), { eventId: eventState.event.id, revision: 4, text: intent.text });
  assert.deepEqual(parseProposalReviewHash(new URL(next.reviewUrl).hash), { eventId: eventState.event.id, revision: 5, text: intent.text });
  assert.equal(first.reviewUrl, new URL(originalHash, "https://deployed.example.test:8443/").href);
  assert.doesNotMatch(originalHash, /slots|newCondition|Compared|plan/);
  assert.deepEqual(api.calls.filter(([name]) => name === "compare").map(([, state]) => state.revision), [4, 5]);
});

test("legacy event and issue readers still use no planner API calls or proposal storage", async () => {
  const api = mcpHarness();
  const event = JSON.parse((await api.rpc("tools/call", { name: "get_event", arguments: {} })).content[0].text);
  const issues = JSON.parse((await api.rpc("tools/call", { name: "list_open_issues", arguments: {} })).content[0].text);
  assert.deepEqual(event.state, eventState);
  assert.equal(event.storage, "cloud");
  assert.deepEqual(issues, { revision: 4, issues: [], bufferMinutes: 40 });
  assert.equal(api.calls.filter(([name]) => name === "compare").length, 0);
  assert.deepEqual(api.state, eventState);
});

test("invalid legacy change input cannot cause comparison, review generation or storage", async () => {
  const api = mcpHarness();
  const result = await api.rpc("tools/call", { name: "propose_change", arguments: { text: intent.text, plans: [] } });
  assert.equal(result.isError, true);
  assert.equal(api.calls.filter(([name]) => name === "compare" || name === "read-event").length, 0);
  assert.deepEqual(api.state, eventState);
});
