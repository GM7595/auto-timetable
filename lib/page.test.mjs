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
const dotInstructions = compile("./dots-instructions.ts");
const proposalReviewLink = compile("./proposal-review-link.ts");
function render(filter = "all") {
  const reactForPage = filter === "all" ? React : {
    ...React,
    useState(initial) { return React.useState(initial === "all" ? filter : initial); },
  };
  const { default: Home } = compile("../app/page.tsx", {
    react: reactForPage, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl, "@/lib/dots-instructions": dotInstructions, "@/lib/proposal-review-link": proposalReviewLink,
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

test("the closed settings menu contains only connections and sample reset", () => {
  const menu = html.match(/<details class="utility-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.doesNotMatch(menu[1], /\bopen(?:=|\s|$)/);
  assert.match(menu[2], /<summary[^>]*aria-label="表示・連携設定"/);
  for (const label of ["連携・保存", "サンプルに戻す"]) assert.ok(plainText(menu[2]).includes(label), label);
  for (const label of ["イベント設定", "変更履歴", "CSVを書き出す", "バックアップ", "新しいイベント", "枠を追加"]) assert.ok(!plainText(menu[2]).includes(label), label);
  assert.equal((menu[2].match(/<button\b/g) ?? []).length, 2);
  assert.doesNotMatch(menu[2], /その他の操作|lucide-ellipsis|theme-control|表示モード|ライトモード|ダークモード/);
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

test("appearance icons are directly visible in the header and not duplicated in a menu", () => {
  const topbar = html.match(/<header class="minimal-topbar">([\s\S]*?)<\/header>/)?.[1] ?? "";
  const menu = html.match(/<details class="utility-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.match(topbar, /<div class="theme-control" role="group" aria-label="表示モード">/);
  assert.ok(topbar.indexOf('class="theme-control"') < topbar.indexOf('class="utility-menu"'));
  for (const label of ["ライトモード", "ダークモード", "端末に合わせる"]) {
    const button = topbar.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>[\\s\\S]*?</button>`))?.[0] ?? "";
    assert.match(button, new RegExp(`title="${label}"`));
    assert.match(button, /aria-pressed="(?:true|false)"/);
    assert.match(button, /<svg[^>]*aria-hidden="true"/);
    assert.equal((html.match(new RegExp(`aria-label="${label}"`, "g")) ?? []).length, 1);
  }
  assert.doesNotMatch(menu[2], /theme-control|ライトモード|ダークモード|端末に合わせる/);
  assert.doesNotMatch(main, /theme-control|appearance-theme/);
  assert.doesNotMatch(html, /<select id="appearance-theme"/);
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
  assert.doesNotMatch(html, /class="agent-inbox"|エージェントからの提案|接続を確認|dotsへの指示をコピー/);
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
function pageActions({ event = structuredClone(demo.demoState), aiConfigured = false, agentProposals = [], saveStatus = "saved", storage = "local", planning = false } = {}) {
  const hooks = [];
  // Explicitly seed only page state, not a mounted effect. These hook positions
  // include refs and are guarded below so a changed layout cannot silently seed
  // an unrelated state value and give misleading integration-test results.
  const seeds = new Map([[0, [demo.demoState, event]], [2, ["loading", saveStatus]], [3, ["local", storage]], [4, [false, aiConfigured]], [15, [false, planning]], [23, [[], agentProposals]]]);
  let cursor = 0;
  const effects = [];
  const hooksReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) {
        if (seeds.has(index)) {
          const [expected, value] = seeds.get(index);
          assert.deepEqual(initial, expected, `Page hook ${index} changed; update the test harness`);
          hooks[index] = value;
        } else hooks[index] = typeof initial === "function" ? initial() : initial;
      }
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
    react: hooksReact, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl, "@/lib/dots-instructions": dotInstructions, "@/lib/proposal-review-link": proposalReviewLink,
  });
  return {
    render() { cursor = 0; effects.length = 0; return Home(); },
    effects,
    event() { return Object.hasOwn(hooks, 0) ? hooks[0] : event; },
    setSaveStatus(value) { assert.ok(Object.hasOwn(hooks, 2)); hooks[2] = value; },
    setStorage(value) { assert.ok(Object.hasOwn(hooks, 3)); hooks[3] = value; },
    setPlanning(value) { assert.ok(Object.hasOwn(hooks, 15)); hooks[15] = value; },
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
  const restore = () => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
  try {
    const result = action();
    if (result && typeof result.then === "function") return Promise.resolve(result).finally(restore);
    restore(); return result;
  } catch (error) { restore(); throw error; }
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
    assert.equal(elements(page.render(), node => typeof node.type === "function" && node.props.title === "新しいイベント").length, 0);
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

const connectionDialog = page => elements(page.render(), node => typeof node.type === "function" && node.props.title === "連携・保存")[0];
const settleCallbacks = () => new Promise(resolve => setImmediate(resolve));
const noEventWrites = {
  fetch() { assert.fail("reviewing or copying must not call an API"); },
  localStorage: { setItem() { assert.fail("reviewing or copying must not save the event"); } },
  setTimeout() { return 1; }, clearTimeout() {},
};

test("a configured key is labeled unverified, and opening connections never checks it automatically", () => {
  const page = pageActions({ aiConfigured: true });
  const snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /キー設定済み・未確認/);
    assert.doesNotMatch(textOf(dialog), /接続確認済み|接続エラー/);
    assert.match(textOf(dialog), /dotsで初回設定が必要/);
    assert.match(textOf(dialog), /MCPの利用だけではdotsの稼働状態は判定できません/);
    assert.match(textOf(dialog), /自動反映はしません/);
    assert.ok(buttonNamed(dialog, "接続を確認"));
    assert.ok(buttonNamed(dialog, "dotsへの指示をコピー"));
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("only an explicit connection check POST verifies Decisions and never saves event data", async () => {
  const page = pageActions({ aiConfigured: true }), calls = [];
  const snapshot = JSON.stringify(page.event());
  let respond;
  await withGlobals({
    ...noEventWrites,
    fetch(url, options) {
      calls.push([url, options]);
      return new Promise(resolve => { respond = resolve; });
    },
  }, async () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    assert.deepEqual(calls, []);
    buttonNamed(connectionDialog(page), "接続を確認").props.onClick();
    assert.deepEqual(calls, [["/api/decisions/check", { method: "POST" }]]);
    assert.equal(buttonNamed(connectionDialog(page), "確認中").props.disabled, true);
    respond({ ok: true, json: async () => ({ configured: true, aiStatus: "used", notice: "Decisions APIへの接続を確認しました。", decisions: { status: "used", model: "gpt-6-luna", elapsedMs: 8 } }) });
    await settleCallbacks();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /接続確認済み/);
    assert.match(textOf(dialog), /Decisions APIへの接続を確認しました。/);
    assert.doesNotMatch(textOf(dialog), /キー設定済み・未確認/);
    assert.equal(buttonNamed(dialog, "接続を確認").props.disabled, false);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("failed connection checks show only the safe notice and HTTP diagnostic without claiming success", async () => {
  const page = pageActions({ aiConfigured: true }), calls = [];
  await withGlobals({
    ...noEventWrites,
    fetch(url, options) {
      calls.push([url, options]);
      return Promise.resolve({ ok: true, json: async () => ({ configured: true, aiStatus: "fallback", notice: "APIキーの認証に失敗しました。", decisions: { status: "failed", model: "gpt-6-luna", elapsedMs: 8, failureKind: "authentication", httpStatus: 401 }, upstreamBody: "upstream-private-error-sentinel" }) });
    },
  }, async () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    buttonNamed(connectionDialog(page), "接続を確認").props.onClick();
    await settleCallbacks();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /接続エラー/);
    assert.match(textOf(dialog), /APIキーの認証に失敗しました。（HTTP 401）/);
    assert.doesNotMatch(textOf(dialog), /接続確認済み|upstream-private-error-sentinel/);
    assert.equal(buttonNamed(dialog, "接続を確認").props.disabled, false);
    assert.equal(calls.length, 1);
  });
});

test("connection transport failure is recoverable and does not echo an exception message", async () => {
  const page = pageActions({ aiConfigured: true });
  await withGlobals({ ...noEventWrites, fetch: async () => { throw new Error("private-transport-error-sentinel"); } }, async () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    buttonNamed(connectionDialog(page), "接続を確認").props.onClick();
    await settleCallbacks();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /接続確認を完了できませんでした/);
    assert.doesNotMatch(textOf(dialog), /接続確認済み|private-transport-error-sentinel/);
    assert.equal(buttonNamed(dialog, "接続を確認").props.disabled, false);
  });
});

test("copying dot instructions shares only the public site origin, not the private event or token URL", async () => {
  const privateEvent = structuredClone(demo.demoState);
  privateEvent.event.name = "private-event-name-sentinel";
  privateEvent.slots[0].notes = "private-event-notes-sentinel";
  const page = pageActions({ event: privateEvent }), copied = [];
  const snapshot = JSON.stringify(page.event());
  await withGlobals({
    ...noEventWrites,
    window: { location: { origin: "https://tool.example.test" } },
    navigator: { clipboard: { async writeText(text) { copied.push(text); } } },
  }, async () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    buttonNamed(connectionDialog(page), "dotsへの指示をコピー").props.onClick();
    await settleCallbacks();
    assert.deepEqual(copied, [dotInstructions.dotSetupInstructions("https://tool.example.test")]);
    assert.match(copied[0], /get_agent_context/);
    assert.match(copied[0], /publish_change_proposal/);
    assert.match(copied[0], /expectedRevision/);
    assert.doesNotMatch(copied[0], /private-event-name-sentinel|private-event-notes-sentinel/);
    assert.equal(JSON.stringify(page.event()), snapshot);
    assert.match(textOf(page.render()), /dotsへの指示をコピーしました/);
  });
});

function proposalFixture(overrides = {}) {
  const slots = structuredClone(demo.demoState.slots);
  return {
    id: "agent-proposal-test", eventId: demo.demoState.event.id, baseRevision: demo.demoState.revision,
    text: "次の登壇者が15分遅れます", createdAt: "2026-10-18T06:00:00Z",
    result: {
      plans: [{ id: "agent-plan-test", title: "保存済みの比較案", description: "主催者が内容を確認する案", slots, schedule: planner.computeSchedule(demo.demoState, slots), changes: ["進行条件を確認"], tradeoffs: ["時刻を優先"], score: 100 }],
      issue: { kind: "delay", minutes: 15, text: "次の登壇者が15分遅れます" },
      engine: "decisions", aiStatus: "used", elapsedMs: 12,
      decisions: { status: "used", model: "gpt-6-luna", elapsedMs: 10 },
    },
    ...overrides,
  };
}

test("reviewing and previewing a persisted agent proposal is read-only until the organizer applies it", () => {
  const proposal = proposalFixture(), page = pageActions({ agentProposals: [proposal] });
  const snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    const tree = page.render();
    assert.match(textOf(tree), /エージェントからの提案 · 1件/);
    assert.match(textOf(tree), /Decisions APIで比較済み/);
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0);
    const review = buttonNamed(tree, "提案を確認");
    assert.equal(review.props.disabled, false);
    review.props.onClick();
    let reviewed = page.render();
    const plans = elements(reviewed, node => node.props.className === "plan-results");
    assert.equal(plans.length, 1);
    assert.match(textOf(plans[0]), /保存済みの比較案/);
    assert.match(textOf(plans[0]), /Decisions API · 10ms/);
    assert.equal(elements(reviewed, node => node.type === "input" && node.props.id === "issue-input")[0].props.value, proposal.text);
    buttonNamed(reviewed, "表で比較").props.onClick();
    reviewed = page.render();
    assert.equal(elements(reviewed, node => node.props.className === "preview-strip").length, 1);
    assert.equal(elements(reviewed, node => node.type === timetable.Timetable)[0].props.preview, true);
    buttonNamed(reviewed, "元の表に戻す").props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "preview-strip").length, 0);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("stale proposals remain identifiable but cannot populate adjustment plans even through a captured callback", () => {
  const page = pageActions({ agentProposals: [proposalFixture({ baseRevision: demo.demoState.revision - 1 })] });
  const snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    const tree = page.render(), review = buttonNamed(tree, "提案を確認");
    assert.match(textOf(tree), /更新前の進行表への提案/);
    assert.equal(review.props.disabled, true);
    review.props.onClick();
    const rejected = page.render();
    assert.equal(elements(rejected, node => node.props.className === "plan-results").length, 0);
    assert.match(textOf(rejected), /最新の条件で再提案/);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("foreign event proposals are not shown and changed-event metadata is rejected when reviewed", () => {
  const foreign = pageActions({ agentProposals: [proposalFixture({ eventId: "other-event" })] });
  assert.equal(elements(foreign.render(), node => node.props.className === "agent-inbox").length, 0);
  const proposal = proposalFixture(), page = pageActions({ agentProposals: [proposal] });
  const snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    const review = buttonNamed(page.render(), "提案を確認");
    proposal.eventId = "other-event";
    review.props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    assert.match(textOf(page.render()), /最新の条件で再提案/);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("proposal review recomputes constraints instead of trusting a cached clean schedule", () => {
  const proposal = proposalFixture();
  proposal.result.plans[0].slots[3].durationMinutes = 9999;
  assert.equal(proposal.result.plans[0].schedule.violations.filter(item => item.severity === "error").length, 0);
  const page = pageActions({ agentProposals: [proposal] }), snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    const rejected = page.render();
    assert.equal(elements(rejected, node => node.props.className === "plan-results").length, 0);
    assert.match(textOf(rejected), /現在の条件で成立しない提案/);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

function reviewHash({ eventId = demo.demoState.event.id, revision = demo.demoState.revision, text = "次の登壇者が15分遅れます" } = {}) {
  return "#" + new URLSearchParams({ review: "1", event: eventId, revision: String(revision), text });
}
function reviewBrowser(hash) {
  const listeners = new Map(), replacements = [];
  const location = { hash, pathname: "/events/current", search: "?view=table" };
  const history = { state: { retained: true }, replaceState(state, title, url) {
    replacements.push([state, title, url]);
    const destination = new URL(String(url), "https://tool.example.test");
    location.hash = destination.hash;
    location.pathname = destination.pathname;
    location.search = destination.search;
  } };
  return {
    listeners, replacements, location, history,
    window: {
      location, history,
      addEventListener(type, handler) { assert.ok(!listeners.has(type), `${type} listener already exists`); listeners.set(type, handler); },
      removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
    },
  };
}
function runReviewEffect(page) {
  assert.equal(page.effects.length, 4, "Page effects changed; review tests must never run loading or polling effects");
  return page.effects[3]();
}
function reviewFetch(calls, state = demo.demoState) {
  return (url, options) => {
    calls.push([url, options]);
    if (url === "/api/event") {
      assert.deepEqual(options, { cache: "no-store" });
      return Promise.resolve({ ok: true, json: async () => ({ state: structuredClone(state) }) });
    }
    assert.equal(url, "/api/plans", "review links may only refresh the event and request a read-only comparison");
    assert.equal(options.method, "POST");
    return Promise.resolve({ ok: true, json: async () => proposalFixture().result });
  };
}
const planCalls = calls => calls.filter(([url]) => url === "/api/plans");

test("a current-event review link compares Unicode change text once without saving or applying it", async () => {
  const text = "次の登壇者が15分遅れます 🎸 & 音止めは維持", hash = reviewHash({ text });
  const browser = reviewBrowser(hash), page = pageActions({ storage: "cloud" }), calls = [];
  const snapshot = JSON.stringify(page.event());
  await withGlobals({
    ...noEventWrites, window: browser.window, history: browser.history, location: browser.location,
    fetch: reviewFetch(calls),
  }, async () => {
    page.render();
    let cleanup = runReviewEffect(page);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["/api/event", { cache: "no-store" }]);
    assert.equal(browser.location.hash, "");
    assert.equal(browser.replacements.length, 1);
    assert.deepEqual(browser.replacements[0][0], { retained: true });
    assert.equal(browser.replacements[0][2], "/events/current?view=table");
    assert.equal(elements(page.render(), node => node.type === "input" && node.props.id === "issue-input")[0].props.value, text);
    await settleCallbacks();
    assert.equal(calls.length, 2);
    assert.equal(planCalls(calls).length, 1);
    assert.deepEqual(JSON.parse(planCalls(calls)[0][1].body), { state: demo.demoState, text });
    const reviewed = page.render();
    assert.equal(elements(reviewed, node => node.props.className === "plan-results").length, 1);
    assert.match(textOf(reviewed), /再比較/);
    assert.match(textOf(reviewed), /未反映/);
    cleanup?.();
    // Restoring the same fragment simulates a rerender or duplicate link event.
    // The consumed-link ref must prevent another API call, not just hash removal.
    browser.location.hash = hash;
    page.render();
    cleanup = runReviewEffect(page);
    browser.listeners.get("hashchange")?.();
    await settleCallbacks();
    assert.equal(calls.length, 2);
    assert.equal(JSON.stringify(page.event()), snapshot);
    cleanup?.();
    assert.equal(browser.listeners.size, 0);
  });
});

test("review links wait for a cloud-saved event and never run against local or loading data", async () => {
  for (const initial of [{ storage: "cloud", saveStatus: "loading" }, { storage: "local", saveStatus: "saved" }]) {
    const browser = reviewBrowser(reviewHash()), page = pageActions(initial), calls = [];
    await withGlobals({
      ...noEventWrites, window: browser.window, history: browser.history, location: browser.location,
      fetch: reviewFetch(calls),
    }, async () => {
      page.render();
      const cleanup = runReviewEffect(page);
      assert.equal(calls.length, 0);
      assert.equal(browser.replacements.length, 0, "a link must remain available until cloud loading completes");
      cleanup?.();
      page.setSaveStatus("saved"); page.setStorage("cloud");
      page.render();
      const loadedCleanup = runReviewEffect(page);
      await settleCallbacks();
      assert.equal(calls.length, 2);
      assert.equal(planCalls(calls).length, 1);
      loadedCleanup?.();
      assert.equal(browser.listeners.size, 0);
    });
  }
});

test("review links defer while another comparison is running and respond to later hash changes", async () => {
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud", planning: true }), calls = [];
  await withGlobals({
    ...noEventWrites, window: browser.window, history: browser.history, location: browser.location,
    fetch: reviewFetch(calls),
  }, async () => {
    page.render();
    let cleanup = runReviewEffect(page);
    assert.equal(calls.length, 0);
    assert.equal(browser.replacements.length, 0);
    cleanup?.();
    page.setPlanning(false);
    page.render();
    cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(calls.length, 2);
    cleanup?.();
    page.render();
    cleanup = runReviewEffect(page);
    const text = "次の登壇者が20分遅れます";
    browser.location.hash = reviewHash({ text });
    browser.listeners.get("hashchange")();
    await settleCallbacks();
    assert.equal(calls.length, 4);
    assert.equal(planCalls(calls).length, 2);
    assert.equal(JSON.parse(planCalls(calls)[1][1].body).text, text);
    cleanup?.();
    assert.equal(browser.listeners.size, 0);
  });
});

test("stale, foreign and malformed review links never compare, persist or apply changes", async () => {
  const updatedEvent = structuredClone(demo.demoState); updatedEvent.revision += 1;
  for (const [hash, event = structuredClone(demo.demoState)] of [
    [reviewHash(), updatedEvent],
    [reviewHash({ revision: demo.demoState.revision + 1 })],
    [reviewHash({ eventId: "foreign-event" })],
    ["#review=1&event=missing-revision&text=change"],
    [reviewHash({ text: "" })],
    ["#review=1&event=demo&revision=NaN&text=change"],
    ["#ordinary-section"],
  ]) {
    const browser = reviewBrowser(hash), page = pageActions({ storage: "cloud", event }), snapshot = JSON.stringify(page.event()), calls = [];
    await withGlobals({ ...noEventWrites, window: browser.window, history: browser.history, location: browser.location, fetch: reviewFetch(calls, event) }, async () => {
      page.render();
      const cleanup = runReviewEffect(page);
      await settleCallbacks();
      const tree = page.render();
      assert.equal(planCalls(calls).length, 0, hash);
      const link = proposalReviewLink.parseProposalReviewHash(hash);
      assert.equal(calls.length, link?.eventId === event.event.id ? 1 : 0, hash);
      assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0, hash);
      assert.equal(JSON.stringify(page.event()), snapshot, hash);
      cleanup?.();
      assert.equal(browser.listeners.size, 0);
    });
  }
});

test("a same-tab link refreshes an older mounted event and compares only the matching latest server revision", async () => {
  const latest = structuredClone(demo.demoState); latest.revision += 1; latest.slots[3].notes = "new server condition";
  const text = "次の登壇者が15分遅れます", browser = reviewBrowser(reviewHash({ revision: latest.revision, text }));
  const page = pageActions({ storage: "cloud" }), calls = [];
  await withGlobals({ ...noEventWrites, window: browser.window, fetch: reviewFetch(calls, latest) }, async () => {
    page.render();
    const cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(planCalls(calls)[0][1].body), { state: latest, text });
    assert.deepEqual(page.event(), latest, "only the fresh saved server state is synchronized in memory");
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 1);
    cleanup?.();
  });
});

test("a link matching old mounted state is rejected when the server revision has advanced", async () => {
  const latest = structuredClone(demo.demoState); latest.revision += 1;
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
  const snapshot = JSON.stringify(page.event());
  await withGlobals({ ...noEventWrites, window: browser.window, fetch: reviewFetch(calls, latest) }, async () => {
    page.render();
    const cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(calls.length, 1);
    assert.equal(planCalls(calls).length, 0);
    const tree = page.render();
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0);
    assert.match(textOf(tree), /更新前の進行表/);
    assert.equal(JSON.stringify(page.event()), snapshot);
    cleanup?.();
  });
});

test("review-link refresh failures never compare or fall back to stale local planning", async () => {
  for (const response of [null, { ok: false }, { ok: true, json: async () => ({ state: null }) }]) {
    const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
    const snapshot = JSON.stringify(page.event());
    await withGlobals({ ...noEventWrites, window: browser.window, fetch(url, options) {
      calls.push([url, options]);
      if (!response) return Promise.reject(new Error("private-refresh-error-sentinel"));
      return Promise.resolve(response);
    } }, async () => {
      page.render();
      const cleanup = runReviewEffect(page);
      await settleCallbacks();
      assert.deepEqual(calls, [["/api/event", { cache: "no-store" }]]);
      const tree = page.render();
      assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0);
      assert.match(textOf(tree), /最新の進行表で再比較できませんでした/);
      assert.doesNotMatch(textOf(tree), /端末内の制約計算|private-refresh-error-sentinel/);
      assert.equal(JSON.stringify(page.event()), snapshot);
      cleanup?.();
    });
  }
});

test("a second hash cannot start another refresh before the planning rerender, and remains pending afterward", async () => {
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
  const normalFetch = reviewFetch(calls);
  let respond;
  await withGlobals({ ...noEventWrites, window: browser.window, fetch(url, options) {
    if (!calls.length) {
      calls.push([url, options]);
      return new Promise(resolve => { respond = resolve; });
    }
    return normalFetch(url, options);
  } }, async () => {
    page.render();
    let cleanup = runReviewEffect(page);
    assert.equal(calls.length, 1);
    const text = "次の登壇者が20分遅れます", secondHash = reviewHash({ text });
    browser.location.hash = secondHash;
    browser.listeners.get("hashchange")();
    assert.equal(calls.length, 1);
    assert.equal(browser.location.hash, secondHash, "in-flight work must not consume a new request");
    respond({ ok: true, json: async () => ({ state: structuredClone(demo.demoState) }) });
    await settleCallbacks();
    assert.equal(calls.length, 2);
    cleanup?.();
    page.render();
    cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(calls.length, 4);
    assert.equal(planCalls(calls).length, 2);
    assert.equal(JSON.parse(planCalls(calls)[1][1].body).text, text);
    cleanup?.();
    assert.equal(browser.listeners.size, 0);
  });
});
