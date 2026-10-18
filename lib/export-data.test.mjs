import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function compile(name, dependencies = {}) {
  const output = ts.transpileModule(readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", output)(name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}
const planner = compile("planner"), roles = compile("member-roles");
const { createTimetableExport } = compile("export-data", { "./planner": planner, "./member-roles": roles });
const slot = (id, extra = {}) => ({ id, title: `演目${id}`, group: "バンド", kind: "live", durationMinutes: 20, changeoverMinutes: 5, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "", ...extra });
const fixture = () => ({ event: { id: "test", name: "秋のライブ", date: "2026-11-14", location: "東京", startTime: 840, endTime: 1050, quietWindows: [] }, slots: [slot("a"), slot("b", { earliestStart: 880 })], revision: 7, history: [] });

test("export rows retain real preparation and waiting intervals in chronological order", () => {
  const state = fixture(), before = structuredClone(state);
  const data = createTimetableExport(state);
  assert.deepEqual(data.rows.map(row => [row.kind, row.start, row.end, row.durationMinutes]), [
    ["program", 840, 860, 20], ["changeover", 860, 865, 5], ["wait", 865, 880, 15], ["program", 880, 900, 20],
  ]);
  assert.equal(data.endsAt, 900);
  assert.deepEqual(state, before);
  assert.deepEqual(Object.keys(data.event), ["name", "date", "location", "startTime", "endTime"]);
  assert.ok(!("revision" in data) && !("history" in data));
});

test("titles fall back to group, member order and labels remain readable without decorative emoji", () => {
  const state = fixture();
  state.slots = [slot("a", {
    title: "  ", group: " Evening Notes ", locked: true, fixedStart: 840,
    people: ["山田 太郎", "ひかり", "旧形式"],
    members: [{ name: "山田 太郎", familyName: "山田", givenName: "太郎", roles: ["Vo.", "部長"], roleIcons: { 部長: "👑" } }, { name: "ひかり", givenName: "ひかり", roles: ["Key."] }],
    equipment: ["マイク"], notes: "メモを保持",
  })];
  const row = createTimetableExport(state).rows[0];
  assert.equal(row.title, "Evening Notes");
  assert.deepEqual(row.members, ["山田 太郎 (Vo. / 部長)", "ひかり (Key.)", "旧形式"]);
  assert.deepEqual(row.equipment, ["マイク"]);
  assert.equal(row.notes, "メモを保持"); assert.equal(row.locked, true);
  row.equipment.push("追加"); assert.deepEqual(state.slots[0].equipment, ["マイク"]);
});

test("empty events and midnight times remain representable without fabricated rows", () => {
  const state = fixture(); state.slots = []; state.event.startTime = 0;
  assert.deepEqual(createTimetableExport(state).rows, []);
  assert.equal(createTimetableExport(state).endsAt, 0);
  state.event.startTime = 1430; state.slots = [slot("night")];
  assert.equal(createTimetableExport(state).rows[0].end, 1450);
});

test("document exports lazy-load only their selected generator and return real binary MIME blobs", async () => {
  const calls = [];
  const { createDocumentExport } = compile("export-files", {
    "./export-data": { createTimetableExport },
    "./export-pdf": { async buildTimetablePdf(data) { calls.push(["pdf", data]); return new Uint8Array([37, 80, 68, 70]); } },
    "./export-xlsx": { async buildTimetableXlsx(data) { calls.push(["xlsx", data]); return new Uint8Array([80, 75]); } },
  });
  for (const [format, mime, signature] of [["pdf", "application/pdf", "%PDF"], ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK"]]) {
    const before = calls.length;
    const blob = await createDocumentExport(fixture(), format);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)[0], format);
    assert.equal(blob.type, mime); assert.equal(await blob.text(), signature);
    assert.equal(calls.at(-1)[1].rows.length, 4);
  }
});
