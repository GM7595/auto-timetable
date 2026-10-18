"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { GripVertical, Plus, Trash2, UserRound, X } from "lucide-react";
import type { SlotMember } from "@/lib/types";
import { formatMemberName, getMemberNameParts, getMemberRole, isMemberRoleIcon, MAX_MEMBERS, MAX_MEMBER_NAME_LENGTH, MAX_MEMBER_ROLE_LENGTH, MAX_MEMBER_ROLES, MEMBER_ROLE_PRESETS } from "@/lib/member-roles";
import { RoleEmojiPicker } from "@/components/role-emoji-picker";

type MemberDrag = {
  source: number;
  target: number;
  active: boolean;
  kind: "pointer" | "keyboard";
  pointerId?: number;
  startX: number;
  startY: number;
  pointerY: number;
  grabOffsetY: number;
  layout: { top: number; height: number }[];
  handle: HTMLButtonElement;
  members: SlotMember[];
  rolesOptional: boolean;
};

export function MemberEditor({ members, onChange, rolesOptional, onRolesOptionalChange }: { members: SlotMember[]; onChange: (members: SlotMember[]) => void; rolesOptional: boolean; onRolesOptionalChange: (optional: boolean) => void }) {
  const id = useId();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [customRole, setCustomRole] = useState("");
  const [customEmoji, setCustomEmoji] = useState("🏷️");
  const [emojiTarget, setEmojiTarget] = useState<{ index: number; role: string | null } | null>(null);
  const [manualEmoji, setManualEmoji] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const emojiTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const handleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const tableFrameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<MemberDrag | null>(null);
  const pendingFocusRef = useRef<number | null>(null);
  const pendingMotionRef = useRef<number[] | null>(null);
  const [drag, setDrag] = useState<MemberDrag | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const canAddMember = members.length < MAX_MEMBERS;
  const missingNames = members.some(member => getMemberNameParts(member).givenName.trim().length === 0);
  const missingRoles = !rolesOptional && members.some(member => member.roles.length === 0);

  useLayoutEffect(() => {
    if (dragRef.current && (dragRef.current.members !== members || dragRef.current.rolesOptional !== rolesOptional)) cancelDrag();
    if (pendingFocusRef.current !== null) {
      handleRefs.current[pendingFocusRef.current]?.focus({ preventScroll: true });
      pendingFocusRef.current = null;
    }
  }, [members, rolesOptional]);
  useLayoutEffect(() => {
    const positions = pendingMotionRef.current;
    if (!positions) return;
    pendingMotionRef.current = null;
    for (let index = 0; index < positions.length; index++) {
      const row = rowRefs.current[index];
      if (!row || row.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) continue;
      const offset = positions[index] - row.getBoundingClientRect().top;
      if (Math.abs(offset) < .5) continue;
      row.animate?.([{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }], { duration: 190, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }, [members, drag]);
  // Closing an expanded palette changes the untransformed row layout. Capture it
  // once after the palette closes; animated row rectangles never drive hit tests.
  useLayoutEffect(() => {
    const current = dragRef.current;
    if (!current?.active || current.members !== members) return;
    const layout = measureRows();
    if (layout.every((row, index) => row.top === current.layout[index]?.top && row.height === current.layout[index]?.height)) return;
    const next = { ...current, layout };
    if (next.kind === "pointer") next.target = pointerTarget(next, next.pointerY);
    dragRef.current = next;
    setDrag(next);
  }, [openIndex, emojiTarget, drag?.active]);
  useLayoutEffect(() => {
    if (!drag?.active || drag.kind !== "pointer") return;
    const document = tableFrameRef.current?.ownerDocument;
    const followScroll = () => {
      const current = dragRef.current;
      if (!current?.active || current.kind !== "pointer" || current.members !== members || current.rolesOptional !== rolesOptional) return;
      const measured = { ...current, layout: measureRows() };
      updateDrag(measured, pointerTarget(measured, measured.pointerY));
    };
    // Scroll does not bubble, so capture ancestor dialog/document scrolling too.
    document?.addEventListener("scroll", followScroll, { capture: true, passive: true });
    return () => document?.removeEventListener("scroll", followScroll, true);
  }, [drag?.active, drag?.kind]);
  useEffect(() => () => { releaseDrag(); }, []);

  function measureRows() {
    return members.map((_, index) => {
      const row = rowRefs.current[index];
      const rect = row?.getBoundingClientRect();
      // offsetTop/offsetHeight stay stable while CSS transforms move the rows.
      const top = row?.offsetParent && typeof row.offsetTop === "number" ? row.offsetParent.getBoundingClientRect().top + row.offsetTop : rect?.top ?? 0;
      return { top, height: row?.offsetHeight || rect?.height || 0 };
    });
  }

  function stopRowMotion() {
    for (const row of rowRefs.current) row?.getAnimations?.().forEach(animation => animation.cancel());
  }

  function rowOffset(current: MemberDrag, index: number) {
    const source = current.layout[current.source];
    const target = current.layout[current.target];
    if (!source || !target || !current.active) return 0;
    if (index === current.source) return current.kind === "pointer" ? current.pointerY - current.grabOffsetY - source.top : current.target < current.source ? target.top - source.top : target.top + target.height - source.top - source.height;
    if (current.source < current.target && index > current.source && index <= current.target) return -source.height;
    if (current.target < current.source && index >= current.target && index < current.source) return source.height;
    return 0;
  }

  function rememberPositions(current: MemberDrag, target = current.source) {
    if (!current.active) return;
    const positions = current.members.map((_, index) => rowRefs.current[index]?.getBoundingClientRect().top ?? current.layout[index]?.top ?? 0);
    const [moved] = positions.splice(current.source, 1);
    positions.splice(target, 0, moved);
    pendingMotionRef.current = positions;
  }

  function newMember(): SlotMember {
    return rolesOptional ? { name: "", familyName: "", givenName: "", roles: [], roleNotRequired: true } : { name: "", familyName: "", givenName: "", roles: [] };
  }

  function copyMember(member: SlotMember, change: Partial<SlotMember> = {}): SlotMember {
    const next = { ...member, ...change };
    const copy = { ...next, roles: [...next.roles] };
    if (next.roleIcons && Object.keys(next.roleIcons).length > 0) copy.roleIcons = { ...next.roleIcons };
    else delete copy.roleIcons;
    return copy;
  }

  function changeMember(index: number, change: Partial<SlotMember>) {
    cancelDrag();
    onChange(members.map((member, memberIndex) => copyMember(member, memberIndex === index ? change : {})));
  }

  function changeNamePart(index: number, part: "familyName" | "givenName", value: string) {
    const parts = { ...getMemberNameParts(members[index]), [part]: value };
    // Keep draft whitespace intact for IME/editing; only the shared display name
    // is normalized here. The parent trims the structured parts when saving.
    changeMember(index, { ...parts, name: formatMemberName(parts) });
  }

  function resetPickers() {
    setOpenIndex(null);
    setCustomRole("");
    setCustomEmoji("🏷️");
    setEmojiTarget(null);
    setManualEmoji("");
  }

  function releaseDrag() {
    const current = dragRef.current;
    dragRef.current = null;
    if (current?.kind === "pointer" && current.pointerId !== undefined && current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    return current;
  }

  function cancelDrag(restoreFocus = false) {
    const current = releaseDrag();
    if (!current) return;
    rememberPositions(current);
    setDrag(null);
    setDragAnnouncement("並び替えをキャンセルしました。");
    if (restoreFocus) current.handle.focus({ preventScroll: true });
  }

  function dragName(current: MemberDrag) {
    const member = current.members[current.source];
    return member && formatMemberName(getMemberNameParts(member)) || `メンバー${current.source + 1}`;
  }

  function updateDrag(current: MemberDrag, target: number, pointerY = current.pointerY) {
    const next = { ...current, active: true, target, pointerY };
    dragRef.current = next;
    setDrag(next);
    if (!current.active || current.target !== target) setDragAnnouncement(`${dragName(current)}の移動先は${target + 1}番目です。離すか Enter キーで確定、Escape キーでキャンセルします。`);
  }

  function moveMember(current: MemberDrag, target: number) {
    if (current.members !== members || current.rolesOptional !== rolesOptional || current.source < 0 || current.source >= members.length || target < 0 || target >= members.length || target === current.source) return;
    const reordered = members.map(member => copyMember(member));
    const [moved] = reordered.splice(current.source, 1);
    reordered.splice(target, 0, moved);
    rememberPositions(current, target);
    resetPickers();
    pendingFocusRef.current = target;
    setDragAnnouncement(`${dragName(current)}を${target + 1}番目に移動しました。`);
    onChange(reordered);
  }

  // Main-row midpoints exclude both the dragged member and any expanded palette rows.
  function pointerTarget(current: MemberDrag, clientY: number) {
    let target = 0;
    for (let index = 0; index < members.length; index++) {
      if (index === current.source) continue;
      const rect = current.layout[index];
      if (rect && clientY >= rect.top + rect.height / 2) target++;
    }
    return Math.min(members.length - 1, target);
  }

  function startPointerDrag(event: PointerEvent<HTMLButtonElement>, index: number) {
    if (members.length < 2 || index < 0 || index >= members.length || event.button !== 0 || !event.isPrimary) return;
    cancelDrag();
    stopRowMotion();
    pendingMotionRef.current = null;
    const layout = measureRows();
    const current: MemberDrag = { source: index, target: index, active: false, kind: "pointer", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, pointerY: event.clientY, grabOffsetY: event.clientY - layout[index].top, layout, handle: event.currentTarget, members, rolesOptional };
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = current;
    setDrag(current);
  }

  function movePointerDrag(event: PointerEvent<HTMLButtonElement>) {
    const captured = dragRef.current;
    if (!captured || captured.kind !== "pointer" || captured.pointerId !== event.pointerId) return;
    if (captured.members !== members || captured.rolesOptional !== rolesOptional) { cancelDrag(); return; }
    const current = { ...captured, layout: measureRows() };
    if (!current.active && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return;
    event.preventDefault();
    if (!current.active) resetPickers();
    updateDrag(current, pointerTarget(current, event.clientY), event.clientY);
  }

  function endPointerDrag(event: PointerEvent<HTMLButtonElement>) {
    const captured = dragRef.current;
    if (!captured || captured.kind !== "pointer" || captured.pointerId !== event.pointerId) return;
    const current = { ...captured, layout: measureRows() };
    const frame = tableFrameRef.current;
    const rect = frame?.getBoundingClientRect();
    const inside = rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const hit = frame?.ownerDocument.elementFromPoint(event.clientX, event.clientY);
    if (!current.active || !inside || !hit || !frame?.contains(hit)) { cancelDrag(); return; }
    event.preventDefault();
    const target = pointerTarget(current, event.clientY);
    if (target === current.source) rememberPositions(current);
    releaseDrag();
    setDrag(null);
    moveMember(current, target);
  }

  function keyDrag(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const current = dragRef.current;
    if (event.key === "Escape" && current) {
      event.preventDefault(); event.stopPropagation(); cancelDrag(true); return;
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || members.length < 2) return;
      if (current?.kind === "keyboard" && current.source === index) {
        if (current.target === current.source) rememberPositions(current);
        releaseDrag(); setDrag(null); moveMember(current, current.target);
      } else {
        cancelDrag(); resetPickers();
        stopRowMotion();
        pendingMotionRef.current = null;
        const next: MemberDrag = { source: index, target: index, active: true, kind: "keyboard", startX: 0, startY: 0, pointerY: 0, grabOffsetY: 0, layout: measureRows(), handle: event.currentTarget, members, rolesOptional };
        dragRef.current = next;
        setDrag(next);
        setDragAnnouncement(`${dragName(next)}をつかみました。上下矢印キーで移動先を選び、Enter キーで確定します。`);
      }
      return;
    }
    if (!current || current.kind !== "keyboard" || current.source !== index || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.key === "Home" ? 0 : event.key === "End" ? members.length - 1 : Math.max(0, Math.min(members.length - 1, current.target + (event.key === "ArrowUp" ? -1 : 1)));
    updateDrag(current, target);
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
    if (dragRef.current) { event.preventDefault(); event.stopPropagation(); cancelDrag(true); }
    else if (emojiTarget !== null) { event.preventDefault(); event.stopPropagation(); closeEmojiPicker(); }
    else if (openIndex !== null) { event.preventDefault(); event.stopPropagation(); closePicker(); }
  }}>
    <legend>メンバー</legend>
    <div className="member-editor-toolbar">
      <p className="member-editor-hint">{members.length > 1 && <><GripVertical size={13} aria-hidden="true" />ドラッグで並び替え</>}</p>
      <label className="member-role-optional" htmlFor={`${id}-no-roles`}>
        <input id={`${id}-no-roles`} type="checkbox" role="switch" aria-label="全メンバーの役職なし" checked={rolesOptional} onChange={event => {
          cancelDrag();
          resetPickers();
          onRolesOptionalChange(event.target.checked);
        }} />
        <span>役職なし</span>
      </label>
    </div>
    <p className="visually-hidden" id={`${id}-drag-instructions`}>ドラッグして並び替えます。キーボードでは Space または Enter キーでつかみ、上下矢印キーで移動、Space または Enter キーで確定、Escape キーでキャンセルします。</p>
    <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{dragAnnouncement}</span>
    {members.length > 0 && <div className="member-editor-table-frame" ref={tableFrameRef} data-dragging={drag?.active || undefined}>
      <table className={`member-editor-table${rolesOptional ? " member-editor-table-no-roles" : ""}`}>
        <caption className="visually-hidden">メンバーと楽器・役職</caption>
        <colgroup><col className="member-editor-name-column" />{!rolesOptional && <col />}<col className="member-editor-action-column" /></colgroup>
        <thead><tr><th scope="col">姓・名 <span className={`required${missingNames ? " required-missing" : ""}`}>名は必須</span></th>{!rolesOptional && <th scope="col">楽器・役職 <span className={`required${missingRoles ? " required-missing" : ""}`}>必須</span></th>}<th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>{members.map((member, index) => {
          const nameParts = getMemberNameParts(member);
          return <Fragment key={index}>
        <tr ref={node => { rowRefs.current[index] = node; }} className={`member-editor-row${drag?.active && drag.source === index ? " member-editor-row-dragging" : ""}`} style={drag?.active ? { transform: `translateY(${rowOffset(drag, index)}px)` } : undefined} data-drag-kind={drag?.active && drag.source === index ? drag.kind : undefined} data-drop-position={drag?.active && drag.target !== drag.source && drag.target === index ? drag.target < drag.source ? "before" : "after" : undefined}>
          <td><div className="member-editor-name-row">
          <button ref={node => { handleRefs.current[index] = node; }} className="icon-button member-editor-drag-handle" type="button" aria-label={`メンバー${index + 1}をドラッグして並び替え`} title="ドラッグして並び替え" aria-describedby={`${id}-drag-instructions`} aria-pressed={drag?.active && drag.source === index || false} disabled={members.length < 2} onPointerDown={event => startPointerDrag(event, index)} onPointerMove={movePointerDrag} onPointerUp={endPointerDrag} onPointerCancel={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag(); }} onLostPointerCapture={event => { if (dragRef.current?.pointerId === event.pointerId) cancelDrag(); }} onBlur={() => { if (dragRef.current?.kind === "keyboard") cancelDrag(); }} onKeyDown={event => keyDrag(event, index)}><GripVertical size={15} aria-hidden="true" /></button>
          <UserRound size={15} aria-hidden="true" />
          <div className="member-editor-name-fields">
            <label className="visually-hidden" htmlFor={`${id}-family-name-${index}`}>メンバー{index + 1}の姓</label>
            <input id={`${id}-family-name-${index}`} aria-label={`メンバー${index + 1}の姓`} aria-invalid={false} value={nameParts.familyName} maxLength={MAX_MEMBER_NAME_LENGTH} placeholder="姓" onChange={event => changeNamePart(index, "familyName", event.target.value)} />
            <label className="visually-hidden" htmlFor={`${id}-given-name-${index}`}>メンバー{index + 1}の名</label>
            <input id={`${id}-given-name-${index}`} aria-label={`メンバー${index + 1}の名`} required aria-invalid={nameParts.givenName.trim().length === 0} value={nameParts.givenName} maxLength={MAX_MEMBER_NAME_LENGTH} placeholder="名" onChange={event => changeNamePart(index, "givenName", event.target.value)} />
          </div>
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
          <button type="button" className="member-role-picker-toggle" aria-label={`メンバー${index + 1}の楽器・役職を選ぶ`} aria-invalid={member.roles.length === 0} aria-expanded={openIndex === index} aria-controls={`${id}-roles-${index}`} onClick={event => {
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
          <button className="icon-button member-editor-remove" type="button" aria-label={`メンバー${index + 1}を削除`} title="メンバーを削除" onClick={() => {
            cancelDrag();
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
            <RoleEmojiPicker selected={emojiTarget.role === null ? customEmoji : getMemberRole(emojiTarget.role, member.roleIcons).icon} onSelect={chooseEmoji} />
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
      </Fragment>;
      })}</tbody>
      </table>
    </div>}
    <button className="text-button member-editor-add" type="button" disabled={!canAddMember} title={!canAddMember ? `メンバーは${MAX_MEMBERS}人までです。` : undefined} onClick={() => {
      if (!canAddMember) return;
      cancelDrag();
      onChange([...members.map(member => copyMember(member)), newMember()]);
    }}><Plus size={14} aria-hidden="true" />メンバーを追加</button>
    {members.length >= MAX_MEMBERS && <p className="member-role-limit">メンバーは{MAX_MEMBERS}人までです。</p>}
  </fieldset>;
}
