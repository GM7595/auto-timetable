import { getSlotMembers } from "./member-roles";
import { computeSchedule } from "./planner";
import type { EventState } from "./types";

export interface TimetableExportRow {
  kind: "program" | "changeover" | "wait";
  start: number;
  end: number;
  durationMinutes: number;
  title: string;
  group: string;
  members: string[];
  equipment: string[];
  notes: string;
  locked: boolean;
  slotId: string;
}

export interface TimetableExportData {
  event: Pick<EventState["event"], "name" | "date" | "location" | "startTime" | "endTime">;
  rows: TimetableExportRow[];
  endsAt: number;
}

/** Export the entire saved event, never a filter or an unapplied proposal. */
export function createTimetableExport(state: EventState): TimetableExportData {
  const schedule = computeSchedule(state);
  const rows: TimetableExportRow[] = [];
  schedule.rows.forEach((row, index) => {
    const group = row.group.trim();
    const title = row.title.trim() || group || "名称未設定";
    const preparation = index === 0 ? 0 : Math.max(0, row.changeoverMinutes);
    const preparationEnd = row.changeoverStart + preparation;
    const base = { slotId: row.id, members: [], equipment: [], notes: "", locked: false };
    if (preparation > 0) rows.push({ ...base, kind: "changeover", start: row.changeoverStart, end: preparationEnd, durationMinutes: preparation, title: "転換・準備", group: group || title });
    if (row.waitMinutes > 0) rows.push({ ...base, kind: "wait", start: preparationEnd, end: row.start, durationMinutes: row.waitMinutes, title: "時間調整・待機", group: "" });
    rows.push({
      kind: "program", start: row.start, end: row.end, durationMinutes: row.durationMinutes,
      title, group, slotId: row.id, locked: row.locked,
      // Emoji are decorative in the UI; portable documents retain role labels.
      members: getSlotMembers(row).map(member => member.name + (member.roles.length ? ` (${member.roles.join(" / ")})` : "")),
      equipment: [...row.equipment], notes: row.notes,
    });
  });
  const { name, date, location, startTime, endTime } = state.event;
  return { event: { name, date, location, startTime, endTime }, rows, endsAt: schedule.endsAt };
}
