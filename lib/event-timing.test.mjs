import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("./event-timing.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const module = { exports: {} };
new Function("module", "exports", compiled.outputText)(module, module.exports);
const { getTimedSchedule, getEventTiming } = module.exports;

const state = {
  event: { id: "event", name: "イベント", date: "2026-11-14", location: "東京", startTime: 840, endTime: 1020, quietWindows: [] },
  slots: [], history: [], revision: 12,
};
const row = (id, overrides = {}) => ({
  id, title: `演目 ${id}`, group: "", kind: "talk", durationMinutes: 10, changeoverMinutes: 5,
  people: [], equipment: [], locked: false, status: "active", energy: 3, notes: "",
  start: 840, end: 850, changeoverStart: 840, waitMinutes: 0, violations: [], ...overrides,
});
const first = row("first", { status: "done" });
const second = row("second", { start: 865, end: 875, changeoverStart: 850, waitMinutes: 10 });
const schedule = { rows: [first, second], endsAt: 875, contentMinutes: 20, changeoverMinutes: 5, violations: [], bufferMinutes: 145 };
const at = time => Date.parse(`2026-11-14T${time}+09:00`);
const statuses = (now, event = state, current = schedule) => getTimedSchedule(event, current, now).rows.map(item => item.status);
const timing = time => getEventTiming(state, schedule, at(time));

test("future event rows stay planned regardless of seeded stored statuses", () => {
  const now = Date.parse("2026-10-18T16:40:00+09:00");
  assert.deepEqual(statuses(now), ["planned", "planned"]);
  assert.deepEqual(getEventTiming(state, schedule, now), {
    phase: "upcoming", label: "開始前", nextSlotId: "first",
    startsAt: at("14:00:00"), endsAt: at("14:35:00"),
  });
  assert.deepEqual(statuses(at("13:59:59.999")), ["planned", "planned"]);
});

test("program start is inclusive and program end is exclusive", () => {
  assert.deepEqual(statuses(at("14:00:00")), ["active", "planned"]);
  assert.deepEqual(statuses(at("14:09:59.999")), ["active", "planned"]);
  assert.deepEqual(statuses(at("14:10:00")), ["done", "planned"]);
  assert.equal(timing("14:00:00").activeSlotId, "first");
  assert.equal(timing("14:00:00").interval, "program");
  assert.equal(timing("14:00:00").label, "演目 first");
});

test("preparation and availability waiting are real progress intervals, not active performances", () => {
  const preparing = timing("14:10:00");
  assert.equal(preparing.phase, "active");
  assert.equal(preparing.interval, "changeover");
  assert.equal(preparing.label, "転換・準備");
  assert.equal(preparing.nextSlotId, "second");
  assert.equal(preparing.activeSlotId, undefined);
  assert.equal(timing("14:14:59.999").interval, "changeover");
  const waiting = timing("14:15:00");
  assert.equal(waiting.phase, "active");
  assert.equal(waiting.interval, "waiting");
  assert.equal(waiting.label, "時間調整・待機");
  assert.equal(waiting.nextSlotId, "second");
  assert.deepEqual(statuses(at("14:24:59.999")), ["done", "planned"]);
});

test("the next program becomes active at its actual start and the whole event ends at its final end", () => {
  assert.deepEqual(statuses(at("14:25:00")), ["done", "active"]);
  assert.equal(timing("14:25:00").activeSlotId, "second");
  assert.equal(timing("14:34:59.999").phase, "active");
  assert.deepEqual(statuses(at("14:35:00")), ["done", "done"]);
  assert.deepEqual(timing("14:35:00"), { phase: "finished", label: "終了", startsAt: at("14:00:00"), endsAt: at("14:35:00") });
});

test("adjacent programs switch without a spurious waiting interval", () => {
  const adjacent = { ...schedule, rows: [first, row("adjacent", { start: 850, end: 860, changeoverMinutes: 0, changeoverStart: 850 })] };
  assert.deepEqual(statuses(at("14:10:00"), state, adjacent), ["done", "active"]);
  const current = getEventTiming(state, adjacent, at("14:10:00"));
  assert.equal(current.interval, "program");
  assert.equal(current.activeSlotId, "adjacent");
});

test("past and future dates are distinguished even at the same wall-clock time", () => {
  const yesterday = Date.parse("2026-11-13T14:05:00+09:00");
  const tomorrow = Date.parse("2026-11-15T14:05:00+09:00");
  assert.deepEqual(statuses(yesterday), ["planned", "planned"]);
  assert.deepEqual(statuses(tomorrow), ["done", "done"]);
  assert.equal(getEventTiming(state, schedule, yesterday).phase, "upcoming");
  assert.equal(getEventTiming(state, schedule, tomorrow).phase, "finished");
});

test("minute offsets beyond midnight preserve the event's Japan calendar date", () => {
  const overnight = { ...schedule, rows: [row("night", { start: 1430, end: 1450, changeoverStart: 1430, durationMinutes: 20 })], endsAt: 1450 };
  assert.deepEqual(statuses(Date.parse("2026-11-14T23:29:59+09:00"), state, overnight), ["planned"]);
  assert.deepEqual(statuses(Date.parse("2026-11-14T23:50:00+09:00"), state, overnight), ["active"]);
  const nextDay = Date.parse("2026-11-15T00:05:00+09:00");
  assert.deepEqual(statuses(nextDay, state, overnight), ["active"]);
  assert.equal(getEventTiming(state, overnight, nextDay).activeSlotId, "night");
  assert.deepEqual(statuses(Date.parse("2026-11-15T00:10:00+09:00"), state, overnight), ["done"]);
});

test("a non-Japan viewing device does not change progress", () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    const equivalentUtc = Date.parse("2026-11-14T05:05:00Z");
    assert.deepEqual(statuses(equivalentUtc), ["active", "planned"]);
    assert.equal(getEventTiming(state, schedule, equivalentUtc).startsAt, Date.parse("2026-11-14T05:00:00Z"));
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test("empty or invalid intervals never claim a program is running", () => {
  assert.deepEqual(getEventTiming(state, { ...schedule, rows: [] }, at("14:00:00")), { phase: "empty", label: "予定なし" });
  const invalid = { ...schedule, rows: [row("invalid", { end: Number.NaN })] };
  assert.deepEqual(statuses(at("14:00:00"), state, invalid), ["planned"]);
  assert.equal(getEventTiming(state, invalid, at("14:00:00")).phase, "empty");
  for (const date of ["2026-02-30", "2026-2-14", "not-a-date", "2026-11-14T00:00:00Z"]) {
    const event = { ...state, event: { ...state.event, date } };
    assert.deepEqual(statuses(at("14:05:00"), event), ["planned", "planned"]);
    assert.equal(getEventTiming(event, schedule, at("14:05:00")).label, "日時を確認");
  }
  assert.deepEqual(statuses(Number.NaN), ["planned", "planned"]);
  assert.equal(getEventTiming(state, schedule, Number.POSITIVE_INFINITY).activeSlotId, undefined);
});

test("clock projection never mutates stored progress, revision, anchors, or schedule", () => {
  const source = structuredClone({ ...state, slots: [first, second] });
  const current = structuredClone(schedule);
  const snapshot = structuredClone({ source, current });
  function freeze(value) {
    if (value && typeof value === "object") {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  }
  freeze(source);
  freeze(current);
  const projected = getTimedSchedule(source, current, at("14:05:00"));
  getEventTiming(source, current, at("14:05:00"));
  assert.notEqual(projected, current);
  assert.notEqual(projected.rows, current.rows);
  assert.notEqual(projected.rows[0], current.rows[0]);
  assert.deepEqual(projected.rows.map(item => item.status), ["active", "planned"]);
  assert.deepEqual({ source, current }, snapshot);
  assert.equal(projected.endsAt, current.endsAt);
  assert.equal(projected.bufferMinutes, current.bufferMinutes);
});
