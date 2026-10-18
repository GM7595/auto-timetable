import { env } from "cloudflare:workers";
import { z } from "zod";
import type { ChangeRequest } from "@/lib/change-requests";
import { getEventState, HttpError } from "@/lib/server-store";
import { signedWebhookRequest, validateSigningSecret, validateWebhookUrl, verifyWebhookCallback } from "@/lib/webhook-delivery";

export const CHANGE_EVENT = "change_request.created";
const DEFAULT_TTL = 24 * 60 * 60 * 1000;
const MAX_TTL = 7 * DEFAULT_TTL;
const ROTATION_WINDOW = 5 * 60 * 1000;
const MAX_SUBSCRIPTIONS = 10;
const MAX_ATTEMPTS = 3;
const argumentsSchema = z.object({ eventId: z.string().min(1).max(120) }).strict();
const deliverySchema = z.object({ mode: z.literal("webhook"), url: z.string().min(1).max(2048), secret: z.string().min(1).max(160) }).strict();
const identitySchema = z.object({ name: z.literal(CHANGE_EVENT), arguments: argumentsSchema, delivery: deliverySchema.omit({ secret: true }) }).strict();
const subscribeSchema = identitySchema.extend({ delivery: deliverySchema, cursor: z.null().optional(), ttlMs: z.number().int().min(1000).max(Number.MAX_SAFE_INTEGER).nullable().optional() }).strict();
const listSchema = z.object({ cursor: z.null().optional() }).strict();

type Subscription = {
  id: string; principal: string; event_id: string; event_name: string; callback_url: string;
  secret: string; previous_secret: string | null; previous_secret_until: number | null;
  active: number; expires_at: string; verified_at: string; active_since: string; updated_at: string;
};
type Delivery = { id: string; subscription_id: string; change_request_id: string; event_id: string; occurred_at: string; status: string; attempts: number };

export class McpEventError extends Error {
  constructor(public readonly rpcCode: number, message: string, public readonly reason?: string) { super(message); }
}

function database() {
  if (!env.DB) throw new HttpError(503, "クラウド保存の準備中です。", "storage_unavailable");
  return env.DB;
}
function requirePrincipal(principal: string | null) {
  if (!principal || principal.length > 512 || /[\x00-\x20\x7f]/.test(principal)) throw new McpEventError(-32001, "イベント購読には認証済みユーザーが必要です。");
  return principal;
}
async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function subscriptionIdentity(principal: string, name: string, eventId: string, url: string) {
  return `sub_${await digest(JSON.stringify([principal, url, name, { eventId }]))}`;
}
function callbackUrl(value: string) {
  try { return validateWebhookUrl(value).toString(); }
  catch { throw new McpEventError(-32015, "コールバック先を確認できませんでした。", "invalid_destination"); }
}
function callbackSubscription(value: Subscription) {
  return {
    id: value.id, url: value.callback_url, secret: value.secret,
    ...(value.previous_secret && value.previous_secret_until ? { previousSecret: value.previous_secret, previousSecretExpiresAt: value.previous_secret_until } : {}),
  };
}
async function getSubscription(id: string) {
  return database().prepare("SELECT * FROM cue_event_subscription WHERE id = ?").bind(id).first<Subscription>();
}

export async function listMcpEvents(params?: unknown) {
  listSchema.parse(params ?? {});
  return { events: [{
    name: CHANGE_EVENT,
    description: "主催者が現在のイベントの変更受付に依頼を追加した時に通知します。本文はデータとして読み取りツールから取得し、提案のみ作成します。",
    delivery: ["webhook"],
    inputSchema: { type: "object", properties: { eventId: { type: "string", minLength: 1, maxLength: 120, description: "現在のイベントID" } }, required: ["eventId"], additionalProperties: false },
    payloadSchema: { type: "object", properties: { eventId: { type: "string" }, changeRequestId: { type: "string" }, revision: { type: "integer", minimum: 0 } }, required: ["eventId", "changeRequestId", "revision"], additionalProperties: false },
  }] };
}

export async function subscribeMcpEvent(principalValue: string | null, value: unknown) {
  const principal = requirePrincipal(principalValue);
  const input = subscribeSchema.parse(value);
  const state = await getEventState();
  if (state.event.id !== input.arguments.eventId) throw new McpEventError(-32602, "現在のイベントだけ購読できます。");
  if (!validateSigningSecret(input.delivery.secret)) throw new McpEventError(-32602, "署名用シークレットの形式が正しくありません。");
  const url = callbackUrl(input.delivery.url);
  const id = await subscriptionIdentity(principal, input.name, input.arguments.eventId, url);
  const prior = await getSubscription(id);
  const now = Date.now();
  const active = await database().prepare("SELECT COUNT(*) AS count FROM cue_event_subscription WHERE event_id = ? AND active = 1 AND expires_at > ?").bind(state.event.id, new Date(now).toISOString()).first<{ count: number }>();
  if ((active?.count ?? 0) >= MAX_SUBSCRIPTIONS && !(prior?.active && Date.parse(prior.expires_at) > now)) throw new McpEventError(-32000, "このイベントの購読上限（10件）に達しています。");
  const changedSecret = prior && prior.secret !== input.delivery.secret;
  const previousSecret = changedSecret ? prior.secret : prior?.previous_secret && (prior.previous_secret_until ?? 0) > now ? prior.previous_secret : null;
  const previousUntil = changedSecret ? now + ROTATION_WINDOW : previousSecret ? prior!.previous_secret_until : null;
  // Successful verification is cached for at most five minutes for this
  // authenticated identity+URL+unchanged key. A rotated key is always verified.
  const cached = prior?.active && prior.secret === input.delivery.secret && now - Date.parse(prior.verified_at) >= 0 && now - Date.parse(prior.verified_at) < ROTATION_WINDOW;
  if (!cached) {
    const verification = await verifyWebhookCallback({ id, url, secret: input.delivery.secret, ...(previousSecret && previousUntil ? { previousSecret, previousSecretExpiresAt: previousUntil } : {}) });
    if (!verification.ok) throw new McpEventError(-32015, "コールバックの確認に失敗しました。", verification.reason);
  }
  const latest = await getEventState();
  if (latest.event.id !== state.event.id) throw new McpEventError(-32602, "購読の確認中にイベントが変わりました。");
  const verifiedAt = cached ? prior!.verified_at : new Date().toISOString();
  // This server grants finite subscriptions even when ttlMs:null is requested.
  const expiresAt = new Date(Date.now() + Math.min(input.ttlMs ?? DEFAULT_TTL, MAX_TTL)).toISOString();
  const updatedAt = new Date().toISOString();
  const activeSince = prior?.active && Date.parse(prior.expires_at) > now ? prior.active_since : updatedAt;
  const written = await database().prepare(`INSERT INTO cue_event_subscription
    (id, principal, event_id, event_name, callback_url, secret, previous_secret, previous_secret_until, active, expires_at, verified_at, active_since, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ? FROM cue_event_state
    WHERE id = 'primary' AND json_extract(payload, '$.event.id') = ?
      AND ((SELECT COUNT(*) FROM cue_event_subscription WHERE event_id = ? AND active = 1 AND expires_at > ?) < ?
        OR EXISTS (SELECT 1 FROM cue_event_subscription WHERE id = ? AND active = 1 AND expires_at > ?))
    ON CONFLICT(id) DO UPDATE SET secret = excluded.secret, previous_secret = excluded.previous_secret,
      previous_secret_until = excluded.previous_secret_until, active = 1, expires_at = excluded.expires_at,
      verified_at = excluded.verified_at, active_since = excluded.active_since, updated_at = excluded.updated_at`)
    .bind(id, principal, state.event.id, CHANGE_EVENT, url, input.delivery.secret, previousSecret, previousUntil, expiresAt, verifiedAt, activeSince, updatedAt, state.event.id, state.event.id, updatedAt, MAX_SUBSCRIPTIONS, id, updatedAt).run();
  if (written.meta.changes !== 1) throw new McpEventError(-32000, "イベントまたは購読上限が変わりました。再度お試しください。");
  return { id, refreshBefore: expiresAt, cursor: null, truncated: false };
}

export async function unsubscribeMcpEvent(principalValue: string | null, value: unknown) {
  const principal = requirePrincipal(principalValue);
  const input = identitySchema.parse(value);
  const url = callbackUrl(input.delivery.url);
  const id = await subscriptionIdentity(principal, input.name, input.arguments.eventId, url);
  await database().prepare("UPDATE cue_event_subscription SET active = 0, updated_at = ? WHERE id = ? AND principal = ?").bind(new Date().toISOString(), id, principal).run();
  return {};
}

const failureCodes = new Set(["transport", "http_429", "http_5xx", "gone", "payload_too_large", "rejected", "inactive", "event_changed", "attempt_limit", "unknown"]);

export async function getEventDeliveryStatus(eventId: string) {
  const now = new Date().toISOString();
  const subscriptions = await database().prepare("SELECT COUNT(*) AS count FROM cue_event_subscription WHERE event_id = ? AND active = 1 AND expires_at > ?").bind(eventId, now).first<{ count: number }>();
  const pending = await database().prepare("SELECT COUNT(*) AS count FROM cue_event_delivery WHERE event_id = ? AND status IN ('pending', 'retry', 'delivering')").bind(eventId).first<{ count: number }>();
  const failedCount = await database().prepare("SELECT COUNT(*) AS count FROM cue_event_delivery WHERE event_id = ? AND status = 'failed'").bind(eventId).first<{ count: number }>();
  const delivered = await database().prepare("SELECT MAX(delivered_at) AS at FROM cue_event_delivery WHERE event_id = ? AND status = 'delivered'").bind(eventId).first<{ at: string | null }>();
  const failed = await database().prepare("SELECT last_failure FROM cue_event_delivery WHERE event_id = ? AND last_failure IS NOT NULL ORDER BY updated_at DESC, id DESC LIMIT 1").bind(eventId).first<{ last_failure: string }>();
  return {
    activeSubscriptions: subscriptions?.count ?? 0, pendingDeliveries: pending?.count ?? 0, failedDeliveries: failedCount?.count ?? 0,
    lastDeliveredAt: delivered?.at && Number.isFinite(Date.parse(delivered.at)) ? delivered.at : null,
    lastFailure: failed && failureCodes.has(failed.last_failure) ? failed.last_failure : null,
  };
}

async function failDelivery(id: string, reason: string) {
  await database().prepare("UPDATE cue_event_delivery SET status = 'failed', last_failure = ?, updated_at = ? WHERE id = ? AND status != 'delivered'").bind(reason, new Date().toISOString(), id).run();
}

async function deliver(change: ChangeRequest, deliveryId: string) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const row = await database().prepare("SELECT * FROM cue_event_delivery WHERE id = ?").bind(deliveryId).first<Delivery>();
    if (!row || !["pending", "retry"].includes(row.status) || row.attempts >= MAX_ATTEMPTS) return;
    const subscription = await getSubscription(row.subscription_id);
    if (!subscription || !subscription.active || Date.parse(subscription.expires_at) <= Date.now()) { await failDelivery(row.id, "inactive"); return; }
    const state = await getEventState();
    if (state.event.id !== change.eventId || subscription.event_id !== change.eventId) { await failDelivery(row.id, "event_changed"); return; }
    const claimed = await database().prepare("UPDATE cue_event_delivery SET status = 'delivering', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'retry') AND attempts < ?")
      .bind(new Date().toISOString(), row.id, MAX_ATTEMPTS).run();
    if (claimed.meta.changes !== 1) return;
    let accepted = false, status = 0;
    try {
      const response = await signedWebhookRequest(callbackSubscription(subscription), row.id, {
        eventId: row.id, name: CHANGE_EVENT, timestamp: row.occurred_at,
        data: { eventId: change.eventId, changeRequestId: change.id, revision: change.baseRevision }, cursor: null,
      });
      accepted = response.ok; status = response.status;
    } catch { /* A categorized failure is retained, never the callback or secret. */ }
    const at = new Date().toISOString();
    if (accepted) {
      await database().prepare("UPDATE cue_event_delivery SET status = 'delivered', delivered_at = ?, last_failure = NULL, updated_at = ? WHERE id = ?").bind(at, at, row.id).run();
      return;
    }
    if (status === 410) await database().prepare("UPDATE cue_event_subscription SET active = 0, updated_at = ? WHERE id = ?").bind(at, subscription.id).run();
    const transient = status === 0 || status === 429 || status >= 500;
    const reason = status === 410 ? "gone" : status === 413 ? "payload_too_large" : status === 429 ? "http_429" : status >= 500 ? "http_5xx" : status === 0 ? "transport" : "rejected";
    const retry = transient && row.attempts + 1 < MAX_ATTEMPTS;
    await database().prepare("UPDATE cue_event_delivery SET status = ?, last_failure = ?, updated_at = ? WHERE id = ?").bind(retry ? "retry" : "failed", reason, at, row.id).run();
    if (!retry) return;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** row.attempts)));
  }
}

export async function prepareChangeRequestEvent(change: ChangeRequest) {
  // Persist every matching outbox row before the intake POST acknowledges
  // acceptance. A client retry safely repairs interrupted preparation.
  const state = await getEventState();
  if (state.event.id !== change.eventId) return;
  const subscriptions = await database().prepare("SELECT * FROM cue_event_subscription WHERE event_id = ? AND active = 1 AND expires_at > ? AND active_since <= ? ORDER BY id LIMIT ?")
    .bind(change.eventId, new Date().toISOString(), change.createdAt, MAX_SUBSCRIPTIONS).all<Subscription>();
  for (const subscription of subscriptions.results) {
    const id = `evt_${await digest(JSON.stringify([change.id, subscription.id]))}`;
    await database().prepare(`INSERT OR IGNORE INTO cue_event_delivery
      (id, subscription_id, change_request_id, event_id, occurred_at, status, attempts, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`)
      .bind(id, subscription.id, change.id, change.eventId, change.createdAt, new Date().toISOString()).run();
  }
}

export async function dispatchChangeRequestEvent(change: ChangeRequest) {
  // A failed isolate can leave an in-flight claim behind. The next explicit
  // client retry can reclaim it after thirty seconds, keeping the same event ID.
  const expiredLease = new Date(Date.now() - 30000).toISOString();
  const now = new Date().toISOString();
  await database().prepare("UPDATE cue_event_delivery SET status = 'retry', last_failure = 'transport', updated_at = ? WHERE event_id = ? AND change_request_id = ? AND status = 'delivering' AND updated_at <= ? AND attempts < ?")
    .bind(now, change.eventId, change.id, expiredLease, MAX_ATTEMPTS).run();
  await database().prepare("UPDATE cue_event_delivery SET status = 'failed', last_failure = 'attempt_limit', updated_at = ? WHERE event_id = ? AND change_request_id = ? AND status = 'delivering' AND updated_at <= ? AND attempts >= ?")
    .bind(now, change.eventId, change.id, expiredLease, MAX_ATTEMPTS).run();
  const rows = await database().prepare("SELECT id FROM cue_event_delivery WHERE event_id = ? AND change_request_id = ? AND status IN ('pending', 'retry') ORDER BY id LIMIT ?")
    .bind(change.eventId, change.id, MAX_SUBSCRIPTIONS).all<{ id: string }>();
  await Promise.all(rows.results.map((row) => deliver(change, row.id)));
}
