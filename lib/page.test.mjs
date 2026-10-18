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

test("the closed settings menu contains only appearance, connections and sample reset", () => {
  const menu = html.match(/<details class="utility-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.doesNotMatch(menu[1], /\bopen(?:=|\s|$)/);
  assert.match(menu[2], /<summary[^>]*aria-label="表示・連携設定"/);
  for (const label of ["連携・保存", "サンプルに戻す"]) assert.ok(plainText(menu[2]).includes(label), label);
  for (const label of ["イベント設定", "変更履歴", "CSVを書き出す", "バックアップ", "新しいイベント", "枠を追加"]) assert.ok(!plainText(menu[2]).includes(label), label);
  assert.equal((menu[2].match(/<button\b/g) ?? []).length, 2);
  assert.doesNotMatch(menu[2], /その他の操作|lucide-ellipsis/);
});

test("primary actions appear exactly once in their relevant page contexts", () => {
  const topbar = html.match(/<header class="minimal-topbar">([\s\S]*?)<\/header>/)?.[1] ?? "";
  const heading = main.match(/<div class="event-heading">([\s\S]*?)<form class="change-form"/)?.[1] ?? "";
  const toolbar = main.match(/<div class="table-toolbar">([\s\S]*?)<div class="run-table-scroll"/)?.[1] ?? "";
  assert.match(topbar, /class="button secondary small new-event-button"/);
  assert.ok(plainText(topbar).includes("新しいイベント"));
  assert.doesNotMatch(plainText(topbar), /変更履歴|枠を追加|書き出し/);
  assert.match(heading, /<div class="event-title-row"><h1>Community Day 2026<\/h1><button[^>]*aria-label="イベント設定"/);
  assert.ok(plainText(heading).includes("変更履歴"));
  assert.match(toolbar, /class="table-tools" role="group" aria-label="タイムテーブルの操作"/);
  for (const label of ["枠を追加", "書き出し", "表示する進行枠"]) assert.ok(plainText(toolbar).includes(label), label);
  for (const label of ["新しいイベント", "変更履歴", "枠を追加", "CSVを書き出す", "バックアップ（JSON）"]) assert.equal(plainText(html).split(label).length - 1, 1, label);
  assert.equal((html.match(/aria-label="イベント設定"/g) ?? []).length, 1);
});

test("exports have a dedicated closed-by-default menu with CSV and JSON choices", () => {
  const menu = html.match(/<details class="export-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.doesNotMatch(menu[1], /\bopen(?:=|\s|$)/);
  assert.match(menu[2], /<summary[^>]*aria-label="書き出し"/);
  assert.match(menu[2], /class="export-popover"/);
  assert.equal((menu[2].match(/<button\b/g) ?? []).length, 2);
  for (const label of ["CSVを書き出す", "バックアップ（JSON）"]) assert.ok(plainText(menu[2]).includes(label), label);
  assert.doesNotMatch(plainText(menu[2]), /新しいイベント|変更履歴|連携・保存/);
});

test("new actions have decorative icons while icon-only controls retain accessible names", () => {
  const controls = [...html.matchAll(/<(button|summary)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  for (const label of ["新しいイベント", "表示・連携設定", "イベント設定", "変更履歴", "枠を追加", "書き出し", "CSVを書き出す", "バックアップ（JSON）", "連携・保存", "サンプルに戻す"]) {
    const control = controls.find(([, , attributes, content]) => attributes.includes(`aria-label="${label}"`) || plainText(content) === label);
    assert.ok(control, label);
    assert.match(control[3], /<svg[^>]*aria-hidden="true"/, label);
  }
  assert.match(html, /<summary[^>]*aria-label="表示・連携設定"[^>]*title="表示・連携設定"/);
  assert.match(html, /<button[^>]*aria-label="イベント設定"[^>]*title="イベント設定を編集"/);
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

// Exercise real page callbacks with in-memory hooks. Do not mount the page or
// run its loading effect: these checks never contact APIs or browser storage.
function pageActions() {
  const hooks = [];
  let cursor = 0;
  const effects = [];
  const hooksReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = initial === "loading" ? "saved" : typeof initial === "function" ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(compute) { return compute(); },
    useEffect(effect) { effects.push(effect); },
  };
  const { default: Home } = compile("../app/page.tsx", {
    react: hooksReact, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl,
  });
  return {
    render() { cursor = 0; effects.length = 0; return Home(); },
    effects,
    event() { return hooks[0]; },
  };
}
function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props.children, predicate)];
}
function textOf(tree) {
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (React.isValidElement(tree)) return textOf(tree.props.children);
  return typeof tree === "string" || typeof tree === "number" ? String(tree) : "";
}
const buttonNamed = (tree, name) => elements(tree, node => node.type === "button" && textOf(node) === name)[0];
function withGlobals(values, action) {
  const originals = Object.fromEntries(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try { return action(); }
  finally {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
function attachMenus(tree) {
  return ["utility-menu", "export-menu"].map(className => {
    const element = elements(tree, node => node.type === "details" && node.props.className === className)[0];
    const inside = {};
    const menu = { open: false, focused: false, inside, contains: target => target === inside, querySelector: selector => {
      assert.equal(selector, "summary");
      return { focus() { menu.focused = true; } };
    } };
    element.props.ref.current = menu;
    return menu;
  });
}

test("opening and cancelling a new event never mutates the saved timetable", () => {
  const page = pageActions(), initial = page.render(), [utility, exports] = attachMenus(initial);
  const snapshot = JSON.stringify(page.event());
  utility.open = exports.open = true;
  withGlobals({
    fetch() { assert.fail("opening a dialog must not call an API"); },
    localStorage: { setItem() { assert.fail("opening a dialog must not write storage"); } },
  }, () => {
    const create = buttonNamed(initial, "新しいイベント");
    assert.equal(create.props.disabled, false);
    create.props.onClick();
    assert.equal(utility.open, false);
    assert.equal(exports.open, false);
    const dialog = elements(page.render(), node => typeof node.type === "function" && node.props.title === "新しいイベント")[0];
    assert.ok(dialog);
    assert.ok(buttonNamed(dialog, "現在のイベントをバックアップ"));
    dialog.props.onClose();
    assert.equal(elements(page.render(), node => node.props.title === "新しいイベント").length, 0);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("connections do not duplicate exports, while replacement confirmations retain safety backups", () => {
  const page = pageActions();
  let tree = page.render();
  buttonNamed(tree, "連携・保存").props.onClick();
  let dialog = elements(page.render(), node => typeof node.type === "function" && node.props.title === "連携・保存")[0];
  assert.ok(dialog);
  assert.doesNotMatch(textOf(dialog), /バックアップ|CSVを書き出す/);
  dialog.props.onClose();
  tree = page.render();
  buttonNamed(tree, "サンプルに戻す").props.onClick();
  dialog = elements(page.render(), node => typeof node.type === "function" && node.props.title === "サンプルに戻しますか？")[0];
  assert.ok(buttonNamed(dialog, "バックアップを書き出す"));
});

test("both native menus close on outside clicks and Escape returns focus to the open summary", () => {
  const page = pageActions(), tree = page.render(), [utility, exports] = attachMenus(tree), listeners = new Map();
  withGlobals({ document: {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
  } }, () => {
    const cleanup = page.effects[0]();
    utility.open = exports.open = true;
    listeners.get("click")({ target: utility.inside });
    assert.equal(utility.open, true);
    assert.equal(exports.open, false);
    utility.open = exports.open = true;
    listeners.get("click")({ target: {} });
    assert.equal(utility.open, false);
    assert.equal(exports.open, false);
    for (const menu of [utility, exports]) {
      menu.open = true;
      let prevented = false;
      listeners.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
      assert.equal(menu.open, false);
      assert.equal(menu.focused, true);
      assert.equal(prevented, true);
    }
    cleanup();
    assert.equal(listeners.size, 0);
  });
});

test("CSV and JSON export callbacks download the original event without mutating it", async () => {
  const page = pageActions(), tree = page.render(), [utility, exports] = attachMenus(tree), files = [], revoked = [], clicks = [];
  const snapshot = JSON.stringify(page.event());
  const createObjectURL = URL.createObjectURL, revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = blob => { files.push(blob); return "blob:local-test"; };
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    withGlobals({
      document: { createElement(tag) { assert.equal(tag, "a"); return { click() { clicks.push({ href: this.href, download: this.download }); } }; } },
      setTimeout() { return 1; }, clearTimeout() {},
      fetch() { assert.fail("exports must not call an API"); },
      localStorage: { setItem() { assert.fail("exports must not write storage"); } },
    }, () => {
      for (const label of ["CSVを書き出す", "バックアップ（JSON）"]) {
        utility.open = exports.open = true;
        const button = buttonNamed(tree, label);
        assert.equal(button.props.disabled, false);
        button.props.onClick();
        assert.equal(utility.open, false);
        assert.equal(exports.open, false);
      }
    });
  } finally { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; }
  assert.deepEqual(clicks.map(file => file.download), [`timetable-${demo.demoState.event.date}.csv`, `timetable-${demo.demoState.event.date}.json`]);
  assert.deepEqual(revoked, ["blob:local-test", "blob:local-test"]);
  assert.match(await files[0].text(), /開始,終了,タイトル,出演者・グループ/);
  assert.deepEqual(JSON.parse(await files[1].text()), demo.demoState);
  assert.equal(JSON.stringify(page.event()), snapshot);
});
