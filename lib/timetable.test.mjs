import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Compile the actual component and actual formatter in memory: no browser,
// generated source files, network, storage, or API credentials are involved.
const projectRequire = createRequire(import.meta.url);
const React = projectRequire("react");
const { renderToStaticMarkup } = projectRequire("react-dom/server");
function compile(relativePath, dependencies = {}) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(fileUrl, "utf8"), {
    fileName: fileUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const module = { exports: {} };
  const localRequire = name => Object.hasOwn(dependencies, name) ? dependencies[name] : projectRequire(name);
  new Function("require", "module", "exports", compiled.outputText)(localRequire, module, module.exports);
  return module.exports;
}
const planner = compile("./planner.ts");
const { Timetable } = compile("../components/timetable.tsx", { "@/lib/planner": planner });
const slot = (id, overrides = {}) => ({
  id, title: `内容 ${id}`, group: `出演者 ${id}`, kind: "talk", durationMinutes: 10,
  changeoverMinutes: 5, people: [], equipment: [], locked: false, status: "planned",
  energy: 3, notes: "", start: 840, end: 850, changeoverStart: 840, waitMinutes: 0, violations: [], ...overrides,
});
const first = slot("first");
const second = slot("second", { start: 865, end: 875, changeoverStart: 850, waitMinutes: 10 });
function render(rows = [first, second], overrides = {}) {
  return renderToStaticMarkup(React.createElement(Timetable, {
    rows, allRows: rows, originalRows: rows, preview: false, onEdit() {}, onFinishActive() {}, ...overrides,
  }));
}
const plainText = markup => markup.replace(/<[^>]+>/g, "");
const count = (markup, className) => (markup.match(new RegExp(`class="${className}"`, "g")) ?? []).length;

test("renders a semantic timetable with five labeled column headers", () => {
  const html = render();
  assert.match(html, /<table class="run-table">/);
  assert.match(html, /<caption/);
  assert.equal((html.match(/<th scope="col">/g) ?? []).length, 5);
  for (const label of ["時間", "内容・出演者", "所要", "状態", "操作"]) assert.ok(html.includes(`<th scope="col">${label}</th>`));
  assert.match(html, /role="region"[^>]+tabindex="0"/);
});

test("the first full-schedule slot has no preparation even if its raw setup is nonzero", () => {
  const html = render([first]);
  assert.equal(count(html, "run-table-transition"), 0);
  assert.match(plainText(html), /14:00–14:10/);
});

test("filtering out earlier slots does not discard a later slot's preparation", () => {
  const html = render([second], { allRows: [first, second] });
  assert.equal(count(html, "run-table-transition"), 1);
  assert.match(html, /run-table-prep-target">出演者 second/);
  assert.match(plainText(html), /14:10–14:15転換・準備/);
});

test("preparation and waiting have separate, accurate adjacent intervals", () => {
  const html = render();
  const text = plainText(html);
  assert.match(text, /14:10–14:15転換・準備出演者 second5分/);
  assert.match(text, /14:15–14:25時間調整・待機10分/);
  assert.ok(html.indexOf("run-table-transition") < html.indexOf("run-table-wait"));
  assert.ok(html.indexOf("run-table-wait") < html.lastIndexOf("run-table-main"));
  assert.doesNotMatch(text, /待機・音出し不可/);
});

test("only a real active row exposes finish, and identifies current progress accessibly", () => {
  const active = slot("active", { status: "active" });
  const html = render([active]);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /この枠を終了/);
  assert.match(html, /activeを編集/);
  assert.doesNotMatch(render([first]), /この枠を終了/);
});

test("preview disables progress mutation while retaining edit access", () => {
  const active = slot("active", { status: "active" });
  const html = render([active], { preview: true });
  assert.doesNotMatch(html, /この枠を終了/);
  assert.match(html, /activeを編集/);
});

test("warnings and fixed state remain visible as text, with escaped organizer content", () => {
  const html = render([slot("warning", { locked: true, title: "<script>alert(1)</script>", violations: ["固定枠に転換が間に合いません。"] })]);
  assert.match(html, /固定枠に転換が間に合いません。/);
  assert.match(html, />固定</);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a changed preview reports old times, old duration, and order changes", () => {
  const changedSecond = { ...second, start: 900, end: 920, durationMinutes: 20, waitMinutes: 0 };
  const html = render([changedSecond, first], { preview: true, originalRows: [first, second] });
  const text = plainText(html);
  assert.match(text, /15:00–15:20旧 14:25–14:35/);
  assert.match(text, /順番 2 → 1/);
  assert.match(text, /20分旧10分/);
  assert.match(html, /run-table-change-badge">変更/);
});

test("end-only changes are marked and an empty table remains well formed", () => {
  const changed = { ...first, end: 855, durationMinutes: 15 };
  assert.match(plainText(render([changed], { preview: true, originalRows: [first] })), /14:00–14:15旧 14:00–14:10/);
  const empty = render([]);
  assert.match(empty, /<tbody><tr><td colSpan="5" class="run-table-empty">表示する進行枠がありません。/);
});
