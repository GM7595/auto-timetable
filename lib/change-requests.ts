import { env } from "cloudflare:workers";
import { z } from "zod";
import { getEventState, HttpError } from "@/lib/server-store";
import { planningResultSchema } from "@/lib/planning-result-schema";

export interface ChangeRequest {
  id: string;
  eventId: string;
  baseRevision: number;
  text: string;
  createdAt: string;
  status: "pending" | "proposed";
  proposalId?: string;
  requestId: string;
}

export const enqueueChangeSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  requestId: z.string().uuid(),
}).strict();

type ChangeRow = {
  id: string; event_id: string; base_revision: number; request_text: string; created_at: string;
  proposal_id?: string | null; proposal_result?: string | null;
};
const columns = "q.id, q.event_id, q.base_revision, q.request_text, q.created_at";
// The unique proposal request ID and exact request text make a successful
// persisted proposal the acknowledgement. Retries, failed comparisons, and
// proposals for another event cannot consume queue items.
export const MAX_QUEUED_RESULT_BYTES = 256 * 1024;
const joined = `SELECT ${columns}, p.id AS proposal_id,
  CASE WHEN length(CAST(p.result AS BLOB)) <= ${MAX_QUEUED_RESULT_BYTES} THEN p.result ELSE NULL END AS proposal_result FROM cue_change_request q
  LEFT JOIN cue_agent_proposal p ON p.event_id = q.event_id
    AND p.request_id = 'change:' || q.id AND p.request_text = q.request_text
    AND p.base_revision >= q.base_revision`;
export const MAX_CHANGE_REQUESTS = 100;

function database() {
  if (!env.DB) throw new HttpError(503, "クラウド保存の準備中です。少し待って再読み込みしてください。", "storage_unavailable");
  return env.DB;
}

function decode(row: ChangeRow): ChangeRequest {
  if (!z.string().uuid().safeParse(row.id).success || !row.event_id || row.event_id.length > 120 ||
      !Number.isSafeInteger(row.base_revision) || row.base_revision < 0 || !row.request_text ||
      row.request_text.length > 2000 || !Number.isFinite(Date.parse(row.created_at)) ||
      (row.proposal_id != null && (!row.proposal_id || row.proposal_id.length > 120))) {
    throw new HttpError(503, "保存された変更依頼を読み取れませんでした。管理者に確認してください。", "change_storage_invalid");
  }
  let proposed = false;
  if (row.proposal_id && row.proposal_result) {
    try {
      const parsed = planningResultSchema.safeParse(JSON.parse(row.proposal_result));
      proposed = parsed.success && (parsed.data.aiStatus === "used" || parsed.data.aiStatus === "not-needed");
    } catch { /* Corrupt proposals leave intake pending; no content is exposed. */ }
  }
  return {
    id: row.id, eventId: row.event_id, baseRevision: row.base_revision, text: row.request_text,
    createdAt: row.created_at, status: proposed ? "proposed" : "pending",
    ...(proposed ? { proposalId: row.proposal_id! } : {}), requestId: `change:${row.id}`,
  };
}

async function findRequest(eventId: string, id: string) {
  return database().prepare(`${joined} WHERE q.event_id = ? AND q.id = ?`).bind(eventId, id).first<ChangeRow>();
}

async function countRequests(eventId: string) {
  const row = await database().prepare("SELECT COUNT(*) AS count FROM cue_change_request WHERE event_id = ?").bind(eventId).first<{ count: number }>();
  return row?.count ?? 0;
}

export async function listChangeRequests(eventId: string): Promise<{ requests: ChangeRequest[]; pendingRequests: ChangeRequest[]; pendingCount: number }> {
  // The per-event hard cap bounds this read and permits an exact pending count,
  // including older requests outside the latest-20 UI window.
  const rows = await database().prepare(`${joined} WHERE q.event_id = ? ORDER BY q.created_at DESC, q.id DESC LIMIT ?`).bind(eventId, MAX_CHANGE_REQUESTS).all<ChangeRow>();
  const values = rows.results.map(decode);
  const pendingRequests = values.filter((entry) => entry.status === "pending").reverse();
  return { requests: values.slice(0, 20), pendingRequests, pendingCount: pendingRequests.length };
}

export async function listPendingChangeRequests(eventId: string): Promise<ChangeRequest[]> {
  const rows = await database().prepare(`${joined} WHERE q.event_id = ? ORDER BY q.created_at ASC, q.id ASC LIMIT ?`).bind(eventId, MAX_CHANGE_REQUESTS).all<ChangeRow>();
  return rows.results.map(decode).filter((entry) => entry.status === "pending");
}

export async function validateQueuedProposal(eventId: string, requestId: string, text: string, revision: number) {
  if (!requestId.startsWith("change:")) return false;
  const id = requestId.slice("change:".length);
  if (!z.string().uuid().safeParse(id).success) throw queueMismatch();
  const row = await findRequest(eventId, id);
  if (!row) throw queueMismatch();
  const request = decode(row);
  if (request.text !== text || request.baseRevision > revision) throw queueMismatch();
  return true;
}

export async function enqueueChangeRequest(value: unknown) {
  const parsed = enqueueChangeSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(422, "変更内容・保存バージョン・再試行IDを確認してください。", "invalid_change_request");
  const input = parsed.data;
  const state = await getEventState();
  const replay = (row: ChangeRow) => {
    const request = decode(row);
    if (request.baseRevision !== input.expectedRevision || request.text !== input.text) {
      throw new HttpError(409, "同じ送信IDで異なる変更依頼が送られています。新しいIDで送信してください。", "change_request_conflict");
    }
    return { request, applied: false as const, replayed: true as const };
  };
  const prior = await findRequest(state.event.id, input.requestId);
  if (prior) return replay(prior);
  if (state.revision !== input.expectedRevision) throw staleChange();
  if (await countRequests(state.event.id) >= MAX_CHANGE_REQUESTS) throw capacity();
  const createdAt = new Date().toISOString();
  const inserted = await database().prepare(`INSERT OR IGNORE INTO cue_change_request (id, event_id, base_revision, request_text, created_at)
    SELECT ?, ?, ?, ?, ? FROM cue_event_state
    WHERE id = ? AND revision = ? AND json_extract(payload, '$.event.id') = ?
      AND (SELECT COUNT(*) FROM cue_change_request WHERE event_id = ?) < ?`)
    .bind(input.requestId, state.event.id, input.expectedRevision, input.text, createdAt, "primary", input.expectedRevision, state.event.id, state.event.id, MAX_CHANGE_REQUESTS).run();
  const saved = await findRequest(state.event.id, input.requestId);
  if (!saved) {
    const current = await getEventState();
    if (current.event.id !== state.event.id || current.revision !== input.expectedRevision) throw staleChange();
    if (await countRequests(state.event.id) >= MAX_CHANGE_REQUESTS) throw capacity();
    // A caller-provided UUID may already belong to another event. Do not reveal
    // that record or silently move it across event boundaries.
    throw new HttpError(409, "この送信IDは利用できません。新しいIDで送信してください。", "change_request_conflict");
  }
  if (inserted.meta.changes !== 1) return replay(saved);
  return { request: decode(saved), applied: false as const };
}

function staleChange() {
  return new HttpError(409, "進行表が更新されています。最新の状態を読み込み、変更依頼を送信してください。", "change_revision_conflict");
}
function capacity() {
  return new HttpError(409, "このイベントの変更受付上限（100件）に達しました。保存済みの依頼は自動削除しません。", "change_capacity");
}
function queueMismatch() {
  return new HttpError(409, "変更受付のID・内容・イベントが一致しません。最新の未処理依頼を読み直してください。", "change_request_mismatch");
}
