export type SlotKind = "talk" | "workshop" | "live" | "break" | "other";

export interface EventSlot {
  id: string;
  title: string;
  group: string;
  kind: SlotKind;
  durationMinutes: number;
  /** Preparation time immediately before this slot. */
  changeoverMinutes: number;
  people: string[];
  equipment: string[];
  earliestStart?: number;
  latestEnd?: number;
  /** Durable start anchor for locked, active, or completed entries. */
  fixedStart?: number;
  locked: boolean;
  status: "planned" | "active" | "done";
  energy: number;
  notes: string;
}

export interface HistoryEntry {
  id: string;
  at: string;
  title: string;
  detail: string;
  kind: "edit" | "plan" | "progress" | "create";
}

export interface EventState {
  event: {
    id: string;
    name: string;
    date: string;
    location: string;
    startTime: number;
    endTime: number;
    quietWindows: { id: string; label: string; start: number; end: number }[];
  };
  slots: EventSlot[];
  history: HistoryEntry[];
  revision: number;
}

export interface Violation {
  code: string;
  message: string;
  slotId?: string;
  severity: "error" | "warning";
}

export interface ScheduledSlot extends EventSlot {
  start: number;
  end: number;
  changeoverStart: number;
  waitMinutes: number;
  violations: string[];
}

export interface Schedule {
  rows: ScheduledSlot[];
  endsAt: number;
  contentMinutes: number;
  changeoverMinutes: number;
  violations: Violation[];
  bufferMinutes: number;
}

export interface Issue {
  kind: "delay" | "unavailable" | "shorten" | "note";
  slotId?: string;
  minutes?: number;
  until?: number;
  text: string;
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  slots: EventSlot[];
  schedule: Schedule;
  changes: string[];
  tradeoffs: string[];
  score: number;
  /** Net finish-time goal. Absent when shortening one specific slot. */
  shortening?: {
    originalEnd: number;
    targetEnd: number;
    requestedMinutes: number;
    achievedMinutes: number;
    shortfallMinutes: number;
    contentReductionMinutes: number;
    met: boolean;
  };
}
