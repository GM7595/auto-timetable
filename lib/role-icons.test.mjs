import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = ts.transpileModule(readFileSync(new URL("./member-roles.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("module", "exports", source)(module, module.exports);
const { getMemberRole, getSlotMembers, isMemberRoleIcon } = module.exports;

test("custom roles use chosen emoji while presets and legacy custom roles retain their icons", () => {
  assert.deepEqual(getMemberRole("部長", { 部長: "👑" }), { label: "部長", name: "部長", icon: "👑" });
  assert.equal(getMemberRole("Vo.", { "Vo.": "🦊" }).icon, "🎤");
  assert.equal(getMemberRole("部長").icon, "🏷️");
  assert.equal(getMemberRole("部長", { 部長: "invalid" }).icon, "🏷️");
  assert.equal(getMemberRole("toString", {}).icon, "🏷️");
  assert.equal(getMemberRole("__proto__", JSON.parse('{"__proto__":"👑"}')).icon, "👑");
});

test("emoji validation accepts one grapheme including complex sequences and rejects ordinary text", () => {
  for (const icon of ["🎤", "👩🏽‍💼", "👨‍👩‍👧‍👦", "❤️", "🇯🇵", "1️⃣", "#️⃣", "🧑‍🦽‍➡️"]) assert.equal(isMemberRoleIcon(icon), true, icon);
  for (const icon of ["", " ", "test", "🎤🎸", "🎤 🎸", "a🎤", "1", "🇯", "🏽", "<img>", " 🎤 ", "😀".repeat(17), null, 17, {}]) assert.equal(isMemberRoleIcon(icon), false, String(icon));
});

test("member materialization deep copies emoji maps without inventing metadata in old entries", () => {
  const member = { name: "田中", roles: ["部長"], roleIcons: JSON.parse('{"部長":"👑","__proto__":"⭐"}') };
  const result = getSlotMembers({ people: ["田中", "鈴木"], members: [member] });
  assert.notEqual(result[0].roleIcons, member.roleIcons);
  result[0].roleIcons.部長 = "💥";
  assert.equal(member.roleIcons.部長, "👑");
  assert.ok(Object.hasOwn(result[0].roleIcons, "__proto__"));
  assert.ok(!Object.hasOwn(result[1], "roleIcons"));
  assert.deepEqual(result[1], { name: "鈴木", roles: [], roleNotRequired: true });
});
