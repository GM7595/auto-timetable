import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Exercise the real private SlotForm through its returned React elements. Its
// dialog and child editor are not mounted, so no browser, effects, API requests,
// storage, or credential access is involved.
const projectRequire = createRequire(import.meta.url);
const React = projectRequire("react");
function compile(relativePath, dependencies = {}, exposeSlotForm = false) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(fileUrl, "utf8"), {
    fileName: fileUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const module = { exports: {} };
  const localRequire = name => Object.hasOwn(dependencies, name) ? dependencies[name] : projectRequire(name);
  const output = compiled.outputText + (exposeSlotForm ? "\nexports.__SlotForm = SlotForm;\n" : "");
  new Function("require", "module", "exports", output)(localRequire, module, module.exports);
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
const fixture = overrides => ({
  id: "band-one", title: "春のライブ", group: "春のバンド", kind: "live", durationMinutes: 25,
  changeoverMinutes: 7, people: ["佐藤", "田中"], equipment: ["マイク", "アンプ"],
  earliestStart: 900, latestEnd: 1080, fixedStart: 930, locked: true, status: "planned", energy: 4,
  notes: "ステージ上手から入場", ...overrides,
});

function slotForm(slot = fixture(), options = {}) {
  const hooks = [];
  let cursor = 0;
  const saved = [];
  let closed = 0;
  const hooksReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) {
        if (index === 0) assert.equal(initial, "", "SlotForm error hook changed; update the test harness");
        if (index === 1) assert.equal(typeof initial, "function", "SlotForm member initializer changed; update the test harness");
        hooks[index] = typeof initial === "function" ? initial() : initial;
      }
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
  };
  const { __SlotForm: SlotForm } = compile("../app/page.tsx", {
    react: hooksReact, "@/lib/planner": planner, "@/lib/demo": demo,
    "@/components/timetable": timetable, "@/components/theme-control": themeControl,
    "@/lib/dots-instructions": dotInstructions, "@/lib/proposal-review-link": proposalReviewLink,
    "@/lib/event-timing": eventTiming, "@/components/member-editor": memberEditor,
    "@/lib/member-roles": memberRoles,
  }, true);
  function render() {
    cursor = 0;
    const result = SlotForm({ slot, currentStart: options.currentStart ?? 940, defaultChangeoverMinutes: options.defaultChangeoverMinutes, onSave(value) { saved.push(value); }, onClose() { closed++; } });
    assert.equal(cursor, 7, "SlotForm hook count changed; update the test harness");
    return result;
  }
  function editor(tree = render()) {
    const editor = elements(tree, node => node.type === memberEditor.MemberEditor)[0];
    assert.ok(editor, "SlotForm must render the actual MemberEditor");
    return editor;
  }
  function submit(overrides = {}) {
    for (const [name, value] of Object.entries(overrides)) setField(name, value);
    const tree = render();
    const form = elements(tree, node => node.type === "form")[0];
    assert.ok(form);
    // Derive values from the real form's default fields instead of replacing
    // unrelated data with a second hand-written version of the form.
    const values = Object.fromEntries(elements(form, node => ["input", "select", "textarea"].includes(node.type) && node.props.name)
      .map(node => [node.props.name, node.props.type === "checkbox" ? node.props.defaultChecked ? "on" : "" : node.props.value ?? node.props.defaultValue ?? ""]));
    Object.assign(values, overrides);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "FormData");
    let prevented = false;
    Object.defineProperty(globalThis, "FormData", { configurable: true, writable: true, value: class InMemoryFormData {
      constructor(target) { assert.equal(target, form); }
      get(name) { return Object.hasOwn(values, name) ? values[name] : null; }
    } });
    try {
      form.props.onSubmit({ currentTarget: form, preventDefault() { prevented = true; } });
    } finally {
      if (previous) Object.defineProperty(globalThis, "FormData", previous);
      else delete globalThis.FormData;
    }
    assert.ok(prevented);
    return render();
  }
  function setField(name, value) {
    elements(render(), node => node.props.name === name)[0]?.props.onChange?.({ target: { value } });
  }
  return {
    render, editor, saved, submit, setField, closed: () => closed,
    setRolesOptional(optional) { editor().props.onRolesOptionalChange(optional); },
    // Enter fixture data in its corresponding whole-table mode, just as a user
    // first chooses the global switch before filling the member rows.
    setMembers(members) {
      editor().props.onRolesOptionalChange(members.length > 0 && members.every(member => member.roleNotRequired === true));
      editor().props.onChange(members);
    },
    error: () => hooks[0],
  };
}

test("legacy name-only people initialize with explicit no-role compatibility and remain savable", () => {
  const slot = fixture();
  const form = slotForm(slot);
  const legacyMembers = [{ name: "佐藤", roles: [], roleNotRequired: true }, { name: "田中", roles: [], roleNotRequired: true }];
  assert.deepEqual(form.editor().props.members, legacyMembers);
  assert.equal(form.editor().props.rolesOptional, true);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0], { ...slot, members: legacyMembers });
  assert.deepEqual(slot.people, ["佐藤", "田中"]);
  assert.equal(slot.members, undefined, "initialization and saving must not mutate the original slot");
});

test("editor changes persist aligned trimmed names and multiple preset/custom roles without losing slot fields", () => {
  const slot = fixture({ members: [{ name: "佐藤", roles: ["Vo."] }, { name: "田中", roles: ["Dr."] }] });
  const form = slotForm(slot);
  form.setMembers([
    { name: " 佐藤 ", roles: [" Vo. ", "Gt.", "部長", "Vo.", " "] },
    { name: "田中", roles: ["Ba.", "Key.", "Dr.", "会計"] },
  ]);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0], {
    ...slot,
    people: ["佐藤", "田中"],
    members: [{ name: "佐藤", roles: ["Vo.", "Gt.", "部長"] }, { name: "田中", roles: ["Ba.", "Key.", "Dr.", "会計"] }],
  });
  assert.deepEqual(slot.members, [{ name: "佐藤", roles: ["Vo."] }, { name: "田中", roles: ["Dr."] }]);
});

test("custom role emoji survive saving and reopening while orphan and invalid icons are discarded", () => {
  const form = slotForm(null);
  const members = [{ name: " 佐藤 ", roles: [" 部長 ", "司会"], roleIcons: { " 部長 ": " 👑 ", "司会": "🎙️", "未選択": "💼" } }];
  const original = structuredClone(members);
  form.setMembers(members);
  form.submit({ title: "トーク", group: "トークチーム" });
  assert.equal(form.saved.length, 1);
  const expected = [{ name: "佐藤", roles: ["部長", "司会"], roleIcons: { "部長": "👑", "司会": "🎙️" } }];
  assert.deepEqual(form.saved[0].members, expected);
  assert.deepEqual(slotForm(form.saved[0]).editor().props.members, expected);
  assert.deepEqual(members, original);
  const invalid = slotForm(null);
  invalid.setMembers([{ name: "田中", roles: ["会計"], roleIcons: { "会計": "not-an-emoji" } }]);
  invalid.submit({ title: "トーク", group: "トークチーム" });
  assert.deepEqual(invalid.saved[0].members, [{ name: "田中", roles: ["会計"] }]);
});

test("global no-role mode removes every custom icon from edited and saved members", () => {
  const form = slotForm(null);
  form.setMembers([{ name: "佐藤", roles: ["部長"], roleIcons: { "部長": "👑" } }, { name: "田中", roles: ["司会"], roleIcons: { "司会": "🎙️" } }]);
  form.setRolesOptional(true);
  assert.ok(form.editor().props.members.every(member => !Object.hasOwn(member, "roleIcons")));
  form.submit({ title: "ライブ", group: "ライブチーム" });
  assert.ok(form.saved[0].members.every(member => member.roleNotRequired && member.roles.length === 0 && !Object.hasOwn(member, "roleIcons")));
});

test("the keynote supports saving more than two named members in both whole-table modes", () => {
  const keynote = demo.demoState.slots.find(slot => slot.id === "keynote");
  assert.equal(keynote.title, "アイデアから、最初の一歩へ");
  for (const optional of [true, false]) {
    const form = slotForm(keynote);
    form.setMembers(Array.from({ length: 4 }, (_, i) => optional
      ? { name: `メンバー${i + 1}`, roles: [], roleNotRequired: true }
      : { name: `メンバー${i + 1}`, roles: ["部長"], roleIcons: { "部長": "👑" } }));
    form.submit();
    assert.equal(form.saved.length, 1);
    assert.equal(form.saved[0].members.length, 4);
    assert.deepEqual(form.saved[0].people, ["メンバー1", "メンバー2", "メンバー3", "メンバー4"]);
    assert.equal(form.saved[0].status, keynote.status);
    assert.equal(form.saved[0].locked, keynote.locked);
  }
});

test("saving edited member roles preserves active/completed anchors even when the lock checkbox is off", () => {
  for (const status of ["active", "done"]) {
    for (const fixedStart of [930, undefined]) {
      const slot = fixture({ status, fixedStart, locked: false });
      const form = slotForm(slot, { currentStart: 940 });
      form.setMembers([{ name: "佐藤", roles: ["Vo.", "Gt."] }]);
      form.submit();
      assert.equal(form.saved[0].status, status);
      assert.equal(form.saved[0].fixedStart, fixedStart ?? 940);
      assert.equal(form.saved[0].locked, false);
      assert.deepEqual(form.saved[0].equipment, slot.equipment);
      assert.equal(form.saved[0].earliestStart, 900);
      assert.equal(form.saved[0].latestEnd, 1080);
    }
  }
});

test("a newly added slot saves member roles and a new identity without fabricating old progress", () => {
  const form = slotForm(null);
  assert.deepEqual(form.editor().props.members, []);
  form.setMembers([{ name: " 佐藤 ", roles: ["Vo.", "Gt.", "部長"] }]);
  form.submit({ title: " 新しいライブ ", group: " 新バンド " });
  assert.equal(form.saved.length, 1);
  const saved = form.saved[0];
  assert.equal(typeof saved.id, "string");
  assert.ok(saved.id.length > 0);
  assert.equal(saved.title, "新しいライブ");
  assert.equal(saved.group, "新バンド");
  assert.deepEqual(saved.people, ["佐藤"]);
  assert.deepEqual(saved.members, [{ name: "佐藤", roles: ["Vo.", "Gt.", "部長"] }]);
  assert.equal(saved.status, "planned");
  assert.equal(saved.locked, false);
  assert.equal(saved.fixedStart, undefined);
});

test("duplicate normalized member names are rejected without calling onSave", () => {
  const form = slotForm();
  form.setMembers([{ name: "佐藤", roles: ["Vo."] }, { name: " 佐藤 ", roles: ["Gt."] }]);
  const tree = form.submit();
  assert.equal(form.saved.length, 0);
  assert.match(form.error(), /同じ名前のメンバーが重複/);
  assert.ok(elements(tree, node => node.props.role === "alert").some(node => textOf(node).includes("同じ名前")));
});

test("a concrete role assigned to an unnamed member is rejected", () => {
  for (const member of [{ name: " ", roles: ["Vo."] }]) {
    const invalid = slotForm();
    invalid.setMembers([member]);
    invalid.submit();
    assert.equal(invalid.saved.length, 0);
    assert.match(invalid.error(), /名前を入力/);
  }
});

test("a named member must have a role unless no-role was explicitly selected", () => {
  for (const member of [
    { name: "佐藤", roles: [] },
    { name: "佐藤", roles: [" "] },
    { name: "佐藤", roles: [], roleNotRequired: false },
  ]) {
    const invalid = slotForm(null);
    invalid.setMembers([member]);
    const tree = invalid.submit({ title: "ライブ", group: "ライブチーム" });
    assert.equal(invalid.saved.length, 0);
    assert.match(invalid.error(), /楽器|役職|担当/);
    assert.ok(elements(tree, node => node.props.role === "alert").length > 0);
  }
});

test("mixed old per-member flags cannot bypass the whole-table role requirement", () => {
  const valid = slotForm();
  valid.setMembers([
    { name: " 佐藤 ", roles: [], roleNotRequired: true },
    { name: "田中", roles: ["Dr."], roleNotRequired: false },
  ]);
  valid.submit();
  assert.equal(valid.editor().props.rolesOptional, false);
  assert.equal(valid.saved.length, 0);
  assert.match(valid.error(), /名前と楽器・役職/);
});

test("the whole-table no-role mode clears roles for every member and survives reopening", () => {
  const form = slotForm();
  form.setMembers([{ name: "佐藤", roles: ["Vo.", "Gt."] }, { name: "田中", roles: ["Dr."] }]);
  form.setRolesOptional(true);
  assert.equal(form.editor().props.rolesOptional, true);
  assert.deepEqual(form.editor().props.members, [
    { name: "佐藤", roles: [], roleNotRequired: true },
    { name: "田中", roles: [], roleNotRequired: true },
  ]);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0].members, form.editor().props.members);
  const reopened = slotForm(form.saved[0]);
  assert.equal(reopened.editor().props.rolesOptional, true);
  reopened.setRolesOptional(false);
  assert.equal(reopened.editor().props.rolesOptional, false);
  assert.ok(reopened.editor().props.members.every(member => !member.roleNotRequired));
  reopened.submit();
  assert.equal(reopened.saved.length, 0);
  assert.match(reopened.error(), /名前と楽器・役職/);
});

test("mixed legacy flags initialize the global switch off and require all members to have roles", () => {
  const form = slotForm(fixture({ members: [{ name: "佐藤", roles: [], roleNotRequired: true }, { name: "田中", roles: ["Dr."] }] }));
  assert.equal(form.editor().props.rolesOptional, false);
  form.submit();
  assert.equal(form.saved.length, 0);
  assert.match(form.error(), /名前と楽器・役職/);
  form.setRolesOptional(true);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.ok(form.saved[0].members.every(member => member.roleNotRequired && member.roles.length === 0));
});

test("global no-role mode remains selected after removing all members and applies to new rows", () => {
  const form = slotForm();
  assert.equal(form.editor().props.rolesOptional, true);
  form.editor().props.onChange([]);
  assert.equal(form.editor().props.rolesOptional, true);
  form.editor().props.onChange([{ name: "新人", roles: [], roleNotRequired: true }]);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0].members, [{ name: "新人", roles: [], roleNotRequired: true }]);
});

test("an incomplete member row blocks Save and the submit handler in ordinary role mode", () => {
  const form = slotForm(null);
  form.setField("title", "ライブ");
  form.setField("group", "ライブチーム");
  form.setMembers([{ name: "佐藤", roles: ["Vo."] }, { name: " ", roles: [] }]);
  const save = elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0];
  assert.equal(save.props.disabled, true);
  assert.equal(save.props.title, undefined, "the redundant save instruction is removed");
  form.submit({ title: "ライブ" });
  assert.equal(form.saved.length, 0);
  assert.match(form.error(), /名前を入力/);
  form.editor().props.onChange([{ name: "佐藤", roles: ["Vo."] }, { name: "田中", roles: [] }]);
  const missingRole = elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0];
  assert.equal(missingRole.props.disabled, true);
  assert.equal(missingRole.props.title, undefined);
  form.submit({ title: "ライブ" });
  assert.equal(form.saved.length, 0);
  form.editor().props.onChange([{ name: "佐藤", roles: ["Vo."] }, { name: "田中", roles: ["Gt."] }]);
  assert.equal(elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
  form.submit({ title: "ライブ" });
  assert.equal(form.saved.length, 1);
  assert.equal(form.saved[0].members.length, 2);
});

test("blank rows also block Save in global no-role mode and removing them restores saving", () => {
  for (const slot of [null, fixture({ people: [], members: [] }), fixture()]) {
    const form = slotForm(slot);
    form.setField("title", "ライブ");
    form.setField("group", "ライブチーム");
    form.setRolesOptional(true);
    const named = form.editor().props.members.filter(member => member.name);
    form.editor().props.onChange([...named, { name: " ", roles: [], roleNotRequired: true }]);
    assert.equal(elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, true);
    form.submit({ title: "ライブ" });
    assert.equal(form.saved.length, 0);
    form.editor().props.onChange(named);
    assert.equal(elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
    form.submit({ title: "ライブ" });
    assert.equal(form.saved.length, 1);
    assert.deepEqual(form.saved[0].people, named.map(member => member.name));
    assert.deepEqual(form.saved[0].members, named);
  }
});

test("memberless new and existing slots start empty and may save without adding a row", () => {
  for (const slot of [null, fixture({ people: [], members: [] })]) {
    const form = slotForm(slot);
    assert.deepEqual(form.editor().props.members, []);
    form.setField("title", "休憩");
    form.setField("group", "主催");
    assert.equal(elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
    form.submit({ title: "休憩" });
    assert.equal(form.saved.length, 1);
    assert.deepEqual(form.saved[0].people, []);
    assert.deepEqual(form.saved[0].members, []);
  }
});

test("reordered members save and reopen in the new order with names, roles and emoji aligned", () => {
  const original = [
    { name: "佐藤", roles: ["部長"], roleIcons: { "部長": "👑" } },
    { name: "田中", roles: ["Gt."] },
    { name: "鈴木", roles: ["司会"], roleIcons: { "司会": "🎙️" } },
  ];
  const form = slotForm(fixture({ people: original.map(member => member.name), members: original }));
  const reordered = [original[2], original[0], original[1]];
  form.editor().props.onChange(reordered);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0].people, ["鈴木", "佐藤", "田中"]);
  assert.deepEqual(form.saved[0].members, reordered);
  assert.deepEqual(slotForm(form.saved[0]).editor().props.members, reordered);
  assert.deepEqual(original.map(member => member.name), ["佐藤", "田中", "鈴木"]);
});

test("member count, name length, role count, and role length limits reject invalid form saves", () => {
  const invalidCases = [
    Array.from({ length: memberRoles.MAX_MEMBERS + 1 }, (_, index) => ({ name: `人${index}`, roles: ["Vo."] })),
    [{ name: "名".repeat(memberRoles.MAX_MEMBER_NAME_LENGTH + 1), roles: ["Vo."] }],
    [{ name: "佐藤", roles: Array.from({ length: memberRoles.MAX_MEMBER_ROLES + 1 }, (_, index) => `役職${index}`) }],
    [{ name: "佐藤", roles: ["役".repeat(memberRoles.MAX_MEMBER_ROLE_LENGTH + 1)] }],
  ];
  for (const members of invalidCases) {
    const form = slotForm();
    form.setMembers(members);
    form.submit();
    assert.equal(form.saved.length, 0);
    assert.match(form.error(), /30人まで/);
  }
});

test("members and roles exactly at the documented limits can be saved", () => {
  const members = Array.from({ length: memberRoles.MAX_MEMBERS }, (_, index) => ({
    name: index === 0 ? "名".repeat(memberRoles.MAX_MEMBER_NAME_LENGTH) : `人${index}`,
    roles: Array.from({ length: memberRoles.MAX_MEMBER_ROLES }, (_, roleIndex) => `${roleIndex}`.padEnd(memberRoles.MAX_MEMBER_ROLE_LENGTH, "役")),
  }));
  const form = slotForm();
  form.setMembers(members);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.deepEqual(form.saved[0].members, members);
  assert.deepEqual(form.saved[0].people, members.map(member => member.name));
});

test("canceling member edits calls only onClose, never onSave", () => {
  const form = slotForm();
  form.setMembers([{ name: "佐藤", roles: ["Vo.", "部長"] }]);
  const cancel = elements(form.render(), node => node.type === "button" && textOf(node) === "キャンセル")[0];
  assert.ok(cancel);
  assert.equal(cancel.props.type, "button");
  cancel.props.onClick();
  assert.equal(form.closed(), 1);
  assert.equal(form.saved.length, 0);
});

test("the required artist field loses its red state when populated and regains it when cleared", () => {
  const form = slotForm(null);
  const input = name => elements(form.render(), node => node.type === "input" && node.props.name === name)[0];
  const save = () => elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0];
  for (const name of ["group"]) {
    assert.equal(input(name).props.required, true);
    assert.equal(input(name).props["aria-invalid"], true);
    form.setField(name, "  ");
    assert.equal(input(name).props["aria-invalid"], true);
    form.setField(name, name === "title" ? "演目" : "アーティスト");
    assert.equal(input(name).props["aria-invalid"], false);
  }
  assert.equal(save().props.disabled, false);
  assert.match(textOf(form.render()), /アーティスト・グループ名必須/);
  assert.doesNotMatch(textOf(form.render()), /出演者・グループ名/);
  form.setField("group", "");
  assert.equal(input("group").props["aria-invalid"], true);
  assert.equal(save().props.disabled, true);
  form.submit({ title: "演目", group: " " });
  assert.equal(form.saved.length, 0, "manual submit must not bypass required artist validation");
});

test("a title is optional for new and edited slots, without invalid styling or fabricated saved text", () => {
  for (const existing of [null, fixture()]) {
    for (const title of ["", "   "]) {
      const form = slotForm(existing);
      form.setField("group", "タイトルのないバンド");
      form.setField("title", title);
      const tree = form.render();
      const input = elements(tree, node => node.type === "input" && node.props.name === "title")[0];
      assert.equal(input.props.required, undefined);
      assert.notEqual(input.props["aria-invalid"], true);
      const label = elements(tree, node => node.type === "label" && elements(node, child => child === input).length > 0)[0];
      assert.ok(label);
      assert.doesNotMatch(textOf(label), /必須/);
      assert.equal(elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0].props.disabled, false);
      form.submit();
      assert.equal(form.saved.length, 1);
      assert.equal(form.saved[0].title, "");
      assert.equal(form.saved[0].group, "タイトルのないバンド");
      assert.equal(elements(slotForm(form.saved[0]).render(), node => node.props.name === "title")[0].props.value, "");
    }
  }
});

test("main duration is required, validates integral minutes, and recovers immediately after correction", () => {
  const form = slotForm();
  const duration = () => elements(form.render(), node => node.type === "input" && node.props.name === "duration")[0];
  const save = () => elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0];
  assert.equal(duration().props.required, true);
  assert.equal(duration().props["aria-invalid"], false);
  for (const value of ["", " ", "0", "-1", "1.5", "241", "NaN"]) {
    form.setField("duration", value);
    assert.equal(duration().props["aria-invalid"], true, value);
    assert.equal(save().props.disabled, true);
    form.submit();
    assert.equal(form.saved.length, 0);
  }
  form.setField("duration", "30");
  assert.equal(duration().props["aria-invalid"], false);
  assert.equal(save().props.disabled, false);
  form.submit();
  assert.equal(form.saved[0].durationMinutes, 30);
});

test("new slots inherit their event's changeover default including zero, but edits preserve existing overrides", () => {
  for (const defaultChangeoverMinutes of [undefined, 0, 9, 90]) {
    const form = slotForm(null, { defaultChangeoverMinutes });
    const changeover = elements(form.render(), node => node.props.name === "changeover")[0];
    assert.equal(Number(changeover.props.value), defaultChangeoverMinutes ?? 5);
    form.submit({ title: "演目", group: "バンド" });
    assert.equal(form.saved[0].changeoverMinutes, defaultChangeoverMinutes ?? 5);
    for (const override of [0, 7]) {
      const edited = slotForm(fixture({ changeoverMinutes: override }), { defaultChangeoverMinutes });
      edited.submit();
      assert.equal(edited.saved[0].changeoverMinutes, override);
    }
  }
});

test("invalid preparation minutes cannot be saved even by bypassing native form validation", () => {
  for (const value of ["", "-1", "2.5", "91", "Infinity"]) {
    const form = slotForm();
    form.submit({ changeover: value });
    assert.equal(form.saved.length, 0);
    assert.match(form.error(), /準備・転換/);
  }
});

test("category presents just program and support while preserving unchanged legacy category details", () => {
  for (const kind of ["talk", "workshop", "live", "break", "other"]) {
    const form = slotForm(fixture({ kind }));
    const category = elements(form.render(), node => node.type === "select" && node.props.name === "kind")[0];
    assert.deepEqual(elements(category, node => node.type === "option").map(node => textOf(node)), ["演目", "転換・その他"]);
    form.submit();
    assert.equal(form.saved[0].kind, kind);
  }
  const support = slotForm();
  support.submit({ kind: "support" });
  assert.equal(support.saved[0].kind, "break");
  const program = slotForm(fixture({ kind: "break" }));
  program.submit({ kind: "program" });
  assert.equal(program.saved[0].kind, "talk");
});

test("energy selection is removed without discarding existing saved energy", () => {
  const form = slotForm();
  assert.equal(elements(form.render(), node => node.props.name === "energy").length, 0);
  assert.doesNotMatch(textOf(form.render()), /雰囲気・エネルギー/);
  form.submit();
  assert.equal(form.saved[0].energy, 4);
});
