import type { EventState, Schedule, ScheduledSlot } from "./types";

export interface EventTiming {
  phase: "upcoming" | "active" | "finished" | "empty";
  label: string;
  activeSlotId?: string;
  nextSlotId?: string;
  interval?: "program" | "changeover" | "waiting";
  /** Epoch milliseconds, based on the event date in Asia/Tokyo. */
  startsAt?: number;
  /** Epoch milliseconds, based on the event date in Asia/Tokyo. */
  endsAt?: number;
}

const MINUTE_MS = 60_000;
const JAPAN_OFFSET_MS = 9 * 60 * MINUTE_MS;

/** Do not let the viewer's device time zone change the event's calendar date. */
function eventMidnight(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const midnight = Date.parse(`${date}T00:00:00+09:00`);
  // Date.parse normalizes some invalid dates (for example, February 30).
  if (!Number.isFinite(midnight) || new Date(midnight + JAPAN_OFFSET_MS).toISOString().slice(0, 10) !== date) return Number.NaN;
  return midnight;
}

function hasValidInterval(row: ScheduledSlot): boolean {
  return Number.isFinite(row.start) && Number.isFinite(row.end) && row.end > row.start;
}

function statusAt(row: ScheduledSlot, midnight: number, now: number): ScheduledSlot["status"] {
  if (!Number.isFinite(midnight) || !Number.isFinite(now) || !hasValidInterval(row)) return "planned";
  const start = midnight + row.start * MINUTE_MS;
  const end = midnight + row.end * MINUTE_MS;
  return now >= end ? "done" : now >= start ? "active" : "planned";
}

/**
 * A display-only projection. Stored progress and fixed-start anchors are never
 * changed by a clock tick, nor is the timetable recalculated by this helper.
 * Minute offsets intentionally may exceed 24 hours for overnight events.
 */
export function getTimedSchedule(state: EventState, schedule: Schedule, now: number): Schedule {
  const midnight = eventMidnight(state.event.date);
  return { ...schedule, rows: schedule.rows.map(row => ({ ...row, status: statusAt(row, midnight, now) })) };
}

/** Planned-time progress, not a claim that performers actually started on time. */
export function getEventTiming(state: EventState, schedule: Schedule, now: number): EventTiming {
  const midnight = eventMidnight(state.event.date);
  const validRows = schedule.rows.filter(hasValidInterval);
  if (!validRows.length) return { phase: "empty", label: "予定なし" };
  if (!Number.isFinite(midnight) || !Number.isFinite(now)) return { phase: "upcoming", label: "日時を確認" };

  const first = validRows.reduce((earliest, row) => row.start < earliest.start ? row : earliest);
  const startsAt = midnight + first.start * MINUTE_MS;
  const endsAt = midnight + Math.max(...validRows.map(row => row.end)) * MINUTE_MS;
  if (now < startsAt) return { phase: "upcoming", label: "開始前", nextSlotId: first.id, startsAt, endsAt };
  if (now >= endsAt) return { phase: "finished", label: "終了", startsAt, endsAt };

  const active = validRows.find(row => statusAt(row, midnight, now) === "active");
  if (active) return { phase: "active", label: active.title, interval: "program", activeSlotId: active.id, startsAt, endsAt };

  const minute = (now - midnight) / MINUTE_MS;
  const next = validRows.filter(row => row.start > minute).reduce<ScheduledSlot | undefined>((earliest, row) => !earliest || row.start < earliest.start ? row : earliest, undefined);
  if (next) {
    const index = schedule.rows.findIndex(row => row.id === next.id);
    const setup = index === 0 ? 0 : Number.isFinite(next.changeoverMinutes) ? Math.max(0, next.changeoverMinutes) : 0;
    const preparing = setup > 0 && Number.isFinite(next.changeoverStart) && minute >= next.changeoverStart && minute < next.changeoverStart + setup;
    return { phase: "active", label: preparing ? "転換・準備" : "時間調整・待機", interval: preparing ? "changeover" : "waiting", nextSlotId: next.id, startsAt, endsAt };
  }
  return { phase: "finished", label: "終了", startsAt, endsAt };
}
