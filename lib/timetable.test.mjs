import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

// Compile the actual component and actual formatter in memory: no browser,
// generated source files, network, storage, or API credentials are involved.
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
const memberRoles = compile("./member-roles.ts");
const { Timetable } = compile("../components/timetable.tsx", { "@/lib/planner": planner, "@/lib/member-roles": memberRoles });
const slot = (id, overrides = {}) => ({
  id, title: `内容 ${id}`, group: `出演者 ${id}`, kind: "talk", durationMinutes: 10,
  changeoverMinutes: 5, people: [], equipment: [], locked: false, status: "planned",
  energy: 3, notes: "", start: 840, end: 850, changeoverStart: 840, waitMinutes: 0, violations: [], ...overrides,
});
const first = slot("first");
const second = slot("second", { start: 865, end: 875, changeoverStart: 850, waitMinutes: 10 });
function render(rows = [first, second], overrides = {}) {
  return renderToStaticMarkup(React.createElement(Timetable, {
    rows, allRows: rows, originalRows: rows, preview: false, onEdit() {}, onFinishActive() {}, ...overrides,
  }));
}
const plainText = markup => markup.replace(/<[^>]+>/g, "");
const count = (markup, className) => (markup.match(new RegExp(`class="${className}"`, "g")) ?? []).length;
function elements(tree, predicate) {
  if (Array.isArray(tree)) return tree.flatMap(child => elements(child, predicate));
  if (!React.isValidElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...elements(tree.props.children, predicate)];
}

test("renders a semantic timetable with three columns and no status or action column", () => {
  const html = render();
  assert.match(html, /<table class="run-table">/);
  assert.match(html, /<caption/);
  assert.equal((html.match(/<th scope="col">/g) ?? []).length, 3);
  assert.equal((html.match(/<col(?:\s|\/|>)/g) ?? []).length, 3);
  for (const label of ["時間", "内容", "所要"]) assert.ok(html.includes(`<th scope="col">${label}</th>`));
  assert.doesNotMatch(html, /内容・出演者/);
  assert.doesNotMatch(html, /<th[^>]*>(?:状態|操作)<\/th>|run-table-col-status|run-table-state|run-table-status|run-table-col-actions|run-table-actions/);
  assert.match(html, /role="region"[^>]+tabindex="0"/);
});

test("main, preparation, and waiting rows each have exactly three real cells", () => {
  const html = render();
  const tableRows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)];
  assert.equal(tableRows.length, 5, "header, two programs, preparation, and waiting are retained");
  for (const [, cells] of tableRows) {
    const columns = [...cells.matchAll(/<(?:td|th)\b([^>]*)>/g)]
      .reduce((sum, [, attributes]) => sum + Number(attributes.match(/colspan="(\d+)"/i)?.[1] ?? 1), 0);
    assert.equal(columns, 3);
    assert.equal((cells.match(/<(?:td|th)\b/g) ?? []).length, 3);
  }
  assert.doesNotMatch(html, /colSpan=/);
});

test("a fixed slot has one accessible lock icon immediately before its content title", () => {
  const html = render([slot("fixed", { locked: true, title: "固定した演目" })]);
  assert.match(html, /<div class="run-table-title-line"><span class="run-table-fixed" role="img" aria-label="出演時刻を固定" title="出演時刻を固定"><svg[^>]*class="[^"]*lucide-lock-keyhole[^"]*"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/span><strong>固定した演目<\/strong>/);
  assert.equal(count(html, "run-table-fixed"), 1);
  assert.equal((html.match(/lucide-lock-keyhole/g) ?? []).length, 1);
  assert.doesNotMatch(html, />固定<\/|run-table-state/);
  assert.doesNotMatch(render([first]), /run-table-fixed|lucide-lock-keyhole/);
});

test("an untitled slot displays its artist once and keeps a meaningful edit button label", () => {
  for (const title of ["", "   "]) {
    const row = slot("untitled", { title, group: "タイトルのないバンド", locked: true });
    const html = render([row]);
    assert.match(html, /<strong>タイトルのないバンド<\/strong>/);
    assert.match(html, /aria-label="タイトルのないバンドを編集"/);
    assert.equal(count(html, "run-table-group"), 0, "the artist must not be duplicated below the title");
    assert.equal(count(html, "run-table-fixed"), 1);
    assert.equal(row.title, title, "display fallback must never write into saved data");
  }
  const legacy = render([slot("legacy", { title: "", group: "" })]);
  assert.match(legacy, /<strong>名称未設定<\/strong>/);
  assert.match(legacy, /aria-label="名称未設定を編集"/);
});

test("editing is one accessible pencil button inside each content title line, not a separate column", () => {
  const html = render();
  assert.equal(count(html, "run-table-edit"), 2);
  assert.match(html, /<div class="run-table-title-line"><strong>内容 first<\/strong><button type="button" class="run-table-edit" aria-label="内容 firstを編集" title="編集"><svg[^>]*class="[^"]*lucide-pencil[^"]*"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><\/button><\/div>/);
  assert.doesNotMatch(html, /<span>編集<\/span>|<td[^>]*class="run-table-actions"/);
  const clicked = [];
  const tree = Timetable({ rows: [first, second], allRows: [first, second], originalRows: [first, second], preview: false, onEdit(id) { clicked.push(id); } });
  const buttons = elements(tree, element => element.type === "button" && element.props.className === "run-table-edit");
  assert.equal(buttons.length, 2);
  buttons[1].props.onClick();
  assert.deepEqual(clicked, ["second"]);
});

test("performer text is retained next to a decorative people icon", () => {
  const html = render([first]);
  assert.match(html, /<span class="run-table-group"><svg[^>]*class="[^"]*lucide-users-round[^"]*"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>出演者 first<\/span><\/span>/);
  assert.equal(count(html, "run-table-group"), 1);
  assert.equal((html.match(/lucide-users-round/g) ?? []).length, 1);
});

test("empty or title-identical performer names do not leave an orphan icon", () => {
  for (const group of ["", "   ", first.title]) {
    const html = render([{ ...first, group }]);
    assert.equal(count(html, "run-table-group"), 0);
    assert.doesNotMatch(html, /lucide-users-round/);
    assert.ok(html.includes(`<strong>${first.title}</strong>`));
  }
});

test("all members appear below their performer group, including legacy members without roles", () => {
  const html = render([slot("band", { group: "春のバンド", people: ["佐藤", "田中", "鈴木"] })]);
  assert.equal(count(html, "run-table-members"), 1);
  assert.equal(count(html, "run-table-member"), 3);
  assert.equal(count(html, "run-table-member-role"), 0);
  assert.equal((html.match(/lucide-user-round/g) ?? []).length, 3);
  assert.ok(html.indexOf("春のバンド") < html.indexOf("佐藤"));
  for (const name of ["佐藤", "田中", "鈴木"]) assert.match(html, new RegExp(`run-table-member-name">[\\s\\S]*?<span>${name}</span>`));
});

test("each member's multiple instrument and custom roles retain icon, short label, and full name", () => {
  const html = render([slot("band", {
    people: ["佐藤", "田中", "鈴木"],
    members: [
      { name: "佐藤", roles: ["Vo.", "Gt."] },
      { name: "田中", roles: ["Ba.", "Key.", "Dr."] },
      { name: "鈴木", roles: ["部長"] },
    ],
  })]);
  assert.equal(count(html, "run-table-member"), 3);
  assert.equal(count(html, "run-table-member-role"), 6);
  for (const label of ["Vo.", "Gt.", "Ba.", "Key.", "Dr.", "部長"]) assert.ok(html.includes(`<span>${label}</span>`));
  for (const name of ["ボーカル", "ギター", "ベース", "キーボード", "ドラム", "部長"]) assert.ok(html.includes(`title="${name}"`));
  for (const icon of ["🎤", "🎸", "🎹", "🥁", "🏷️"]) assert.ok(html.includes(icon));
});

test("custom role emoji appear in timetable and comparison while presets keep their fixed icons", () => {
  const member = { name: "佐藤", roles: ["Vo.", "部長", "司会"], roleIcons: { "Vo.": "💼", "部長": "👑", "司会": "🎙️" } };
  const rows = [slot("band", { people: ["佐藤"], members: [member] })];
  const original = structuredClone(rows);
  for (const preview of [false, true]) {
    const html = render(rows, { preview });
    for (const icon of ["🎤", "👑", "🎙️"]) assert.ok(html.includes(icon));
    assert.ok(!html.includes("💼"));
    assert.match(html, /title="部長"/);
    assert.match(html, /title="司会"/);
  }
  assert.deepEqual(rows, original);
});

test("empty members have no extra list while title-identical performer groups still show actual members", () => {
  const html = render([slot("none", { people: [], members: [] })]);
  assert.equal(count(html, "run-table-members"), 0);
  assert.doesNotMatch(html, /lucide-user-round/);
  const sameGroup = render([slot("band", { group: "内容 band", people: ["佐藤"] })]);
  assert.equal(count(sameGroup, "run-table-group"), 0);
  assert.equal(count(sameGroup, "run-table-member"), 1);
  assert.match(sameGroup, /佐藤/);
});

test("an explicit no-role member remains visible without an empty or invented role chip", () => {
  const html = render([slot("none", { people: ["佐藤"], members: [{ name: "佐藤", roles: [], roleNotRequired: true }] })]);
  assert.equal(count(html, "run-table-member"), 1);
  assert.equal(count(html, "run-table-member-role"), 0);
  assert.match(html, /佐藤/);
  assert.doesNotMatch(html, /🎤|🎸|🎹|🥁|🏷️/);
});

test("custom member names and roles remain escaped in visible content and hover text", () => {
  const name = '<img src=x onerror="bad()">';
  const role = '<script title="bad()">部長</script>';
  const html = render([slot("safe", { people: [name], members: [{ name, roles: [role] }] })]);
  assert.ok(html.includes("&lt;img src=x onerror=&quot;bad()&quot;&gt;"));
  assert.ok(html.includes("&lt;script title=&quot;bad()&quot;&gt;部長&lt;/script&gt;"));
  assert.doesNotMatch(html, /<img|<script/);
});

test("candidate previews retain member identities and roles without affecting preparation or changed metadata", () => {
  const original = slot("band", { people: ["佐藤", "田中"], members: [{ name: "佐藤", roles: ["Vo.", "Gt."] }, { name: "田中", roles: ["Dr."] }] });
  const candidate = { ...original, start: 900, end: 912, durationMinutes: 12, changeoverStart: 895, waitMinutes: 0 };
  const html = render([candidate], { allRows: [first, candidate], originalRows: [first, original], preview: true });
  assert.equal(count(html, "run-table-member"), 2);
  assert.equal(count(html, "run-table-member-role"), 3);
  assert.equal(count(html, "run-table-transition"), 1);
  assert.match(plainText(html), /15:00–15:12旧 14:00–14:10/);
  assert.match(html, /佐藤|田中/);
  assert.match(html, /run-table-change-badge">変更/);
  assert.match(html, /class="run-table-main run-table-planned run-table-changed"/);
});

test("the first full-schedule slot has no preparation even if its raw setup is nonzero", () => {
  const html = render([first]);
  assert.equal(count(html, "run-table-transition"), 0);
  assert.match(plainText(html), /14:00–14:10/);
});

test("filtering out earlier slots does not discard a later slot's preparation", () => {
  const html = render([second], { allRows: [first, second] });
  assert.equal(count(html, "run-table-transition"), 1);
  assert.match(html, /run-table-prep-target">出演者 second/);
  assert.match(plainText(html), /14:10–14:15転換・準備/);
});

test("preparation and waiting have separate, accurate adjacent intervals", () => {
  const html = render();
  const text = plainText(html);
  assert.match(text, /14:10–14:15転換・準備出演者 second5分/);
  assert.match(text, /14:15–14:25時間調整・待機10分/);
  assert.ok(html.indexOf("run-table-transition") < html.indexOf("run-table-wait"));
  assert.ok(html.indexOf("run-table-wait") < html.lastIndexOf("run-table-main"));
  assert.doesNotMatch(text, /待機・音出し不可/);
});

test("a clock-derived active row identifies progress without manual finish controls", () => {
  const active = slot("active", { status: "active" });
  const html = render([active]);
  assert.match(html, /aria-current="step"/);
  assert.match(html, /class="run-table-main run-table-active"/);
  assert.doesNotMatch(html, /この枠を終了/);
  assert.match(html, /activeを編集/);
  assert.doesNotMatch(render([first]), /この枠を終了/);
});

test("an unapplied preview never claims to be in progress, while retaining edit access", () => {
  const active = slot("active", { status: "active" });
  const html = render([active], { preview: true });
  assert.doesNotMatch(html, /この枠を終了/);
  assert.doesNotMatch(html, /aria-current="step"|run-table-active|進行中/);
  assert.match(html, /class="run-table-main run-table-planned"/);
  assert.match(html, /activeを編集/);
  assert.doesNotMatch(render([slot("done", { status: "done" })], { preview: true }), /run-table-done|>終了</);
});

test("completed rows retain clock-derived styling without reintroducing a status label", () => {
  const html = render([slot("done", { status: "done" })]);
  assert.match(html, /class="run-table-main run-table-done"/);
  assert.doesNotMatch(html, /aria-current="step"|run-table-status|>終了</);
});

test("warnings remain visible and fixed state stays accessible, with escaped organizer content", () => {
  const html = render([slot("warning", { locked: true, title: "<script>alert(1)</script>", violations: ["固定枠に転換が間に合いません。"] })]);
  assert.match(html, /固定枠に転換が間に合いません。/);
  assert.match(html, /role="img" aria-label="出演時刻を固定" title="出演時刻を固定"/);
  assert.doesNotMatch(html, />固定<\//);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("a changed preview reports old times, old duration, and order changes", () => {
  const changedSecond = { ...second, start: 900, end: 920, durationMinutes: 20, waitMinutes: 0 };
  const html = render([changedSecond, first], { preview: true, originalRows: [first, second] });
  const text = plainText(html);
  assert.match(text, /15:00–15:20旧 14:25–14:35/);
  assert.match(text, /順番 2 → 1/);
  assert.match(text, /20分旧10分/);
  assert.match(html, /run-table-change-badge">変更/);
});

test("end-only changes are marked and an empty table remains well formed", () => {
  const changed = { ...first, end: 855, durationMinutes: 15 };
  assert.match(plainText(render([changed], { preview: true, originalRows: [first] })), /14:00–14:15旧 14:00–14:10/);
  const empty = render([]);
  assert.match(empty, /<tbody><tr><td colSpan="3" class="run-table-empty">表示する進行枠がありません。/);
});
