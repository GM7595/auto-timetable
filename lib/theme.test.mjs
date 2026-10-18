import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Compile the real sources in memory. Browser APIs below are isolated fakes;
// these tests never use a browser, server, event data, or API credentials.
function source(relativePath) {
  const fileUrl = new URL(relativePath, import.meta.url);
  return ts.transpileModule(readFileSync(fileUrl, "utf8"), {
    fileName: fileUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
function compile(compiledSource, dependencies = {}, globals = {}) {
  const module = { exports: {} };
  runInNewContext(compiledSource, {
    module, exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
    ...globals,
  });
  return module.exports;
}
const theme = compile(source("./theme.ts"));
const componentSource = source("../components/theme-control.tsx");
const key = theme.THEME_STORAGE_KEY;

test("light surfaces are soft warm tones with readable text, while dark colors remain unchanged", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/gi)].map(([, name, value]) => [name, value]));
  const light = tokens(css.match(/:root\s*\{([^}]+)\}/)[1]);
  const dark = tokens(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1]);
  const rgb = color => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16));
  const luminance = color => rgb(color).map(channel => { const v = channel / 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  for (const name of ["background", "surface", "surface-hover", "surface-subtle", "surface-selected", "table-header", "table-done", "table-prep", "table-wait"]) {
    const [r, g, b] = rgb(light[name]);
    assert.ok(r > g && g > b, `${name} should have a subtle warm tint`);
    assert.ok(luminance(light[name]) < .95, `${name} should not be near-pure white`);
  }
  for (const [text, background] of [
    ["foreground", "background"], ["secondary", "background"], ["secondary", "surface"], ["secondary", "surface-hover"], ["secondary", "surface-subtle"], ["secondary", "surface-selected"],
    ["table-text", "surface"], ["table-heading", "table-header"], ["table-muted", "table-prep"], ["table-fixed", "table-done"], ["table-prep-text", "table-prep"], ["table-prep-time", "table-prep"], ["table-prep-time", "table-wait"], ["table-wait-text", "table-wait"], ["warning", "background"], ["warning", "warning-background"],
  ]) {
    const levels = [luminance(light[text]), luminance(light[background])].sort((a, b) => b - a);
    assert.ok((levels[0] + .05) / (levels[1] + .05) >= 4.5, `${text} on ${background} must remain readable`);
  }
  assert.equal(dark.background, "#151820");
  assert.equal(dark.surface, "#1c212b");
});

function browser({ saved = null, systemDark = false, blockedStorage = false, mediaMode = "available" } = {}) {
  const values = new Map(saved === null ? [] : [[key, saved]]);
  const writes = [];
  const storageListeners = new Set();
  const mediaListeners = new Set();
  const localStorage = {
    getItem(name) { if (blockedStorage) throw new Error("Storage blocked"); return values.get(name) ?? null; },
    setItem(name, value) { if (blockedStorage) throw new Error("Storage blocked"); values.set(name, value); writes.push([name, value]); },
  };
  const media = {
    matches: systemDark,
    addEventListener(type, listener) { assert.equal(type, "change"); mediaListeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "change"); mediaListeners.delete(listener); },
  };
  const window = {
    localStorage,
    addEventListener(type, listener) { assert.equal(type, "storage"); storageListeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, "storage"); storageListeners.delete(listener); },
  };
  if (mediaMode !== "missing") window.matchMedia = query => {
    assert.equal(query, "(prefers-color-scheme: dark)");
    if (mediaMode === "throwing") throw new Error("Media unavailable");
    return media;
  };
  const document = { documentElement: { dataset: {} } };
  return {
    window, document, localStorage, values, writes, mediaListeners, storageListeners,
    systemChange(dark) { media.matches = dark; for (const listener of mediaListeners) listener({ matches: dark }); },
    storageChange(storageKey, newValue, storageArea = localStorage) {
      for (const listener of storageListeners) listener({ key: storageKey, newValue, storageArea });
    },
  };
}

function control(fixture, { mount = true } = {}) {
  const hooks = [];
  const effects = [];
  const cleanups = [];
  let cursor = 0;
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!(index in hooks)) { hooks[index] = true; effects.push(effect); }
    },
  };
  const jsx = (type, props) => ({ type, props });
  const { ThemeControl } = compile(componentSource, {
    react, "react/jsx-runtime": { jsx, jsxs: jsx }, "@/lib/theme": theme,
    "lucide-react": { Sun: "Sun", Moon: "Moon", Monitor: "Monitor" },
  }, fixture ? { window: fixture.window, document: fixture.document } : {});
  const render = () => { cursor = 0; return ThemeControl(); };
  let markup = render();
  if (mount) { for (const effect of effects) cleanups.push(effect()); markup = render(); }
  const labels = { light: "ライトモード", dark: "ダークモード", system: "端末に合わせる" };
  const options = () => markup.props.children.filter(child => child.type === "button");
  return {
    value() {
      markup = render();
      const selected = options().filter(button => button.props["aria-pressed"]);
      assert.equal(selected.length, 1, "Exactly one display mode must be selected");
      return Object.keys(labels).find(value => labels[value] === selected[0].props["aria-label"]);
    },
    choose(value) {
      const button = options().find(option => option.props["aria-label"] === labels[value]);
      assert.ok(button, `Missing mode button: ${value}`);
      button.props.onClick();
      markup = render();
    },
    markup() { markup = render(); return markup; },
    cleanup() { for (const cleanup of cleanups) cleanup?.(); },
  };
}

test("theme preferences accept only supported values and resolve system appearance", () => {
  assert.equal(key, "timetable.theme.v1");
  for (const value of ["light", "dark", "system"]) assert.equal(theme.normalizeThemePreference(value), value);
  for (const value of [null, undefined, "", "DARK", "other", 1, {}, []]) assert.equal(theme.normalizeThemePreference(value), "system");
  assert.equal(theme.resolveTheme("system", false), "light");
  assert.equal(theme.resolveTheme("system", true), "dark");
  assert.equal(theme.resolveTheme("light", true), "light");
  assert.equal(theme.resolveTheme("dark", false), "dark");
});

test("the actual inline bootstrap is self-contained and honors explicit choices over the OS", () => {
  for (const [saved, systemDark, expected] of [
    ["dark", false, "dark"], ["light", true, "light"],
    ["system", true, "dark"], ["system", false, "light"],
    [null, true, "dark"], [null, false, "light"], ["unknown", true, "dark"],
  ]) {
    const fixture = browser({ saved, systemDark });
    runInNewContext(theme.THEME_INIT_SCRIPT, { window: fixture.window, document: fixture.document });
    assert.equal(fixture.document.documentElement.dataset.theme, expected);
    assert.equal(fixture.writes.length, 0, "Bootstrap must not rewrite preferences");
  }
});

test("bootstrap treats stored content as data, never executable source", () => {
  const fixture = browser({ saved: '");window.injected=true;//', systemDark: true });
  runInNewContext(theme.THEME_INIT_SCRIPT, { window: fixture.window, document: fixture.document });
  assert.equal(fixture.window.injected, undefined);
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
});

test("bootstrap tolerates blocked storage and missing or throwing matchMedia", () => {
  for (const options of [
    { blockedStorage: true, systemDark: true, expected: "dark" },
    { blockedStorage: true, mediaMode: "missing", expected: "light" },
    { mediaMode: "throwing", expected: "light" },
    { saved: "dark", mediaMode: "missing", expected: "dark" },
  ]) {
    const fixture = browser(options);
    assert.doesNotThrow(() => runInNewContext(theme.THEME_INIT_SCRIPT, { window: fixture.window, document: fixture.document }));
    assert.equal(fixture.document.documentElement.dataset.theme, options.expected);
  }
});

test("the control's first render is system mode and does not access browser globals", () => {
  assert.equal(control(null, { mount: false }).value(), "system");
});

test("the control exposes three always-visible, accessible icon buttons with a selected state", () => {
  const ui = control(browser({ saved: "dark" }));
  const markup = ui.markup();
  assert.equal(markup.type, "div");
  assert.equal(markup.props.className, "theme-control");
  assert.equal(markup.props.role, "group");
  assert.equal(markup.props["aria-label"], "表示モード");
  const buttons = markup.props.children;
  assert.equal(buttons.length, 3);
  for (const [index, [label, icon, pressed]] of [
    ["ライトモード", "Sun", false],
    ["ダークモード", "Moon", true],
    ["端末に合わせる", "Monitor", false],
  ].entries()) {
    const button = buttons[index];
    assert.equal(button.type, "button");
    assert.equal(button.props.type, "button");
    assert.equal(button.props.className, "icon-button theme-option");
    assert.equal(button.props.title, label);
    assert.equal(button.props["aria-label"], label);
    assert.equal(button.props["aria-pressed"], pressed);
    assert.equal(button.props.hidden, undefined);
    assert.equal(button.props.children.type, icon);
    assert.equal(button.props.children.props.size, 16);
    assert.equal(button.props.children.props["aria-hidden"], "true");
  }
  ui.choose("light");
  assert.deepEqual(Array.from(ui.markup().props.children, button => button.props["aria-pressed"]), [true, false, false]);
  ui.choose("system");
  assert.deepEqual(Array.from(ui.markup().props.children, button => button.props["aria-pressed"]), [false, false, true]);
});

test("mount restores the saved preference without changing local storage", () => {
  const fixture = browser({ saved: "dark" });
  const ui = control(fixture);
  assert.equal(ui.value(), "dark");
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.storageListeners.size, 1);
  assert.equal(fixture.mediaListeners.size, 1);
});

test("a selected mode is persisted and explicit choices survive system changes", () => {
  const fixture = browser();
  const ui = control(fixture);
  ui.choose("dark");
  assert.equal(ui.value(), "dark");
  assert.deepEqual(fixture.writes, [[key, "dark"]]);
  fixture.systemChange(true);
  fixture.systemChange(false);
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
  ui.choose("light");
  fixture.systemChange(true);
  assert.equal(fixture.document.documentElement.dataset.theme, "light");
});

test("system mode follows OS changes, including after switching from an explicit mode", () => {
  const fixture = browser({ saved: "light" });
  const ui = control(fixture);
  fixture.systemChange(true);
  ui.choose("system");
  assert.equal(ui.value(), "system");
  assert.equal(fixture.values.get(key), "system");
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
  fixture.systemChange(false);
  assert.equal(fixture.document.documentElement.dataset.theme, "light");
});

test("other-tab changes, removals, and storage clears are synchronized without echo writes", () => {
  const fixture = browser({ systemDark: true });
  const ui = control(fixture);
  fixture.storageChange(key, "light");
  assert.equal(ui.value(), "light");
  assert.equal(fixture.document.documentElement.dataset.theme, "light");
  fixture.storageChange(key, "dark");
  assert.equal(ui.value(), "dark");
  fixture.storageChange(key, "invalid");
  assert.equal(ui.value(), "system");
  fixture.storageChange(key, "light");
  fixture.storageChange(key, null);
  assert.equal(ui.value(), "system");
  fixture.storageChange(key, "light");
  fixture.storageChange(null, null);
  assert.equal(ui.value(), "system");
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
  assert.deepEqual(fixture.writes, []);
});

test("unrelated storage events cannot affect the selected appearance", () => {
  const fixture = browser({ saved: "light" });
  const ui = control(fixture);
  fixture.storageChange("timetable.event.v1", "dark");
  fixture.storageChange(key, "dark", {});
  assert.equal(ui.value(), "light");
  assert.equal(fixture.document.documentElement.dataset.theme, "light");
});

test("cleanup removes media and storage subscriptions", () => {
  const fixture = browser({ saved: "dark" });
  const ui = control(fixture);
  ui.cleanup();
  assert.equal(fixture.storageListeners.size, 0);
  assert.equal(fixture.mediaListeners.size, 0);
  fixture.storageChange(key, "light");
  fixture.systemChange(true);
  assert.equal(ui.value(), "dark");
});

test("blocked storage does not prevent immediate changes or system tracking", () => {
  const fixture = browser({ blockedStorage: true });
  const ui = control(fixture);
  assert.doesNotThrow(() => ui.choose("dark"));
  assert.equal(ui.value(), "dark");
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
  assert.doesNotThrow(() => ui.choose("system"));
  fixture.systemChange(true);
  assert.equal(fixture.document.documentElement.dataset.theme, "dark");
});

test("missing or throwing matchMedia permits manual appearance changes", () => {
  for (const mediaMode of ["missing", "throwing"]) {
    const fixture = browser({ mediaMode });
    const ui = control(fixture);
    assert.equal(fixture.document.documentElement.dataset.theme, "light");
    ui.choose("dark");
    assert.equal(fixture.document.documentElement.dataset.theme, "dark");
    ui.cleanup();
    assert.equal(fixture.storageListeners.size, 0);
  }
});
