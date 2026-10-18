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
const memberRoles = compile("./member-roles.ts");
const memberEditor = compile("../components/member-editor.tsx", { "@/lib/member-roles": memberRoles, "@/components/role-emoji-picker": { RoleEmojiPicker: () => null } });
const timetable = compile("../components/timetable.tsx", { "@/lib/planner": planner, "@/lib/member-roles": memberRoles });
const theme = compile("./theme.ts");
const themeControl = compile("../components/theme-control.tsx", { "@/lib/theme": theme });
const dotInstructions = compile("./dots-instructions.ts");
const proposalReviewLink = compile("./proposal-review-link.ts");
const eventTiming = compile("./event-timing.ts");
function render(filter = "all") {
  const reactForPage = filter === "all" ? React : {
    ...React,
    useState(initial) { return React.useState(initial === "all" ? filter : initial); },
  };
  const { default: Home } = compile("../app/page.tsx", {
    react: reactForPage, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl, "@/lib/dots-instructions": dotInstructions, "@/lib/proposal-review-link": proposalReviewLink, "@/lib/event-timing": eventTiming, "@/components/member-editor": memberEditor, "@/lib/member-roles": memberRoles,
  });
  return renderToStaticMarkup(React.createElement(Home));
}
const html = render();
const plainText = markup => markup.replace(/<[^>]+>/g, "");
const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";

test("event date, time and location each have their own decorative icon", () => {
  const details = html.match(/<p class="event-details">([\s\S]*?)<\/p>/)?.[1];
  assert.ok(details);
  for (const icon of ["calendar-days", "clock-3", "map-pin"]) assert.match(details, new RegExp(`lucide-${icon}`));
  assert.equal((details.match(/aria-hidden="true"/g) ?? []).length, 3);
  assert.match(details, /<time dateTime="2026-11-14">|<time datetime="2026-11-14">/);
  assert.match(plainText(details), /2026年11月14日\(土\).*14:00–17:30.*Shibuya Community Hall/);
  assert.doesNotMatch(plainText(details), /·/);
});

test("the header uses a descriptive tool name instead of Cue branding", () => {
  assert.match(html, /<span class="minimal-brand">タイテ作成ツール<\/span>/);
  assert.doesNotMatch(plainText(html), /\bcue\b/i);
});

test("browser metadata uses the same descriptive tool name", () => {
  const { metadata } = compile("../app/layout.tsx", { "./globals.css": {}, "@/components/role-emoji-picker.css": {}, "@/lib/theme": theme });
  assert.equal(metadata.title, "タイテ作成ツール");
  assert.doesNotMatch(metadata.description, /\bcue\b/i);
});

test("the initial page has one main timetable and one event-name heading", () => {
  assert.equal((html.match(/<main\b/g) ?? []).length, 1);
  assert.equal((html.match(/<table\b/g) ?? []).length, 1);
  assert.match(main, /<table class="run-table">/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1>Community Day 2026<\/h1>/);
  assert.equal((html.match(/<h2\b/g) ?? []).length, 1);
  assert.match(html, /<h2 id="change-section-title">[\s\S]*?進行を調整<\/h2>/);
  assert.doesNotMatch(html, /<h[3-6]\b/);
});

test("change input, examples and dot action share one named adjustment section separate from the timetable", () => {
  const section = main.match(/<section class="change-section" aria-labelledby="change-section-title">([\s\S]*?)<\/section>/)?.[1];
  assert.ok(section);
  assert.match(section, /<h2 id="change-section-title"><svg[^>]*class="[^"]*lucide-wand-sparkles[^"]*"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>進行を調整<\/h2>/);
  assert.equal((section.match(/<form class="change-form"/g) ?? []).length, 1);
  assert.match(section, /class="change-assist"/);
  assert.match(section, /class="change-examples"/);
  for (const label of ["入力例", "いまの進行が10分押しています", "次の登壇者が15分遅れます", "全体を10分短縮したい", "dotに依頼"]) assert.ok(plainText(section).includes(label), label);
  assert.doesNotMatch(section, /timetable-shell|run-table|table-toolbar|event-heading|変更履歴|バックアップ/);
  assert.ok(main.indexOf('class="change-section"') < main.indexOf('class="timetable-shell"'));
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
  const heading = main.match(/<div class="event-heading">([\s\S]*?)<section class="change-section"/)?.[1] ?? "";
  const toolbar = main.match(/<div class="table-toolbar">([\s\S]*?)<div class="run-table-scroll"/)?.[1] ?? "";
  assert.match(topbar, /class="button secondary small new-event-button"/);
  assert.ok(plainText(topbar).includes("新しいイベント"));
  assert.doesNotMatch(plainText(topbar), /変更履歴|枠を追加|書き出し/);
  assert.match(heading, /<div class="event-title-row"><h1>Community Day 2026<\/h1><button[^>]*aria-label="イベント設定"/);
  assert.ok(plainText(heading).includes("変更履歴"));
  assert.match(toolbar, /class="table-tools" role="group" aria-label="タイムテーブルの操作"/);
  for (const label of ["枠を追加", "書き出し", "表示する進行枠"]) assert.ok(plainText(toolbar).includes(label), label);
  for (const label of ["新しいイベント", "変更履歴", "枠を追加", "PDFを書き出す", "Excel（.xlsx）を書き出す", "CSVを書き出す", "バックアップ（JSON）"]) assert.equal(plainText(html).split(label).length - 1, 1, label);
  assert.equal((html.match(/aria-label="イベント設定"/g) ?? []).length, 1);
});

test("exports have a dedicated closed-by-default menu with PDF, Excel, CSV and JSON choices", () => {
  const menu = html.match(/<details class="export-menu"([^>]*)>([\s\S]*?)<\/details>/);
  assert.ok(menu);
  assert.doesNotMatch(menu[1], /\bopen(?:=|\s|$)/);
  assert.match(menu[2], /<summary[^>]*aria-label="書き出し"/);
  assert.match(menu[2], /class="export-popover"/);
  assert.equal((menu[2].match(/<button\b/g) ?? []).length, 4);
  for (const label of ["PDFを書き出す", "Excel（.xlsx）を書き出す", "CSVを書き出す", "バックアップ（JSON）"]) assert.ok(plainText(menu[2]).includes(label), label);
  assert.match(menu[2], /aria-busy="false"/);
  assert.doesNotMatch(plainText(menu[2]), /新しいイベント|変更履歴|連携・保存/);
});

test("new actions have decorative icons while icon-only controls retain accessible names", () => {
  const controls = [...html.matchAll(/<(button|summary)\b([^>]*)>([\s\S]*?)<\/\1>/g)];
  for (const label of ["新しいイベント", "表示・連携設定", "イベント設定", "変更履歴", "枠を追加", "書き出し", "PDFを書き出す", "Excel（.xlsx）を書き出す", "CSVを書き出す", "バックアップ（JSON）", "連携・保存", "サンプルに戻す"]) {
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
  const { default: RootLayout } = compile("../app/layout.tsx", { "./globals.css": {}, "@/components/role-emoji-picker.css": {}, "@/lib/theme": theme });
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
  assert.doesNotMatch(main, /aria-current="step"/, "server output must not trust seeded demo progress before the real clock loads");
  assert.match(main, /タイムテーブル · 8枠/);
  assert.match(main, /<select[^>]*><option value="all" selected="">すべて<\/option>/);
});

test("server-side filters do not mistake seeded demo progress for actual event-time progress", () => {
  const remaining = render("remaining");
  assert.equal((remaining.match(/class="run-table-slot"/g) ?? []).length, 8);
  assert.doesNotMatch(remaining, /aria-current="step"/);
  assert.doesNotMatch(remaining, /class="run-table-main run-table-done/);
  const done = render("done");
  assert.equal((done.match(/class="run-table-slot"/g) ?? []).length, 0);
  assert.doesNotMatch(done, /aria-current="step"/);
});

// Exercise real page callbacks with in-memory hooks. Do not mount the page or
// run its loading effect: these checks never contact APIs or browser storage.
function pageActions({ event = structuredClone(demo.demoState), aiConfigured = false, agentProposals = [], changeRequests = [], eventDelivery = null, saveStatus = "saved", storage = "local", planning = false, clockNow = null, eventSummaries = [], documentExporter = { createDocumentExport() { assert.fail("document exporters must be explicitly injected for callback tests"); } } } = {}) {
  const hooks = [];
  // Explicitly seed only page state, not a mounted effect. These hook positions
  // include refs and are guarded below so a changed layout cannot silently seed
  // an unrelated state value and give misleading integration-test results.
  const seededDelivery = eventDelivery ? { eventId: event.event.id, ...eventDelivery } : null;
  const seeds = new Map([[0, [demo.demoState, event]], [2, ["loading", saveStatus]], [3, ["local", storage]], [4, [false, aiConfigured]], [15, [false, planning]], [23, [[], agentProposals]], [31, [[], changeRequests]], [32, [0, changeRequests.filter(request => request.eventId === event.event.id && request.status === "pending").length]], [36, [null, seededDelivery]], [38, [[], eventSummaries]], [41, [null, clockNow]]]);
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
      if (!Object.hasOwn(hooks, index)) {
        if (index === 26) assert.equal(initial, 0, "The server-revision ref index changed; update the test harness");
        hooks[index] = { current: index === 26 ? event.revision : initial };
      }
      return hooks[index];
    },
    useMemo(compute) { return compute(); },
    useEffect(effect) { effects.push(effect); },
  };
  const { default: Home } = compile("../app/page.tsx", {
    react: hooksReact, "@/lib/planner": planner, "@/lib/demo": demo, "@/components/timetable": timetable, "@/components/theme-control": themeControl, "@/lib/dots-instructions": dotInstructions, "@/lib/proposal-review-link": proposalReviewLink, "@/lib/event-timing": eventTiming, "@/components/member-editor": memberEditor, "@/lib/member-roles": memberRoles, "@/lib/export-files": documentExporter,
  });
  return {
    render() { cursor = 0; effects.length = 0; return Home(); },
    effects,
    event() { return Object.hasOwn(hooks, 0) ? hooks[0] : event; },
    setEvent(value) { assert.ok(Object.hasOwn(hooks, 0) && Object.hasOwn(hooks, 1)); hooks[0] = value; hooks[1].current = value; },
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
const buttonLabelled = (tree, name) => elements(tree, node => node.type === "button" && node.props["aria-label"] === name)[0];
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
  const event = structuredClone(demo.demoState);
  event.slots[0].members = [{ name: "田中", roles: ["Vo.", "Gt.", "部長"], roleIcons: { "部長": "👑" } }];
  const page = pageActions({ event }), tree = page.render(), [utility, exports] = attachMenus(tree), files = [], revoked = [], clicks = [];
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
  assert.match(await files[0].text(), /田中 \(Vo\. \/ Gt\. \/ 👑 部長\)/);
  assert.deepEqual(JSON.parse(await files[1].text()), event);
  assert.equal(JSON.stringify(page.event()), snapshot);
});

const connectionDialog = page => elements(page.render(), node => typeof node.type === "function" && node.props.title === "連携・保存")[0];
const settleCallbacks = () => new Promise(resolve => setImmediate(resolve));
const noEventWrites = {
  fetch() { assert.fail("reviewing or copying must not call an API"); },
  localStorage: { setItem() { assert.fail("reviewing or copying must not save the event"); } },
  setTimeout() { return 1; }, clearTimeout() {},
};

function documentDownloads() {
  const files = [], clicks = [], revoked = [], timers = [], apiCalls = [], storageWrites = [];
  return {
    files, clicks, revoked, timers, apiCalls, storageWrites,
    globals: {
      document: { createElement(tag) { assert.equal(tag, "a"); return { click() { clicks.push({ href: this.href, download: this.download }); } }; } },
      URL: { createObjectURL(blob) { files.push(blob); return `blob:document-${files.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
      setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
      fetch(...args) { apiCalls.push(args); assert.fail("document exports must not call APIs"); },
      localStorage: { setItem(...args) { storageWrites.push(args); assert.fail("document exports must not write event storage"); } },
    },
  };
}
const documentExportLabels = ["PDFを書き出す", "Excel（.xlsx）を書き出す", "CSVを書き出す", "バックアップ（JSON）"];
const exportSummary = tree => elements(tree, node => node.type === "summary" && node.props["aria-label"] === "書き出し")[0];

test("PDF and Excel export actions download their generated Blob types and dated filenames without API or event writes", async () => {
  const event = structuredClone(demo.demoState), snapshots = [], downloads = documentDownloads();
  event.event.date = "2027-04-25";
  event.slots[0].members = [{ name: "田中 太郎", familyName: "田中", givenName: "太郎", roles: ["Vo.", "部長"], roleIcons: { 部長: "👑" } }];
  const original = structuredClone(event);
  const mimeTypes = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const page = pageActions({ event, documentExporter: { async createDocumentExport(snapshot, format) {
    snapshots.push({ state: snapshot, format });
    return new Blob([`generated-${format}`], { type: mimeTypes[format] });
  } } });
  const tree = page.render(), [utility, exports] = attachMenus(tree);
  await withGlobals(downloads.globals, async () => {
    for (const [index, [label, format]] of [["PDFを書き出す", "pdf"], ["Excel（.xlsx）を書き出す", "xlsx"]].entries()) {
      utility.open = exports.open = true;
      buttonNamed(page.render(), label).props.onClick();
      assert.equal(utility.open, false);
      assert.equal(exports.open, false);
      await settleCallbacks();
      assert.equal(downloads.files[index].type, mimeTypes[format]);
      assert.equal(await downloads.files[index].text(), `generated-${format}`);
      assert.deepEqual(snapshots[index], { state: original, format });
      assert.notEqual(snapshots[index].state, event, "the exporter receives an independent snapshot");
      assert.equal(downloads.clicks[index].download, `timetable-2027-04-25.${format}`);
      assert.equal(exportSummary(page.render()).props["aria-busy"], false);
    }
    assert.deepEqual(downloads.revoked, [], "document Blob URLs stay alive briefly for download navigation");
    for (const timer of downloads.timers.filter(timer => timer.delay === 1000)) timer.callback();
    assert.deepEqual(downloads.revoked, ["blob:document-1", "blob:document-2"]);
    assert.deepEqual(downloads.apiCalls, []);
    assert.deepEqual(downloads.storageWrites, []);
    assert.deepEqual(page.event(), original);
    assert.deepEqual(event, original);
  });
});

test("document export locks duplicate callbacks synchronously and shows a busy state until the file settles", async () => {
  const downloads = documentDownloads(), calls = [];
  let finish;
  const page = pageActions({ documentExporter: { createDocumentExport(snapshot, format) {
    calls.push({ snapshot, format });
    return new Promise(resolve => { finish = resolve; });
  } } });
  const initial = page.render(), snapshot = structuredClone(page.event());
  await withGlobals(downloads.globals, async () => {
    const pdf = buttonNamed(initial, "PDFを書き出す"), excel = buttonNamed(initial, "Excel（.xlsx）を書き出す");
    pdf.props.onClick();
    excel.props.onClick();
    pdf.props.onClick();
    let busy = page.render();
    assert.equal(exportSummary(busy).props["aria-busy"], true);
    assert.equal(textOf(exportSummary(busy)), "書き出し中");
    for (const label of documentExportLabels) assert.equal(buttonNamed(busy, label).props.disabled, true, label);
    await settleCallbacks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].format, "pdf");
    excel.props.onClick();
    await settleCallbacks();
    assert.equal(calls.length, 1, "stale button callbacks cannot bypass the ref-based lock");
    finish(new Blob(["%PDF test"], { type: "application/pdf" }));
    await settleCallbacks();
    busy = page.render();
    assert.equal(exportSummary(busy).props["aria-busy"], false);
    assert.equal(textOf(exportSummary(busy)), "書き出し");
    for (const label of documentExportLabels) assert.equal(buttonNamed(busy, label).props.disabled, false, label);
    assert.equal(downloads.files.length, 1);
    assert.deepEqual(page.event(), snapshot);
    assert.deepEqual(downloads.apiCalls, []);
    assert.deepEqual(downloads.storageWrites, []);
  });
});

test("a document export reads the latest event ref but keeps that snapshot if the event changes during lazy loading", async () => {
  const downloads = documentDownloads(), calls = [];
  const page = pageActions({ documentExporter: { async createDocumentExport(snapshot, format) {
    calls.push({ snapshot, format });
    return new Blob([snapshot.event.name], { type: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  } } });
  const oldTree = page.render();
  const second = structuredClone(demo.demoState), third = structuredClone(demo.demoState);
  second.event = { ...second.event, id: "second-event", name: "2番目のイベント", date: "2027-06-06" };
  second.slots[0].title = "2番目の演目";
  third.event = { ...third.event, id: "third-event", name: "3番目のイベント", date: "2028-07-07" };
  await withGlobals(downloads.globals, async () => {
    page.setEvent(second);
    buttonNamed(oldTree, "PDFを書き出す").props.onClick();
    // The lazy import has not yielded its exporter yet. The action must already
    // hold a clone of the event selected when it was clicked, not the old tree.
    page.setEvent(third);
    await settleCallbacks();
    assert.deepEqual(calls[0], { snapshot: second, format: "pdf" });
    assert.notEqual(calls[0].snapshot, second);
    assert.notEqual(calls[0].snapshot.slots, second.slots);
    assert.equal(await downloads.files[0].text(), "2番目のイベント");
    assert.equal(downloads.clicks[0].download, "timetable-2027-06-06.pdf");
    assert.deepEqual(page.event(), third);
    buttonNamed(oldTree, "Excel（.xlsx）を書き出す").props.onClick();
    await settleCallbacks();
    assert.deepEqual(calls[1], { snapshot: third, format: "xlsx" });
    assert.equal(downloads.clicks[1].download, "timetable-2028-07-07.xlsx");
    assert.deepEqual(page.event(), third);
    assert.deepEqual(downloads.apiCalls, []);
    assert.deepEqual(downloads.storageWrites, []);
  });
});

test("document export failures show a safe message, release busy state and allow a successful retry", async () => {
  for (const [label, format, display] of [["PDFを書き出す", "pdf", "PDF"], ["Excel（.xlsx）を書き出す", "xlsx", "Excel"]]) {
    const downloads = documentDownloads();
    let attempts = 0;
    const page = pageActions({ documentExporter: { async createDocumentExport() {
      if (++attempts === 1) throw new Error("private-document-generation-error-sentinel");
      return new Blob(["retry succeeded"], { type: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    } } });
    const original = structuredClone(page.event());
    await withGlobals(downloads.globals, async () => {
      buttonNamed(page.render(), label).props.onClick();
      await settleCallbacks();
      const failed = page.render();
      assert.match(textOf(failed), new RegExp(`${display}を書き出せませんでした。`));
      assert.doesNotMatch(textOf(failed), /private-document-generation-error-sentinel/);
      assert.equal(exportSummary(failed).props["aria-busy"], false);
      for (const exportLabel of documentExportLabels) assert.equal(buttonNamed(failed, exportLabel).props.disabled, false);
      assert.equal(downloads.files.length, 0);
      buttonNamed(failed, label).props.onClick();
      await settleCallbacks();
      assert.equal(attempts, 2);
      assert.equal(downloads.files.length, 1);
      assert.equal(downloads.clicks[0].download, `timetable-${original.event.date}.${format}`);
      assert.match(textOf(page.render()), new RegExp(`進行表を${display}で書き出しました。`));
      assert.equal(exportSummary(page.render()).props["aria-busy"], false);
      assert.deepEqual(page.event(), original);
      assert.deepEqual(downloads.apiCalls, []);
      assert.deepEqual(downloads.storageWrites, []);
    });
  }
});

test("the displayed timetable uses Japan event time rather than saved demo progress", () => {
  for (const [at, expected] of [
    ["2026-10-18T16:32:00+09:00", ["planned", "planned", "planned", "planned", "planned", "planned", "planned", "planned"]],
    ["2026-11-14T14:50:00+09:00", ["done", "done", "active", "planned", "planned", "planned", "planned", "planned"]],
    ["2026-11-15T00:00:00+09:00", ["done", "done", "done", "done", "done", "done", "done", "done"]],
  ]) {
    const page = pageActions({ clockNow: Date.parse(at) }), snapshot = structuredClone(page.event());
    withGlobals(noEventWrites, () => {
      const table = elements(page.render(), node => node.type === timetable.Timetable)[0];
      assert.deepEqual(table.props.rows.map(row => row.status), expected, at);
      assert.deepEqual(page.event(), snapshot, "clock-derived progress is a read-only projection");
    });
  }
});

test("clock ticks update progress without a server call, local save, revision or history change", () => {
  const page = pageActions(), snapshot = structuredClone(page.event()), intervals = [], windowListeners = new Map(), documentListeners = new Map();
  let now = Date.parse("2026-11-14T14:50:00+09:00");
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    withGlobals({ ...noEventWrites,
      window: { addEventListener(type, callback) { windowListeners.set(type, callback); }, removeEventListener(type, callback) { assert.equal(windowListeners.get(type), callback); windowListeners.delete(type); } },
      document: { addEventListener(type, callback) { documentListeners.set(type, callback); }, removeEventListener(type, callback) { assert.equal(documentListeners.get(type), callback); documentListeners.delete(type); } },
      setInterval(callback, delay) { intervals.push([callback, delay]); return 71; },
      clearInterval(id) { assert.equal(id, 71); },
    }, () => {
      page.render();
      assert.ok(page.effects.length >= 5, "the clock effect is appended after the four original effects");
      const cleanup = page.effects[4]();
      assert.equal(intervals.length, 1);
      assert.equal(intervals[0][1], 1000);
      let table = elements(page.render(), node => node.type === timetable.Timetable)[0];
      assert.equal(table.props.rows.find(row => row.status === "active")?.id, "workshop");
      now = Date.parse("2026-11-15T00:00:00+09:00");
      intervals[0][0]();
      table = elements(page.render(), node => node.type === timetable.Timetable)[0];
      assert.ok(table.props.rows.every(row => row.status === "done"));
      assert.deepEqual(page.event(), snapshot);
      cleanup?.();
      assert.equal(windowListeners.size, 0);
      assert.equal(documentListeners.size, 0);
    });
  } finally { Date.now = originalNow; }
});

const eventListDialog = page => elements(page.render(), node => typeof node.type === "function" && node.props.title === "イベント一覧")[0];
const eventListButton = tree => elements(tree, node => node.type === "button" && node.props["aria-label"] === "イベント一覧")[0];
const eventListRows = tree => elements(tree, node => node.type === "button" && node.props.className?.startsWith("event-library-row"));
function eventSummaryFixture(state = demo.demoState) {
  return { ...state.event, slotCount: state.slots.length, updatedAt: "2026-10-18T07:00:00Z" };
}

test("the event list is directly accessible in the header and opens with a read-only cloud fetch", async () => {
  const page = pageActions({ storage: "cloud" }), calls = [], snapshot = structuredClone(page.event());
  const other = { ...eventSummaryFixture(), id: "next-event", name: "次のイベント" };
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    calls.push([url, options]);
    assert.equal(url, "/api/events");
    assert.deepEqual(options, { cache: "no-store" });
    return { ok: true, json: async () => ({ events: [eventSummaryFixture(), other] }) };
  } }, async () => {
    const tree = page.render(), button = eventListButton(tree);
    assert.ok(button);
    assert.equal(eventListButton(elements(tree, node => node.type === "header")[0]), button);
    assert.equal(elements(tree, node => node.type === "details" && node.props.className === "utility-menu").some(menu => !!eventListButton(menu)), false);
    button.props.onClick();
    page.render();
    assert.ok(page.effects.length >= 6, "the library load effect is appended at index 5");
    const cleanup = page.effects[5]();
    await settleCallbacks();
    const dialog = eventListDialog(page), rows = eventListRows(dialog);
    assert.equal(rows.length, 2);
    assert.match(textOf(rows[0]), /Community Day 2026.*表示中/);
    assert.match(textOf(rows[1]), /次のイベント/);
    assert.match(dialog.props.subtitle, /イベントごとにタイテと変更履歴を保存/);
    assert.deepEqual(calls, [["/api/events", { cache: "no-store" }]]);
    assert.deepEqual(page.event(), snapshot);
    cleanup?.();
  });
});

test("switching events sends one revision-bound selection POST and clears previous-event review state", async () => {
  const selected = structuredClone(demo.demoState);
  selected.event.id = "saved-next-event"; selected.event.name = "保存済みの別イベント";
  selected.revision += 1;
  selected.history = [{ id: "other-history", at: "2026-10-18T07:00:00Z", title: "別イベントの履歴", detail: "切替先", kind: "create" }];
  const proposal = proposalFixture(), page = pageActions({ storage: "cloud", agentProposals: [proposal], changeRequests: [changeRequestFixture()], eventSummaries: [eventSummaryFixture(), eventSummaryFixture(selected)] });
  const calls = [], backups = [];
  let respond;
  await withGlobals({ ...noEventWrites,
    localStorage: { setItem(key, value) { backups.push([key, JSON.parse(value)]); } },
    fetch(url, options) {
      calls.push([url, options]);
      assert.equal(url, "/api/events"); assert.equal(options.method, "POST");
      return new Promise(resolve => { respond = resolve; });
    },
  }, async () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    buttonNamed(page.render(), "表で比較").props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 1);
    eventListButton(page.render()).props.onClick();
    const row = eventListRows(eventListDialog(page)).find(button => textOf(button).includes(selected.event.name));
    assert.ok(row);
    row.props.onClick();
    row.props.onClick();
    assert.equal(calls.length, 1, "a captured callback cannot duplicate an in-flight switch");
    assert.deepEqual(JSON.parse(calls[0][1].body), { eventId: selected.event.id, expectedRevision: demo.demoState.revision });
    respond({ ok: true, json: async () => ({ state: selected }) });
    await settleCallbacks();
    const tree = page.render();
    assert.deepEqual(page.event(), selected);
    assert.equal(eventListDialog(page), undefined);
    assert.equal(elements(tree, node => node.props.className === "plan-results" || node.props.className === "preview-strip" || node.props.className === "agent-inbox").length, 0);
    assert.equal(issueInput(tree).props.value, "");
    assert.deepEqual(backups, [["cue.event.v1", selected]]);
    assert.equal(calls.length, 1, "selection must not overwrite either timetable using PUT");
  });
});

test("event selection cannot interrupt a comparison or an unsaved current event, including captured callbacks", () => {
  const other = { ...eventSummaryFixture(), id: "another-event", name: "別イベント" };
  for (const settings of [{ planning: true }, { saveStatus: "saving" }, { saveStatus: "error" }]) {
    const page = pageActions({ storage: "cloud", eventSummaries: [other], ...settings }), snapshot = structuredClone(page.event());
    withGlobals(noEventWrites, () => {
      eventListButton(page.render()).props.onClick();
      const row = eventListRows(eventListDialog(page))[0];
      assert.equal(row.props.disabled, true);
      row.props.onClick();
      assert.deepEqual(page.event(), snapshot);
      assert.ok(eventListDialog(page));
    });
  }
});

test("two queued edits remain unsaved until both PUTs finish and a captured event switch waits for the last one", async () => {
  const selected = structuredClone(demo.demoState);
  selected.event.id = "saved-after-queued-edits"; selected.event.name = "別の保存済みイベント";
  selected.revision += 3;
  const page = pageActions({ storage: "cloud", eventSummaries: [eventSummaryFixture(), eventSummaryFixture(selected)] });
  const calls = [], puts = [], backups = [];
  await withGlobals({ ...noEventWrites,
    localStorage: { setItem(key, value) { backups.push([key, JSON.parse(value)]); } },
    fetch(url, options) {
      calls.push([url, options]);
      if (url === "/api/event") {
        assert.equal(options.method, "PUT");
        return new Promise(resolve => { puts.push({ resolve, input: JSON.parse(options.body) }); });
      }
      assert.equal(url, "/api/events"); assert.equal(options.method, "POST");
      return Promise.resolve({ ok: true, json: async () => ({ state: selected }) });
    },
  }, async () => {
    eventListButton(page.render()).props.onClick();
    const capturedSwitch = eventListRows(eventListDialog(page)).find(row => textOf(row).includes(selected.event.name));
    const editSettings = name => {
      elements(page.render(), node => node.type === "button" && node.props["aria-label"] === "イベント設定")[0].props.onClick();
      const form = elements(page.render(), node => typeof node.type === "function" && typeof node.props.onSave === "function" && node.props.state?.event)[0];
      assert.ok(form);
      form.props.onSave({ ...page.event(), event: { ...page.event().event, name } });
    };
    editSettings("一つ目の編集");
    editSettings("二つ目の編集");
    assert.equal(page.event().revision, demo.demoState.revision + 2);
    assert.equal(textOf(elements(page.render(), node => node.props.className === "save-status")[0]), "保存中");
    capturedSwitch.props.onClick();
    await settleCallbacks();
    assert.equal(puts.length, 1, "the second edit remains queued behind the first cloud write");
    assert.equal(calls.filter(([url]) => url === "/api/events").length, 0);
    assert.equal(puts[0].input.expectedRevision, demo.demoState.revision);
    const firstSaved = { ...puts[0].input.state, revision: demo.demoState.revision + 1 };
    puts[0].resolve({ ok: true, json: async () => ({ state: firstSaved }) });
    await settleCallbacks();
    assert.equal(puts.length, 2);
    assert.equal(textOf(elements(page.render(), node => node.props.className === "save-status")[0]), "保存中", "the first response must not advertise all edits as saved");
    capturedSwitch.props.onClick();
    await settleCallbacks();
    assert.equal(calls.filter(([url]) => url === "/api/events").length, 0, "the saved closure cannot bypass pending writes");
    assert.equal(puts[1].input.expectedRevision, demo.demoState.revision + 1);
    assert.equal(puts[1].input.state.event.name, "二つ目の編集");
    const secondSaved = { ...puts[1].input.state, revision: demo.demoState.revision + 2 };
    puts[1].resolve({ ok: true, json: async () => ({ state: secondSaved }) });
    await settleCallbacks();
    assert.equal(textOf(elements(page.render(), node => node.props.className === "save-status")[0]), "保存済み");
    assert.equal(page.event().event.name, "二つ目の編集");
    capturedSwitch.props.onClick();
    await settleCallbacks();
    const switches = calls.filter(([url]) => url === "/api/events");
    assert.equal(switches.length, 1);
    assert.deepEqual(JSON.parse(switches[0][1].body), { eventId: selected.event.id, expectedRevision: demo.demoState.revision + 2 });
    assert.deepEqual(page.event(), selected);
    assert.equal(backups.length, 3, "two user edits and the explicit event switch retain local backups");
  });
});

test("creating an event includes its own date and starts a separate history instead of carrying the old event history", () => {
  const page = pageActions(), writes = [];
  let nextId = 0;
  withGlobals({ ...noEventWrites,
    localStorage: { setItem(key, value) { writes.push([key, JSON.parse(value)]); } },
    crypto: { randomUUID() { return `new-event-identity-${++nextId}`; } },
    FormData: class { constructor(values) { this.values = values; } get(key) { return this.values[key] ?? null; } },
  }, () => {
    buttonNamed(page.render(), "新しいイベント").props.onClick();
    const dialog = elements(page.render(), node => typeof node.type === "function" && node.props.title === "新しいイベント")[0];
    assert.match(dialog.props.subtitle, /現在のイベントは一覧に残して/);
    const dateInput = elements(dialog, node => node.type === "input" && node.props.name === "date")[0];
    assert.equal(dateInput.props.type, "date"); assert.equal(dateInput.props.required, true);
    assert.match(dateInput.props.defaultValue, /^\d{4}-\d{2}-\d{2}$/);
    const form = elements(dialog, node => node.type === "form")[0];
    form.props.onSubmit({ preventDefault() {}, currentTarget: { name: "新しいライブ", date: "2026-12-05" } });
    assert.equal(page.event().event.name, "新しいライブ");
    assert.equal(page.event().event.date, "2026-12-05");
    assert.notEqual(page.event().event.id, demo.demoState.event.id);
    assert.equal(page.event().history.length, 1);
    assert.equal(page.event().history[0].title, "イベントを作成");
    assert.ok(page.event().history.every(entry => !demo.demoState.history.some(old => old.id === entry.id)));
    assert.equal(writes.length, 1);
  });
});

test("a configured key is labeled unverified, and opening connections never checks it automatically", () => {
  const page = pageActions({ aiConfigured: true });
  const snapshot = JSON.stringify(page.event());
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /キー設定済み・未確認/);
    assert.doesNotMatch(textOf(dialog), /接続確認済み|接続エラー/);
    assert.match(textOf(dialog), /イベント購読未設定/);
    assert.match(textOf(dialog), /受信者がdotsであることや処理完了を示すものではありません/);
    assert.match(textOf(dialog), /自動反映(?:は)?しません/);
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

test("clicking the same proposal review twice closes results and preview just like the close button", () => {
  const proposal = proposalFixture(), page = pageActions({ agentProposals: [proposal] }), snapshot = structuredClone(page.event());
  withGlobals(noEventWrites, () => {
    const capturedReview = buttonNamed(page.render(), "提案を確認");
    assert.equal(capturedReview.props["aria-expanded"], false);
    capturedReview.props.onClick();
    let reviewed = page.render();
    assert.equal(buttonNamed(reviewed, "提案を確認").props["aria-expanded"], true);
    buttonNamed(reviewed, "表で比較").props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "preview-strip").length, 1);
    capturedReview.props.onClick();
    reviewed = page.render();
    assert.equal(elements(reviewed, node => node.props.className === "plan-results" || node.props.className === "preview-strip").length, 0);
    assert.equal(buttonNamed(reviewed, "提案を確認").props["aria-expanded"], false);
    assert.equal(elements(reviewed, node => node.type === timetable.Timetable)[0].props.preview, false);
    buttonNamed(reviewed, "提案を確認").props.onClick();
    reviewed = page.render();
    assert.equal(elements(reviewed, node => node.props.className === "plan-results").length, 1);
    buttonLabelled(reviewed, "調整案を閉じる").props.onClick();
    reviewed = page.render();
    assert.equal(buttonNamed(reviewed, "提案を確認").props["aria-expanded"], false);
    buttonNamed(reviewed, "提案を確認").props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 1, "a closed proposal can be reopened normally");
    assert.deepEqual(page.event(), snapshot);
  });
});

test("reviewing a different proposal switches the comparison instead of toggling the first one closed", () => {
  const first = proposalFixture(), second = proposalFixture({ id: "second-proposal", text: "全体を5分短縮したい" });
  second.result = { ...second.result, plans: [{ ...second.result.plans[0], id: "second-plan", title: "別の依頼の比較案" }] };
  const page = pageActions({ agentProposals: [first, second] });
  withGlobals(noEventWrites, () => {
    const reviews = () => elements(page.render(), node => node.type === "button" && textOf(node) === "提案を確認");
    reviews()[0].props.onClick();
    reviews()[1].props.onClick();
    const tree = page.render(), results = elements(tree, node => node.props.className === "plan-results");
    assert.equal(results.length, 1);
    assert.match(textOf(results[0]), /別の依頼の比較案/);
    assert.deepEqual(reviews().map(button => button.props["aria-expanded"]), [false, true]);
  });
});

test("individual adjustment plans can be removed without deleting other candidates or saving the timetable", () => {
  const proposal = proposalFixture();
  proposal.result.plans.push({ ...proposal.result.plans[0], id: "second-plan", title: "残しておく別案" });
  const page = pageActions({ agentProposals: [proposal] }), snapshot = structuredClone(page.event());
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    const firstPlan = elements(page.render(), node => node.props.className === "plan-option")[0];
    buttonNamed(firstPlan, "表で比較").props.onClick();
    const removeFirst = buttonLabelled(page.render(), "調整案を削除：保存済みの比較案");
    assert.ok(removeFirst);
    removeFirst.props.onClick();
    let tree = page.render(), candidates = elements(tree, node => node.props.className?.startsWith("plan-option") && node.type === "article");
    assert.equal(candidates.length, 1);
    assert.match(textOf(candidates[0]), /残しておく別案/);
    assert.equal(elements(tree, node => node.props.className === "preview-strip").length, 0, "removing the displayed candidate restores the original table");
    buttonLabelled(tree, "調整案を削除：残しておく別案").props.onClick();
    tree = page.render();
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0);
    assert.equal(buttonNamed(tree, "提案を確認").props["aria-expanded"], false);
    assert.deepEqual(page.event(), snapshot);
    assert.equal(proposal.result.plans.length, 2, "local candidate removal does not mutate saved server objects");
  });
});

test("removing an unselected adjustment plan leaves the selected table comparison intact", () => {
  const proposal = proposalFixture();
  proposal.result.plans.push({ ...proposal.result.plans[0], id: "second-plan", title: "不要な別案" });
  const page = pageActions({ agentProposals: [proposal] });
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    buttonNamed(page.render(), "表で比較").props.onClick();
    buttonLabelled(page.render(), "調整案を削除：不要な別案").props.onClick();
    const tree = page.render();
    assert.equal(elements(tree, node => node.props.className === "preview-strip").length, 1);
    assert.equal(elements(tree, node => node.type === timetable.Timetable)[0].props.preview, true);
  });
});

test("a saved proposal can be dismissed and restored without altering its event or appending a duplicate", async () => {
  const proposal = proposalFixture(), page = pageActions({ storage: "cloud", agentProposals: [proposal] }), snapshot = structuredClone(page.event()), calls = [];
  let respond;
  await withGlobals({ ...noEventWrites, fetch(url, options) {
    calls.push([url, options]);
    assert.equal(url, "/api/agent");
    assert.equal(options.method, "PATCH");
    return new Promise(resolve => { respond = resolve; });
  } }, async () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    buttonNamed(page.render(), "表で比較").props.onClick();
    const remove = buttonLabelled(page.render(), `提案を削除：${proposal.text}`);
    assert.ok(remove);
    remove.props.onClick();
    remove.props.onClick();
    assert.equal(calls.length, 1, "a captured callback cannot duplicate an in-flight dismissal");
    assert.deepEqual(JSON.parse(calls[0][1].body), { action: "dismiss", proposalId: proposal.id, eventId: snapshot.event.id, expectedRevision: snapshot.revision });
    respond({ ok: true, json: async () => ({ proposalId: proposal.id, eventId: snapshot.event.id, dismissed: true, applied: false }) });
    await settleCallbacks();
    let tree = page.render();
    assert.equal(buttonLabelled(tree, `提案を削除：${proposal.text}`), undefined);
    assert.equal(elements(tree, node => node.props.className === "plan-results" || node.props.className === "preview-strip").length, 0, "dismissing the active proposal also clears its preview");
    const undo = buttonNamed(tree, "元に戻す");
    assert.ok(undo, "the recoverable dismissal offers undo");
    undo.props.onClick();
    undo.props.onClick();
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1][1].body), { action: "restore", proposalId: proposal.id, eventId: snapshot.event.id, expectedRevision: snapshot.revision });
    respond({ ok: true, json: async () => ({ proposalId: proposal.id, eventId: snapshot.event.id, dismissed: false, applied: false }) });
    await settleCallbacks();
    tree = page.render();
    assert.match(textOf(tree), /エージェントからの提案 · 1件/);
    assert.ok(buttonLabelled(tree, `提案を削除：${proposal.text}`));
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0, "undo restores the card but does not open or apply it");
    assert.deepEqual(page.event(), snapshot);
  });
});

test("a failed saved-proposal dismissal keeps the card and comparison available", async () => {
  const proposal = proposalFixture(), page = pageActions({ storage: "cloud", agentProposals: [proposal] }), snapshot = structuredClone(page.event());
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/agent"); assert.equal(options.method, "PATCH");
    return { ok: false, status: 409, json: async () => ({ error: "別の画面でイベントが更新されました" }) };
  } }, async () => {
    buttonNamed(page.render(), "提案を確認").props.onClick();
    buttonLabelled(page.render(), `提案を削除：${proposal.text}`).props.onClick();
    await settleCallbacks();
    const tree = page.render();
    assert.ok(buttonLabelled(tree, `提案を削除：${proposal.text}`));
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 1);
    assert.equal(buttonNamed(tree, "元に戻す"), undefined);
    assert.deepEqual(page.event(), snapshot);
  });
});

test("an inbox refresh started before dismissal cannot resurrect the dismissed proposal", async () => {
  const proposal = proposalFixture(), page = pageActions({ storage: "cloud", agentProposals: [proposal] }), replies = new Map();
  const snapshot = structuredClone(page.event());
  await withGlobals({ ...noEventWrites,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval() { return 7; }, clearInterval() {},
    fetch(url, options) {
      if (options.method === "PATCH") {
        assert.equal(url, "/api/agent");
        assert.equal(JSON.parse(options.body).action, "dismiss");
        return Promise.resolve({ ok: true, json: async () => ({ proposalId: proposal.id, eventId: snapshot.event.id, dismissed: true, applied: false }) });
      }
      assert.ok(url === "/api/agent" || url === "/api/changes");
      return new Promise(resolve => { replies.set(url, resolve); });
    },
  }, async () => {
    page.render();
    const cleanup = page.effects[2]();
    assert.equal(replies.size, 2);
    buttonLabelled(page.render(), `提案を削除：${proposal.text}`).props.onClick();
    await settleCallbacks();
    assert.equal(buttonLabelled(page.render(), `提案を削除：${proposal.text}`), undefined);
    replies.get("/api/agent")({ ok: true, json: async () => ({ proposals: [proposal] }) });
    replies.get("/api/changes")({ ok: true, json: async () => ({ eventId: snapshot.event.id, pendingRequests: [], pendingCount: 0 }) });
    await settleCallbacks();
    assert.equal(buttonLabelled(page.render(), `提案を削除：${proposal.text}`), undefined, "the stale poll response cannot override a successful dismissal");
    assert.deepEqual(page.event(), snapshot);
    cleanup?.();
  });
});

test("stale proposals refresh their original persisted request in place against the latest event", async () => {
  const proposal = proposalFixture({ baseRevision: demo.demoState.revision - 1 });
  const originalProposal = structuredClone(proposal), latest = structuredClone(demo.demoState);
  latest.slots[3].notes = "最新の出演条件のセンチネル";
  const page = pageActions({ storage: "cloud", agentProposals: [proposal] }), calls = [];
  const refreshed = proposalFixture({ baseRevision: latest.revision, createdAt: "2026-10-18T07:10:00Z", result: { ...proposal.result, plans: [{ ...proposal.result.plans[0], title: "最新条件で作成した比較案" }] } });
  await withGlobals({ ...noEventWrites, fetch: proposalRefreshFetch(calls, latest, refreshed) }, async () => {
    const tree = page.render(), review = buttonNamed(tree, "最新条件で再比較");
    assert.match(textOf(tree), /更新前の提案/);
    assert.ok(review);
    assert.equal(review.props.disabled, false);
    review.props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0, "cached plans must never be shown as refreshed");
    await settleCallbacks();
    assert.deepEqual(calls.map(([url]) => url), ["/api/event", "/api/agent"]);
    assert.deepEqual(JSON.parse(calls[1][1].body), { action: "refresh", proposalId: proposal.id, eventId: latest.event.id, expectedRevision: latest.revision });
    const reviewed = page.render();
    assert.equal(elements(reviewed, node => node.props.className === "plan-results").length, 1);
    assert.match(textOf(reviewed), /最新条件で作成した比較案/);
    assert.match(textOf(reviewed), /エージェントからの提案 · 1件/);
    assert.doesNotMatch(textOf(reviewed), /更新前の提案/);
    assert.match(textOf(reviewed), /再比較/);
    assert.match(textOf(reviewed), /未反映/);
    assert.deepEqual(page.event(), latest, "a fresh cloud read only synchronizes the in-memory event");
    assert.deepEqual(proposal, originalProposal, "the original object is not mutated or given a false fresh revision");
    assert.equal(buttonNamed(reviewed, "提案を確認").props["aria-expanded"], true);
    buttonNamed(reviewed, "提案を確認").props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    buttonNamed(page.render(), "提案を確認").props.onClick();
    assert.match(textOf(elements(page.render(), node => node.props.className === "plan-results")[0]), /最新条件で作成した比較案/);
    assert.equal(calls.length, 2, "toggling a refreshed proposal uses its new stored comparison without rerunning Decisions");
  });
});

test("a rejected saved-proposal refresh preserves the original card without duplicating or locally falling back", async () => {
  const proposal = proposalFixture({ baseRevision: demo.demoState.revision - 1 }), page = pageActions({ storage: "cloud", agentProposals: [proposal] }), calls = [];
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    calls.push([url, options]);
    if (url === "/api/event") return { ok: true, json: async () => ({ state: structuredClone(demo.demoState) }) };
    assert.equal(url, "/api/agent"); assert.equal(options.method, "PATCH");
    return { ok: false, status: 409, json: async () => ({ error: "進行表が更新されました。" }) };
  } }, async () => {
    const captured = buttonNamed(page.render(), "最新条件で再比較");
    captured.props.onClick(); captured.props.onClick();
    await settleCallbacks();
    const tree = page.render();
    assert.deepEqual(calls.map(([url]) => url), ["/api/event", "/api/agent"]);
    assert.match(textOf(tree), /エージェントからの提案 · 1件/);
    assert.match(textOf(tree), /更新前の提案/);
    assert.match(textOf(tree), /進行表が更新されました/);
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 0);
    assert.equal(buttonNamed(tree, "最新条件で再比較").props.disabled, false, "the original request can be retried after the conflict");
  });
});

test("a captured current proposal callback rechecks revision before using its cached candidates", async () => {
  const proposal = proposalFixture(), latest = structuredClone(demo.demoState);
  latest.revision += 1;
  const page = pageActions({ storage: "cloud", agentProposals: [proposal] }), calls = [];
  const refreshed = proposalFixture({ baseRevision: latest.revision });
  await withGlobals({ ...noEventWrites, fetch: proposalRefreshFetch(calls, latest, refreshed) }, async () => {
    const review = buttonNamed(page.render(), "提案を確認");
    page.setEvent(latest);
    review.props.onClick();
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    await settleCallbacks();
    assert.deepEqual(calls.map(([url]) => url), ["/api/event", "/api/agent"]);
    assert.deepEqual(JSON.parse(calls[1][1].body), { action: "refresh", proposalId: proposal.id, eventId: latest.event.id, expectedRevision: latest.revision });
    assert.deepEqual(page.event(), latest);
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
    assert.match(textOf(page.render()), /現在のイベントの保存状態を確認/);
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
  assert.ok(page.effects.length >= 4, "The first four page effects must retain their ordering");
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
function proposalRefreshFetch(calls, state, refreshed) {
  return (url, options) => {
    calls.push([url, options]);
    if (url === "/api/event") {
      assert.deepEqual(options, { cache: "no-store" });
      return Promise.resolve({ ok: true, json: async () => ({ state: structuredClone(state) }) });
    }
    assert.equal(url, "/api/agent", "saved proposals must update their existing record instead of appending another comparison");
    assert.equal(options.method, "PATCH");
    return Promise.resolve({ ok: true, json: async () => ({ proposal: refreshed, applied: false }) });
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

test("future, foreign and malformed review links never compare, persist or apply changes", async () => {
  for (const [hash, event = structuredClone(demo.demoState)] of [
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

test("an old link automatically replays its request once against newer server conditions without event writes", async () => {
  const latest = structuredClone(demo.demoState); latest.revision += 1; latest.slots[3].notes = "new server condition";
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
  await withGlobals({ ...noEventWrites, window: browser.window, fetch: reviewFetch(calls, latest) }, async () => {
    page.render();
    const cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.deepEqual(calls.map(([url]) => url), ["/api/event", "/api/plans"]);
    assert.deepEqual(JSON.parse(planCalls(calls)[0][1].body), { state: latest, text: "次の登壇者が15分遅れます" });
    const tree = page.render();
    assert.equal(elements(tree, node => node.props.className === "plan-results").length, 1);
    assert.match(textOf(tree), /再比較/);
    assert.match(textOf(tree), /未反映/);
    assert.doesNotMatch(textOf(tree), /リンクを作り直してください/);
    assert.deepEqual(page.event(), latest);
    assert.equal(browser.replacements.length, 1);
    cleanup?.();
    browser.location.hash = reviewHash();
    page.render();
    const repeatedCleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(planCalls(calls).length, 1, "restoring the same stale link does not rerun paid comparison");
    repeatedCleanup?.();
  });
});

test("an old link also replays when mounted state is already at the newer revision", async () => {
  const latest = structuredClone(demo.demoState); latest.revision += 2;
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud", event: latest }), calls = [];
  await withGlobals({ ...noEventWrites, window: browser.window, fetch: reviewFetch(calls, latest) }, async () => {
    page.render();
    const cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.equal(planCalls(calls).length, 1);
    assert.deepEqual(JSON.parse(planCalls(calls)[0][1].body).state, latest);
    assert.deepEqual(page.event(), latest);
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

test("a latest-event read cannot replace a newer same-tab edit or an event switch while it is pending", async () => {
  for (const changedIdentity of [false, true]) {
    const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
    let respond;
    await withGlobals({ ...noEventWrites, window: browser.window, fetch(url, options) {
      calls.push([url, options]);
      assert.equal(url, "/api/event", "a raced refresh must stop before comparing candidates");
      return new Promise(resolve => { respond = resolve; });
    } }, async () => {
      page.render();
      const cleanup = runReviewEffect(page);
      const edited = structuredClone(demo.demoState);
      if (changedIdentity) edited.event.id = "another-event-at-the-same-revision";
      else { edited.revision += 1; edited.slots[3].notes = "same-tab newer edit"; }
      page.setEvent(edited);
      respond({ ok: true, json: async () => ({ state: structuredClone(demo.demoState) }) });
      await settleCallbacks();
      assert.equal(calls.length, 1);
      assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
      assert.deepEqual(page.event(), edited, "the user's newer state is preserved");
      cleanup?.();
    });
  }
});

test("a latest-event read rejects another server event without rebinding the request text", async () => {
  const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
  const foreign = structuredClone(demo.demoState); foreign.event.id = "server-switched-event";
  const snapshot = structuredClone(page.event());
  await withGlobals({ ...noEventWrites, window: browser.window, fetch: reviewFetch(calls, foreign) }, async () => {
    page.render();
    const cleanup = runReviewEffect(page);
    await settleCallbacks();
    assert.deepEqual(calls.map(([url]) => url), ["/api/event"]);
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    assert.deepEqual(page.event(), snapshot);
    cleanup?.();
  });
});

test("a finished comparison cannot publish cached candidates after a same-tab revision or event change", async () => {
  for (const changedIdentity of [false, true]) {
    const browser = reviewBrowser(reviewHash()), page = pageActions({ storage: "cloud" }), calls = [];
    let respond;
    await withGlobals({ ...noEventWrites, window: browser.window, fetch(url, options) {
      calls.push([url, options]);
      if (url === "/api/event") return Promise.resolve({ ok: true, json: async () => ({ state: structuredClone(demo.demoState) }) });
      assert.equal(url, "/api/plans");
      return new Promise(resolve => { respond = resolve; });
    } }, async () => {
      page.render();
      const cleanup = runReviewEffect(page);
      await settleCallbacks();
      assert.ok(respond, "the comparison is now pending");
      const edited = structuredClone(demo.demoState);
      if (changedIdentity) edited.event.id = "another-event-at-the-same-revision";
      else edited.revision += 1;
      page.setEvent(edited);
      respond({ ok: true, json: async () => proposalFixture().result });
      await settleCallbacks();
      assert.deepEqual(calls.map(([url]) => url), ["/api/event", "/api/plans"]);
      assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
      assert.deepEqual(page.event(), edited);
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

const issueInput = tree => elements(tree, node => node.type === "input" && node.props.id === "issue-input")[0];
function enterIssue(page, text) { issueInput(page.render()).props.onChange({ target: { value: text } }); return page.render(); }
function changeRequestFixture(overrides = {}) {
  const id = "d4a01bea-d0e0-4cf7-851c-361202e1a963";
  return { id, eventId: demo.demoState.event.id, baseRevision: demo.demoState.revision, text: "全体を10分短縮したい", createdAt: "2026-10-18T06:00:00Z", status: "pending", requestId: `change:${id}`, ...overrides };
}

test("the dot request action stays secondary and its empty inbox is hidden", () => {
  const page = pageActions(), tree = page.render();
  const submit = buttonNamed(tree, "dotに依頼");
  assert.ok(submit);
  assert.equal(submit.props.type, "button");
  assert.equal(submit.props.disabled, true);
  assert.doesNotMatch(submit.props.className ?? "", /\bprimary\b/);
  assert.equal(elements(tree, node => node.props.className === "agent-inbox").length, 0);
  assert.doesNotMatch(textOf(tree), /待機中の変更依頼|未処理の変更依頼/);
});

test("dot request callbacks cannot enqueue while the event is local, loading, unsaved or comparing", async () => {
  for (const initial of [
    { storage: "local" },
    { storage: "cloud", saveStatus: "loading" },
    { storage: "cloud", saveStatus: "saving" },
    { storage: "cloud", saveStatus: "error" },
    { storage: "cloud", planning: true },
  ]) {
    const page = pageActions(initial), snapshot = JSON.stringify(page.event());
    await withGlobals(noEventWrites, async () => {
      const tree = enterIssue(page, "全体を10分短縮したい");
      const submit = buttonNamed(tree, "dotに依頼");
      assert.equal(submit.props.disabled, true, JSON.stringify(initial));
      submit.props.onClick();
      await settleCallbacks();
      assert.equal(issueInput(page.render()).props.value, "全体を10分短縮したい");
      assert.equal(JSON.stringify(page.event()), snapshot);
    });
  }
});

test("enqueuing sends a single revision-bound POST, clears the successful input and never saves the timetable", async () => {
  const page = pageActions({ storage: "cloud" }), calls = [];
  const text = "全体を10分短縮したい 🎸 & 音止めは維持", snapshot = JSON.stringify(page.event());
  let respond;
  await withGlobals({
    ...noEventWrites,
    fetch(url, options) {
      assert.equal(url, "/api/changes");
      assert.equal(options.method, "POST");
      calls.push([url, options]);
      return new Promise(resolve => { respond = resolve; });
    },
  }, async () => {
    const tree = enterIssue(page, text), submit = buttonNamed(tree, "dotに依頼");
    assert.equal(submit.props.disabled, false);
    submit.props.onClick();
    submit.props.onClick(); // Captured callback before a rerender must still be single-flight.
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0][1].body);
    assert.deepEqual(Object.keys(sent).sort(), ["expectedRevision", "requestId", "text"]);
    assert.equal(sent.text, text);
    assert.equal(sent.expectedRevision, demo.demoState.revision);
    assert.match(sent.requestId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    assert.deepEqual(calls[0][1].headers, { "Content-Type": "application/json" });
    respond({ ok: true, json: async () => ({ request: changeRequestFixture({ id: sent.requestId, text }), applied: false }) });
    await settleCallbacks();
    assert.equal(issueInput(page.render()).props.value, "");
    assert.match(textOf(page.render()), /dot|変更依頼/);
    assert.equal(JSON.stringify(page.event()), snapshot);
    assert.equal(calls.length, 1);
  });
});

test("a failed dot request keeps its text and reuses its ID when exactly the same event and revision are retried", async () => {
  const page = pageActions({ storage: "cloud" }), calls = [];
  const text = "全体を10分短縮したい", snapshot = JSON.stringify(page.event());
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/changes");
    assert.equal(options.method, "POST");
    calls.push([url, options]);
    if (calls.length === 1) throw new Error("private-request-transport-sentinel");
    const sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ request: changeRequestFixture({ id: sent.requestId, text }), applied: false, replayed: true }) };
  } }, async () => {
    buttonNamed(enterIssue(page, text), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.equal(issueInput(page.render()).props.value, text);
    assert.doesNotMatch(textOf(page.render()), /private-request-transport-sentinel/);
    buttonNamed(page.render(), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1][1].body), JSON.parse(calls[0][1].body));
    assert.equal(issueInput(page.render()).props.value, "");
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("a replayed receipt uses authoritative queue and event-delivery counts instead of incrementing them locally", async () => {
  const page = pageActions({ storage: "cloud", changeRequests: [changeRequestFixture()] });
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST");
    const sent = JSON.parse(options.body);
    return { ok: true, json: async () => ({ request: changeRequestFixture({ id: sent.requestId, text: sent.text }), pendingCount: 7, events: { activeSubscriptions: 2, pendingDeliveries: 1, lastDeliveredAt: null }, replayed: true, applied: false }) };
  } }, async () => {
    buttonNamed(enterIssue(page, "全体を10分短縮したい"), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.match(textOf(page.render()), /dotへの依頼 · 未処理7件/);
    buttonNamed(page.render(), "連携・保存").props.onClick();
    assert.match(textOf(connectionDialog(page)), /イベント購読2件/);
    assert.match(textOf(connectionDialog(page)), /未通知のイベントが1件/);
    assert.deepEqual(page.event(), demo.demoState);
  });
});

test("a captured proposal-review callback cannot replace the submitted text while queue acceptance is pending", async () => {
  const page = pageActions({ storage: "cloud", agentProposals: [proposalFixture()] }), calls = [];
  const text = "全体を10分短縮したい", snapshot = JSON.stringify(page.event());
  let respond;
  await withGlobals({ ...noEventWrites, fetch(url, options) {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST");
    calls.push(JSON.parse(options.body));
    return new Promise(resolve => { respond = resolve; });
  } }, async () => {
    const initial = enterIssue(page, text), capturedReview = buttonNamed(initial, "提案を確認");
    assert.equal(capturedReview.props.disabled, false);
    buttonNamed(initial, "dotに依頼").props.onClick();
    capturedReview.props.onClick();
    assert.equal(calls.length, 1);
    assert.equal(issueInput(page.render()).props.value, text);
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    assert.equal(buttonNamed(page.render(), "提案を確認").props.disabled, true);
    assert.match(textOf(page.render()), /受付中/);
    respond({ ok: true, json: async () => ({ request: changeRequestFixture({ id: calls[0].requestId, text }), pendingCount: 1, applied: false }) });
    await settleCallbacks();
    assert.equal(issueInput(page.render()).props.value, "");
    assert.equal(buttonNamed(page.render(), "提案を確認").props.disabled, false);
    assert.equal(elements(page.render(), node => node.props.className === "plan-results").length, 0);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("an old queue receipt cannot overwrite an event changed while the request was pending", async () => {
  const oldEvent = structuredClone(demo.demoState), updated = structuredClone(oldEvent);
  updated.event.id = "new-current-event"; updated.event.name = "新しいイベント"; updated.revision += 1;
  const page = pageActions({ storage: "cloud", event: oldEvent, eventDelivery: { activeSubscriptions: 5, pendingDeliveries: 2, lastDeliveredAt: "2026-10-18T06:00:00Z" } });
  let respond, sent;
  await withGlobals({ ...noEventWrites, fetch(url, options) {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST"); sent = JSON.parse(options.body);
    return new Promise(resolve => { respond = resolve; });
  } }, async () => {
    buttonNamed(enterIssue(page, "全体を10分短縮したい"), "dotに依頼").props.onClick();
    page.setEvent(updated); // Simulates a separate, explicit organizer edit.
    respond({ ok: true, json: async () => ({ request: changeRequestFixture({ id: sent.requestId, text: sent.text }), pendingCount: 8, events: { activeSubscriptions: 9, pendingDeliveries: 6, lastDeliveredAt: "2026-10-18T07:00:00Z" }, applied: false }) });
    await settleCallbacks();
    assert.deepEqual(page.event(), updated);
    assert.equal(issueInput(page.render()).props.value, sent.text, "the old receipt must not clear current-event UI");
    assert.doesNotMatch(textOf(page.render()), /dotへの依頼 · 未処理8件/);
    buttonNamed(page.render(), "連携・保存").props.onClick();
    assert.match(textOf(connectionDialog(page)), /イベント購読未設定/);
    assert.doesNotMatch(textOf(connectionDialog(page)), /イベント購読[59]件|直近の通知受領|未通知のイベントが[26]件/);
  });
});

test("HTTP rejection keeps a queued request editable without claiming that it was sent", async () => {
  const page = pageActions({ storage: "cloud" });
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST");
    return { ok: false, status: 409, json: async () => ({ error: "進行表が更新されています。最新の状態を読み込んでください。" }) };
  } }, async () => {
    buttonNamed(enterIssue(page, "全体を10分短縮したい"), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.equal(issueInput(page.render()).props.value, "全体を10分短縮したい");
    assert.match(textOf(page.render()), /変更を受け付けられませんでした/);
    assert.doesNotMatch(textOf(page.render()), /変更依頼を受け付け|dotに依頼しました/);
  });
});

test("changing a rejected request starts a new idempotency identity instead of replaying different text under one ID", async () => {
  const page = pageActions({ storage: "cloud" }), sent = [];
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST");
    sent.push(JSON.parse(options.body));
    return { ok: false, status: 503, json: async () => ({ error: "受付できません。時間をおいて再度お試しください。" }) };
  } }, async () => {
    buttonNamed(enterIssue(page, "全体を10分短縮したい"), "dotに依頼").props.onClick();
    await settleCallbacks();
    buttonNamed(enterIssue(page, "全体を15分短縮したい"), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1].requestId, sent[0].requestId);
    assert.equal(sent[1].text, "全体を15分短縮したい");
    assert.equal(sent[0].expectedRevision, sent[1].expectedRevision);
    assert.equal(issueInput(page.render()).props.value, sent[1].text);
  });
});

test("the same request text gets a new idempotency identity after the event revision changes", async () => {
  const page = pageActions({ storage: "cloud" }), sent = [];
  await withGlobals({ ...noEventWrites, fetch: async (url, options) => {
    assert.equal(url, "/api/changes"); assert.equal(options.method, "POST");
    sent.push(JSON.parse(options.body));
    return { ok: false, status: 503, json: async () => ({ error: "受付できません。" }) };
  } }, async () => {
    buttonNamed(enterIssue(page, "全体を10分短縮したい"), "dotに依頼").props.onClick();
    await settleCallbacks();
    const updated = structuredClone(page.event()); updated.revision += 1;
    page.setEvent(updated);
    buttonNamed(page.render(), "dotに依頼").props.onClick();
    await settleCallbacks();
    assert.equal(sent.length, 2);
    assert.notEqual(sent[1].requestId, sent[0].requestId);
    assert.equal(sent[1].text, sent[0].text);
    assert.equal(sent[1].expectedRevision, updated.revision);
    assert.equal(sent[0].expectedRevision, demo.demoState.revision);
  });
});

test("the pending-change inbox excludes completed requests and requests for other events", () => {
  const pending = changeRequestFixture({ text: "このイベントの未処理依頼" });
  const done = changeRequestFixture({ id: "a2b39197-272d-42df-aa18-d75b95a871dd", text: "完了済み依頼の非表示センチネル", status: "proposed", proposalId: "proposal-done" });
  const foreign = changeRequestFixture({ id: "ff1d708b-f4a4-4bae-8841-cbfbe070d64c", eventId: "other-event", text: "他イベント依頼の非表示センチネル" });
  const page = pageActions({ storage: "cloud", changeRequests: [pending, done, foreign] });
  withGlobals(noEventWrites, () => {
    const tree = page.render();
    assert.match(textOf(tree), /このイベントの未処理依頼/);
    assert.match(textOf(tree), /dotへの依頼 · 未処理1件/);
    assert.doesNotMatch(textOf(tree), /完了済み依頼の非表示センチネル|他イベント依頼の非表示センチネル/);
  });
  assert.doesNotMatch(textOf(pageActions({ changeRequests: [done, foreign] }).render()), /このイベントの未処理依頼|完了済み依頼の非表示センチネル|他イベント依頼の非表示センチネル/);
});

test("the existing read-only inbox refresh also loads queued changes without becoming a browser-side dot scheduler", async () => {
  const page = pageActions({ storage: "cloud" }), calls = [], windowListeners = new Map(), documentListeners = new Map(), intervals = [];
  const document = { visibilityState: "visible", addEventListener(type, handler) { documentListeners.set(type, handler); }, removeEventListener(type, handler) { assert.equal(documentListeners.get(type), handler); documentListeners.delete(type); } };
  const window = { addEventListener(type, handler) { windowListeners.set(type, handler); }, removeEventListener(type, handler) { assert.equal(windowListeners.get(type), handler); windowListeners.delete(type); } };
  const snapshot = JSON.stringify(page.event());
  await withGlobals({ ...noEventWrites, window, document,
    setInterval(handler, interval) { intervals.push([handler, interval]); return 7; },
    clearInterval(id) { assert.equal(id, 7); },
    fetch: async (url, options) => {
      assert.ok(url === "/api/agent" || url === "/api/changes", "inbox refresh cannot enqueue or plan");
      assert.deepEqual(options, { cache: "no-store" });
      calls.push(url);
      return { ok: true, json: async () => url === "/api/agent" ? { proposals: [proposalFixture()] } : { eventId: demo.demoState.event.id, requests: [changeRequestFixture({ text: "古い一覧を優先しないセンチネル" })], pendingRequests: [changeRequestFixture({ text: "ポーリングで取得した依頼" })], pendingCount: 1, events: { activeSubscriptions: 2, pendingDeliveries: 1, lastDeliveredAt: "2026-10-18T06:00:00Z" } } };
    },
  }, async () => {
    page.render();
    assert.ok(page.effects.length >= 4, "queue display must retain the original inbox refresh effect at index 2");
    const cleanup = page.effects[2]();
    await settleCallbacks();
    assert.deepEqual([...calls].sort(), ["/api/agent", "/api/changes"]);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0][1], 15000, "a visual inbox refresh is not a remote event subscription");
    assert.match(textOf(page.render()), /ポーリングで取得した依頼/);
    assert.doesNotMatch(textOf(page.render()), /古い一覧を優先しないセンチネル/);
    assert.match(textOf(page.render()), /エージェントからの提案/);
    buttonNamed(page.render(), "連携・保存").props.onClick();
    assert.match(textOf(connectionDialog(page)), /イベント購読2件/);
    assert.match(textOf(connectionDialog(page)), /未通知のイベントが1件/);
    document.visibilityState = "hidden";
    windowListeners.get("focus")();
    await settleCallbacks();
    assert.equal(calls.length, 2, "hidden pages must not repeatedly fetch inboxes");
    cleanup();
    assert.equal(windowListeners.size, 0);
    assert.equal(documentListeners.size, 0);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("a foreign or missing queue event identity cannot overwrite current proposals, requests or delivery metadata", async () => {
  for (const eventId of ["foreign-current-event", undefined]) {
    const oldProposal = proposalFixture({ text: "保持される提案のセンチネル" });
    const oldRequest = changeRequestFixture({ text: "保持される受付のセンチネル" });
    const page = pageActions({ storage: "cloud", agentProposals: [oldProposal], changeRequests: [oldRequest], eventDelivery: { activeSubscriptions: 2, pendingDeliveries: 0, lastDeliveredAt: null } });
    const snapshot = structuredClone(page.event());
    await withGlobals({ ...noEventWrites,
      document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
      setInterval() { return 7; }, clearInterval() {},
      fetch: async url => {
        assert.ok(url === "/api/agent" || url === "/api/changes");
        return { ok: true, json: async () => url === "/api/agent" ? { proposals: [proposalFixture({ text: "取り込んではいけない提案のセンチネル" })] } : { ...(eventId ? { eventId } : {}), pendingRequests: [changeRequestFixture({ text: "取り込んではいけない受付のセンチネル" })], pendingCount: 9, events: { activeSubscriptions: 9, pendingDeliveries: 9, lastDeliveredAt: null } } };
      },
    }, async () => {
      page.render();
      const cleanup = page.effects[2]();
      await settleCallbacks();
      let tree = page.render();
      assert.match(textOf(tree), /保持される提案のセンチネル/);
      assert.match(textOf(tree), /保持される受付のセンチネル/);
      assert.doesNotMatch(textOf(tree), /取り込んではいけない/);
      buttonNamed(tree, "連携・保存").props.onClick();
      tree = connectionDialog(page);
      assert.match(textOf(tree), /イベント購読2件/);
      assert.doesNotMatch(textOf(tree), /イベント購読9件|未通知のイベントが9件/);
      assert.match(textOf(tree), /別の画面でイベントが切り替わりました/);
      assert.deepEqual(page.event(), snapshot);
      cleanup?.();
    });
  }
});

test("an inbox refresh begun for an earlier event cannot populate a newly selected event", async () => {
  const page = pageActions({ storage: "cloud" }), replies = new Map();
  const next = structuredClone(demo.demoState); next.event.id = "event-selected-during-refresh"; next.revision += 1;
  await withGlobals({ ...noEventWrites,
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    window: { addEventListener() {}, removeEventListener() {} },
    setInterval() { return 7; }, clearInterval() {},
    fetch: url => new Promise(resolve => { assert.ok(url === "/api/agent" || url === "/api/changes"); replies.set(url, resolve); }),
  }, async () => {
    page.render();
    const cleanup = page.effects[2]();
    page.setEvent(next);
    replies.get("/api/agent")({ ok: true, json: async () => ({ proposals: [proposalFixture({ eventId: next.event.id, text: "旧リクエストからの提案を混ぜないセンチネル" })] }) });
    replies.get("/api/changes")({ ok: true, json: async () => ({ eventId: demo.demoState.event.id, pendingRequests: [changeRequestFixture({ eventId: next.event.id, text: "旧リクエストからの受付を混ぜないセンチネル" })], pendingCount: 7, events: { activeSubscriptions: 7, pendingDeliveries: 7, lastDeliveredAt: null } }) });
    await settleCallbacks();
    assert.doesNotMatch(textOf(page.render()), /旧リクエストからの/);
    buttonNamed(page.render(), "連携・保存").props.onClick();
    assert.doesNotMatch(textOf(connectionDialog(page)), /イベント購読7件|未通知のイベントが7件/);
    assert.deepEqual(page.event(), next);
    cleanup?.();
  });
});

test("copying event-monitor setup never registers a subscription or writes event state by itself", async () => {
  const page = pageActions(), copied = [], snapshot = JSON.stringify(page.event());
  await withGlobals({ ...noEventWrites, window: { location: { origin: "https://tool.example.test" } }, navigator: { clipboard: { async writeText(text) { copied.push(text); } } } }, async () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    const copy = buttonNamed(connectionDialog(page), "イベント監視の指示をコピー");
    assert.ok(copy);
    copy.props.onClick();
    await settleCallbacks();
    assert.deepEqual(copied, [dotInstructions.dotMonitoringInstructions("https://tool.example.test")]);
    assert.match(textOf(connectionDialog(page)), /(?:稼働|監視).*(?:判定|確認|確かめ)|(?:判定|確認|確かめ).*(?:稼働|監視)/);
    assert.equal(JSON.stringify(page.event()), snapshot);
  });
});

test("subscription and delivery metadata never claim that a dot processed the request or completed a proposal", () => {
  const page = pageActions({ eventDelivery: { activeSubscriptions: 2, pendingDeliveries: 3, lastDeliveredAt: "2026-10-18T06:00:00Z" } });
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /イベント購読2件/);
    assert.match(textOf(dialog), /未通知のイベントが3件/);
    assert.match(textOf(dialog), /直近の通知受領/);
    assert.match(textOf(dialog), /候補の作成完了とは別です/);
    assert.match(textOf(dialog), /受信者がdotsであることや処理完了を示すものではありません/);
    assert.doesNotMatch(textOf(dialog), /dot(?:s)?接続確認済み|dot(?:s)?稼働中|提案作成済み/);
  });
});

test("notification metadata for another event is never shown as a subscription for the current event", () => {
  const page = pageActions({ eventDelivery: { eventId: "foreign-event", activeSubscriptions: 5, pendingDeliveries: 7, lastDeliveredAt: "2026-10-18T06:00:00Z" } });
  withGlobals(noEventWrites, () => {
    buttonNamed(page.render(), "連携・保存").props.onClick();
    const dialog = connectionDialog(page);
    assert.match(textOf(dialog), /イベント購読未設定/);
    assert.doesNotMatch(textOf(dialog), /イベント購読5件|未通知のイベントが7件|直近の通知受領/);
    assert.deepEqual(page.event(), demo.demoState);
  });
});

function shorteningProposalFixture(met = false) {
  const proposal = proposalFixture({ text: "全体を10分短縮したい" });
  proposal.result.issue = { kind: "shorten", minutes: 10, text: proposal.text };
  const plan = proposal.result.plans[0];
  const reductions = met ? { panel: 10 } : { break: 5, lightning: 2, panel: 3 };
  plan.slots = plan.slots.map(slot => ({ ...slot, durationMinutes: slot.durationMinutes - (reductions[slot.id] ?? 0) }));
  plan.schedule = planner.computeSchedule(demo.demoState, plan.slots);
  assert.equal(plan.schedule.endsAt, met ? 1000 : 1002);
  assert.equal(planner.computeSchedule(demo.demoState).contentMinutes - plan.schedule.contentMinutes, 10);
  return proposal;
}

test("overall-shortening plans display net finish progress separately from content cuts and label unmet approval explicitly", () => {
  for (const met of [false, true]) {
    const proposal = shorteningProposalFixture(met);
    proposal.result.plans[0].shortening = { originalEnd: 1010, targetEnd: 1000, requestedMinutes: 10, achievedMinutes: met ? 10 : 8, shortfallMinutes: met ? 0 : 2, contentReductionMinutes: 10, met };
    const page = pageActions({ agentProposals: [proposal] });
    withGlobals(noEventWrites, () => {
      buttonNamed(page.render(), "提案を確認").props.onClick();
      const tree = page.render(), results = elements(tree, node => node.props.className === "plan-results")[0];
      assert.match(textOf(results), /16:40/);
      assert.match(textOf(results), met ? /10分/ : /8分/);
      assert.match(textOf(results), /(?:内容|演目).*10分/);
      if (!met) {
        assert.match(textOf(results), /(?:不足|未達|あと).*2分|2分.*(?:不足|未達)/);
        assert.ok(buttonNamed(results, "未達案を反映"));
        assert.equal(buttonNamed(results, "反映"), undefined);
      } else {
        assert.ok(buttonNamed(results, "反映"));
        assert.equal(buttonNamed(results, "未達案を反映"), undefined);
      }
      assert.deepEqual(page.event(), demo.demoState);
    });
  }
});

test("legacy shortening proposals recompute actual eight-minute progress and missing two-minute shortfall instead of trusting cached metadata", () => {
  for (const forgedMetadata of [undefined, { originalEnd: 1010, targetEnd: 1000, requestedMinutes: 10, achievedMinutes: 10, shortfallMinutes: 0, contentReductionMinutes: 10, met: true }]) {
    const proposal = shorteningProposalFixture(false);
    if (forgedMetadata) proposal.result.plans[0].shortening = forgedMetadata;
    // Old saved schedules and metadata are presentation caches, not authority.
    proposal.result.plans[0].schedule.endsAt = 1000;
    const originalProposal = structuredClone(proposal), page = pageActions({ agentProposals: [proposal] });
    withGlobals(noEventWrites, () => {
      buttonNamed(page.render(), "提案を確認").props.onClick();
      const results = elements(page.render(), node => node.props.className === "plan-results")[0];
      assert.match(textOf(results), /終了 16:42/);
      assert.match(textOf(results), /目標 16:40/);
      assert.match(textOf(results), /終演8分短縮/);
      assert.match(textOf(results), /あと2分不足/);
      assert.match(textOf(results), /演目時間の削減は10分/);
      assert.ok(buttonNamed(results, "未達案を反映"));
      assert.equal(buttonNamed(results, "反映"), undefined);
      assert.deepEqual(proposal, originalProposal, "reviewing must not rewrite the persisted proposal");
      assert.deepEqual(page.event(), demo.demoState);
    });
  }
});
