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

test("members can be added freely while existing names and roles are still incomplete", () => {
  const editor = editorActions([member("")]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 2);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  click(editor.byClass("text-button member-editor-add"));
  assert.deepEqual(editor.members, [member("田中"), member(""), member(""), member("")]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  assert.equal(editor.byClass("text-button member-editor-add").props["aria-describedby"], undefined);
});

test("the global role-free opt-out allows free row additions while reminding that names are required to save", () => {
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
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 2);
  assert.deepEqual(editor.members[1], { name: "", roles: [], roleNotRequired: true });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
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
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  editor.open();
  assert.equal(editor.byLabel("メンバー1のカスタム役職").props.value, "");
  click(editor.byLabel("ギター（Gt.）"));
  assert.deepEqual(editor.members[0].roles, ["Gt."]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false, "role validation belongs to Save, not adding rows");
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

test("the controlled table mode, not an individual legacy flag, gates role editing but never row additions", () => {
  const editor = editorActions([{ name: "田中", roles: [], roleNotRequired: true }], false);
  assert.equal(editor.byLabel("全メンバーの役職なし").props.checked, false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  editor.open();
  click(editor.byLabel("ボーカル（Vo.）"));
  assert.deepEqual(editor.members[0].roles, ["Vo."]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("an empty editor uses the ordinary member-add action to start and restart drafts", () => {
  const editor = editorActions([]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.deepEqual(editor.members, [member("")]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byLabel("メンバー1を削除"));
  assert.deepEqual(editor.members, []);
  assert.ok(editor.byClass("text-button member-editor-add"));
});

test("global role-free mode is retained when starting again from an empty member list", () => {
  const editor = editorActions([], true);
  click(editor.byClass("text-button member-editor-add"));
  assert.deepEqual(editor.members, [{ name: "", roles: [], roleNotRequired: true }]);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  editor.byLabel("メンバー1の名前").props.onChange({ target: { value: "田中" } });
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("mobile styles keep name and role columns side by side instead of stacking person cards", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.member-editor-table \{[^}]*table-layout:fixed/);
  assert.match(css, /\.member-editor-table \.member-editor-name-column \{ width:42%; \}/);
  assert.match(css, /\.member-editor-table \.member-editor-action-column \{ width:60px; \}/);
  assert.match(css, /\.member-editor-reorder \{[^}]*flex-direction:column/);
  assert.doesNotMatch(css, /\.member-editor-row\s*\{[^}]*(?:display:block|flex-direction:column)/);
});

test("a custom role can choose an accessible emoji before being added without changing preset icons", () => {
  const editor = editorActions([member()]);
  editor.open();
  editor.custom("  部長  ");
  const trigger = editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ");
  assert.equal(trigger.props["aria-expanded"], false);
  let focused = 0;
  trigger.props.onClick({ currentTarget: { focus() { focused++; } } });
  assert.equal(editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props["aria-expanded"], true);
  const options = editor.nodes().filter(node => node.props.className === "member-role-emoji-option");
  assert.equal(options.length, 36);
  assert.equal(editor.byLabel("タグの絵文字").props["aria-pressed"], true);
  assert.equal(editor.byLabel("リーダーの絵文字").props.title, "リーダー");
  click(editor.byLabel("リーダーの絵文字"));
  assert.equal(focused, 1);
  assert.equal(editor.callbacks.length, 0, "selecting an unsaved custom icon must not add a role yet");
  assert.equal(editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props["aria-expanded"], false);
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members, [{ name: "田中", roles: ["部長"], roleIcons: { 部長: "👑" } }]);
  const html = renderToStaticMarkup(editor.render());
  assert.match(html, /👑/);
  assert.match(html, /メンバー1の「部長」の絵文字を選ぶ/);
  editor.custom(" gt. ");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("星の絵文字"));
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0], { name: "田中", roles: ["部長", "Gt."], roleIcons: { 部長: "👑" } });
  assert.equal(editor.nodes().some(node => node.props["aria-label"] === "メンバー1の「Gt.」の絵文字を選ぶ"), false);
});

test("saved custom-role icons can be edited in place, copied immutably and reset when their role is removed", () => {
  const original = [{ name: "田中", roles: ["部長", "写真"], roleIcons: { 部長: "👑", 写真: "📷" } }, { name: "鈴木", roles: ["会計"], roleIcons: { 会計: "💰" } }];
  const editor = editorActions(original);
  const before = editor.members;
  editor.byLabel("メンバー1の「部長」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  assert.equal(editor.byLabel("リーダーの絵文字").props["aria-pressed"], true);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-presets"), false, "editing an icon alone does not need to open the whole role palette");
  click(editor.byLabel("運営の絵文字"));
  assert.deepEqual(editor.members[0].roleIcons, { 部長: "💼", 写真: "📷" });
  assert.notEqual(editor.members[0].roleIcons, before[0].roleIcons);
  assert.notEqual(editor.members[1].roleIcons, before[1].roleIcons);
  assert.deepEqual(before, original);
  editor.byLabel("メンバー1の「部長」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("タグの絵文字"));
  assert.deepEqual(editor.members[0].roleIcons, { 写真: "📷" });
  click(editor.byLabel("写真を外す"));
  assert.deepEqual(editor.members[0], { name: "田中", roles: ["部長"] });
  click(editor.byClass("text-button member-editor-add"));
  assert.notEqual(editor.members[1].roleIcons, before[1].roleIcons);
  click(editor.byLabel("メンバー1を削除"));
  assert.deepEqual(editor.members[0], { name: "鈴木", roles: ["会計"], roleIcons: { 会計: "💰" } });
  assert.deepEqual(original[0].roleIcons, { 部長: "👑", 写真: "📷" });
});

test("the emoji menu consumes Escape before its enclosing role palette and restores the correct trigger focus", () => {
  const editor = editorActions([member()]);
  let paletteFocus = 0;
  let emojiFocus = 0;
  editor.open(0, { focus() { paletteFocus++; } });
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() { emojiFocus++; } } });
  const escape = () => {
    const calls = [];
    editor.render().props.onKeyDown({ key: "Escape", preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); } });
    assert.deepEqual(calls, ["prevent", "stop"]);
  };
  escape();
  assert.equal(emojiFocus, 1);
  assert.equal(paletteFocus, 0);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-expanded"], true);
  assert.equal(editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props["aria-expanded"], false);
  escape();
  assert.equal(paletteFocus, 1);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-expanded"], false);
});

test("manual emoji entry accepts one emoji sequence, blocks text and multiple emoji, and preserves IME confirmation", () => {
  const editor = editorActions([{ name: "田中", roles: ["応援"] }]);
  editor.byLabel("メンバー1の「応援」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  function fill(value) { editor.byLabel("その他の絵文字").props.onChange({ target: { value } }); }
  function useButton() { return editor.nodes().find(node => node.type === "button" && node.props.children === "使う"); }
  for (const invalid of ["hello", "👑🎤", "<script>"]) {
    fill(invalid);
    assert.equal(useButton().props.disabled, true);
    click(useButton());
    assert.equal(editor.members[0].roleIcons, undefined);
    assert.equal(editor.byLabel("その他の絵文字").props["aria-invalid"], true);
  }
  fill(" 👩🏽‍🚀 ");
  assert.equal(useButton().props.disabled, false);
  let imeStops = 0;
  editor.byLabel("その他の絵文字").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: true }, preventDefault() { throw new Error("composition must not be interrupted"); }, stopPropagation() { imeStops++; } });
  editor.byLabel("その他の絵文字").props.onKeyDown({ key: "Enter", nativeEvent: { keyCode: 229 }, preventDefault() { throw new Error("composition must not be interrupted"); }, stopPropagation() { imeStops++; } });
  assert.equal(imeStops, 2);
  assert.equal(editor.members[0].roleIcons, undefined);
  const calls = [];
  editor.byLabel("その他の絵文字").props.onKeyDown({ key: "Enter", nativeEvent: { isComposing: false }, preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); } });
  assert.deepEqual(calls, ["stop", "prevent"]);
  assert.deepEqual(editor.members[0].roleIcons, { 応援: "👩🏽‍🚀" });
});

test("global role-free mode closes both emoji and role menus, and switching members drops an unfinished emoji choice", () => {
  const editor = editorActions([member("田中", ["部長"]), member("鈴木", ["Vo."])]);
  editor.open();
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("リーダーの絵文字"));
  editor.open(1);
  const html = renderToStaticMarkup(editor.render());
  assert.doesNotMatch(html, /👑/);
  editor.byLabel("メンバー2のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.byLabel("全メンバーの役職なし").props.onChange({ target: { checked: true } });
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-emoji-picker"), false);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-picker"), false);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-chip-emoji"), false);
  assert.equal(editor.rolesOptional, true);
});

test("save guidance identifies the first incomplete member without blocking or describing the enabled add action", () => {
  const editor = editorActions([member("田中"), member("鈴木", ["Ba."])]);
  const add = editor.byClass("text-button member-editor-add");
  assert.equal(add.props.disabled, false);
  assert.equal(add.props["aria-describedby"], undefined);
  assert.equal(add.props.title, undefined);
  const explanation = editor.nodes().find(node => node.props.id === "member-test-incomplete");
  assert.equal(explanation.props.children, "保存するには1人目の楽器・役職を選んでください（不要なら「役職なし」をオン）。");
  editor.open();
  click(editor.byLabel("ボーカル（Vo.）"));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 3);
  assert.equal(editor.nodes().find(node => node.props.id === "member-test-incomplete").props.children, "保存するには3人目の名前を入力してください。");
  editor.byLabel("メンバー3の名前").props.onChange({ target: { value: "山本" } });
  assert.equal(editor.nodes().find(node => node.props.id === "member-test-incomplete").props.children, "保存するには3人目の楽器・役職を選んでください（不要なら「役職なし」をオン）。");
  editor.open(2);
  click(editor.byLabel("ドラム（Dr.）"));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  assert.equal(editor.nodes().some(node => node.props.id === "member-test-incomplete"), false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 4, "required-role mode has no two-member cap");
});

test("visible up and down controls reorder members without losing role icon metadata or mutating props", () => {
  const original = [{ name: "田中", roles: ["部長", "Gt."], roleIcons: { 部長: "👑" } }, { name: "鈴木", roles: ["会計"], roleIcons: { 会計: "💰" } }, member("山本", ["Dr."])];
  const editor = editorActions(original);
  const before = editor.members;
  assert.equal(editor.byLabel("メンバー1を上へ").props.disabled, true);
  assert.equal(editor.byLabel("メンバー1を下へ").props.disabled, false);
  assert.equal(editor.byLabel("メンバー3を下へ").props.disabled, true);
  click(editor.byLabel("メンバー1を上へ"));
  click(editor.byLabel("メンバー3を下へ"));
  assert.equal(editor.callbacks.length, 0, "boundary guards also protect direct callback invocation");
  click(editor.byLabel("メンバー1を下へ"));
  assert.deepEqual(editor.members, [original[1], original[0], original[2]]);
  assert.deepEqual(before, original);
  assert.notEqual(editor.members[0], before[1]);
  assert.notEqual(editor.members[0].roles, before[1].roles);
  assert.notEqual(editor.members[0].roleIcons, before[1].roleIcons);
  assert.notEqual(editor.members[1].roleIcons, before[0].roleIcons);
  assert.notEqual(editor.members[2], before[2], "unchanged members are cloned as well");
  click(editor.byLabel("メンバー3を上へ"));
  assert.deepEqual(editor.members.map(member => member.name), ["鈴木", "山本", "田中"]);
  assert.deepEqual(editor.members[2].roleIcons, { 部長: "👑" });
});

test("reordering closes role and emoji pickers so unfinished input cannot be applied to a different member", () => {
  const editor = editorActions([member("田中", ["Vo."]), member("鈴木", ["Ba."])]);
  editor.open();
  editor.custom("部長");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("リーダーの絵文字"));
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.byLabel("その他の絵文字").props.onChange({ target: { value: "🌟" } });
  click(editor.byLabel("メンバー1を下へ"));
  assert.deepEqual(editor.members, [member("鈴木", ["Ba."]), member("田中", ["Vo."])]);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-picker"), false);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-emoji-picker"), false);
  editor.open(1);
  assert.equal(editor.byLabel("メンバー2のカスタム役職").props.value, "");
  editor.byLabel("メンバー2のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  assert.equal(editor.byLabel("タグの絵文字").props["aria-pressed"], true);
  assert.equal(editor.byLabel("その他の絵文字").props.value, "");
});

test("role-free members can be reordered while preserving their mode flags and empty draft names", () => {
  const editor = editorActions([{ name: "", roles: [], roleNotRequired: true }, { name: "田中", roles: [], roleNotRequired: true }], true);
  click(editor.byLabel("メンバー2を上へ"));
  assert.deepEqual(editor.members, [{ name: "田中", roles: [], roleNotRequired: true }, { name: "", roles: [], roleNotRequired: true }]);
  assert.equal(editor.rolesOptional, true);
  assert.equal(editor.nodes().some(node => node.props.className === "member-editor-roles"), false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("custom role names matching object prototype keys retain their emoji as safe own properties", () => {
  const editor = editorActions([member()]);
  editor.open();
  editor.custom("__proto__");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("星の絵文字"));
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.ok(Object.hasOwn(editor.members[0].roleIcons, "__proto__"));
  assert.equal(editor.members[0].roleIcons.__proto__, "⭐");
  assert.equal(Object.getPrototypeOf(editor.members[0].roleIcons), Object.prototype);
  editor.byLabel("メンバー1の「__proto__」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  click(editor.byLabel("リーダーの絵文字"));
  assert.equal(editor.members[0].roleIcons.__proto__, "👑");
  assert.equal(Object.getPrototypeOf(editor.members[0].roleIcons), Object.prototype);
  click(editor.byLabel("__proto__を外す"));
  assert.equal(editor.members[0].roleIcons, undefined);
});
