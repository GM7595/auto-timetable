import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const projectRequire = createRequire(import.meta.url);
const React = projectRequire("react");
const { renderToStaticMarkup } = projectRequire("react-dom/server");
const { searchEmojis, getEmojiByUnified } = projectRequire("emoji-picker-react/data");
const importedDataset = projectRequire("emoji-picker-react/data/emojis-ja");
const dataset = importedDataset.default ?? importedDataset;
const pickerPackage = projectRequire("emoji-picker-react");
function compile(path, dependencies = {}) {
  const url = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
    fileName: url.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const module = { exports: {} };
  const require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : projectRequire(name);
  new Function("require", "module", "exports", compiled.outputText)(require, module, module.exports);
  return module.exports;
}
const { isMemberRoleIcon } = compile("./member-roles.ts");
const labelsModule = compile("./emoji-picker-labels.ts");
function picker() {
  const calls = [];
  const effects = [];
  let colorScheme = "light";
  function MockPicker() {}
  const { RoleEmojiPickerContent } = compile("../components/role-emoji-picker-content.tsx", {
    react: { ...React, useState: () => [colorScheme, next => { colorScheme = next; }], useEffect: effect => effects.push(effect) },
    "emoji-picker-react": { ...pickerPackage, __esModule: true, default: MockPicker },
    "@/lib/emoji-picker-labels": labelsModule,
    "@/lib/member-roles": { isMemberRoleIcon },
  });
  function render() { return RoleEmojiPickerContent({ selected: "🏷️", onSelect: emoji => calls.push(emoji) }); }
  return { render, calls, effects, config: () => render().props.children.props };
}
const toEmoji = unified => String.fromCodePoint(...unified.split("-").map(code => Number.parseInt(code, 16)));

test("the local Japanese dataset includes all categories, thousands of variants, flags and ZWJ sequences", () => {
  const entries = Object.values(dataset.emojis).flat();
  assert.ok(entries.length > 1800);
  const unified = entries.flatMap(emoji => [emoji.u, ...(emoji.v ?? [])]);
  assert.ok(unified.length > 3500);
  for (const category of ["smileys_people", "animals_nature", "food_drink", "travel_places", "activities", "objects", "symbols", "flags"]) assert.ok(dataset.emojis[category].length > 0, category);
  assert.equal(getEmojiByUnified("1f1ef-1f1f5", { emojiData: dataset }).emoji, "🇯🇵");
  assert.equal(getEmojiByUnified("1f9d1-200d-1f680", { emojiData: dataset }).emoji, "🧑‍🚀");
  assert.ok(unified.includes("1f44d-1f3fd"));
  for (const value of unified) assert.ok(isMemberRoleIcon(toEmoji(value)), `Persisted icon validator rejected ${value}`);
});

test("Japanese names and keywords find emojis outside the former short curated list", () => {
  for (const [search, emoji] of [["猫", "😺"], ["ピザ", "🍕"], ["ロケット", "🚀"]]) {
    assert.ok(searchEmojis(search, { emojiData: dataset }).some(result => result.emoji === emoji), search);
  }
});

test("the picker uses the bundled locale with native Unicode, all categories, search, recent and skin tones", () => {
  const control = picker();
  const config = control.config();
  assert.equal(config.emojiData, dataset);
  assert.equal(config.emojiStyle, "native");
  assert.equal(config.lang, "ja");
  assert.equal(config.suggestedEmojisMode, "recent");
  assert.equal(config.width, "100%");
  assert.equal(config.height, 360);
  assert.equal(config.style.minWidth, 0);
  assert.equal(config.style.maxWidth, "100%");
  assert.equal(config.categories.length, 9);
  assert.ok(config.categories.some(category => category.category === "flags" && category.name === "旗"));
  assert.equal(config.skinTonesDisabled, undefined);
  assert.equal(config.searchDisabled, undefined);
  assert.equal(config.emojiVersion, undefined);
  assert.equal(config.hiddenEmojis, undefined);
  assert.equal(config.customEmojis, undefined);
  assert.equal(config.getEmojiUrl, undefined);
});

test("the real picker server-renders safely inside forms with accessible Japanese controls and no remote emoji images", () => {
  const { RoleEmojiPickerContent } = compile("../components/role-emoji-picker-content.tsx", {
    "@/lib/emoji-picker-labels": labelsModule,
    "@/lib/member-roles": { isMemberRoleIcon },
  });
  const html = renderToStaticMarkup(React.createElement(RoleEmojiPickerContent, { selected: "🏷️", onSelect() {} }));
  assert.match(html, /aria-label="絵文字を検索"/);
  assert.match(html, /aria-label="絵文字のカテゴリ"/);
  assert.match(html, /role="tablist"/);
  assert.ok([...html.matchAll(/<button\b/g)].length > 8);
  assert.doesNotMatch(html, /<form\b|<img\b|src="https?:/);
  for (const button of html.matchAll(/<button\b([^>]*)>/g)) assert.match(button[1], /type="button"/);
});

test("the stable lazy wrapper defers the engine and dictionaries until opened and preserves callbacks with a Japanese loading state", () => {
  const loaders = [];
  function MockLazy() {}
  const { RoleEmojiPicker } = compile("../components/role-emoji-picker.tsx", {
    react: { ...React, lazy(loader) { loaders.push(loader); return MockLazy; } },
  });
  assert.equal(loaders.length, 1);
  const onSelect = () => {};
  const wrapper = RoleEmojiPicker({ selected: "🍕", onSelect });
  assert.equal(wrapper.type, "div");
  assert.equal(wrapper.props.style.width, "100%");
  assert.equal(wrapper.props.style.minWidth, 0);
  const suspense = wrapper.props.children;
  assert.equal(suspense.type, React.Suspense);
  assert.equal(suspense.props.fallback.props.role, "status");
  assert.equal(suspense.props.fallback.props.children, "絵文字を読み込み中…");
  assert.equal(suspense.props.children.type, MockLazy);
  assert.equal(suspense.props.children.props.selected, "🍕");
  assert.equal(suspense.props.children.props.onSelect, onSelect);
  RoleEmojiPicker({ selected: "🎤", onSelect });
  assert.equal(loaders.length, 1, "the loader must not be recreated per render");
  const source = readFileSync(new URL("../components/role-emoji-picker.tsx", import.meta.url), "utf8");
  assert.match(source, /lazy\(\(\) => import\("\.\/role-emoji-picker-content"\)/);
  assert.doesNotMatch(source, /from "emoji-picker-react(?:\/data[^\"]*)?"/);
});

test("only a valid native emoji can leave the picker, including flags and skin-tone sequences", () => {
  const control = picker();
  for (const emoji of ["🍕", "🇯🇵", "👍🏽", "🧑‍🚀"]) control.config().onEmojiClick({ emoji, isCustom: false });
  for (const emoji of ["", "letters", "🎤🎤", "<img>"]) control.config().onEmojiClick({ emoji, isCustom: false });
  control.config().onEmojiClick({ emoji: "😀", isCustom: true });
  assert.deepEqual(control.calls, ["🍕", "🇯🇵", "👍🏽", "🧑‍🚀"]);
});

test("every chrome label, category and preview caption is Japanese", () => {
  const config = picker().config();
  const expectedKeys = ["searchPlaceholder", "searchLabel", "searchClear", "searchResultsNone", "searchResultsOne", "searchResultsMany", "categoryNavigation", "reactions", "expandReactions", "loading", "loadingError", "retryLoading", "skinToneNeutral", "skinToneLight", "skinToneMediumLight", "skinToneMedium", "skinToneMediumDark", "skinToneDark"];
  assert.deepEqual(Object.keys(config.labels).sort(), expectedKeys.sort());
  for (const label of Object.values(config.labels)) assert.match(label, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u);
  assert.ok(config.labels.searchResultsMany.includes("%n"));
  assert.equal(config.previewConfig.defaultCaption, "絵文字を選んでください");
});

test("theme follows the app's resolved data-theme rather than the OS, including later theme switches", () => {
  const previousDocument = globalThis.document;
  const previousObserver = globalThis.MutationObserver;
  const root = { dataset: { theme: "dark" } };
  let callback;
  let observed;
  let disconnected = false;
  globalThis.document = { documentElement: root };
  globalThis.MutationObserver = class {
    constructor(update) { callback = update; }
    observe(element, options) { observed = { element, options }; }
    disconnect() { disconnected = true; }
  };
  try {
    const control = picker();
    control.render();
    const cleanup = control.effects[0]();
    assert.deepEqual(observed, { element: root, options: { attributes: true, attributeFilter: ["data-theme"] } });
    assert.equal(control.config().colorScheme, "dark");
    root.dataset.theme = "light";
    callback();
    assert.equal(control.config().colorScheme, "light");
    cleanup();
    assert.equal(disconnected, true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    if (previousObserver === undefined) delete globalThis.MutationObserver; else globalThis.MutationObserver = previousObserver;
  }
});

function keyEvent(key, part = "search-input", nativeEvent = {}) {
  const calls = [];
  return {
    calls,
    key,
    target: { getAttribute(name) { return name === "data-epr-part" ? part : null; } },
    currentTarget: {},
    nativeEvent,
    stopPropagation() { calls.push("stop"); },
    preventDefault() { calls.push("prevent"); },
  };
}

test("search Enter cannot submit the slot form; Escape and emoji-button shortcuts keep their semantics", () => {
  const tree = picker().render();
  const enter = keyEvent("Enter");
  tree.props.onKeyDown(enter);
  assert.deepEqual(enter.calls, ["stop", "prevent"]);
  for (const event of [keyEvent("Escape"), keyEvent("ArrowDown"), keyEvent("Enter", "emoji"), keyEvent(" ", "emoji")]) {
    tree.props.onKeyDown(event);
    assert.deepEqual(event.calls, []);
  }
});

test("IME confirmation is neither submitted nor passed to the picker's selection shortcut", () => {
  const tree = picker().render();
  for (const nativeEvent of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = keyEvent("Enter", "search-input", nativeEvent);
    tree.props.onKeyDownCapture(event);
    assert.deepEqual(event.calls, ["stop"]);
  }
  const normalEnter = keyEvent("Enter");
  tree.props.onKeyDownCapture(normalEnter);
  assert.deepEqual(normalEnter.calls, []);
});

test("picker CSS maps every surface and focus state to app tokens and lets category navigation scroll on small screens", () => {
  const css = readFileSync(new URL("../components/role-emoji-picker.css", import.meta.url), "utf8");
  for (const mapping of ["--epr-bg-color:var(--surface)", "--epr-search-input-bg-color:var(--surface-subtle)", "--epr-category-label-bg-color:var(--surface)", "--epr-skin-tone-picker-menu-color:var(--surface)", "--epr-search-border-color-active:var(--focus)", "--epr-dark-bg-color:var(--surface)", "--epr-text-color:var(--foreground)"]) assert.ok(css.includes(mapping), mapping);
  assert.match(css, /min-width:0/);
  assert.match(css, /max-width:100%/);
  assert.match(css, /overflow-x:auto/);
  assert.match(css, /font-size:16px/);
  assert.doesNotMatch(css, /https?:|prefers-color-scheme|url\(/);
});
