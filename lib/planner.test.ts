import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Native Node TypeScript execution requires the .ts extension.
import { computeSchedule, formatTime, generatePlans, parseIssue, parseTime } from "./planner.ts";
// @ts-expect-error Native Node TypeScript execution requires the .ts extension.
import { demoState, createEmptyState } from "./demo.ts";
import type { EventState } from "./types";

function fresh(): EventState { return structuredClone(demoState); }

test("demo is feasible and preserves the specified current progress", () => {
  const schedule = computeSchedule(fresh());
  assert.deepEqual(schedule.violations, []);
  assert.equal(schedule.rows[0].start, 14 * 60);
  assert.equal(schedule.rows[1].start, 14 * 60 + 15);
  assert.equal(schedule.rows[2].start, 14 * 60 + 45);
  assert.equal(schedule.bufferMinutes, 40);
});

test("quiet windows shift an entire performance, without splitting it", () => {
  const state = fresh();
  state.slots = state.slots.slice(0, 4);
  state.slots[3].durationMinutes = 20;
  const row = computeSchedule(state).rows[3];
  assert.equal(row.start, 15 * 60 + 40);
  assert.equal(row.end, 16 * 60);
});

test("fixed starts stay anchored and impossible overlaps are reported", () => {
  const state = fresh();
  state.slots[3].locked = true;
  const proposed = structuredClone(state.slots);
  proposed[2].durationMinutes += 10;
  const schedule = computeSchedule(state, proposed);
  assert.equal(schedule.rows[3].start, 15 * 60 + 20);
  assert.ok(schedule.violations.some((item) => item.code === "fixed-overlap"));
});

test("hard end and performer availability cannot be silently violated", () => {
  const state = fresh();
  state.slots[6].durationMinutes = 100;
  state.slots[5].latestEnd = 16 * 60;
  const errors = computeSchedule(state).violations;
  assert.ok(errors.some((item) => item.code === "hard-end"));
  assert.ok(errors.some((item) => item.code === "availability"));
});

test("three supported quick inputs resolve to concrete issues", () => {
  const state = fresh();
  assert.deepEqual(parseIssue("いまの進行が10分押しています", state), { kind: "delay", slotId: "workshop", minutes: 10, text: "いまの進行が10分押しています" });
  assert.equal(parseIssue("次の登壇者が15分遅れます", state)?.slotId, "lightning");
  assert.equal(parseIssue("全体を10分短縮したい", state)?.kind, "shorten");
  assert.equal(parseIssue("いい感じにして", state), null);
  assert.equal(parseIssue("知らないバンドが10分遅れます", state), null);
  assert.equal(parseIssue("ライトニングトークは16:10まで出演できません", state)?.until, 970);
  assert.equal(parseIssue("ライトニングトークは16:10以降は出演できません", state), null);
  assert.equal(parseIssue("ライトニングトークは16:10まで出演できます", state), null);
  assert.equal(parseIssue("ライトニングトークは16:80まで出演できません", state), null);
});

test("replanning keeps completed/current content and returns deterministic feasible options", () => {
  const state = fresh();
  const issue = parseIssue("次の登壇者が15分遅れます", state)!;
  const plans = generatePlans(state, issue);
  assert.ok(plans.length > 0);
  assert.deepEqual(plans, generatePlans(state, issue));
  for (const plan of plans) {
    assert.equal(plan.schedule.violations.filter((item) => item.severity === "error").length, 0);
    assert.deepEqual(plan.slots.slice(0, 3), state.slots.slice(0, 3));
    assert.deepEqual(plan.slots.map((item) => item.id).sort(), state.slots.map((item) => item.id).sort());
    assert.ok(plan.schedule.rows.find((item) => item.id === "lightning")!.start >= 935);
  }
  assert.equal(state.slots[3].earliestStart, undefined);
});

test("overall shortening removes exactly the requested time without deleting slots", () => {
  const state = fresh();
  const plans = generatePlans(state, parseIssue("全体を10分短縮したい", state)!);
  assert.ok(plans.length > 0);
  const before = state.slots.reduce((sum, item) => sum + item.durationMinutes, 0);
  for (const plan of plans) {
    assert.equal(before - plan.slots.reduce((sum, item) => sum + item.durationMinutes, 0), 10);
    assert.equal(plan.slots.length, state.slots.length);
    assert.deepEqual(plan.slots.slice(0, 3), state.slots.slice(0, 3));
  }
});

test("unresolvable conditions stay visible and unsupported issues create no plans", () => {
  const state = fresh();
  const plans = generatePlans(state, { kind: "unavailable", slotId: "live", until: 18 * 60, text: "18時まで不在" });
  assert.ok(plans[0].schedule.violations.some((item) => item.code === "hard-end"));
  assert.equal(plans.length, 1);
  assert.deepEqual(generatePlans(state, { kind: "note", text: "いい感じにして" }), []);
});

test("time helpers and empty events handle invalid/empty input", () => {
  assert.equal(parseTime("09:05"), 545);
  assert.equal(formatTime(545), "09:05");
  assert.ok(Number.isNaN(parseTime("24:00")));
  assert.ok(Number.isNaN(parseTime("12:80")));
  const empty = computeSchedule(createEmptyState());
  assert.equal(empty.rows.length, 0);
  assert.equal(empty.bufferMinutes, 210);
});

test("large programs use a bounded search and retain every entry", () => {
  const state = createEmptyState();
  state.event.endTime = 2600;
  state.slots = Array.from({ length: 80 }, (_, index) => ({
    ...structuredClone(demoState.slots[3]), id: `entry-${index}`, title: `Session ${index}`, status: "planned" as const, durationMinutes: 10, changeoverMinutes: 1,
  }));
  const plans = generatePlans(state, { kind: "delay", slotId: "entry-0", minutes: 10, text: "delay first entry" });
  assert.ok(plans.length > 0);
  assert.equal(plans[0].slots.length, 80);
  assert.equal(new Set(plans[0].slots.map((item) => item.id)).size, 80);
});

test("fixed starts persist after applying, serializing, and reopening reordered plans", () => {
  const state = createEmptyState();
  state.event.startTime = 0;
  state.event.endTime = 200;
  const base = { ...structuredClone(demoState.slots[3]), changeoverMinutes: 0, people: [], equipment: [] };
  state.slots = [
    { ...base, id: "long", title: "Long", durationMinutes: 20 },
    { ...base, id: "fixed", title: "Fixed", durationMinutes: 20, locked: true },
    { ...base, id: "short", title: "Short", durationMinutes: 10 },
  ];
  const plans = generatePlans(state, { kind: "delay", slotId: "long", minutes: 10, text: "long is delayed" });
  assert.ok(plans.length > 0);
  for (const plan of plans) {
    assert.equal(plan.schedule.violations.filter((item) => item.severity === "error").length, 0);
    assert.equal(plan.slots.find((slot) => slot.id === "fixed")!.fixedStart, 20);
    const reopened: EventState = JSON.parse(JSON.stringify({ ...state, slots: plan.slots }));
    const persisted = computeSchedule(reopened);
    assert.equal(persisted.rows.find((row) => row.id === "fixed")!.start, 20);
    assert.deepEqual(persisted.rows.map((row) => [row.id, row.start, row.end]), plan.schedule.rows.map((row) => [row.id, row.start, row.end]));
  }
});

test("successive delays retain an explicit closing after future program content", () => {
  let state = fresh();
  const first = generatePlans(state, parseIssue("いまの進行が10分押しています", state)!)[0];
  state = { ...state, slots: first.slots };
  state.slots.push({ ...structuredClone(demoState.slots[3]), id: "extra", title: "追加セッション", durationMinutes: 5, changeoverMinutes: 0 });
  const plans = generatePlans(state, parseIssue("次の登壇者が15分遅れます", state)!);
  assert.ok(plans.length > 0);
  for (const plan of plans) {
    const closingIndex = plan.slots.findIndex((slot) => slot.id === "closing");
    assert.ok(closingIndex > plan.slots.findIndex((slot) => slot.id === "live"));
    assert.ok(closingIndex > plan.slots.findIndex((slot) => slot.id === "extra"));
  }
});

test("closing preference remains soft when availability requires a different order", () => {
  const state = createEmptyState();
  state.event.startTime = 0;
  state.event.endTime = 100;
  const base = { ...structuredClone(demoState.slots[3]), changeoverMinutes: 0, people: [], equipment: [] };
  state.slots = [
    { ...base, id: "talk", title: "Talk", durationMinutes: 20 },
    { ...base, id: "closing", title: "Closing remarks", durationMinutes: 10, latestEnd: 10 },
  ];
  const plans = generatePlans(state, { kind: "delay", slotId: "talk", minutes: 10, text: "talk delayed" });
  assert.ok(plans.length > 0);
  assert.equal(plans[0].slots[0].id, "closing");
  assert.equal(plans[0].schedule.violations.filter((item) => item.severity === "error").length, 0);
});
