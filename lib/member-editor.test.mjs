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
const RoleEmojiPickerStub = () => null;
function editorActions(initialMembers = [], initialRolesOptional = false) {
  let members = structuredClone(initialMembers);
  let rolesOptional = initialRolesOptional;
  const modeCallbacks = [];
  const callbacks = [];
  const hooks = [];
  const effects = [];
  const domNodes = new Map();
  const focusCalls = [];
  const animations = [];
  let customRowRects = null;
  let visibleDrop = true;
  let reducedMotion = false;
  let viewportOffset = 0;
  let cursor = 0;
  const scrollListeners = new Set();
  const document = {
    defaultView: { matchMedia() { return { matches: reducedMotion }; } },
    elementFromPoint() { return { insideFrame: visibleDrop }; },
    addEventListener(name, listener) { if (name === "scroll") scrollListeners.add(listener); },
    removeEventListener(name, listener) { if (name === "scroll") scrollListeners.delete(listener); },
  };
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
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (!previous || dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies[dependencyIndex]))) {
        effects.push(() => { previous?.cleanup?.(); hooks[index] = { dependencies, cleanup: effect() }; });
      }
    },
    useLayoutEffect(effect, dependencies) { return hooksReact.useEffect(effect, dependencies); },
  };
  const { MemberEditor } = compile("../components/member-editor.tsx", { react: hooksReact, "@/lib/member-roles": roles, "@/components/role-emoji-picker": { RoleEmojiPicker: RoleEmojiPickerStub } });
  function render() {
    cursor = 0;
    const tree = MemberEditor({ members, rolesOptional, onChange(next) { callbacks.push(next); members = next; }, onRolesOptionalChange(next) {
      modeCallbacks.push(next);
      rolesOptional = next;
      // The parent owns normalization; the editor only changes its controlled mode.
      members = members.map(member => next ? { ...member, roles: [], roleNotRequired: true } : { name: member.name, roles: [...member.roles] });
    } });
    let rowIndex = 0;
    function attach(value) {
      if (Array.isArray(value)) return value.forEach(attach);
      if (!value || typeof value !== "object" || !value.props) return;
      const ref = value.props.ref;
      if (ref) {
        const key = `${value.type}:${value.props["aria-label"] ?? (value.type === "tr" ? rowIndex++ : value.props.className)}`;
        if (!domNodes.has(key)) {
          const captures = new Set();
          domNodes.set(key, { animate(frames, options) { animations.push({ key, frames, options }); }, focus() { focusCalls.push(key); }, setPointerCapture(id) { captures.add(id); }, releasePointerCapture(id) { captures.delete(id); }, hasPointerCapture(id) { return captures.has(id); }, ownerDocument: document, contains(target) { return target.insideFrame === true; } });
        }
        const node = domNodes.get(key);
        const index = rowIndex - 1;
        if (value.type === "tr") {
          const rect = customRowRects?.[index] ?? { left: 0, right: 600, top: 40 + index * 60, bottom: 100 + index * 60, height: 60 };
          node.offsetParent = { getBoundingClientRect() { return { top: viewportOffset }; } };
          node.offsetTop = rect.top;
          node.offsetHeight = rect.height;
          node.getBoundingClientRect = () => {
            const translate = Number(value.props.style?.transform?.match(/translateY\(([-\d.]+)px\)/)?.[1] ?? 0);
            return { ...rect, top: rect.top + viewportOffset + translate, bottom: (rect.bottom ?? rect.top + rect.height) + viewportOffset + translate };
          };
        } else node.getBoundingClientRect = () => ({ left: 0, right: 600, top: viewportOffset, bottom: 40 + members.length * 60 + viewportOffset, height: 40 + members.length * 60 });
        if (typeof ref === "function") ref(node); else ref.current = node;
      }
      attach(value.props.children);
    }
    attach(tree);
    while (effects.length) effects.shift()();
    return tree;
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
  function dragHandle(index = 0) { return byLabel(`メンバー${index + 1}をドラッグして並び替え`); }
  function pointerEvent(index = 0, options = {}) {
    render();
    return { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, clientX: 20, clientY: 70 + index * 60, currentTarget: domNodes.get(`button:メンバー${index + 1}をドラッグして並び替え`), preventDefault() {}, stopPropagation() {}, ...options };
  }
  function keyEvent(index = 0, key = " ", options = {}) { return { ...pointerEvent(index), key, ...options }; }
  function emojiPicker() { const picker = nodes().find(node => node.type === RoleEmojiPickerStub); assert.ok(picker, "Full emoji picker must be present"); return picker; }
  function chooseEmoji(icon) { emojiPicker().props.onSelect(icon); }
  return { render, nodes, byLabel, byClass, open, custom, callbacks, modeCallbacks, dragHandle, pointerEvent, keyEvent, focusCalls, animations, emojiPicker, chooseEmoji, scrollTo(offset, dispatch = true) { viewportOffset = offset; if (dispatch) for (const listener of scrollListeners) listener(); }, get scrollListenerCount() { return scrollListeners.size; }, setReducedMotion(value) { reducedMotion = value; }, setDropVisible(value) { visibleDrop = value; }, setRowRects(rects) { customRowRects = rects; }, replaceMembers(next) { members = structuredClone(next); }, get rolesOptional() { return rolesOptional; }, get members() { return members; } };
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
  assert.match(html, /<th scope="col">名前 <span class="required">必須<\/span><\/th><th scope="col">楽器・役職 <span class="required">必須<\/span><\/th>/);
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
  assert.match(css, /\.member-editor-drag-handle \{[^}]*touch-action:none/);
  assert.doesNotMatch(css, /\.member-editor-table(?:-frame)?\s*\{[^}]*touch-action:none/);
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
  assert.equal(editor.emojiPicker().props.selected, "🏷️");
  editor.chooseEmoji("👑");
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
  editor.chooseEmoji("⭐");
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.deepEqual(editor.members[0], { name: "田中", roles: ["部長", "Gt."], roleIcons: { 部長: "👑" } });
  assert.equal(editor.nodes().some(node => node.props["aria-label"] === "メンバー1の「Gt.」の絵文字を選ぶ"), false);
});

test("saved custom-role icons can be edited in place, copied immutably and reset when their role is removed", () => {
  const original = [{ name: "田中", roles: ["部長", "写真"], roleIcons: { 部長: "👑", 写真: "📷" } }, { name: "鈴木", roles: ["会計"], roleIcons: { 会計: "💰" } }];
  const editor = editorActions(original);
  const before = editor.members;
  editor.byLabel("メンバー1の「部長」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  assert.equal(editor.emojiPicker().props.selected, "👑");
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-presets"), false, "editing an icon alone does not need to open the whole role palette");
  editor.chooseEmoji("💼");
  assert.deepEqual(editor.members[0].roleIcons, { 部長: "💼", 写真: "📷" });
  assert.notEqual(editor.members[0].roleIcons, before[0].roleIcons);
  assert.notEqual(editor.members[1].roleIcons, before[1].roleIcons);
  assert.deepEqual(before, original);
  editor.byLabel("メンバー1の「部長」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.chooseEmoji("🏷️");
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
  editor.chooseEmoji("👑");
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

test("missing names and roles are marked in place and recover immediately without a save instruction", () => {
  const editor = editorActions([member("田中"), member("鈴木", ["Ba."])]);
  const add = editor.byClass("text-button member-editor-add");
  assert.equal(add.props.disabled, false);
  assert.equal(add.props["aria-describedby"], undefined);
  assert.equal(add.props.title, undefined);
  assert.equal(editor.byLabel("メンバー1の名前").props["aria-invalid"], false);
  assert.equal(editor.byLabel("メンバー1の名前").props.required, true);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-invalid"], true);
  assert.equal(editor.byLabel("メンバー2の楽器・役職を選ぶ").props["aria-invalid"], false);
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /保存するには|member-test-incomplete/);
  editor.open();
  click(editor.byLabel("ボーカル（Vo.）"));
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-invalid"], false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 3);
  assert.equal(editor.byLabel("メンバー3の名前").props["aria-invalid"], true);
  assert.equal(editor.byLabel("メンバー3の楽器・役職を選ぶ").props["aria-invalid"], true);
  assert.equal(editor.nodes().filter(node => node.props.className === "required required-missing").length, 2);
  editor.byLabel("メンバー3の名前").props.onChange({ target: { value: "山本" } });
  assert.equal(editor.byLabel("メンバー3の名前").props["aria-invalid"], false);
  assert.equal(editor.nodes().filter(node => node.props.className === "required required-missing").length, 1);
  editor.open(2);
  click(editor.byLabel("ドラム（Dr.）"));
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
  assert.equal(editor.byLabel("メンバー3の楽器・役職を選ぶ").props["aria-invalid"], false);
  assert.equal(editor.nodes().some(node => node.props.className === "required required-missing"), false);
  click(editor.byClass("text-button member-editor-add"));
  assert.equal(editor.members.length, 4, "required-role mode has no two-member cap");
});

test("whitespace names stay invalid and the global role-free switch removes only role requirements", () => {
  const editor = editorActions([member("   "), member("二", ["Vo."])]);
  assert.equal(editor.byLabel("メンバー1の名前").props["aria-invalid"], true);
  assert.equal(editor.byLabel("メンバー1の楽器・役職を選ぶ").props["aria-invalid"], true);
  editor.byLabel("全メンバーの役職なし").props.onChange({ target: { checked: true } });
  assert.equal(editor.byLabel("メンバー1の名前").props["aria-invalid"], true);
  assert.equal(editor.byLabel("メンバー2の名前").props["aria-invalid"], false);
  assert.equal(editor.nodes().filter(node => node.props.className === "required required-missing").length, 1);
  assert.doesNotMatch(renderToStaticMarkup(editor.render()), /保存するには|楽器・役職を選ぶ/);
});

test("mouse handle drag crosses multiple rows once on release without losing metadata or mutating props", () => {
  const original = [{ name: "田中", roles: ["部長", "Gt."], roleIcons: { 部長: "👑" } }, { name: "鈴木", roles: ["会計"], roleIcons: { 会計: "💰" } }, member("山本", ["Dr."])];
  const editor = editorActions(original);
  const before = editor.members;
  assert.equal(editor.dragHandle().props.disabled, false);
  assert.equal(editor.byLabel("メンバー1の名前").props.onPointerDown, undefined, "only the handle starts a drag");
  assert.equal(editor.byClass("member-editor-roles").props.onPointerDown, undefined);
  const handle = editor.dragHandle();
  handle.props.onPointerDown(editor.pointerEvent());
  handle.props.onPointerMove(editor.pointerEvent(0, { clientY: 180 }));
  assert.equal(editor.callbacks.length, 0);
  assert.equal(editor.dragHandle().props["aria-pressed"], true);
  assert.equal(editor.nodes().find(node => node.props["data-drop-position"] === "after").props.className, "member-editor-row");
  handle.props.onPointerUp(editor.pointerEvent(0, { clientY: 215 }));
  assert.equal(editor.callbacks.length, 1);
  assert.deepEqual(editor.members, [original[1], original[2], original[0]]);
  assert.deepEqual(before, original);
  assert.notEqual(editor.members[0], before[1]);
  assert.notEqual(editor.members[0].roles, before[1].roles);
  assert.notEqual(editor.members[0].roleIcons, before[1].roleIcons);
  assert.notEqual(editor.members[2].roleIcons, before[0].roleIcons);
  assert.notEqual(editor.members[1], before[2], "unchanged members are cloned as well");
  assert.deepEqual(editor.members[2].roleIcons, { 部長: "👑" });
  editor.render();
  assert.equal(editor.focusCalls.at(-1), "button:メンバー3をドラッグして並び替え");
  assert.equal(editor.dragHandle(2).props["aria-pressed"], false);
});

test("pointer drag lifts the actual member, slides its neighbors and settles from the release position", () => {
  const editor = editorActions([member("一", ["Vo."]), member("二", ["Gt."]), member("三", ["Ba."])]);
  const rows = () => editor.nodes().filter(node => node.type === "tr" && node.props.className?.includes("member-editor-row"));
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 210 });
  assert.equal(editor.byClass("member-editor-table-frame").props["data-dragging"], true);
  assert.equal(rows()[0].props["data-drag-kind"], "pointer");
  assert.equal(rows()[0].props.style.transform, "translateY(140px)");
  assert.equal(rows()[1].props.style.transform, "translateY(-60px)");
  assert.equal(rows()[2].props.style.transform, "translateY(-60px)");
  assert.deepEqual(editor.members.map(item => item.name), ["一", "二", "三"], "the preview must not persist intermediate orders");
  handle.props.onPointerMove({ ...start, clientY: 110 });
  assert.equal(rows()[0].props.style.transform, "translateY(40px)");
  assert.equal(rows()[1].props.style.transform, "translateY(0px)", "neighbors smoothly return when moving back over the source slot");
  handle.props.onPointerMove({ ...start, clientY: 210 });
  rows();
  handle.props.onPointerUp({ ...start, clientY: 210 });
  editor.render();
  assert.deepEqual(editor.members.map(item => item.name), ["二", "三", "一"]);
  assert.ok(rows().every(row => row.props.style === undefined));
  assert.ok(editor.animations.some(animation => animation.frames[0].transform === "translateY(20px)" && animation.frames[1].transform === "translateY(0px)"));
  assert.ok(editor.animations.every(animation => animation.options.duration === 190));
});

test("keyboard preview slides the destination gap without depending on animated hit rectangles", () => {
  const editor = editorActions([member("一"), member("二"), member("三")]);
  editor.dragHandle(2).props.onKeyDown(editor.keyEvent(2, "Enter"));
  editor.dragHandle(2).props.onKeyDown(editor.keyEvent(2, "Home"));
  const rows = editor.nodes().filter(node => node.type === "tr" && node.props.className?.includes("member-editor-row"));
  assert.equal(rows[2].props["data-drag-kind"], "keyboard");
  assert.equal(rows[2].props.style.transform, "translateY(-120px)");
  assert.equal(rows[0].props.style.transform, "translateY(60px)");
  assert.equal(rows[1].props.style.transform, "translateY(60px)");
  editor.dragHandle(2).props.onKeyDown(editor.keyEvent(2, "Enter"));
  assert.deepEqual(editor.members.map(item => item.name), ["三", "一", "二"]);
});

test("scrolling the dialog keeps a stationary pointer attached to its member and refreshes the destination", () => {
  const original = Array.from({ length: 8 }, (_, index) => member(String(index + 1), ["Vo."]));
  const editor = editorActions(original);
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 80 });
  editor.render();
  assert.equal(editor.scrollListenerCount, 1);
  editor.scrollTo(-120);
  const source = editor.nodes().find(node => node.props["data-drag-kind"] === "pointer");
  assert.equal(source.props.style.transform, "translateY(130px)", "the source stays at viewport y50 while its untransformed row moves to y−80");
  const target = editor.nodes().find(node => node.props["data-drop-position"]);
  assert.equal(editor.nodes(target).find(node => node.type === "input").props.value, "3");
  handle.props.onPointerUp({ ...start, clientY: 80 });
  editor.render();
  assert.deepEqual(editor.members.map(item => item.name), ["2", "3", "1", "4", "5", "6", "7", "8"]);
  assert.equal(editor.scrollListenerCount, 0, "the captured scroll listener is removed after release");
});

test("pointer movement and release each refresh layout even before a scroll notification arrives", () => {
  for (const scenario of ["move", "release"]) {
    const editor = editorActions(Array.from({ length: 8 }, (_, index) => member(String(index + 1))));
    const handle = editor.dragHandle();
    const start = editor.pointerEvent();
    handle.props.onPointerDown(start);
    handle.props.onPointerMove({ ...start, clientY: 80 });
    editor.render();
    editor.scrollTo(-120, false);
    if (scenario === "move") {
      handle.props.onPointerMove({ ...start, clientY: 80 });
      assert.equal(editor.nodes().find(node => node.props["data-drag-kind"] === "pointer").props.style.transform, "translateY(130px)");
    }
    handle.props.onPointerUp({ ...start, clientY: 80 });
    editor.render();
    assert.deepEqual(editor.members.map(item => item.name), ["2", "3", "1", "4", "5", "6", "7", "8"], scenario);
    assert.equal(editor.scrollListenerCount, 0, scenario);
  }
});

test("reduced-motion preference disables settling animations and CSS neighbor transitions", () => {
  const editor = editorActions([member("一"), member("二"), member("三")]);
  editor.setReducedMotion(true);
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 210 });
  editor.render();
  handle.props.onPointerUp({ ...start, clientY: 210 });
  editor.render();
  assert.deepEqual(editor.members.map(item => item.name), ["二", "三", "一"]);
  assert.equal(editor.animations.length, 0);
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\s*\{\s*\.member-editor-table-frame\[data-dragging="true"\] \.member-editor-row \{ transition:none; \}/);
  assert.match(css, /\.member-editor-table-frame\[data-dragging="true"\] \.member-editor-row \{[^}]*transition:transform 190ms/);
  assert.match(css, /\.member-editor-row\[data-drag-kind="pointer"\] \{ transition:none; \}/);
  assert.match(css, /\.member-editor-row\.member-editor-row-dragging \{[^}]*filter:drop-shadow/);
  assert.match(css, /\.member-editor-name-row>input\[aria-invalid="true"\][^{]*\{ border-color:var\(--danger\); \}/);
  assert.match(css, /\.member-role-picker-toggle\[aria-invalid="true"\][^{]*\{ border-color:var\(--danger\); \}/);
});

test("reordering closes role and emoji pickers so unfinished input cannot be applied to a different member", () => {
  const editor = editorActions([member("田中", ["Vo."]), member("鈴木", ["Ba."])]);
  editor.open();
  editor.custom("部長");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.chooseEmoji("👑");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.byLabel("その他の絵文字").props.onChange({ target: { value: "🌟" } });
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, " "));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "ArrowDown"));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "Enter"));
  assert.deepEqual(editor.members, [member("鈴木", ["Ba."]), member("田中", ["Vo."])]);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-picker"), false);
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-emoji-picker"), false);
  editor.open(1);
  assert.equal(editor.byLabel("メンバー2のカスタム役職").props.value, "");
  editor.byLabel("メンバー2のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  assert.equal(editor.emojiPicker().props.selected, "🏷️");
  assert.equal(editor.byLabel("その他の絵文字").props.value, "");
});

test("role-free members can be reordered while preserving their mode flags and empty draft names", () => {
  const editor = editorActions([{ name: "", roles: [], roleNotRequired: true }, { name: "田中", roles: [], roleNotRequired: true }], true);
  editor.dragHandle(1).props.onPointerDown(editor.pointerEvent(1, { pointerType: "touch" }));
  editor.dragHandle(1).props.onPointerMove(editor.pointerEvent(1, { pointerType: "touch", clientY: 45 }));
  editor.dragHandle(1).props.onPointerUp(editor.pointerEvent(1, { pointerType: "touch", clientY: 45 }));
  assert.deepEqual(editor.members, [{ name: "田中", roles: [], roleNotRequired: true }, { name: "", roles: [], roleNotRequired: true }]);
  assert.equal(editor.rolesOptional, true);
  assert.equal(editor.nodes().some(node => node.props.className === "member-editor-roles"), false);
  assert.equal(editor.byClass("text-button member-editor-add").props.disabled, false);
});

test("pointer capture uses the latest target even when movement and release happen before a render", () => {
  const editor = editorActions([member("一"), member("二"), member("三"), member("四")]);
  const handle = editor.dragHandle(3);
  const start = editor.pointerEvent(3);
  const move = { ...start, clientY: 45 };
  handle.props.onPointerDown(start);
  assert.equal(start.currentTarget.hasPointerCapture(1), true);
  handle.props.onPointerMove(move);
  handle.props.onPointerUp(move);
  assert.deepEqual(editor.members.map(item => item.name), ["四", "一", "二", "三"]);
  assert.equal(editor.callbacks.length, 1);
  assert.equal(start.currentTarget.hasPointerCapture(1), false);
});

test("clicks, sub-threshold motion, return to the source and out-of-list releases do not reorder", () => {
  for (const scenario of ["click", "tiny", "source", "outside-x", "outside-y"]) {
    const editor = editorActions([member("一"), member("二"), member("三")]);
    const handle = editor.dragHandle();
    const start = editor.pointerEvent();
    handle.props.onPointerDown(start);
    if (scenario === "tiny") handle.props.onPointerMove({ ...start, clientY: start.clientY + 4 });
    if (scenario === "source") handle.props.onPointerMove({ ...start, clientY: 90 });
    if (scenario.startsWith("outside")) handle.props.onPointerMove({ ...start, clientY: 200 });
    handle.props.onPointerUp({ ...start, ...(scenario === "outside-x" ? { clientX: 601, clientY: 200 } : scenario === "outside-y" ? { clientY: 221 } : {}) });
    assert.equal(editor.callbacks.length, 0, scenario);
    assert.equal(start.currentTarget.hasPointerCapture(1), false, scenario);
  }
});

test("pointer cancellation, lost capture and Escape consume an active drag without changing members", () => {
  for (const scenario of ["cancel", "lost", "escape"]) {
    const editor = editorActions([member("一"), member("二")]);
    const handle = editor.dragHandle();
    const start = editor.pointerEvent();
    handle.props.onPointerDown(start);
    handle.props.onPointerMove({ ...start, clientY: 140 });
    if (scenario === "cancel") handle.props.onPointerCancel(start);
    else if (scenario === "lost") handle.props.onLostPointerCapture(start);
    else {
      const calls = [];
      editor.render().props.onKeyDown({ key: "Escape", preventDefault() { calls.push("prevent"); }, stopPropagation() { calls.push("stop"); } });
      assert.deepEqual(calls, ["prevent", "stop"]);
      assert.equal(editor.focusCalls.at(-1), "button:メンバー1をドラッグして並び替え");
    }
    handle.props.onPointerUp({ ...start, clientY: 140 });
    assert.equal(editor.callbacks.length, 0, scenario);
    assert.equal(editor.dragHandle().props["aria-pressed"], false);
  }
});

test("right clicks, nonprimary pointers, mismatched pointer IDs and a single member cannot reorder", () => {
  const editor = editorActions([member("一"), member("二")]);
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  for (const options of [{ button: 2 }, { isPrimary: false }]) {
    handle.props.onPointerDown({ ...start, ...options });
    handle.props.onPointerMove({ ...start, clientY: 150 });
    handle.props.onPointerUp({ ...start, clientY: 150 });
  }
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, pointerId: 2, clientY: 150 });
  handle.props.onPointerUp({ ...start, pointerId: 2, clientY: 150 });
  assert.equal(editor.callbacks.length, 0);
  handle.props.onPointerCancel(start);
  const singleton = editorActions([member("一")]);
  assert.equal(singleton.dragHandle().props.disabled, true);
  singleton.dragHandle().props.onPointerDown(singleton.pointerEvent());
  singleton.dragHandle().props.onPointerMove(singleton.pointerEvent(0, { clientY: 95 }));
  singleton.dragHandle().props.onPointerUp(singleton.pointerEvent(0, { clientY: 95 }));
  singleton.dragHandle().props.onKeyDown(singleton.keyEvent(0, "Enter"));
  assert.equal(singleton.callbacks.length, 0);
});

test("row midpoint targeting handles unequal row heights and ignores expanded picker rows", () => {
  const editor = editorActions([member("一"), member("二"), member("三")]);
  editor.setRowRects([
    { top: 40, height: 40 },
    { top: 80, height: 90 },
    { top: 170, height: 50 },
  ]);
  editor.open(1);
  const handle = editor.dragHandle(2);
  const start = editor.pointerEvent(2, { clientY: 195 });
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 115 });
  assert.equal(editor.nodes().some(node => node.props.className === "member-role-picker"), false);
  const marker = editor.nodes().find(node => node.props["data-drop-position"]);
  assert.equal(marker.props["data-drop-position"], "before");
  handle.props.onPointerUp({ ...start, clientY: 115 });
  assert.deepEqual(editor.members.map(item => item.name), ["一", "三", "二"]);
});

test("keyboard drag supports multi-row moves, boundary clamps, announcements and Escape cancellation", () => {
  const editor = editorActions([member("一"), member("二"), member("三"), member("四")]);
  const handle = editor.dragHandle(2);
  assert.equal(handle.props["aria-describedby"], "member-test-drag-instructions");
  handle.props.onKeyDown(editor.keyEvent(2, "Enter"));
  handle.props.onKeyDown(editor.keyEvent(2, "ArrowUp"));
  handle.props.onKeyDown(editor.keyEvent(2, "ArrowUp"));
  handle.props.onKeyDown(editor.keyEvent(2, "ArrowUp"));
  assert.equal(editor.callbacks.length, 0);
  assert.match(editor.nodes().find(node => node.props.role === "status").props.children, /移動先は1番目/);
  handle.props.onKeyDown(editor.keyEvent(2, " "));
  assert.deepEqual(editor.members.map(item => item.name), ["三", "一", "二", "四"]);
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, " "));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "End"));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "ArrowDown"));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "Escape"));
  assert.equal(editor.callbacks.length, 1);
  assert.deepEqual(editor.members.map(item => item.name), ["三", "一", "二", "四"]);
  editor.dragHandle(3).props.onKeyDown(editor.keyEvent(3, "Enter"));
  editor.dragHandle(3).props.onKeyDown(editor.keyEvent(3, "Home"));
  editor.dragHandle(3).props.onKeyDown(editor.keyEvent(3, "Enter"));
  assert.deepEqual(editor.members.map(item => item.name), ["四", "三", "一", "二"]);
});

test("adding, deleting, role-mode changes and external member updates cancel an in-flight drag", () => {
  for (const scenario of ["add", "delete", "mode", "external", "rename"]) {
    const editor = editorActions([member("一"), member("二"), member("三")]);
    const handle = editor.dragHandle();
    const start = editor.pointerEvent();
    handle.props.onPointerDown(start);
    handle.props.onPointerMove({ ...start, clientY: 200 });
    if (scenario === "add") click(editor.byClass("text-button member-editor-add"));
    else if (scenario === "delete") click(editor.byLabel("メンバー2を削除"));
    else if (scenario === "mode") editor.byLabel("全メンバーの役職なし").props.onChange({ target: { checked: true } });
    else if (scenario === "rename") editor.byLabel("メンバー2の名前").props.onChange({ target: { value: "新しい二" } });
    else { editor.replaceMembers([member("外部変更"), member("二"), member("三")]); editor.render(); }
    const changes = editor.callbacks.length;
    handle.props.onPointerUp({ ...start, clientY: 200 });
    assert.equal(editor.callbacks.length, changes, scenario);
    assert.equal(start.currentTarget.hasPointerCapture(1), false, scenario);
    assert.equal(editor.members[0].name, scenario === "external" ? "外部変更" : "一", scenario);
  }
});

test("a drop over clipped or covered table content cancels even inside its nominal bounds", () => {
  const editor = editorActions([member("一", ["Vo."]), member("二", ["Gt."]), member("三", ["Ba."])]);
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 190 });
  editor.setDropVisible(false);
  handle.props.onPointerUp({ ...start, clientY: 190 });
  assert.equal(editor.callbacks.length, 0);
  assert.equal(start.currentTarget.hasPointerCapture(1), false);
  assert.deepEqual(editor.members.map(member => member.name), ["一", "二", "三"]);
});

test("tabbing away cancels a keyboard drag but does not interrupt a captured pointer drag", () => {
  const editor = editorActions([member("一", ["Vo."]), member("二", ["Gt."])]);
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, " "));
  editor.dragHandle().props.onKeyDown(editor.keyEvent(0, "ArrowDown"));
  editor.dragHandle().props.onBlur();
  assert.equal(editor.dragHandle().props["aria-pressed"], false);
  assert.equal(editor.callbacks.length, 0);
  assert.ok(editor.nodes().filter(node => node.type === "tr").every(node => !node.props["data-drop-position"]));
  const handle = editor.dragHandle();
  const start = editor.pointerEvent();
  handle.props.onPointerDown(start);
  handle.props.onPointerMove({ ...start, clientY: 150 });
  handle.props.onBlur();
  handle.props.onPointerUp({ ...start, clientY: 150 });
  assert.deepEqual(editor.members.map(member => member.name), ["二", "一"]);
});

test("custom role names matching object prototype keys retain their emoji as safe own properties", () => {
  const editor = editorActions([member()]);
  editor.open();
  editor.custom("__proto__");
  editor.byLabel("メンバー1のカスタム役職の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.chooseEmoji("⭐");
  click(editor.byLabel("メンバー1にカスタム役職を追加"));
  assert.ok(Object.hasOwn(editor.members[0].roleIcons, "__proto__"));
  assert.equal(editor.members[0].roleIcons.__proto__, "⭐");
  assert.equal(Object.getPrototypeOf(editor.members[0].roleIcons), Object.prototype);
  editor.byLabel("メンバー1の「__proto__」の絵文字を選ぶ").props.onClick({ currentTarget: { focus() {} } });
  editor.chooseEmoji("👑");
  assert.equal(editor.members[0].roleIcons.__proto__, "👑");
  assert.equal(Object.getPrototypeOf(editor.members[0].roleIcons), Object.prototype);
  click(editor.byLabel("__proto__を外す"));
  assert.equal(editor.members[0].roleIcons, undefined);
});
