"use client";

import { useId, useRef, useState } from "react";
import { Plus, Trash2, UserRound, X } from "lucide-react";
import type { SlotMember } from "@/lib/types";
import { getMemberRole, MAX_MEMBERS, MAX_MEMBER_NAME_LENGTH, MAX_MEMBER_ROLE_LENGTH, MAX_MEMBER_ROLES, MEMBER_ROLE_PRESETS } from "@/lib/member-roles";

export function MemberEditor({ members, onChange }: { members: SlotMember[]; onChange: (members: SlotMember[]) => void }) {
  const id = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [customRole, setCustomRole] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const canAddMember = members.length < MAX_MEMBERS && members.every(member => member.name.trim().length > 0 && (member.roles.length > 0 || member.roleNotRequired === true));

  function changeMember(index: number, change: Partial<SlotMember>) {
    onChange(members.map((member, memberIndex) => ({
      ...member,
      ...memberIndex === index ? change : {},
      roles: [...(memberIndex === index ? change.roles ?? member.roles : member.roles)],
    })));
  }

  function toggleRole(index: number, role: string) {
    const member = members[index];
    if (!member || member.roleNotRequired) return;
    if (member.roles.includes(role)) changeMember(index, { roles: member.roles.filter(selected => selected !== role) });
    else if (member.roles.length < MAX_MEMBER_ROLES) changeMember(index, { roles: [...member.roles, role] });
  }

  function normalizedCustomRole() {
    const trimmed = customRole.trim();
    return MEMBER_ROLE_PRESETS.find(preset => preset.label.toLowerCase() === trimmed.toLowerCase())?.label ?? trimmed;
  }

  function canAddCustom(index: number) {
    const role = normalizedCustomRole();
    const member = members[index];
    return !!member && !member.roleNotRequired && role.length > 0 && role.length <= MAX_MEMBER_ROLE_LENGTH && member.roles.length < MAX_MEMBER_ROLES && !member.roles.some(selected => selected.trim().toLowerCase() === role.toLowerCase());
  }

  function addCustom(index: number) {
    if (!canAddCustom(index)) return;
    changeMember(index, { roles: [...members[index].roles, normalizedCustomRole()] });
    setCustomRole("");
  }

  function closePicker() {
    setOpenIndex(null);
    setCustomRole("");
    triggerRef.current?.focus();
  }

  return <fieldset className="member-editor" onKeyDown={event => {
    if (event.key === "Escape" && openIndex !== null) { event.preventDefault(); event.stopPropagation(); closePicker(); }
  }}>
    <legend>メンバー</legend>
    <p className="member-editor-hint">名前と楽器・役職を入力すると、次のメンバーを追加できます。</p>
    {members.length > 0 && <ol className="member-editor-list">
      {members.map((member, index) => <li className="member-editor-row" key={index}>
        <div className="member-editor-name-row">
          <UserRound size={15} aria-hidden="true" />
          <label className="visually-hidden" htmlFor={`${id}-name-${index}`}>メンバー{index + 1}の名前</label>
          <input id={`${id}-name-${index}`} aria-label={`メンバー${index + 1}の名前`} value={member.name} maxLength={MAX_MEMBER_NAME_LENGTH} placeholder="名前" onChange={event => changeMember(index, { name: event.target.value })} />
          <button className="icon-button member-editor-remove" type="button" aria-label={`メンバー${index + 1}を削除`} title="メンバーを削除" onClick={() => {
            onChange(members.filter((_, memberIndex) => memberIndex !== index).map(remaining => ({ ...remaining, roles: [...remaining.roles] })));
            if (openIndex === index) { setOpenIndex(null); setCustomRole(""); }
            else if (openIndex !== null && openIndex > index) setOpenIndex(openIndex - 1);
          }}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
        <label className="member-role-optional" htmlFor={`${id}-no-role-${index}`}>
          <input id={`${id}-no-role-${index}`} type="checkbox" role="switch" aria-label={`メンバー${index + 1}は役職なし`} checked={member.roleNotRequired === true} onChange={event => {
            if (event.target.checked) {
              changeMember(index, { roles: [], roleNotRequired: true });
              if (openIndex === index) { setOpenIndex(null); setCustomRole(""); }
            } else changeMember(index, { roleNotRequired: undefined });
          }} />
          <span>役職なし</span>
        </label>
        <div className="member-editor-roles">
          {member.roles.map(role => {
            const definition = getMemberRole(role);
            return <button key={role} className="member-role-chip" type="button" aria-label={`${definition.name}${definition.label !== definition.name ? `（${definition.label}）` : ""}を外す`} title={`${definition.name}を外す`} disabled={member.roleNotRequired === true} onClick={() => toggleRole(index, role)}><span aria-hidden="true">{definition.icon}</span><span>{definition.label}</span><X size={11} aria-hidden="true" /></button>;
          })}
          <button type="button" className="member-role-picker-toggle" aria-label={`メンバー${index + 1}の楽器・役職を選ぶ`} aria-expanded={openIndex === index && !member.roleNotRequired} aria-controls={`${id}-roles-${index}`} disabled={member.roleNotRequired === true} onClick={event => {
            if (member.roleNotRequired) return;
            triggerRef.current = event.currentTarget;
            setOpenIndex(openIndex === index ? null : index);
            setCustomRole("");
          }}><Plus size={13} aria-hidden="true" />楽器・役職</button>
        </div>
        {openIndex === index && !member.roleNotRequired && <div className="member-role-picker" id={`${id}-roles-${index}`}>
          <div className="member-role-presets" role="group" aria-label={`メンバー${index + 1}の楽器`}>
            {MEMBER_ROLE_PRESETS.map(role => <button type="button" key={role.label} className="member-role-option" aria-label={`${role.name}（${role.label}）`} title={`${role.name}（${role.label}）`} data-tooltip={role.name} aria-pressed={member.roles.includes(role.label)} disabled={member.roles.length >= MAX_MEMBER_ROLES && !member.roles.includes(role.label)} onClick={() => toggleRole(index, role.label)}><span aria-hidden="true">{role.icon}</span><span aria-hidden="true">{role.label}</span></button>)}
          </div>
          <div className="member-role-custom">
            <label className="visually-hidden" htmlFor={`${id}-custom-${index}`}>メンバー{index + 1}のカスタム役職</label>
            <input id={`${id}-custom-${index}`} aria-label={`メンバー${index + 1}のカスタム役職`} value={customRole} maxLength={MAX_MEMBER_ROLE_LENGTH} placeholder="カスタム役職（例：部長）" onChange={event => setCustomRole(event.target.value)} onKeyDown={event => {
              if (event.key !== "Enter") return;
              event.stopPropagation();
              // Leave Japanese IME confirmation intact, but never treat it as an add shortcut.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              addCustom(index);
            }} />
            <button className="button small" type="button" aria-label={`メンバー${index + 1}にカスタム役職を追加`} disabled={!canAddCustom(index)} onClick={() => addCustom(index)}>追加</button>
          </div>
          {member.roles.length >= MAX_MEMBER_ROLES && <p className="member-role-limit">役職は1人につき{MAX_MEMBER_ROLES}個までです。</p>}
        </div>}
      </li>)}
    </ol>}
    {members.length === 0 ? <button className="text-button member-editor-start" type="button" onClick={() => onChange([{ name: "", roles: [] }])}><Plus size={14} aria-hidden="true" />メンバー入力を始める</button> : <button className="text-button member-editor-add" type="button" disabled={!canAddMember} onClick={() => {
      if (!canAddMember) return;
      onChange([...members.map(member => ({ ...member, roles: [...member.roles] })), { name: "", roles: [] }]);
    }}><Plus size={14} aria-hidden="true" />メンバーを追加</button>}
    {members.length >= MAX_MEMBERS && <p className="member-role-limit">メンバーは{MAX_MEMBERS}人までです。</p>}
  </fieldset>;
}
