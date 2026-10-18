import { env } from "cloudflare:workers";
import { z } from "zod";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { demoState } from "@/lib/demo";
import type { EventState } from "@/lib/types";

const MAX_BODY_BYTES = 512 * 1024;
const minute = z.number().int().min(0).max(2880);
const shortText = z.string().trim().min(1).max(160);
const members = z.array(z.object({
  name: shortText,
  roles: z.array(z.string().trim().min(1).max(40)).max(12)
    .refine((roles) => new Set(roles).size === roles.length, "同じ役割を重複して選択できません。"),
  roleNotRequired: z.boolean().optional(),
}).strict().superRefine((member, context) => {
  if (member.roles.length === 0 && member.roleNotRequired !== true) {
    context.addIssue({ code: "custom", path: ["roles"], message: "役職を選ぶか「役職なし」を指定してください。" });
  }
  if (member.roles.length > 0 && member.roleNotRequired === true) {
    context.addIssue({ code: "custom", path: ["roleNotRequired"], message: "役職と「役職なし」は同時に指定できません。" });
  }
})).max(30)
  .refine((entries) => new Set(entries.map((member) => member.name)).size === entries.length, "メンバー名が重複しています。");
const identifier = z.string().min(1).max(120);
const eventDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "有効な日付を入力してください。");

const slotSchema = z.object({
  id: identifier,
  title: shortText,
  group: z.string().max(160),
  kind: z.enum(["talk", "workshop", "live", "break", "other"]),
  durationMinutes: z.number().int().min(1).max(720),
  changeoverMinutes: z.number().int().min(0).max(180),
  people: z.array(shortText).max(30),
  members: members.optional(),
  equipment: z.array(shortText).max(30),
  earliestStart: minute.optional(),
  latestEnd: minute.optional(),
  fixedStart: minute.optional(),
  locked: z.boolean(),
  status: z.enum(["planned", "active", "done"]),
  energy: z.number().min(0).max(5),
  notes: z.string().max(2000),
}).strict();

export const eventStateSchema = z.object({
  event: z.object({
    id: identifier,
    name: shortText,
    date: eventDate,
    location: z.string().max(240),
    startTime: minute,
    endTime: minute,
    quietWindows: z.array(z.object({
      id: identifier,
      label: shortText,
      start: minute,
      end: minute,
    }).strict()).max(30),
  }).strict(),
  slots: z.array(slotSchema).max(80),
  history: z.array(z.object({
    id: identifier,
    at: z.string().min(1).max(100),
    title: shortText,
    detail: z.string().max(2000),
    kind: z.enum(["edit", "plan", "progress", "create"]),
  }).strict()).max(200),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((state, context) => {
  if (state.event.endTime <= state.event.startTime) {
    context.addIssue({ code: "custom", path: ["event", "endTime"], message: "終了は開始より後にしてください。" });
  }
  if (new Set(state.slots.map((slot) => slot.id)).size !== state.slots.length) {
    context.addIssue({ code: "custom", path: ["slots"], message: "出演枠のIDが重複しています。" });
  }
  if (new Set(state.history.map((entry) => entry.id)).size !== state.history.length) {
    context.addIssue({ code: "custom", path: ["history"], message: "履歴のIDが重複しています。" });
  }
  const windows = state.event.quietWindows;
  if (new Set(windows.map((window) => window.id)).size !== windows.length) {
    context.addIssue({ code: "custom", path: ["event", "quietWindows"], message: "音止め時間のIDが重複しています。" });
  }
  windows.forEach((window, index) => {
    if (window.end <= window.start) {
      context.addIssue({ code: "custom", path: ["event", "quietWindows", index], message: "音止め終了は開始より後にしてください。" });
    }
  });
  state.slots.forEach((slot, index) => {
    if (slot.members && (slot.members.length !== slot.people.length || slot.members.some((member, memberIndex) => member.name !== slot.people[memberIndex]))) {
      context.addIssue({ code: "custom", path: ["slots", index, "members"], message: "メンバー名と出演者名を同じ順序で指定してください。" });
    }
    if (slot.earliestStart !== undefined && slot.latestEnd !== undefined && slot.earliestStart >= slot.latestEnd) {
      context.addIssue({ code: "custom", path: ["slots", index], message: "出演可能時間の開始と終了を確認してください。" });
    }
  });
});

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = "request_error") {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Vary": "Origin",
    },
  });
}

export function errorResponse(error: unknown) {
  if (error instanceof HttpError) return jsonResponse({ error: error.message, code: error.code }, error.status);
  // Do not log request bodies, event contents, upstream errors, or credentials.
  console.error("Cue request failed", error instanceof Error ? error.name : "UnknownError");
  return jsonResponse({ error: "処理を完了できませんでした。少し待って再度お試しください。", code: "server_error" }, 500);
}

export function checkBrowserOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site") throw new HttpError(403, "この操作はタイテ作成ツールの画面から実行してください。", "origin_rejected");
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "この操作はタイテ作成ツールの画面から実行してください。", "origin_rejected");
  }
}

export async function getPrivateCallerContext() {
  // The hosting manifest MUST remain owner-private. Sites authenticates browser
  // and MCP callers before forwarding requests. Some authorized service calls
  // have no user headers, and local preview has none either. This shared event
  // library relies on that native boundary, rather than treating a missing user
  // header as a different tenant. Revisit before any public launch.
  const user = await getChatGPTUser();
  return { callerKind: user ? "chatgpt-user" : "platform-service-or-preview" } as const;
}

export async function readJsonBody<T>(request: Request, schema: z.ZodType<T>, maxBytes = MAX_BODY_BYTES): Promise<T> {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "JSON形式で送信してください。", "unsupported_media_type");
  }
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "送信内容が大きすぎます。枠やメモを減らしてください。", "body_too_large");
  }
  if (!request.body) throw new HttpError(400, "送信内容がありません。", "invalid_json");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HttpError(413, "送信内容が大きすぎます。枠やメモを減らしてください。", "body_too_large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new HttpError(400, "送信内容を読み取れませんでした。", "invalid_json");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, "入力内容を確認してください。時刻・出演枠・文字数のいずれかが正しくありません。", "invalid_payload");
  return parsed.data;
}

function database() {
  if (!env.DB) throw new HttpError(503, "クラウド保存の準備中です。少し待って再読み込みしてください。", "storage_unavailable");
  return env.DB;
}

type StoredRow = { payload: string; revision: number };
type SavedEventRow = StoredRow & { event_id: string; updated_at: string };
const MAX_SAVED_EVENTS = 100;

export interface EventSummary {
  id: string;
  name: string;
  date: string;
  location: string;
  startTime: number;
  endTime: number;
  slotCount: number;
  updatedAt: string;
}

function decodeStoredRow(row: StoredRow): EventState {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    throw new HttpError(503, "保存データを読み取れませんでした。管理者に確認してください。", "storage_invalid");
  }
  const parsed = eventStateSchema.safeParse(payload);
  if (!parsed.success || parsed.data.revision !== row.revision) {
    throw new HttpError(503, "保存データを読み取れませんでした。管理者に確認してください。", "storage_invalid");
  }
  return parsed.data;
}

export async function getEventState(): Promise<EventState> {
  const db = database();
  let row = await db.prepare("SELECT payload, revision FROM cue_event_state WHERE id = ?").bind("primary").first<StoredRow>();
  if (!row) {
    const initial = eventStateSchema.parse({ ...demoState, revision: 0 });
    await db.prepare("INSERT OR IGNORE INTO cue_event_state (id, revision, payload, updated_at) VALUES (?, ?, ?, ?)")
      .bind("primary", 0, JSON.stringify(initial), new Date().toISOString()).run();
    row = await db.prepare("SELECT payload, revision FROM cue_event_state WHERE id = ?").bind("primary").first<StoredRow>();
  }
  if (!row) throw new HttpError(503, "クラウド保存の準備中です。少し待って再読み込みしてください。", "storage_unavailable");
  return decodeStoredRow(row);
}

export async function saveEventState(state: EventState, expectedRevision: number): Promise<{ state: EventState; conflict: boolean }> {
  validateExpectedRevision(expectedRevision);
  if (state.revision !== expectedRevision) throw new HttpError(422, "保存バージョンが一致しません。再読み込みしてください。", "invalid_revision");
  const current = await getEventState(); // Seed an empty database before the first write.
  if (current.revision !== expectedRevision) return { state: current, conflict: true };
  if (state.event.id !== current.event.id && await savedEventRow(state.event.id)) {
    throw new HttpError(409, "同じIDのイベントが保存済みです。イベント一覧から開いてください。", "event_exists");
  }
  await ensureEventCapacity(current.event.id, state.event.id);
  const next: EventState = { ...state, revision: expectedRevision + 1 };
  return persistActiveState(current, next);
}

function validateExpectedRevision(expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
    throw new HttpError(422, "保存バージョンを確認してください。", "invalid_revision");
  }
}

async function savedEventRow(eventId: string): Promise<SavedEventRow | null> {
  return database().prepare("SELECT event_id, revision, payload, updated_at FROM cue_saved_event WHERE event_id = ?").bind(eventId).first<SavedEventRow>();
}

function decodeSavedEvent(row: SavedEventRow): EventState {
  const state = decodeStoredRow(row);
  if (state.event.id !== row.event_id || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new HttpError(503, "保存データを読み取れませんでした。管理者に確認してください。", "storage_invalid");
  }
  return state;
}

async function ensureEventCapacity(currentId: string, nextId: string) {
  const row = await database().prepare(`SELECT COUNT(*) +
    CASE WHEN EXISTS (SELECT 1 FROM cue_saved_event WHERE event_id = ?) THEN 0 ELSE 1 END +
    CASE WHEN ? = ? OR EXISTS (SELECT 1 FROM cue_saved_event WHERE event_id = ?) THEN 0 ELSE 1 END AS count
    FROM cue_saved_event`).bind(currentId, currentId, nextId, nextId).first<{ count: number }>();
  if (!row || row.count > MAX_SAVED_EVENTS) {
    throw new HttpError(409, "保存できるイベントは100件までです。既存のイベントを一覧から開いてください。", "event_capacity");
  }
}

// D1 batches are transactional. Both archives are guarded by the same global
// revision as the active pointer; a losing writer cannot overwrite either
// event's snapshot. No migration-time backfill or request-time DDL is needed.
async function persistActiveState(current: EventState, next: EventState): Promise<{ state: EventState; conflict: boolean }> {
  const db = database();
  const updatedAt = new Date().toISOString();
  const payload = JSON.stringify(next);
  const result = await db.batch([
    db.prepare(`INSERT INTO cue_saved_event (event_id, revision, payload, updated_at)
      SELECT json_extract(payload, '$.event.id'), revision, payload, updated_at FROM cue_event_state
      WHERE id = ? AND revision = ? AND json_extract(payload, '$.event.id') = ?
      ON CONFLICT(event_id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`)
      .bind("primary", current.revision, current.event.id),
    db.prepare("UPDATE cue_event_state SET payload = ?, revision = ?, updated_at = ? WHERE id = ? AND revision = ? AND json_extract(payload, '$.event.id') = ?")
      .bind(payload, next.revision, updatedAt, "primary", current.revision, current.event.id),
    db.prepare(`INSERT INTO cue_saved_event (event_id, revision, payload, updated_at)
      SELECT json_extract(payload, '$.event.id'), revision, payload, updated_at FROM cue_event_state
      WHERE id = ? AND revision = ? AND payload = ? AND updated_at = ?
      ON CONFLICT(event_id) DO UPDATE SET revision = excluded.revision, payload = excluded.payload, updated_at = excluded.updated_at`)
      .bind("primary", next.revision, payload, updatedAt),
  ]);
  if (result[1]?.meta.changes !== 1) return { state: await getEventState(), conflict: true };
  return { state: next, conflict: false };
}

export async function listEvents(): Promise<EventSummary[]> {
  await getEventState();
  // Project summaries in SQL instead of returning up to 100 full documents
  // (each may be 512 KiB) into one Workers isolate just to draw a small list.
  const response = await database().prepare(`WITH documents AS (
    SELECT event_id, revision, CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS payload, updated_at FROM cue_saved_event
      WHERE event_id != (SELECT json_extract(payload, '$.event.id') FROM cue_event_state WHERE id = ?)
    UNION ALL SELECT json_extract(payload, '$.event.id') AS event_id, revision, payload, updated_at FROM cue_event_state WHERE id = ?
  ) SELECT event_id, revision, updated_at, json_extract(payload, '$.event.id') AS payload_id,
    json_extract(payload, '$.revision') AS payload_revision, json_extract(payload, '$.event.name') AS name,
    json_extract(payload, '$.event.date') AS date, json_extract(payload, '$.event.location') AS location,
    json_extract(payload, '$.event.startTime') AS startTime, json_extract(payload, '$.event.endTime') AS endTime,
    CASE WHEN json_type(payload, '$.slots') = 'array' THEN json_array_length(payload, '$.slots') ELSE NULL END AS slotCount
    FROM documents ORDER BY updated_at DESC, event_id ASC LIMIT ?`).bind("primary", "primary", MAX_SAVED_EVENTS).all<{
      event_id: string; revision: number; updated_at: string; payload_id: unknown; payload_revision: unknown;
      name: unknown; date: unknown; location: unknown; startTime: unknown; endTime: unknown; slotCount: unknown;
    }>();
  const summarySchema = z.object({ id: identifier, name: shortText, date: eventDate, location: z.string().max(240),
    startTime: minute, endTime: minute, slotCount: z.number().int().min(0).max(80), updatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))) });
  return (response.results ?? []).map((row) => {
    const parsed = summarySchema.safeParse({ id: row.event_id, name: row.name, date: row.date, location: row.location,
      startTime: row.startTime, endTime: row.endTime, slotCount: row.slotCount, updatedAt: row.updated_at });
    if (!parsed.success || row.event_id !== row.payload_id || row.revision !== row.payload_revision || parsed.data.endTime <= parsed.data.startTime) {
      throw new HttpError(503, "保存データを読み取れませんでした。管理者に確認してください。", "storage_invalid");
    }
    return parsed.data;
  });
}

export async function switchEventState(eventId: string, expectedRevision: number): Promise<{ state: EventState; conflict: boolean }> {
  validateExpectedRevision(expectedRevision);
  if (!identifier.safeParse(eventId).success) throw new HttpError(422, "イベントを確認してください。", "invalid_event_id");
  const current = await getEventState();
  if (current.revision !== expectedRevision) return { state: current, conflict: true };
  if (eventId === current.event.id) return { state: current, conflict: false };
  const row = await savedEventRow(eventId);
  if (!row) throw new HttpError(404, "このイベントは見つかりません。イベント一覧を再読み込みしてください。", "event_not_found");
  const saved = decodeSavedEvent(row);
  await ensureEventCapacity(current.event.id, eventId);
  return persistActiveState(current, { ...saved, revision: expectedRevision + 1 });
}
