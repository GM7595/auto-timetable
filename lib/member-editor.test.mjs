import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

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
const roles = compile("./member-roles.ts");
function editorActions(initialMembers = [], initialRolesOptional = false) {
  let members = structuredClone(initialMembers);
  let rolesOptional = initialRolesOptional;
  const modeCallbacks = [];
  const callbacks = [];
  const hooks = [];
  let cursor = 0;
  const hooksReact = {
    ...React,
    useId() { return "member-test"; },
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial };
      return hooks[index];
    },
  };
  const { MemberEditor } = compile("../components/member-editor.tsx", { react: hooksReact, "@/lib/member-roles": roles });
  function render() {
    cursor = 0;
    return MemberEditor({ members, rolesOptional, onChange(next) { callbacks.push(next); members = next; }, onRolesOptionalChange(next) {
      modeCallbacks.push(next);
      rolesOptional = next;
      // The parent owns normalization; the editor only changes its controlled mode.
      members = members.map(member => next ? { ...member, roles: [], roleNotRequired: true } : { name: member.name, roles: [...member.roles] });
    } });
  }
  function nodes(tree = render()) {
    const result = [];
    function visit(value) {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== "object" || !value.props) return;
      result.push(value);
      visit(value.props.children);
    }
    visit(tree);
    return result;
  }
  function byLabel(label) {
    const node = nodes().find(item => item.props["aria-label"] === label);
    assert.ok(node, `Missing control: ${label}`);
    return node;
  }
  function byClass(className) {
    const node = nodes().find(item => item.props.className === className);
    assert.ok(node, `Missing node: ${className}`);
    return node;
  }
  function open(index = 0, currentTarget = { focus() {} }) { byLabel(`メンバー${index + 1}の楽器・役職を選ぶ`).props.onClick({ currentTarget }); }
  function custom(value, index = 0) { byLabel(`メンバー${index + 1}のカスタム役職`).props.onChange({ target: { value } }); }
  return { render, nodes, byLabel, byClass, open, custom, callbacks, modeCallbacks, get rolesOptional() { return rolesOptional; }, get members() { return members; } };
}
const member = (name = "田中", selected = []) => ({ name, roles: selected });
const click = node => node.props.onClick();

test("the extensible preset catalog exposes the five stable instrument identifiers", () => {
  assert.deepEqual(roles.MEMBER_ROLE_PRESETS.map(role => role.label), ["Vo.", "Gt.", "Ba.", "Key.", "Dr."]);
  assert.deepEqual(roles.getMemberRole("Vo."), { label: "Vo.", name: "ボーカル", icon: "🎤" });
  assert.deepEqual(roles.getMemberRole("部長"), { label: "部長", name: "部長", icon: "🏷️" });
});

test("canonical participation names upgrade legacy slots and exclude orphan role metadata", () => {
  assert.deepEqual(roles.getSlotMembers({ people: ["田中", "鈴木"] }), [{ ...member("田中"), roleNotRequired: true }, { ...member("鈴木"), roleNotRequired: true }]);
  const stored = [member("鈴木", ["Ba."]), member("退会済み", ["Dr."]), member("田中", ["Vo.", "部長"])];
  const result = roles.getSlotMembers({ people: ["田中", "鈴木"], members: stored });
  assert.deepEqual(result, [member("田中", ["Vo.", "部長"]), member("鈴木", ["Ba."])]);
  result[0].roles.push("Gt.");
  result[0].name = "changed";
  assert.deepEqual(stored[2], member("田中", ["Vo.", "部長"]));
});

test("the controlled editor retains a semantic fieldset and no nested form", () => {
  const editor = editorActions([member("<script>", ["Vo.", "部長"])]);
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /<fieldset class="member-editor"><legend>メンバー<\/legend>/);
  assert.match(html, /メンバー1の名前/);
  assert.match(html, /maxLength="160"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<form\b|<script>|member-role-presets/);
  assert.match(html, /aria-expanded="false"/);
  for (const button of html.matchAll(/<button\b([^>]*)>/g)) assert.match(button[1], /type="button"/);
});

test("members use a single table with adjacent name, role and delete cells and one global switch", () => {
  const editor = editorActions([member("田中", ["Vo."]), member("鈴木", ["Ba."])]);
  const html = renderToStaticMarkup(editor.render());
  assert.equal([...html.matchAll(/role="switch"/g)].length, 1);
  assert.match(html, /aria-label="全メンバーの役職なし"/);
  assert.match(html, /<table class="member-editor-table">/);
  assert.match(html, /<th scope="col">名前<\/th><th scope="col">楽器・役職<\/th>/);
  assert.equal([...html.matchAll(/<tr class="member-editor-row">/g)].length, 2);
  assert.equal([...html.matchAll(/<td\b/g)].length, 6);
  assert.doesNotMatch(html, /member-editor-list|メンバー1は役職なし|メンバー2は役職なし/);
  editor.open(1);
  const picker = editor.nodes().find(node => node.type === "td" && node.props.colSpan === 3);
  assert.ok(picker, "the palette must span the complete table below its member row");
  assert.ok(editor.nodes(picker).some(node => node.props.className === "member-role-picker"));
});

test("adding, renaming and deleting members produce fresh objects without changing input arrays", () => {
  const original = [member("田中", ["Vo."]), member("鈴木", ["Ba."])];
  const editor = editorActions(original);
  const before = editor.members;
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中太郎" } });
  assert.deepEqual(editor.members[0], member("田中太郎", ["Vo."]));
  assert.notEqual(editor.members, before);
  assert.notEqual(editor.members[1].roles, before[1].roles);
  assert.deepEqual(before, original);
  click(editor.byClass("text-button member-editor-add"));
  assert.deepEqual(editor.members[2], member(""));
  click(editor.byLabel("メンバー2を削除"));
  assert.deepEqual(editor.members, [member("田中太郎", ["Vo."]), member("")]);
  assert.deepEqual(original, [member("田中", ["Vo."]), member("鈴木", ["Ba."])]);
});

test("the role palette supports multiple instruments, accessible full names and removable chips", () => {
  const editor = editorActions([member()]);
  editor.open();
  let vo = editor.byLabel("ボーカル（Vo.）");
  assert.equal(vo.props["aria-pressed"], false);
  assert.equal(vo.props.title, "ボーカル（Vo.）");
  assert.equal(vo.props["data-tooltip"], "ボーカル");
  click(vo);
  click(editor.byLabel("ギター（Gt.）"));
  assert.deepEqual(editor.members[0].roles, ["Vo.", "Gt."]);
  assert.equal(editor.byLabel("ボーカル（Vo.）").props["aria-pressed"], true);
  click(editor.byLabel("ボーカル（Vo.）を外す"));
  assert.deepEqual(editor.members[0].roles, ["Gt."]);
  click(editor.byLabel("ギター（Gt.）"));
  assert.deepEqual(editor.members[0].roles, []);
});

test("custom roles trim whitespace, normalize preset case, and do not duplicate existing roles", () => {
  const editor = editorActions([member("田中", ["Vo."])]);
  editor.open();
  editor.custom(" vo. ");
  assert.equal(editor.byLabel("メンバー1にカスタム役職を追加").props.disabled, true);
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0].roles, ["Vo."]);
  editor.custom("  部長  ");
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0].roles, ["Vo.", "部長"]);
  assert.equal(editor.byLabel("メンバー1のカスタム役職").props.value, "");
  editor.custom("部長");
  assert.equal(editor.byLabel("メンバー1にカスタム役職を追加").props.disabled, true);
  editor.custom(" gt. ");
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0].roles, ["Vo.", "部長", "Gt."]);
});

test("custom-role Enter adds only that role and does not submit the parent slot form", () => {
  const editor = editorActions([member()]);
  editor.open();
  editor.custom("司会");
  const calls = [];
  editor.byLabel("メンバー1のカスタム役職").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); } });
  assert.deepEqual(calls, ["stop", "prevent"]);
  assert.deepEqual(editor.members[0].roles, ["司会"]);
  editor.custom("会計");
  let imeStops = 0;
  editor.byLabel("メンバー1のカスタム役職").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { throw new Error("composition must not be interrupted"); }, stopPropagation() { imeStops++; } });
  editor.byLabel("メンバー1のカスタム役職").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false, keyCode: 229 }, preventDefault() { throw new Error("Safari composition must not be interrupted"); }, stopPropagation() { imeStops++; } });
  assert.equal(imeStops, 2);
  assert.deepEqual(editor.members[0].roles, ["司会"]);
});

test("Escape closes only the palette, restores trigger focus, and consumes the outer-dialog shortcut", () => {
  const editor = editorActions([member()]);
  let focused = 0;
  editor.open(0, { focus() { focused++; } });
  const calls = [];
  editor.render().props.onKeyDown({ key: "Escape", preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); } });
  assert.deepEqual(calls, ["prevent", "stop"]);
  assert.equal(focused, 1);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-expanded"], false);
  assert.equal(editor.callbacks.length, 0);
  editor.render().props.onKeyDown({ key: "Escape", preventDefault() { throw new Error("closed palette must let outer dialog handle Escape"); }, stopPropagation() {} });
});

test("the member cap and role cap disable additions but still permit removing existing entries", () => {
  const editor = editorActions(Array.from({ length: 30 }, (_, index) => member(`名前${index}`)));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 30);
  const full = editorActions([member("田中", ["Vo.", ...Array.from({ length: 11 }, (_, index) => `役職${index}`)])]);
  full.open();
  assert.equal(full.byLabel("ギター（Gt.）").props.disabled, true);
  assert.equal(full.byLabel("ボーカル（Vo.）").props.disabled, false);
  click(full.byLabel("ギター（Gt.）"));
  assert.equal(full.members[0].roles.length, 12);
  full.custom("新役職");
  assert.equal(full.byLabel("メンバー1にカスタム役職を追加").props.disabled, true);
  click(full.byLabel("ボーカル（Vo.）"));
  assert.equal(full.members[0].roles.length, 11);
  assert.equal(full.byLabel("ギター（Gt.）").props.disabled, false);
});

test("role and name length guards are declared and oversized custom input is not accepted", () => {
  const editor = editorActions([member()]);
  assert.equal(editor.byLabel("メンバー1の名前").props.maxLength, 160);
  editor.open();
  assert.equal(editor.byLabel("メンバー1のカスタム役職").props.maxLength, 40);
  editor.custom("a".repeat(41));
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0].roles, []);
  editor.custom("a".repeat(40));
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0].roles, ["a".repeat(40)]);
});

test("unknown existing roles remain intact until explicitly removed", () => {
  const editor = editorActions([member("田中", ["部長", "旧カスタム役職"])]);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "新しい名前" } });
  assert.deepEqual(editor.members[0].roles, ["部長", "旧カスタム役職"]);
  editor.open();
  click(editor.byLabel("ドラム（Dr.）"));
  assert.deepEqual(editor.members[0].roles, ["部長", "旧カスタム役職", "Dr."]);
  click(editor.byLabel("部長を外す"));
  assert.deepEqual(editor.members[0].roles, ["旧カスタム役職", "Dr."]);
});

test("deleting an earlier row keeps the open palette attached to its remaining member", () => {
  const editor = editorActions([member("田中"), member("鈴木")]);
  editor.open(1);
  click(editor.byLabel("メンバー1を削除"));
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-expanded"], true);
  click(editor.byLabel("ベース（Ba.）"));
  assert.deepEqual(editor.members, [member("鈴木", ["Ba."])]);
});

test("adding the next member requires every existing row to have a trimmed name and a role", () => {
  const editor = editorActions([member("")]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 1);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.open();
  click(editor.byLabel("ボーカル（Vo.）"));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "  " } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 2);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true, "the new blank row must be completed before another is added");
});

test("the global role-free opt-out allows named members but never permits an empty name", () => {
  const editor = editorActions([member("")]);
  const toggle = editor.byLabel("全メンバーの役職なし");
  assert.equal(toggle.type, "input");
  assert.equal(toggle.props.type, "checkbox");
  assert.equal(toggle.props.role, "switch");
  assert.equal(toggle.props.checked, false);
  toggle.props.onChange({ target: { checked: true } });
  assert.deepEqual(editor.modeCallbacks, [true]);
  assert.equal(editor.callbacks.length, 0, "mode normalization belongs to the parent, not an individual member edit");
  assert.deepEqual(editor.members[0], { name: "", roles: [], roleNotRequired: true });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 2);
  assert.deepEqual(editor.members[1], { name: "", roles: [], roleNotRequired: true });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.byLabel("メンバー2の名前").props.onChange({ target: { value: "鈴木" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.deepEqual(editor.members[2], { name: "", roles: [], roleNotRequired: true });
});

test("global role-free mode closes the palette and hides the whole role column for every member", () => {
  const editor = editorActions([member("田中", ["Vo.", "部長"]), member("鈴木", ["Ba."])]);
  editor.open();
  editor.custom("Gt.");
  editor.byLabel("全メンバーの役職なし").props.onChange({ target: { checked: true } });
  assert.deepEqual(editor.members, [{ name: "田中", roles: [], roleNotRequired: true }, { name: "鈴木", roles: [], roleNotRequired: true }]);
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /member-editor-table-no-roles/);
  assert.doesNotMatch(html, /楽器・役職を選ぶ|<th scope="col">楽器・役職<\/th>/);
  assert.equal([...html.matchAll(/<td\b/g)].length, 4);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-picker"), false);
  editor.byLabel("全メンバーの役職なし").props.onChange({ target: { checked: false } });
  assert.equal(editor.members[0].roleNotRequired, undefined);
  assert.equal(editor.members[1].roleNotRequired, undefined);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-expanded"], false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.open();
  assert.equal(editor.byLabel("メンバー1のカスタム役職").props.value, "");
  click(editor.byLabel("ギター（Gt.）"));
  assert.deepEqual(editor.members[0].roles, ["Gt."]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true, "every member must have a role after the global opt-out is disabled");
  editor.open(1);
  click(editor.byLabel("ベース（Ba.）"));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("role-free entries keep their switch flag when canonical members are copied", () => {
  const stored = [{ name: "田中", roles: [], roleNotRequired: true }];
  const result = roles.getSlotMembers({ people: ["田中"], members: stored });
  assert.deepEqual(result, stored);
  assert.notEqual(result[0], stored[0]);
  assert.notEqual(result[0].roles, stored[0].roles);
  const editor = editorActions(result, true);
  assert.equal(editor.byLabel("全メンバーの役職なし").props.checked, true);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("the controlled table mode, not an individual legacy flag, gates role editing and additions", () => {
  const editor = editorActions([{ name: "田中", roles: [], roleNotRequired: true }], false);
  assert.equal(editor.byLabel("全メンバーの役職なし").props.checked, false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.open();
  click(editor.byLabel("ボーカル（Vo.）"));
  assert.deepEqual(editor.members[0].roles, ["Vo."]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("an empty editor can begin a single draft without exposing an enabled member-add action", () => {
  const editor = editorActions([]);
  assert.equal(editor.nodes().some(node => node.props.className === "text-button member-editor-add"), false);
  click(editor.byClass("text-button member-editor-start"));
  assert.deepEqual(editor.members, [member("")]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  click(editor.byLabel("メンバー1を削除"));
  assert.deepEqual(editor.members, []);
  assert.ok(editor.byClass("text-button member-editor-start"));
});

test("global role-free mode is retained when starting again from an empty member list", () => {
  const editor = editorActions([], true);
  click(editor.byClass("text-button member-editor-start"));
  assert.deepEqual(editor.members, [{ name: "", roles: [], roleNotRequired: true }]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, true);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("mobile styles keep name and role columns side by side instead of stacking person cards", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.member-editor-table \{[^}]*table-layout:fixed/);
  assert.match(css, /\.member-editor-table \.member-editor-name-column \{ width:42%; \}/);
  assert.match(css, /\.member-editor-table \.member-editor-action-column \{ width:34px; \}/);
  assert.doesNotMatch(css, /\.member-editor-row\s*\{[^}]*(?:display:block|flex-direction:column)/);
});
