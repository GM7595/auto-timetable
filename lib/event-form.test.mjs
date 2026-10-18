import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Exercise the private EventForm's real submit handler and rendered fields
// without mounting a dialog, opening a browser, or accessing event storage.
const projectRequire = createRequire(import.meta.url);
const React = projectRequire("react");
function compile(relativePath, dependencies = {}, exposeEventForm = false) {
  const fileUrl = new URL(relativePath, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(fileUrl, "utf8"), {
    fileName: fileUrl.pathname,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  });
  const module = { exports: {} };
  const localRequire = name => Object.hasOwn(dependencies, name)
    ? dependencies[name]
    : name.startsWith("@/") ? {} : projectRequire(name);
  new Function("require", "module", "exports", compiled.outputText + (exposeEventForm ? "\nexports.__EventForm = EventForm;\n" : ""))(localRequire, module, module.exports);
  return module.exports;
}
const planner = compile("./planner.ts");

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
function fixture(defaultChangeoverMinutes) {
  return {
    event: {
      id: "event-one", name: "ライブ", date: "2026-11-14", location: "渋谷ホール", startTime: 840, endTime: 1050,
      quietWindows: [{ id: "quiet", label: "音止め", start: 930, end: 940 }],
      ...(defaultChangeoverMinutes === undefined ? {} : { defaultChangeoverMinutes }),
    },
    slots: [
      { id: "one", title: "Opening", group: "A", kind: "live", durationMinutes: 20, changeoverMinutes: 0, people: ["佐藤"], equipment: [], locked: false, status: "planned", energy: 3, notes: "" },
      { id: "two", title: "Second", group: "B", kind: "live", durationMinutes: 30, changeoverMinutes: 7, people: ["田中"], equipment: ["マイク"], locked: true, fixedStart: 900, status: "planned", energy: 4, notes: "設定済みの転換時間" },
    ],
    history: [{ id: "history-one", at: "2026-10-18T00:00:00.000Z", title: "登録", detail: "初期状態", kind: "create" }],
    revision: 12,
  };
}

function eventForm(state) {
  const hooks = [];
  let cursor = 0;
  let closed = 0;
  const saved = [];
  const overrides = {};
  const hooksReact = {
    ...React,
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], value => { hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
  };
  const { __EventForm: EventForm } = compile("../app/page.tsx", { react: hooksReact, "@/lib/planner": planner }, true);
  function render() {
    cursor = 0;
    return EventForm({ state, onSave(value) { saved.push(value); }, onClose() { closed++; } });
  }
  function input(name, tree = render()) {
    const found = elements(tree, node => node.type === "input" && node.props.name === name)[0];
    assert.ok(found, `EventForm must contain input ${name}`);
    return found;
  }
  function fill(name, value) {
    const field = input(name);
    overrides[name] = value;
    field.props.onChange?.({ target: { value }, currentTarget: { value } });
  }
  function submit(values = {}) {
    for (const [name, value] of Object.entries(values)) fill(name, value);
    const tree = render();
    const form = elements(tree, node => node.type === "form")[0];
    assert.ok(form);
    const fields = Object.fromEntries(elements(form, node => ["input", "select", "textarea"].includes(node.type) && node.props.name)
      .map(node => [node.props.name, node.props.value ?? node.props.defaultValue ?? ""]));
    Object.assign(fields, overrides);
    const previous = Object.getOwnPropertyDescriptor(globalThis, "FormData");
    let prevented = false;
    Object.defineProperty(globalThis, "FormData", { configurable: true, writable: true, value: class InMemoryFormData {
      constructor(target) { assert.equal(target, form); }
      get(name) { return Object.hasOwn(fields, name) ? fields[name] : null; }
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
  return { render, input, fill, submit, saved, closed: () => closed };
}

test("older events display a five-minute default without changing the stored event on render", () => {
  const state = fixture();
  const original = structuredClone(state);
  const form = eventForm(state);
  const field = form.input("defaultChangeover");
  assert.equal(Number(field.props.value ?? field.props.defaultValue), 5);
  assert.equal(field.props.type, "number");
  assert.equal(Number(field.props.min), 0);
  assert.equal(Number(field.props.max), 90);
  assert.equal(field.props.required, true);
  assert.deepEqual(state, original);
  assert.equal(form.saved.length, 0);
});

test("an event's own zero-minute default is not replaced by the legacy fallback", () => {
  const form = eventForm(fixture(0));
  const field = form.input("defaultChangeover");
  assert.equal(Number(field.props.value ?? field.props.defaultValue), 0);
  form.submit();
  assert.equal(form.saved.length, 1);
  assert.equal(form.saved[0].event.defaultChangeoverMinutes, 0);
});

test("saving the event default preserves existing slot overrides, history, and revision", () => {
  for (const value of [0, 9, 90]) {
    const state = fixture(5);
    const original = structuredClone(state);
    const form = eventForm(state);
    form.submit({ defaultChangeover: String(value) });
    assert.equal(form.saved.length, 1);
    assert.deepEqual(form.saved[0], { ...original, event: { ...original.event, defaultChangeoverMinutes: value } });
    assert.deepEqual(form.saved[0].slots.map(slot => slot.changeoverMinutes), [0, 7]);
    assert.deepEqual(state, original, "editing a default must not mutate the input event or its slots");
  }
});

test("invalid event defaults cannot be saved even when native form validation is bypassed", () => {
  for (const value of ["", " ", "abc", "NaN", "Infinity", "2.5", "-1", "91"]) {
    const state = fixture(5);
    const original = structuredClone(state);
    const form = eventForm(state);
    const tree = form.submit({ defaultChangeover: value });
    assert.equal(form.saved.length, 0, `must reject ${JSON.stringify(value)}`);
    assert.ok(elements(tree, node => node.props.role === "alert").some(node => /転換/.test(textOf(node))), `must explain invalid default ${JSON.stringify(value)}`);
    assert.deepEqual(state, original);
  }
});

test("a corrected event default can be saved after an invalid attempt", () => {
  const form = eventForm(fixture(5));
  form.submit({ defaultChangeover: "" });
  assert.equal(form.saved.length, 0);
  form.submit({ defaultChangeover: "9" });
  assert.equal(form.saved.length, 1);
  assert.equal(form.saved[0].event.defaultChangeoverMinutes, 9);
});

test("the default's invalid styling and save button recover as soon as its value is valid", () => {
  const form = eventForm(fixture(5));
  const saveButton = () => elements(form.render(), node => node.type === "button" && node.props.type === "submit")[0];
  assert.equal(form.input("defaultChangeover").props["aria-invalid"], false);
  assert.equal(saveButton().props.disabled, false);
  form.fill("defaultChangeover", "");
  assert.equal(form.input("defaultChangeover").props["aria-invalid"], true);
  assert.equal(saveButton().props.disabled, true);
  form.fill("defaultChangeover", "0");
  assert.equal(form.input("defaultChangeover").props["aria-invalid"], false);
  assert.equal(saveButton().props.disabled, false);
  assert.equal(form.saved.length, 0, "editing validation state must not save an event");
});

test("defaults belong to each event and do not leak to another event form", () => {
  const first = fixture(9);
  const second = fixture(0);
  second.event.id = "event-two";
  second.event.name = "交流イベント";
  const firstOriginal = structuredClone(first);
  const secondOriginal = structuredClone(second);
  const firstForm = eventForm(first);
  const secondForm = eventForm(second);
  firstForm.submit({ defaultChangeover: "12" });
  secondForm.submit();
  assert.equal(firstForm.saved[0].event.defaultChangeoverMinutes, 12);
  assert.equal(secondForm.saved[0].event.defaultChangeoverMinutes, 0);
  assert.equal(secondForm.saved[0].event.id, "event-two");
  assert.deepEqual(first, firstOriginal);
  assert.deepEqual(second, secondOriginal);
  assert.equal(firstForm.closed(), 0);
  assert.equal(secondForm.closed(), 0);
});
