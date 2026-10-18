"use client";

import { Fragment, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, UserRound, X } from "lucide-react";
import type { SlotMember } from "@/lib/types";
import { getMemberRole, isMemberRoleIcon, MAX_MEMBERS, MAX_MEMBER_NAME_LENGTH, MAX_MEMBER_ROLE_LENGTH, MAX_MEMBER_ROLES, MEMBER_ROLE_PRESETS } from "@/lib/member-roles";

const ROLE_EMOJI_OPTIONS = [
  ["🏷️", "タグ"], ["👑", "リーダー"], ["🎤", "マイク"], ["🎙️", "司会"], ["🎸", "ギター"], ["🎹", "キーボード"],
  ["🥁", "ドラム"], ["🎺", "トランペット"], ["🎷", "サックス"], ["🎻", "バイオリン"], ["🪕", "バンジョー"], ["🪈", "フルート"],
  ["🪇", "マラカス"], ["🎼", "楽譜"], ["🎵", "音符"], ["🎧", "ヘッドホン"], ["🎛️", "音響"], ["💡", "照明"],
  ["🎬", "映像"], ["📷", "写真"], ["🎥", "撮影"], ["🖌️", "デザイン"], ["💻", "パソコン"], ["📋", "進行"],
  ["📣", "広報"], ["💼", "運営"], ["🛠️", "技術"], ["🧑‍💼", "担当者"], ["🤝", "調整"], ["🛡️", "安全"],
  ["💰", "会計"], ["🎫", "受付"], ["🍽️", "飲食"], ["🧹", "清掃"], ["⭐", "星"], ["❤️", "ハート"],
] as const;

export function MemberEditor({ members, onChange, rolesOptional, onRolesOptionalChange }: { members: SlotMember[]; onChange: (members: SlotMember[]) => void; rolesOptional: boolean; onRolesOptionalChange: (optional: boolean) => void }) {
  const id = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [customRole, setCustomRole] = useState("");
  const [customEmoji, setCustomEmoji] = useState("🏷️");
  const [emojiTarget, setEmojiTarget] = useState<{ index: number; role: string | null } | null>(null);
  const [manualEmoji, setManualEmoji] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement | null>(null);
  const canAddMember = members.length < MAX_MEMBERS;
  const incompleteIndex = members.findIndex(member => member.name.trim().length === 0 || (!rolesOptional && member.roles.length === 0));
  const incompleteMessage = incompleteIndex < 0 ? "" : members[incompleteIndex].name.trim().length === 0 ? `保存するには${incompleteIndex + 1}人目の名前を入力してください。` : `保存するには${incompleteIndex + 1}人目の楽器・役職を選んでください（不要なら「役職なし」をオン）。`;

  function newMember(): SlotMember {
    return rolesOptional ? { name: "", roles: [], roleNotRequired: true } : { name: "", roles: [] };
  }

  function copyMember(member: SlotMember, change: Partial<SlotMember> = {}): SlotMember {
    const next = { ...member, ...change };
    const copy = { ...next, roles: [...next.roles] };
    if (next.roleIcons && Object.keys(next.roleIcons).length > 0) copy.roleIcons = { ...next.roleIcons };
    else delete copy.roleIcons;
    return copy;
  }

  function changeMember(index: number, change: Partial<SlotMember>) {
    onChange(members.map((member, memberIndex) => copyMember(member, memberIndex === index ? change : {})));
  }

  function resetPickers() {
    setOpenIndex(null);
    setCustomRole("");
    setCustomEmoji("🏷️");
    setEmojiTarget(null);
    setManualEmoji("");
  }

  function moveMember(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (index < 0 || index >= members.length || target < 0 || target >= members.length) return;
    const reordered = members.map(member => copyMember(member));
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    resetPickers();
    onChange(reordered);
  }

  function toggleRole(index: number, role: string) {
    const member = members[index];
    if (!member || rolesOptional) return;
    if (member.roles.includes(role)) {
      const roleIcons = { ...member.roleIcons };
      delete roleIcons[role];
      changeMember(index, { roles: member.roles.filter(selected => selected !== role), roleIcons });
      if (emojiTarget?.index === index && emojiTarget.role === role) closeEmojiPicker();
    }
    else if (member.roles.length < MAX_MEMBER_ROLES) changeMember(index, { roles: [...member.roles, role] });
  }

  function normalizedCustomRole() {
    const trimmed = customRole.trim();
    return MEMBER_ROLE_PRESETS.find(preset => preset.label.toLowerCase() === trimmed.toLowerCase())?.label ?? trimmed;
  }

  function canAddCustom(index: number) {
    const role = normalizedCustomRole();
    const member = members[index];
    return !!member && !rolesOptional && role.length > 0 && role.length <= MAX_MEMBER_ROLE_LENGTH && member.roles.length < MAX_MEMBER_ROLES && !member.roles.some(selected => selected.trim().toLowerCase() === role.toLowerCase());
  }

  function addCustom(index: number) {
    if (!canAddCustom(index)) return;
    const role = normalizedCustomRole();
    const roleIcons = !MEMBER_ROLE_PRESETS.some(preset => preset.label === role) && customEmoji !== "🏷️" ? { ...members[index].roleIcons, [role]: customEmoji } : { ...members[index].roleIcons };
    changeMember(index, { roles: [...members[index].roles, role], roleIcons });
    setCustomRole("");
    setCustomEmoji("🏷️");
    setEmojiTarget(null);
    setManualEmoji("");
  }

  function closeEmojiPicker() {
    setEmojiTarget(null);
    setManualEmoji("");
    emojiTriggerRef.current?.focus();
  }

  function chooseEmoji(icon: string) {
    if (!emojiTarget || rolesOptional || !isMemberRoleIcon(icon)) return;
    if (emojiTarget.role === null) setCustomEmoji(icon);
    else {
      const member = members[emojiTarget.index];
      if (!member?.roles.includes(emojiTarget.role) || MEMBER_ROLE_PRESETS.some(preset => preset.label === emojiTarget.role)) return;
      let roleIcons = { ...member.roleIcons };
      if (icon === "🏷️") delete roleIcons[emojiTarget.role];
      else roleIcons = { ...roleIcons, [emojiTarget.role]: icon };
      changeMember(emojiTarget.index, { roleIcons });
    }
    closeEmojiPicker();
  }

  function openEmojiPicker(index: number, role: string | null, button: HTMLButtonElement) {
    if (openIndex !== null && openIndex !== index) {
      setOpenIndex(null);
      setCustomRole("");
      setCustomEmoji("🏷️");
    }
    emojiTriggerRef.current = button;
    setEmojiTarget(emojiTarget?.index === index && emojiTarget.role === role ? null : { index, role });
    setManualEmoji("");
  }

  function closePicker() {
    resetPickers();
    triggerRef.current?.focus();
  }

  return <fieldset className="member-editor" onKeyDown={event => {
    if (event.key !== "Escape") return;
    if (emojiTarget !== null) { event.preventDefault(); event.stopPropagation(); closeEmojiPicker(); }
    else if (openIndex !== null) { event.preventDefault(); event.stopPropagation(); closePicker(); }
  }}>
    <legend>メンバー</legend>
    <div className="member-editor-toolbar">
      <p className="member-editor-hint">{rolesOptional ? "保存には全メンバーの名前が必要です。" : "保存には全メンバーの名前と楽器・役職が必要です。"}</p>
      <label className="member-role-optional" htmlFor={`${id}-no-roles`}>
        <input id={`${id}-no-roles`} type="checkbox" role="switch" aria-label="全メンバーの役職なし" checked={rolesOptional} onChange={event => {
          resetPickers();
          onRolesOptionalChange(event.target.checked);
        }} />
        <span>役職なし</span>
      </label>
    </div>
    {members.length > 0 && <div className="member-editor-table-frame">
      <table className={`member-editor-table${rolesOptional ? " member-editor-table-no-roles" : ""}`}>
        <caption className="visually-hidden">メンバーと楽器・役職</caption>
        <colgroup><col className="member-editor-name-column" />{!rolesOptional && <col />}<col className="member-editor-action-column" /></colgroup>
        <thead><tr><th scope="col">名前</th>{!rolesOptional && <th scope="col">楽器・役職</th>}<th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>{members.map((member, index) => <Fragment key={index}>
        <tr className="member-editor-row">
          <td><div className="member-editor-name-row">
          <UserRound size={15} aria-hidden="true" />
          <label className="visually-hidden" htmlFor={`${id}-name-${index}`}>メンバー{index + 1}の名前</label>
          <input id={`${id}-name-${index}`} aria-label={`メンバー${index + 1}の名前`} value={member.name} maxLength={MAX_MEMBER_NAME_LENGTH} placeholder="名前" onChange={event => changeMember(index, { name: event.target.value })} />
          </div></td>
          {!rolesOptional && <td><div className="member-editor-roles">
          {member.roles.map(role => {
            const definition = getMemberRole(role, member.roleIcons);
            if (!MEMBER_ROLE_PRESETS.some(preset => preset.label === role)) return <span key={role} className="member-role-chip member-role-custom-chip">
              <button className="member-role-chip-emoji" type="button" aria-label={`メンバー${index + 1}の「${role}」の絵文字を選ぶ`} title={`${role}の絵文字を選ぶ`} aria-expanded={emojiTarget?.index === index && emojiTarget.role === role} aria-controls={`${id}-emoji-${index}`} onClick={event => openEmojiPicker(index, role, event.currentTarget)}><span aria-hidden="true">{definition.icon}</span></button>
              <button className="member-role-chip-remove" type="button" aria-label={`${role}を外す`} title={`${role}を外す`} onClick={() => toggleRole(index, role)}><span>{role}</span><X size={11} aria-hidden="true" /></button>
            </span>;
            return <button key={role} className="member-role-chip" type="button" aria-label={`${definition.name}${definition.label !== definition.name ? `（${definition.label}）` : ""}を外す`} title={`${definition.name}を外す`} onClick={() => toggleRole(index, role)}><span aria-hidden="true">{definition.icon}</span><span>{definition.label}</span><X size={11} aria-hidden="true" /></button>;
          })}
          <button type="button" className="member-role-picker-toggle" aria-label={`メンバー${index + 1}の楽器・役職を選ぶ`} aria-expanded={openIndex === index} aria-controls={`${id}-roles-${index}`} onClick={event => {
            if (rolesOptional) return;
            triggerRef.current = event.currentTarget;
            setOpenIndex(openIndex === index ? null : index);
            setCustomRole("");
            setCustomEmoji("🏷️");
            setEmojiTarget(null);
            setManualEmoji("");
          }}><Plus size={13} aria-hidden="true" />楽器・役職</button>
          </div></td>}
          <td className="member-editor-action-cell"><div className="member-editor-actions">
          <div className="member-editor-reorder">
            <button className="icon-button member-editor-move" type="button" aria-label={`メンバー${index + 1}を上へ`} title="上へ移動" disabled={index === 0} onClick={() => moveMember(index, -1)}><ArrowUp size={13} aria-hidden="true" /></button>
            <button className="icon-button member-editor-move" type="button" aria-label={`メンバー${index + 1}を下へ`} title="下へ移動" disabled={index === members.length - 1} onClick={() => moveMember(index, 1)}><ArrowDown size={13} aria-hidden="true" /></button>
          </div>
          <button className="icon-button member-editor-remove" type="button" aria-label={`メンバー${index + 1}を削除`} title="メンバーを削除" onClick={() => {
            onChange(members.filter((_, memberIndex) => memberIndex !== index).map(remaining => copyMember(remaining)));
            setEmojiTarget(null);
            setManualEmoji("");
            if (openIndex === index) { setOpenIndex(null); setCustomRole(""); setCustomEmoji("🏷️"); }
            else if (openIndex !== null && openIndex > index) setOpenIndex(openIndex - 1);
          }}><Trash2 size={15} aria-hidden="true" /></button>
          </div></td>
        </tr>
        {(openIndex === index || emojiTarget?.index === index) && !rolesOptional && <tr className="member-editor-picker-row"><td colSpan={3}><div className="member-role-picker" id={`${id}-roles-${index}`}>
          {openIndex === index && <><div className="member-role-presets" role="group" aria-label={`メンバー${index + 1}の楽器`}>
            {MEMBER_ROLE_PRESETS.map(role => <button type="button" key={role.label} className="member-role-option" aria-label={`${role.name}（${role.label}）`} title={`${role.name}（${role.label}）`} data-tooltip={role.name} aria-pressed={member.roles.includes(role.label)} disabled={member.roles.length >= MAX_MEMBER_ROLES && !member.roles.includes(role.label)} onClick={() => toggleRole(index, role.label)}><span aria-hidden="true">{role.icon}</span><span aria-hidden="true">{role.label}</span></button>)}
          </div>
          <div className="member-role-custom">
            <button className="member-role-emoji-toggle" type="button" aria-label={`メンバー${index + 1}のカスタム役職の絵文字を選ぶ`} title="カスタム役職の絵文字を選ぶ" aria-expanded={emojiTarget?.index === index && emojiTarget.role === null} aria-controls={`${id}-emoji-${index}`} onClick={event => openEmojiPicker(index, null, event.currentTarget)}><span aria-hidden="true">{customEmoji}</span></button>
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
          </div></>}
          {emojiTarget?.index === index && <div className="member-role-emoji-picker" id={`${id}-emoji-${index}`} role="group" aria-label={emojiTarget.role === null ? "カスタム役職の絵文字" : `${emojiTarget.role}の絵文字`}>
            <p className="member-role-emoji-heading">{emojiTarget.role === null ? "絵文字を選択" : `${emojiTarget.role}の絵文字`}</p>
            <div className="member-role-emoji-options">
              {ROLE_EMOJI_OPTIONS.map(([icon, name]) => <button type="button" className="member-role-emoji-option" key={icon} aria-label={`${name}の絵文字`} title={name} aria-pressed={(emojiTarget.role === null ? customEmoji : getMemberRole(emojiTarget.role, member.roleIcons).icon) === icon} onClick={() => chooseEmoji(icon)}><span aria-hidden="true">{icon}</span></button>)}
            </div>
            <div className="member-role-emoji-manual">
              <label className="visually-hidden" htmlFor={`${id}-manual-emoji-${index}`}>その他の絵文字</label>
              <input id={`${id}-manual-emoji-${index}`} aria-label="その他の絵文字" value={manualEmoji} maxLength={32} placeholder="その他の絵文字を入力" aria-invalid={manualEmoji.length > 0 && !isMemberRoleIcon(manualEmoji.trim())} onChange={event => setManualEmoji(event.target.value)} onKeyDown={event => {
                if (event.key !== "Enter") return;
                event.stopPropagation();
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                chooseEmoji(manualEmoji.trim());
              }} />
              <button className="button small" type="button" disabled={!isMemberRoleIcon(manualEmoji.trim())} onClick={() => chooseEmoji(manualEmoji.trim())}>使う</button>
            </div>
            {manualEmoji.length > 0 && !isMemberRoleIcon(manualEmoji.trim()) && <p className="member-role-limit">絵文字を1つ入力してください。</p>}
          </div>}
          {member.roles.length >= MAX_MEMBER_ROLES && <p className="member-role-limit">役職は1人につき{MAX_MEMBER_ROLES}個までです。</p>}
        </div></td></tr>}
      </Fragment>)}</tbody>
      </table>
    </div>}
    <button className="text-button member-editor-add" type="button" disabled={!canAddMember} title={!canAddMember ? `メンバーは${MAX_MEMBERS}人までです。` : undefined} onClick={() => {
      if (!canAddMember) return;
      onChange([...members.map(member => copyMember(member)), newMember()]);
    }}><Plus size={14} aria-hidden="true" />メンバーを追加</button>
    {incompleteIndex >= 0 && <p className="member-role-limit" id={`${id}-incomplete`} aria-live="polite">{incompleteMessage}</p>}
    {members.length >= MAX_MEMBERS && <p className="member-role-limit">メンバーは{MAX_MEMBERS}人までです。</p>}
  </fieldset>;
}
