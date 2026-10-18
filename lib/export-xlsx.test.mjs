import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import ExcelJS from "exceljs";

const projectRequire = createRequire(import.meta.url);
const source = readFileSync(new URL("./export-xlsx.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { fileName: "export-xlsx.ts", compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
function generator(library = projectRequire("exceljs")) {
  const module = { exports: {} };
  new Function("require", "module", "exports", "fetch", compiled)(name => {
    assert.equal(name, "exceljs", "the app generator may only depend on the browser workbook library");
    return library;
  }, module, module.exports, () => assert.fail("export must never make an external request"));
  return module.exports.buildTimetableXlsx;
}
const buildTimetableXlsx = generator();

const fixture = () => ({
  event: { name: "秋の音楽祭", date: "2026-11-14", location: "渋谷コミュニティホール", startTime: 840, endTime: 1050 },
  endsAt: 900,
  rows: [
    { kind: "program", slotId: "one", start: 840, end: 865, durationMinutes: 25, title: "最初の一歩へ", group: "Evening Notes", members: ["山田 太郎 (Vo. / Gt.)", "鈴木 花子 (Key. / 部長)"], equipment: ["マイク", "キーボード"], notes: "スライドあり。", locked: true },
    { kind: "changeover", slotId: "two", start: 865, end: 870, durationMinutes: 5, title: "転換・準備", group: "次のバンド", members: [], equipment: [], notes: "", locked: false },
    { kind: "wait", slotId: "two", start: 870, end: 880, durationMinutes: 10, title: "待機", group: "次のバンド", members: [], equipment: [], notes: "音止め終了待ち", locked: false },
    { kind: "program", slotId: "two", start: 880, end: 900, durationMinutes: 20, title: "", group: "次のバンド", members: ["すずき (Dr.)"], equipment: ["ドラム"], notes: "", locked: false },
  ],
});

async function reopen(data) {
  const bytes = await buildTimetableXlsx(data);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(String.fromCharCode(...bytes.slice(0, 2)), "PK", "must be an actual XLSX ZIP package");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  assert.equal(workbook.worksheets.length, 1);
  const sheet = workbook.getWorksheet("タイムテーブル");
  assert.ok(sheet);
  return { bytes, workbook, sheet };
}

function numericTime(cell) {
  // ExcelJS may reopen a formatted numeric time as a Date. Both serialize to a
  // numeric Excel value; the format and absolute day value are checked below.
  return cell.value instanceof Date ? (cell.value.getTime() - Date.UTC(1899, 11, 30)) / 86400000 : cell.value;
}

test("the XLSX snapshot reopens with Japanese metadata, plain members and all program/prep/wait rows", async () => {
  const data = fixture(), before = structuredClone(data);
  const { workbook, sheet } = await reopen(data);
  assert.equal(workbook.title, data.event.name);
  assert.equal(sheet.getCell("A2").value, data.event.name);
  assert.ok(sheet.getCell("B3").value instanceof Date);
  assert.equal(sheet.getCell("B3").value.toISOString(), "2026-11-14T00:00:00.000Z");
  assert.equal(sheet.getCell("B3").numFmt, "yyyy/mm/dd");
  assert.equal(sheet.getCell("E3").value, data.event.location);
  assert.deepEqual(sheet.getRow(6).values.slice(1), ["開始", "終了", "所要(分)", "内容", "出演者・グループ", "メンバー", "設備", "メモ", "時刻固定"]);
  assert.equal(sheet.rowCount, 10);
  for (const [index, item] of data.rows.entries()) {
    const row = sheet.getRow(index + 7);
    assert.ok(Math.abs(numericTime(row.getCell(1)) - item.start / 1440) < 1e-9);
    assert.ok(Math.abs(numericTime(row.getCell(2)) - item.end / 1440) < 1e-9);
    assert.equal(row.getCell(1).numFmt, "[h]:mm");
    assert.equal(row.getCell(2).numFmt, "[h]:mm");
    assert.equal(row.getCell(3).value, item.durationMinutes);
    assert.equal(row.getCell(4).value ?? "", item.title);
    assert.equal(row.getCell(5).value, item.group);
    assert.equal(row.getCell(6).value ?? "", item.members.join("\n"));
    assert.equal(row.getCell(7).value ?? "", item.equipment.join("\n"));
    assert.equal(row.getCell(8).value ?? "", item.notes);
    assert.equal(row.getCell(9).value ?? "", item.locked ? "固定" : "");
  }
  assert.deepEqual(data, before);
  assert.equal(sheet.getCell("F7").value.includes("👤"), false);
  assert.equal(sheet.getCell("A8").fill.fgColor.argb, "FFF0F2F6");
  assert.equal(sheet.getCell("A9").fill.fgColor.argb, "FFFBF6E9");
});

test("Excel layout keeps headers visible, wraps content and prints the complete timetable in landscape", async () => {
  const { sheet } = await reopen(fixture());
  assert.equal(sheet.views[0].state, "frozen");
  assert.equal(sheet.views[0].ySplit, 6);
  assert.equal(sheet.views[0].showGridLines, false);
  assert.equal(sheet.pageSetup.orientation, "landscape");
  assert.equal(sheet.pageSetup.fitToWidth, 1);
  assert.equal(sheet.pageSetup.fitToHeight, 0);
  assert.equal(sheet.pageSetup.printTitlesRow, "6:6");
  assert.equal(sheet.pageSetup.printArea, "A1:I10");
  assert.deepEqual(sheet.model.merges, []);
  assert.equal(sheet.getCell("F7").alignment.wrapText, true);
  assert.ok(sheet.getRow(7).height > sheet.getRow(8).height, "two members require more height than a short prep row");
  assert.ok(sheet.getRow(7).height <= 240);
  assert.ok(sheet.getColumn(6).width > sheet.getColumn(1).width);
});

test("numeric midnight, zero minutes and times after 24:00 retain their actual values", async () => {
  const data = fixture();
  data.event.startTime = 0;
  data.event.endTime = 1560;
  data.endsAt = 1505;
  data.rows = [{ ...data.rows[0], start: 0, end: 0, durationMinutes: 0 }, { ...data.rows[1], start: 1440, end: 1505, durationMinutes: 65 }];
  const { sheet } = await reopen(data);
  assert.equal(numericTime(sheet.getCell("A7")), 0);
  assert.equal(numericTime(sheet.getCell("B7")), 0);
  assert.equal(sheet.getCell("C7").value, 0);
  assert.equal(numericTime(sheet.getCell("B4")), 0);
  assert.ok(Math.abs(numericTime(sheet.getCell("A8")) - 1) < 1e-9);
  assert.ok(Math.abs(numericTime(sheet.getCell("B8")) - 1505 / 1440) < 1e-9);
  assert.ok(Math.abs(numericTime(sheet.getCell("E4")) - 1505 / 1440) < 1e-9);
  assert.equal(sheet.getCell("B8").numFmt, "[h]:mm");
});

test("untrusted-looking strings stay literal and long member/notes content is never truncated", async () => {
  const data = fixture();
  data.event.name = "=EVENT()";
  data.event.location = "+Tokyo";
  data.rows[0] = { ...data.rows[0], title: "=HYPERLINK(\"https://invalid.example\")", group: "+Artist", members: ["@member", "-stage name", "長い名前".repeat(80)], equipment: ["=keyboard"], notes: "=not a formula\n" + "長いメモ".repeat(500) };
  const { sheet } = await reopen(data);
  for (const [address, value] of [["A2", data.event.name], ["E3", data.event.location], ["D7", data.rows[0].title], ["E7", data.rows[0].group], ["F7", data.rows[0].members.join("\n")], ["G7", data.rows[0].equipment.join("\n")], ["H7", data.rows[0].notes]]) {
    const cell = sheet.getCell(address);
    assert.equal(cell.value, value);
    assert.equal(cell.type, ExcelJS.ValueType.String);
    assert.equal(cell.formula, undefined);
    assert.equal(cell.hyperlink, undefined);
  }
  assert.equal(sheet.getRow(7).height, 240, "very long content has a bounded row height while its full cell text remains available");
  sheet.eachRow(row => row.eachCell(cell => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)));
});

test("empty timetables still produce a useful single-sheet workbook with metadata and headers", async () => {
  const data = fixture();
  data.rows = [];
  const { sheet } = await reopen(data);
  assert.equal(sheet.rowCount, 6);
  assert.equal(sheet.pageSetup.printArea, "A1:I6");
  assert.equal(sheet.getCell("D6").value, "内容");
  assert.equal(sheet.getCell("A2").value, data.event.name);
});

test("empty optional text exports as genuinely blank cells rather than empty shared strings", async () => {
  const data = fixture();
  data.event.location = "";
  data.rows = [{ ...data.rows[0], title: "", group: "", members: [], equipment: [], notes: "", locked: false }];
  const { sheet } = await reopen(data);
  for (const address of ["E3", "D7", "E7", "F7", "G7", "H7", "I7"]) assert.equal(sheet.getCell(address).value, null, address);
  assert.equal(sheet.getCell("C7").value, 25);
});

test("the documented prebundled browser Workbook also generates a valid portable XLSX", async () => {
  const buildInBrowser = generator(projectRequire("exceljs/dist/exceljs.min.js"));
  const bytes = await buildInBrowser(fixture());
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet("タイムテーブル");
  assert.equal(sheet.getCell("A2").value, "秋の音楽祭");
  assert.equal(sheet.getCell("F7").value, fixture().rows[0].members.join("\n"));
  assert.equal(sheet.getCell("C7").value, 25);
});
