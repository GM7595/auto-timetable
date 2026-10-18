import type { EventSlot, SlotMember } from "@/lib/types";

/** Labels are persisted as role identifiers. Add presets here without changing saved members. */
export const MEMBER_ROLE_PRESETS = [
  { label: "Vo.", name: "ボーカル", icon: "🎤" },
  { label: "Gt.", name: "ギター", icon: "🎸" },
  { label: "Ba.", name: "ベース", icon: "🎸" },
  { label: "Key.", name: "キーボード", icon: "🎹" },
  { label: "Dr.", name: "ドラム", icon: "🥁" },
] as const;

export const MAX_MEMBERS = 30;
export const MAX_MEMBER_ROLES = 12;
export const MAX_MEMBER_NAME_LENGTH = 160;
export const MAX_MEMBER_ROLE_LENGTH = 40;

/** Preserve legacy names whole; never guess where a surname or stage name ends. */
export function getMemberNameParts(member: SlotMember): { familyName: string; givenName: string } {
  if (member.familyName === undefined && member.givenName === undefined) return { familyName: "", givenName: member.name };
  return { familyName: member.familyName ?? "", givenName: member.givenName ?? "" };
}

/** The canonical participation name for explicitly entered name parts. */
export function formatMemberName(parts: { familyName: string; givenName: string }): string {
  return [parts.familyName.trim(), parts.givenName.trim()].filter(Boolean).join(" ");
}

/** One emoji grapheme, including modifiers, ZWJ sequences, flags, and keycaps. */
export function isMemberRoleIcon(value: string): boolean {
  if (typeof value !== "string" || !value || value.length > 32 || value !== value.trim()) return false;
  if (Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)).length !== 1) return false;
  return /^[#*0-9]\uFE0F?\u20E3$/u.test(value)
    || /^\p{Regional_Indicator}{2}$/u.test(value)
    || /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}]*$/u.test(value);
}

export function getMemberRole(role: string, roleIcons?: Record<string, string>): { label: string; name: string; icon: string } {
  const preset = MEMBER_ROLE_PRESETS.find(preset => preset.label === role);
  if (preset) return preset;
  const icon = roleIcons && Object.hasOwn(roleIcons, role) ? roleIcons[role] : undefined;
  return { label: role, name: role, icon: icon && isMemberRoleIcon(icon) ? icon : "🏷️" };
}

/** people remains the canonical participation list, including legacy name-only entries. */
export function getSlotMembers(slot: Pick<EventSlot, "people" | "members">): SlotMember[] {
  return slot.people.map(name => {
    const stored = slot.members?.find(member => member.name === name);
    return {
      ...(stored ?? { roleNotRequired: true }),
      name,
      roles: [...(stored?.roles ?? [])],
      ...(stored?.roleIcons ? { roleIcons: { ...stored.roleIcons } } : {}),
    };
  });
}
