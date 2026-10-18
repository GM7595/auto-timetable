import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Real server rendering of the page and timetable. Effects never run during
// SSR, so this suite does not touch the browser, APIs, secrets, or storage.
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
const demo = compile("./demo.ts");
const timetable = compile("../components/timetable.tsx", { "@/lib/planner": planner });
const theme = compile("./theme.ts");
const themeControl = compile("../components/theme-control.tsx", { "@/lib/theme": theme });
function render(filter = "all") {
  const reactForPage = filter === "all" ? React : {
    ...React,
    useState(initial) { return React.useState(initial === "all" ? filter : initial); },
  };
  const { default: Home } = compile("../app/page.tsx", {
    react: reactForPage, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl,
  });
  return renderToStaticMarkup(React.createElement(Home));
}
const html = render();
const plainText = markup => markup.replace(/<[^>]+>/g, "");
const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";

test("the header uses a descriptive tool name instead of Cue branding", () => {
  assert.match(html, /<span class="minimal-brand">タイテ作成ツール<\/span>/);
  assert.doesNotMatch(plainText(html), /\bcue\b/i);
});

test("browser metadata uses the same descriptive tool name", () => {
  const { metadata } = compile("../app/layout.tsx", { "./globals.css": {}, "@/lib/theme": theme });
  assert.equal(metadata.title, "タイテ作成ツール");
  assert.doesNotMatch(metadata.description, /\bcue\b/i);
});

test("the initial page has one main timetable and one event-name heading", () => {
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.match(main, /<table class="run-table">/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1>Community Day 2026<\/h1>/);
  assert.doesNotMatch(html, /<h[2-6]\b/);
});

test("change input is one labeled single-line field with a submit action", () => {
  assert.match(main, /<form class="change-form"/);
  assert.match(main, /<label for="issue-input"[^>]*>変更・トラブルの内容<\/label>/);
  assert.match(main, /<input id="issue-input"[^>]*placeholder="変更を入力/);
  assert.match(main, /<button[^>]*type="submit"[^>]*>調整案を作る<\/button>/);
  assert.equal((main.match(/<input\b/g) ?? []).length, 1);
  assert.doesNotMatch(main, /<textarea\b/);
});

test("initial layout has no sidebar, navigation, statistics, hero, or marketing panels", () => {
  assert.doesNotMatch(html, /<(?:aside|nav)\b/);
  assert.doesNotMatch(html, /class="[^"]*(?:sidebar|stats-grid|stat-card|hero|profile|right-rail|assistant-card)[^"]*"/);
  for (const removedCopy of ["ワークスペース", "進行ボード", "予定は、変わるもの。", "YOUR EVENT, IN FLOW", "変化にも、次の一手。", "プログラム進捗"]) assert.ok(!plainText(html).includes(removedCopy), removedCopy);
});

test("secondary utilities live inside a native details menu closed by default", () => {
  const menu = html.match(/<details class="utility-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.doesNotMatch(menu[1], /\bopen(?:=|\s|$)/);
  assert.match(menu[2], /<summary[^>]*aria-label="その他の操作"/);
  for (const label of ["イベント設定", "変更履歴", "CSVを書き出す", "バックアップを書き出す", "連携・保存", "新しいイベント", "サンプルに戻す"]) assert.ok(menu[2].includes(`>${label}</button>`), label);
});

test("appearance options stay inside the closed utility menu", () => {
  const menu = html.match(/<details class="utility-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.match(menu[2], /<label[^>]*for="appearance-theme">表示モード<\/label>/);
  assert.match(menu[2], /<select id="appearance-theme"/);
  for (const [value, label] of [["system", "端末に合わせる"], ["light", "ライト"], ["dark", "ダーク"]]) {
    assert.match(menu[2], new RegExp(`<option value="${value}"[^>]*>${label}</option>`));
  }
  assert.doesNotMatch(main, /appearance-theme/);
});

test("the initial theme script runs in the document head before body content", () => {
  const { default: RootLayout } = compile("../app/layout.tsx", { "./globals.css": {}, "@/lib/theme": theme });
  const markup = renderToStaticMarkup(React.createElement(RootLayout, {}, "content"));
  assert.match(markup, /<html lang="ja"><head><script id="theme-init">/);
  assert.ok(markup.indexOf('id="theme-init"') < markup.indexOf("<body"));
});

test("edit, settings, history, connection and confirmation dialogs are not initially rendered", () => {
  assert.doesNotMatch(html, /role="dialog"|aria-modal="true"|class="modal-backdrop"/);
  assert.doesNotMatch(html, /class="plan-results"/);
  assert.doesNotMatch(html, /class="(?:form-body|history-list|connection-panel)"/);
});

test("all eight original programs are retained in the default table", () => {
  assert.equal((main.match(/class="run-table-slot"/g) ?? []).length, 8);
  for (const slot of demo.demoState.slots) {
    const escapedTitle = slot.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    assert.ok(main.includes(`<strong>${escapedTitle}</strong>`), slot.title);
  }
  assert.match(main, /aria-current="step"/);
  assert.match(main, /タイムテーブル · 8枠/);
  assert.match(main, /<select[^>]*><option value="all" selected="">すべて<\/option>/);
});

test("remaining filter includes current progress, while done filter includes only the two completed slots", () => {
  const remaining = render("remaining");
  assert.equal((remaining.match(/class="run-table-slot"/g) ?? []).length, 6);
  assert.match(remaining, /aria-current="step"/);
  assert.doesNotMatch(remaining, /class="run-table-main run-table-done/);
  const done = render("done");
  assert.equal((done.match(/class="run-table-slot"/g) ?? []).length, 2);
  assert.doesNotMatch(done, /aria-current="step"/);
  // The second completed entry still gets its real setup despite filtering.
  assert.match(done, /class="run-table-transition"/);
});
