import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Generate real jsPDF/AutoTable documents. The wrapper only records actual text
// calls and document metadata so Japanese content and pagination are observable
// without depending on a host-installed PDF parser in the repository test suite.
const projectRequire = createRequire(import.meta.url);
const { jsPDF } = projectRequire("jspdf");
const autoTableModule = projectRequire("jspdf-autotable");
const fontBytes = new Uint8Array(readFileSync(new URL("../public/fonts/NotoSansJP-Regular.ttf", import.meta.url)));

function builder() {
  const documents = [];
  const tables = [];
  function RecordedPdf(...args) {
    const doc = new jsPDF(...args);
    const calls = [];
    const text = doc.text.bind(doc);
    doc.text = (value, x, y, ...rest) => {
      calls.push({ lines: Array.isArray(value) ? [...value] : [value], x, y, fontSize: doc.getFontSize(), page: doc.internal.getCurrentPageInfo().pageNumber });
      return text(value, x, y, ...rest);
    };
    documents.push({ doc, calls });
    return doc;
  }
  const sourceUrl = new URL("./export-pdf.ts", import.meta.url);
  const source = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
    fileName: sourceUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const module = { exports: {} };
  const dependencies = {
    jspdf: { jsPDF: RecordedPdf },
    "jspdf-autotable": { ...autoTableModule, autoTable(doc, options) { tables.push(options); return autoTableModule.autoTable(doc, options); } },
  };
  new Function("require", "module", "exports", source.outputText)(name => Object.hasOwn(dependencies, name) ? dependencies[name] : projectRequire(name), module, module.exports);
  return { build: module.exports.buildTimetablePdf, documents, tables };
}

const row = overrides => ({
  kind: "program", start: 840, end: 860, durationMinutes: 20, title: "アコースティックライブ", group: "Evening Notes",
  members: ["佐藤 太郎 (Vo. / Gt.)", "田中 (Ba.)"], equipment: ["マイク", "ギター"],
  notes: "客席の照明を少し落とします。", locked: true, slotId: "acoustic", ...overrides,
});
const fixture = rows => ({
  event: { name: "秋の音楽祭", date: "2026-11-14", location: "渋谷コミュニティホール", startTime: 840, endTime: 1050 },
  rows: rows ?? [
    row(),
    row({ kind: "changeover", start: 860, end: 865, durationMinutes: 5, title: "転換・準備", group: "第二部", members: [], equipment: [], notes: "", locked: false, slotId: "second" }),
    row({ kind: "wait", start: 865, end: 870, durationMinutes: 5, title: "時間調整・待機", group: "", members: [], equipment: [], notes: "", locked: false, slotId: "second" }),
    row({ start: 870, end: 900, durationMinutes: 30, title: "タイトル未入力のバンド", group: "タイトル未入力のバンド", members: ["みのり (Key.)"], locked: false, slotId: "second" }),
  ],
  endsAt: 900,
});
const textOf = recorded => recorded.calls.flatMap(call => call.lines).join("\n");

async function withFetch(value, callback) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value });
  try { return await callback(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "fetch", previous);
    else delete globalThis.fetch;
  }
}

test("real PDF output embeds Japanese TrueType text, preserves every interval and leaves export data untouched", async () => {
  const data = fixture();
  const original = structuredClone(data);
  const pdf = builder();
  const bytes = await withFetch(() => { throw new Error("injected fonts must not make a request"); }, () => pdf.build(data, fontBytes));
  assert.ok(bytes instanceof Uint8Array);
  const source = Buffer.from(bytes).toString("latin1");
  assert.match(source, /^%PDF-/);
  assert.match(source, /\/FontFile2\b/);
  assert.match(source, /\/ToUnicode\b/);
  assert.match(source, /\/Encoding \/Identity-H/);
  assert.match(source, /%%EOF\s*$/);
  assert.equal(pdf.documents.length, 1);
  assert.equal(pdf.documents[0].doc.getNumberOfPages(), 1);
  const text = textOf(pdf.documents[0]);
  for (const expected of ["秋の音楽祭", "2026年11月14日", "渋谷コミュニティホール", "終了予定: 15:00", "転換・準備", "時間調整・待機", "佐藤 太郎", "Vo. / Gt.", "田中", "みのり", "メモ:", "時刻固定"]) assert.ok(text.includes(expected), expected);
  assert.deepEqual(pdf.tables[0].head, [["時間", "所要", "内容"]]);
  assert.equal(pdf.tables[0].body.length, 4);
  assert.deepEqual(pdf.tables[0].body.map(cells => cells[0]), ["14:00 - 14:20", "14:20 - 14:25", "14:25 - 14:30", "14:30 - 15:00"]);
  assert.equal(pdf.tables[0].body[3][2].split("タイトル未入力のバンド").length - 1, 1, "the model's fallback title is not duplicated as a group line");
  assert.deepEqual(data, original);
});

test("the empty event still downloads a valid one-page A4 PDF with a readable empty state", async () => {
  const pdf = builder();
  const data = fixture([]);
  data.event.location = "";
  const bytes = await pdf.build(data, fontBytes);
  assert.ok(bytes.length > 1000);
  const { doc } = pdf.documents[0];
  assert.equal(doc.getNumberOfPages(), 1);
  assert.ok(Math.abs(doc.internal.pageSize.getWidth() - 210) < 0.1);
  assert.ok(Math.abs(doc.internal.pageSize.getHeight() - 297) < 0.1);
  assert.match(textOf(pdf.documents[0]), /進行枠はまだ登録されていません。/);
  assert.doesNotMatch(textOf(pdf.documents[0]), /会場:|undefined|NaN/);
});

test("many slots and an over-page Japanese note wrap across pages without losing the last content", async () => {
  const pdf = builder();
  const rows = Array.from({ length: 65 }, (_, index) => row({
    slotId: `slot-${index}`, title: `演目${index + 1} 星空とともに`, group: `バンド${index + 1}`,
    start: 600 + index * 10, end: 610 + index * 10, durationMinutes: 10,
    notes: index === 3 ? "長い日本語のメモを省略せずに改ページして表示します。".repeat(180) + "長文末尾確認済み" : index === 64 ? "最終演目の末尾確認済み" : "出演後はすみやかに転換してください。",
  }));
  const data = fixture(rows);
  data.event.name = "長いイベント名も省略せずに日本語で表示するための確認用タイトル".repeat(4);
  data.event.location = "とても長い会場名とフロア案内を行送りしながら表示するための確認".repeat(4);
  const original = structuredClone(data);
  const bytes = await pdf.build(data, fontBytes);
  const recorded = pdf.documents[0];
  const pages = recorded.doc.getNumberOfPages();
  assert.ok(pages >= 5, `pagination stress should create multiple pages, got ${pages}`);
  assert.equal((Buffer.from(bytes).toString("latin1").match(/\/Type \/Page\b/g) ?? []).length, pages);
  const compact = textOf(recorded).replace(/\s/g, "");
  assert.ok(compact.includes("長文末尾確認済み"));
  assert.ok(compact.includes("最終演目の末尾確認済み"));
  for (let page = 1; page <= pages; page++) {
    const calls = recorded.calls.filter(call => call.page === page);
    for (const heading of ["時間", "所要", "内容"]) assert.ok(calls.some(call => call.lines.includes(heading)), `page ${page} repeats ${heading}`);
    assert.ok(calls.some(call => call.lines.includes(`${page} / ${pages}`)), `page ${page} has its footer`);
    assert.ok(calls.every(call => call.fontSize >= 9), "PDF text must not shrink below readable 9pt");
    assert.ok(calls.every(call => call.y > 0 && call.y < 297), "text anchors stay within A4");
  }
  assert.equal(pdf.tables[0].styles.overflow, "linebreak");
  assert.equal(pdf.tables[0].rowPageBreak, "avoid");
  assert.deepEqual(data, original);
});

test("the default font is fetched from the same origin only once and never includes event data", async () => {
  const pdf = builder();
  const requests = [];
  await withFetch(async (...args) => {
    requests.push(args);
    return { ok: true, arrayBuffer: async () => fontBytes.slice().buffer };
  }, async () => {
    const first = await pdf.build(fixture());
    const second = await pdf.build(fixture([]));
    assert.ok(first.length > 1000 && second.length > 1000);
  });
  assert.deepEqual(requests, [["/fonts/NotoSansJP-Regular.ttf", { credentials: "same-origin" }]]);
});

test("failed or non-font responses fail clearly and allow a later retry instead of generating broken Japanese", async () => {
  for (const badResponse of [
    { ok: false, arrayBuffer: async () => fontBytes.buffer },
    { ok: true, arrayBuffer: async () => new TextEncoder().encode("<html>not a font</html>").buffer },
  ]) {
    const pdf = builder();
    let requests = 0;
    await withFetch(async () => ++requests === 1 ? badResponse : { ok: true, arrayBuffer: async () => fontBytes.slice().buffer }, async () => {
      await assert.rejects(pdf.build(fixture()), /日本語フォント/);
      assert.equal(pdf.documents.length, 0, "a font failure must not leave a downloadable broken PDF");
      const bytes = await pdf.build(fixture());
      assert.ok(bytes.length > 1000);
      assert.equal(requests, 2);
    });
  }
  const pdf = builder();
  await assert.rejects(pdf.build(fixture(), new Uint8Array([0, 1, 0, 0])), /日本語フォント/);
  assert.equal(pdf.documents.length, 0);
});
