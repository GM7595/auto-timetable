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

export function getMemberRole(role: string): { label: string; name: string; icon: string } {
  return MEMBER_ROLE_PRESETS.find(preset => preset.label === role) ?? { label: role, name: role, icon: "🏷️" };
}

/** people remains the canonical participation list, including legacy name-only entries. */
export function getSlotMembers(slot: Pick<EventSlot, "people" | "members">): SlotMember[] {
  return slot.people.map(name => {
    const stored = slot.members?.find(member => member.name === name);
    return {
      ...(stored ?? { roleNotRequired: true }),
      name,
      roles: [...(stored?.roles ?? [])],
    };
  });
}
