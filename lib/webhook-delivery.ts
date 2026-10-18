/**
 * MCP Events delivery for official ChatGPT callback hosts only.
 *
 * Workers fetch cannot pin a validated DNS address while retaining TLS SNI.
 * Consequently this is intentionally NOT a generic public-URL webhook client:
 * only OpenAI-controlled chatgpt.com/openai.com hosts are accepted. Do not
 * broaden this allowlist without a transport that validates and pins public
 * destination addresses at connection time. Redirects are never followed.
 */
export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  previousSecret?: string;
  /** Unix milliseconds, with the short rotation deadline enforced by storage. */
  previousSecretExpiresAt?: number;
}

type FailureReason = "challenge_failed" | "timeout" | "invalid_destination" | "invalid_secret";
export type CallbackVerification = { ok: true } | { ok: false; reason: FailureReason };

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_VERIFICATION_BYTES = 8 * 1024;
const DELIVERY_TIMEOUT_MS = 5000;
const encoder = new TextEncoder();

export function validateWebhookUrl(input: string): URL {
  const invalid = () => { throw new Error("Invalid webhook destination"); };
  if (typeof input !== "string" || input.length === 0 || input.length > 2048
    || /[\u0000-\u0020\u007f\\#]/.test(input)) return invalid();
  let url: URL;
  try { url = new URL(input); } catch { return invalid(); }
  const hostname = url.hostname;
  const labels = hostname.split(".");
  const official = ["chatgpt.com", "openai.com"].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  if (url.protocol !== "https:" || url.username || url.password || /^https:\/\/[^/?#]*@/i.test(input)
    || url.hash || (url.port !== "" && url.port !== "443") || !official
    || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return invalid();
  return url;
}

function signingBytes(secret: string): Uint8Array | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const encoded = secret.slice(6);
  if (encoded.length < 32 || encoded.length > 88
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  try {
    const decoded = atob(encoded);
    if (decoded.length < 24 || decoded.length > 64 || btoa(decoded) !== encoded) return null;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch { return null; }
}

export function validateSigningSecret(secret: string): boolean {
  return signingBytes(secret) !== null;
}

function safeId(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value);
}

async function signature(secret: string, data: string): Promise<string> {
  const bytes = signingBytes(secret);
  if (!bytes) throw new Error("Invalid signing secret");
  const key = await crypto.subtle.importKey("raw", bytes as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signed)))}`;
}

async function boundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_VERIFICATION_BYTES)) {
    discardResponse(response);
    throw new Error("Invalid verification response");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_VERIFICATION_BYTES) {
        cancel();
        throw new Error("Invalid verification response");
      }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function discardResponse(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

type DeliveryResult = { ok: boolean; status: number; text?: string; reason?: FailureReason };

async function requestSigned(
  subscription: WebhookSubscription,
  eventId: string,
  payload: unknown,
  fetcher: typeof fetch,
  readVerification: boolean,
): Promise<DeliveryResult> {
  let url: URL;
  try { url = validateWebhookUrl(subscription.url); }
  catch { return { ok: false, status: 0, reason: "invalid_destination" }; }
  if (!validateSigningSecret(subscription.secret)) return { ok: false, status: 0, reason: "invalid_secret" };
  if (!safeId(subscription.id) || !safeId(eventId)) return { ok: false, status: 0, reason: "challenge_failed" };
  let body: string;
  try {
    const serialized = JSON.stringify(payload);
    if (typeof serialized !== "string" || encoder.encode(serialized).byteLength > MAX_PAYLOAD_BYTES) return { ok: false, status: 0, reason: "challenge_failed" };
    body = serialized;
  } catch { return { ok: false, status: 0, reason: "challenge_failed" }; }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DeliveryResult>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ ok: false, status: 0, reason: "timeout" });
    }, DELIVERY_TIMEOUT_MS);
  });
  const delivery = async (): Promise<DeliveryResult> => {
    try {
      const now = Date.now();
      const timestamp = String(Math.floor(now / 1000));
      const signedData = `${eventId}.${timestamp}.${body}`;
      const signatures = [await signature(subscription.secret, signedData)];
      if (subscription.previousSecret && subscription.previousSecret !== subscription.secret
        && Number.isFinite(subscription.previousSecretExpiresAt) && subscription.previousSecretExpiresAt! > now
        && validateSigningSecret(subscription.previousSecret)) signatures.push(await signature(subscription.previousSecret, signedData));
      if (timedOut) return { ok: false, status: 0, reason: "timeout" };
      const response = await fetcher(url.href, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "webhook-id": eventId,
          "webhook-timestamp": timestamp,
          "webhook-signature": signatures.join(" "),
          "X-MCP-Subscription-Id": subscription.id,
        },
        body,
      });
      if (timedOut) { discardResponse(response); return { ok: false, status: 0, reason: "timeout" }; }
      if (response.redirected) { discardResponse(response); return { ok: false, status: 0, reason: "challenge_failed" }; }
      const status = response.status;
      if (!response.ok) { discardResponse(response); return { ok: false, status, reason: "challenge_failed" }; }
      if (!readVerification) { discardResponse(response); return { ok: true, status }; }
      return { ok: true, status, text: await boundedResponse(response, controller.signal) };
    } catch { return { ok: false, status: 0, reason: timedOut ? "timeout" : "challenge_failed" }; }
  };
  try { return await Promise.race([delivery(), timeout]); }
  finally { if (timeoutId !== undefined) clearTimeout(timeoutId); }
}

export async function signedWebhookRequest(
  subscription: WebhookSubscription,
  eventId: string,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  const result = await requestSigned(subscription, eventId, payload, fetcher, false);
  return { ok: result.ok, status: result.status };
}

async function constantTimeChallenge(expected: string, actual: string): Promise<boolean> {
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
  ]);
  const left = new Uint8Array(expectedHash);
  const right = new Uint8Array(actualHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export async function verifyWebhookCallback(
  subscription: WebhookSubscription,
  fetcher: typeof fetch = fetch,
): Promise<CallbackVerification> {
  try {
    const challenge = crypto.randomUUID();
    const eventId = `verification_${crypto.randomUUID()}`;
    const result = await requestSigned(subscription, eventId, { type: "verification", challenge }, fetcher, true);
    if (!result.ok) return { ok: false, reason: result.reason ?? "challenge_failed" };
    const parsed: unknown = JSON.parse(result.text ?? "");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("challenge" in parsed)
      || typeof parsed.challenge !== "string" || !await constantTimeChallenge(challenge, parsed.challenge)) return { ok: false, reason: "challenge_failed" };
    return { ok: true };
  } catch { return { ok: false, reason: "challenge_failed" }; }
}
