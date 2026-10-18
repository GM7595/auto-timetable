import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";
import { z } from "zod";

// Real generated migrations, store SQL, and routes in an isolated SQLite
// database. No live event, secret, network request, or browser is involved.
const initial = {
  event: { id: "event-a", name: "Event A", date: "2026-10-18", location: "Tokyo", startTime: 840, endTime: 960, quietWindows: [] },
  slots: [{ id: "a", title: "Talk", group: "", kind: "talk", durationMinutes: 10, changeoverMinutes: 0, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "" }],
  history: [{ id: "history-a", at: "2026-10-18T00:00:00Z", title: "A history", detail: "A only", kind: "create" }], revision: 4,
};
const other = (id, revision = 4) => ({ ...structuredClone(initial), event: { ...initial.event, id, name: `Event ${id}`, location: "Osaka" },
  slots: [], history: [{ id: `history-${id}`, at: "2026-10-18T01:00:00Z", title: `${id} history`, detail: `${id} only`, kind: "create" }], revision });
function compile(path) { return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText; }
function evaluate(source, dependencies) {
  const module = { exports: {} };
  new Function("require", "module", "exports", source)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const compiledStore = compile("./server-store.ts");
const compiledRoute = compile("../app/api/events/route.ts");
function harness({ seed = initial, beforeBatch, failStatement, unavailable = false } = {}) {
  const db = new DatabaseSync(":memory:");
  const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) db.exec(readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), "utf8"));
  const sql = [];
  let identityReads = 0;
  const directState = (state) => db.prepare("INSERT OR REPLACE INTO cue_event_state (id, revision, payload, updated_at) VALUES ('primary', ?, ?, '2026-10-18T00:00:00.000Z')").run(state.revision, JSON.stringify(state));
  const directArchive = (state, updatedAt = "2026-10-18T00:00:00.000Z") => db.prepare("INSERT OR REPLACE INTO cue_saved_event (event_id, revision, payload, updated_at) VALUES (?, ?, ?, ?)").run(state.event.id, state.revision, JSON.stringify(state), updatedAt);
  if (seed) directState(seed);
  const adapter = { prepare(statement) {
    sql.push(statement);
    const statementFor = (args = []) => ({
      statement, args,
      bind(...values) { return statementFor(values); },
      async first() { return db.prepare(statement).get(...args) ?? null; },
      async all() { return { results: db.prepare(statement).all(...args) }; },
      async run() { const result = db.prepare(statement).run(...args); return { meta: { changes: Number(result.changes) } }; },
    });
    return statementFor();
  }, async batch(statements) {
    await beforeBatch?.({ db, directState, directArchive });
    db.exec("BEGIN");
    try {
      const results = statements.map((entry, index) => {
        if (index === failStatement) throw new Error("Simulated transactional storage failure");
        const result = db.prepare(entry.statement).run(...entry.args);
        return { meta: { changes: Number(result.changes) } };
      });
      db.exec("COMMIT");
      return results;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  const api = evaluate(compiledStore, {
    "cloudflare:workers": { env: { DB: unavailable ? undefined : adapter } }, zod: { z },
    "@/app/chatgpt-auth": { async getChatGPTUser() { identityReads++; return null; } },
    "@/lib/demo": { demoState: { ...initial, revision: 0 } },
  });
  const route = evaluate(compiledRoute, { zod: { z }, "@/lib/server-store": api, "@/lib/decisions": { decisionsConfigured: () => true } });
  const isCode = (code, status) => error => error instanceof api.HttpError && error.code === code && (status === undefined || error.status === status);
  return { ...api, route, db, sql, isCode, directState, directArchive, identityReads: () => identityReads,
    savedRows: () => db.prepare("SELECT * FROM cue_saved_event ORDER BY event_id").all(),
    stored: () => JSON.parse(db.prepare("SELECT payload FROM cue_event_state WHERE id = 'primary'").get().payload),
  };
}

test("existing active data is listed lazily without a migration or read-time archive write", async () => {
  const api = harness();
  const events = await api.listEvents();
  assert.deepEqual(events, [{ id: "event-a", name: "Event A", date: "2026-10-18", location: "Tokyo", startTime: 840, endTime: 960, slotCount: 1, updatedAt: "2026-10-18T00:00:00.000Z" }]);
  assert.equal(api.savedRows().length, 0);
  assert.ok(api.sql.every(statement => /^(?:SELECT|WITH)/.test(statement)));
  assert.deepEqual(api.stored(), initial);
});

test("empty storage seeds only the current pointer and the library immediately includes it", async () => {
  const api = harness({ seed: null });
  assert.equal((await api.listEvents())[0].id, initial.event.id);
  assert.equal(api.stored().revision, 0);
  assert.equal(api.savedRows().length, 0);
  assert.ok(api.sql.filter(statement => !/^(?:SELECT|WITH)/.test(statement)).every(statement => statement.startsWith("INSERT OR IGNORE INTO cue_event_state")));
});

test("list deduplicates active data and never lets an old archive replace its summary", async () => {
  const api = harness();
  api.directArchive({ ...initial, event: { ...initial.event, name: "Stale name" }, revision: 1 });
  api.directArchive(other("event-b"));
  const events = await api.listEvents();
  assert.equal(events.length, 2);
  assert.equal(events.find(event => event.id === "event-a").name, "Event A");
  assert.equal(api.savedRows().length, 2);
});

test("creating a new event preserves both independent histories and snapshots atomically", async () => {
  const api = harness();
  const created = await api.saveEventState(other("event-b"), 4);
  assert.equal(created.conflict, false);
  assert.equal(created.state.revision, 5);
  assert.equal(created.state.event.id, "event-b");
  const rows = api.savedRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].payload), initial);
  assert.deepEqual(JSON.parse(rows[1].payload), created.state);
  assert.deepEqual(created.state.history, other("event-b").history);
});

test("switch, edit, and switch back preserve event-specific contents and global revisions", async () => {
  const api = harness();
  const b = (await api.saveEventState(other("event-b"), 4)).state;
  const a = (await api.switchEventState("event-a", 5)).state;
  assert.deepEqual(a, { ...initial, revision: 6 });
  const edited = { ...a, event: { ...a.event, name: "Updated A" }, history: [...a.history, { id: "a-edit", at: "2026-10-18T02:00:00Z", title: "A edit", detail: "", kind: "edit" }] };
  assert.equal((await api.saveEventState(edited, 6)).state.revision, 7);
  const restoredB = (await api.switchEventState("event-b", 7)).state;
  assert.deepEqual(restoredB, { ...b, revision: 8 });
  assert.ok(restoredB.history.every(entry => !entry.id.startsWith("a-")));
  const restoredA = (await api.switchEventState("event-a", 8)).state;
  assert.deepEqual(restoredA, { ...edited, revision: 9 });
  assert.equal((await api.listEvents()).length, 2);
});

test("opening the active event is a no-op and does not rewrite archived snapshots", async () => {
  const api = harness();
  assert.deepEqual(await api.switchEventState("event-a", 4), { state: initial, conflict: false });
  assert.equal(api.savedRows().length, 0);
  assert.ok(api.sql.every(statement => /^SELECT/.test(statement)));
});

test("a reused event ID cannot overwrite an inactive saved event through normal save", async () => {
  const api = harness();
  await api.saveEventState(other("event-b"), 4);
  const before = api.savedRows();
  await assert.rejects(api.saveEventState({ ...initial, revision: 5 }, 5), api.isCode("event_exists", 409));
  assert.deepEqual(api.savedRows(), before);
  assert.equal(api.stored().event.id, "event-b");
});

test("stale saves and stale switches return the latest state without changing either snapshot", async () => {
  const api = harness();
  await api.saveEventState(other("event-b"), 4);
  const before = api.savedRows();
  for (const response of [await api.saveEventState({ ...initial }, 4), await api.switchEventState("event-a", 4)]) {
    assert.equal(response.conflict, true);
    assert.equal(response.state.event.id, "event-b");
    assert.equal(response.state.revision, 5);
  }
  assert.deepEqual(api.savedRows(), before);
});

test("a revision race before the transaction cannot archive stale data or overwrite a winning update", async () => {
  const winning = { ...initial, event: { ...initial.event, name: "Winning update" }, revision: 5 };
  const api = harness({ beforeBatch({ directState, directArchive }) { directState(winning); directArchive(winning); } });
  const result = await api.saveEventState(other("event-b"), 4);
  assert.deepEqual(result, { state: winning, conflict: true });
  assert.equal(api.savedRows().length, 1);
  assert.deepEqual(JSON.parse(api.savedRows()[0].payload), winning);
});

test("concurrent creates from one revision keep exactly one winner and retain the previous event", async () => {
  const api = harness();
  const results = await Promise.all([api.saveEventState(other("event-b"), 4), api.saveEventState(other("event-c"), 4)]);
  assert.equal(results.filter(result => !result.conflict).length, 1);
  assert.equal(api.savedRows().length, 2);
  assert.deepEqual(JSON.parse(api.savedRows().find(row => row.event_id === "event-a").payload), initial);
  assert.equal(api.stored().revision, 5);
});

test("a failed archive statement rolls the pointer and both snapshots back together", async () => {
  const api = harness({ failStatement: 2 });
  await assert.rejects(api.saveEventState(other("event-b"), 4), /transactional storage failure/);
  assert.deepEqual(api.stored(), initial);
  assert.deepEqual(api.savedRows(), []);
});

for (const eventId of ["", "x".repeat(121), null, 7]) {
  test(`invalid event ID is rejected: ${String(eventId).slice(0, 20)}`, async () => {
    const api = harness();
    await assert.rejects(api.switchEventState(eventId, 4), api.isCode("invalid_event_id", 422));
    assert.deepEqual(api.sql, []);
  });
}

test("unknown IDs, including SQL-looking text, never select another event", async () => {
  const api = harness();
  for (const id of ["not-saved", "event-a' OR 1=1 --"]) await assert.rejects(api.switchEventState(id, 4), api.isCode("event_not_found", 404));
  assert.deepEqual(api.stored(), initial);
  assert.equal(api.savedRows().length, 0);
});

for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, NaN]) {
  test(`invalid switch revision is rejected: ${revision}`, async () => {
    const api = harness();
    await assert.rejects(api.switchEventState("event-a", revision), api.isCode("invalid_revision", 422));
    assert.deepEqual(api.sql, []);
  });
}

test("the 100-event cap includes a not-yet-archived active event, while existing events remain editable", async () => {
  const api = harness();
  for (let index = 0; index < 99; index++) api.directArchive(other(`saved-${index}`));
  await assert.rejects(api.saveEventState(other("event-b"), 4), api.isCode("event_capacity", 409));
  assert.equal(api.savedRows().length, 99);
  assert.equal((await api.listEvents()).length, 100);
  const result = await api.saveEventState({ ...initial, event: { ...initial.event, name: "Can still edit" } }, 4);
  assert.equal(result.conflict, false);
  assert.equal(api.savedRows().length, 100);
  assert.equal((await api.switchEventState("saved-0", 5)).state.event.id, "saved-0");
});

test("malformed saved payloads fail closed without changing active data", async () => {
  for (const variant of ["not-json", JSON.stringify({ ...initial, revision: 1 }), JSON.stringify({ ...initial, event: { ...initial.event, id: "wrong-id" } })]) {
    const api = harness();
    api.db.prepare("INSERT INTO cue_saved_event VALUES ('event-b', 4, ?, '2026-10-18T00:00:00.000Z')").run(variant);
    await assert.rejects(api.switchEventState("event-b", 4), api.isCode("storage_invalid", 503));
    await assert.rejects(api.listEvents(), api.isCode("storage_invalid", 503));
    assert.deepEqual(api.stored(), initial);
  }
});

test("GET and POST use the owner-private caller boundary, no-store responses, and strict JSON input", async () => {
  const api = harness();
  const request = new Request("https://private.test/api/events");
  const listed = await api.route.GET(request);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("Cache-Control"), "no-store");
  assert.equal((await listed.json()).events[0].id, "event-a");
  api.directArchive(other("event-b"));
  const switched = await api.route.POST(new Request(request.url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://private.test" }, body: JSON.stringify({ eventId: "event-b", expectedRevision: 4 }) }));
  const body = await switched.json();
  assert.equal(switched.status, 200);
  assert.equal(body.storage, "cloud");
  assert.equal(body.aiConfigured, true);
  assert.equal(body.state.event.id, "event-b");
  assert.equal(body.state.revision, 5);
  assert.equal(api.identityReads(), 2);
});

test("a rejected private caller cannot list or switch event records", async () => {
  const api = harness();
  const route = evaluate(compiledRoute, { zod: { z }, "@/lib/decisions": { decisionsConfigured() { assert.fail("Rejected callers cannot inspect configuration"); } },
    "@/lib/server-store": { ...api, async getPrivateCallerContext() { throw new api.HttpError(403, "Access denied", "access_denied"); } } });
  for (const method of ["GET", "POST"]) {
    const response = await route[method](new Request("https://private.test/api/events", { method }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "access_denied");
  }
  assert.deepEqual(api.sql, []);
  assert.deepEqual(api.stored(), initial);
});

for (const method of ["GET", "POST"]) {
  for (const headers of [{ Origin: "https://other.test" }, { "Sec-Fetch-Site": "cross-site" }]) {
    test(`${method} rejects cross-site requests before storage or identity calls`, async () => {
      const api = harness();
      const response = await api.route[method](new Request("https://private.test/api/events", { method, headers }));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "origin_rejected");
      assert.equal(api.identityReads(), 0);
      assert.deepEqual(api.sql, []);
    });
  }
}

test("switch route exposes a revision conflict with the current authoritative state", async () => {
  const api = harness();
  const response = await api.route.POST(new Request("https://private.test/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId: "event-b", expectedRevision: 3 }) }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "revision_conflict");
  assert.deepEqual(body.state, initial);
  assert.equal(api.savedRows().length, 0);
});

for (const body of [{ eventId: "event-a", expectedRevision: 4, extra: true }, { eventId: "event-a", expectedRevision: -1 }, { expectedRevision: 4 }, { eventId: "", expectedRevision: 4 }]) {
  test(`switch route rejects malformed payload before writes: ${JSON.stringify(body)}`, async () => {
    const api = harness();
    const response = await api.route.POST(new Request("https://private.test/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "invalid_payload");
    assert.deepEqual(api.sql, []);
  });
}

test("missing storage produces a bounded 503 response", async () => {
  const api = harness({ unavailable: true });
  const response = await api.route.GET(new Request("https://private.test/api/events"));
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "storage_unavailable");
});

test("the new generated migration is schema-only, with no data rewrites or backfill", () => {
  const sql = readFileSync(new URL("../drizzle/0005_daffy_lester.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE `cue_saved_event`/);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|DROP)\b/i);
  assert.match(sql, /CREATE INDEX/);
});
