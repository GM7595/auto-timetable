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
const memberEditor = compile("../components/member-editor.tsx", { "@/lib/member-roles": memberRoles });
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
    const result = SlotForm({ slot, currentStart: options.currentStart ?? 940, onSave(value) { saved.push(value); }, onClose() { closed++; } });
    assert.equal(cursor, 2, "SlotForm hook count changed; update the test harness");
    return result;
  }
  function editor(tree = render()) {
    const editor = elements(tree, node => node.type === memberEditor.MemberEditor)[0];
    assert.ok(editor, "SlotForm must render the actual MemberEditor");
    return editor;
  }
  function submit(overrides = {}) {
    const tree = render();
    const form = elements(tree, node => node.type === "form")[0];
    assert.ok(form);
    // Derive values from the real form's default fields instead of replacing
    // unrelated data with a second hand-written version of the form.
    const values = Object.fromEntries(elements(form, node => ["input", "select", "textarea"].includes(node.type) && node.props.name)
      .map(node => [node.props.name, node.props.type === "checkbox" ? node.props.defaultChecked ? "on" : "" : node.props.defaultValue ?? ""]));
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
  return { render, editor, saved, submit, closed: () => closed, setMembers(members) { editor().props.onChange(members); }, error: () => hooks[0] };
}

test("legacy name-only people initialize with explicit no-role compatibility and remain savable", () => {
  const slot = fixture();
  const form = slotForm(slot);
  const legacyMembers = [{ name: "佐藤", roles: [], roleNotRequired: true }, { name: "田中", roles: [], roleNotRequired: true }];
  assert.deepEqual(form.editor().props.members, legacyMembers);
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
  assert.deepEqual(form.editor().props.members, [{ name: "", roles: [] }]);
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

test("a role or no-role choice assigned to an unnamed member is rejected", () => {
  for (const member of [{ name: " ", roles: ["Vo."] }, { name: " ", roles: [], roleNotRequired: true }]) {
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
    const tree = invalid.submit({ title: "ライブ" });
    assert.equal(invalid.saved.length, 0);
    assert.match(invalid.error(), /楽器|役職|担当/);
    assert.ok(elements(tree, node => node.props.role === "alert").length > 0);
  }
});

test("explicit no-role choices are preserved per member and unused blank rows are ignored", () => {
  const valid = slotForm();
  valid.setMembers([
    { name: " 佐藤 ", roles: [], roleNotRequired: true },
    { name: "田中", roles: ["Dr."], roleNotRequired: false },
    { name: "  ", roles: [] },
    { name: "", roles: [" "] },
    { name: " ", roles: [], roleNotRequired: false },
  ]);
  valid.submit();
  assert.equal(valid.saved.length, 1);
  assert.deepEqual(valid.saved[0].people, ["佐藤", "田中"]);
  assert.deepEqual(valid.saved[0].members, [{ name: "佐藤", roles: [], roleNotRequired: true }, { name: "田中", roles: ["Dr."] }]);
});

test("a member cannot select both concrete roles and the explicit no-role option", () => {
  const form = slotForm();
  form.setMembers([{ name: "佐藤", roles: ["Vo."], roleNotRequired: true }]);
  form.submit();
  assert.equal(form.saved.length, 0);
  assert.match(form.error(), /役職なし/);
});

test("memberless new and existing slots start with one unused name field and may save without members", () => {
  for (const slot of [null, fixture({ people: [], members: [] })]) {
    const form = slotForm(slot);
    assert.deepEqual(form.editor().props.members, [{ name: "", roles: [] }]);
    form.submit({ title: "休憩" });
    assert.equal(form.saved.length, 1);
    assert.deepEqual(form.saved[0].people, []);
    assert.deepEqual(form.saved[0].members, []);
  }
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
