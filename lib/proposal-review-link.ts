export type ProposalReviewLink = { eventId: string; revision: number; text: string };

const MAX_HASH_LENGTH = 24_000;
const LINK_KEYS = new Set(["review", "event", "revision", "text"]);

function validInput(input: unknown): input is ProposalReviewLink {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 3 || !Object.keys(value).every((key) => ["eventId", "revision", "text"].includes(key))) return false;
  if (typeof value.eventId !== "string" || !value.eventId.trim() || value.eventId.length > 120 || /[\u0000-\u001f\u007f]/.test(value.eventId)) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return false;
  if (typeof value.text !== "string" || !value.text.trim() || value.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)) return false;
  try {
    // URLSearchParams silently replaces lone surrogates. Reject them instead.
    encodeURIComponent(value.eventId);
    encodeURIComponent(value.text);
    return true;
  } catch {
    return false;
  }
}

/** Carries only an untrusted request for a fresh comparison, never a saved plan. */
export function createProposalReviewUrl(origin: string, input: ProposalReviewLink): string {
  if (!validInput(input)) throw new Error("Invalid proposal review intent");
  const url = new URL(origin);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid proposal review origin");
  const params = new URLSearchParams({ review: "1", event: input.eventId, revision: String(input.revision), text: input.text });
  url.hash = params.toString();
  if (url.hash.length > MAX_HASH_LENGTH) throw new Error("Proposal review intent is too large");
  return url.toString();
}

/** Strictly validates fragment input before the organizer can request a comparison. */
export function parseProposalReviewHash(hash: string): ProposalReviewLink | null {
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length > MAX_HASH_LENGTH) return null;
  const raw = hash.slice(1);
  if (raw.split("&").length !== 4) return null;
  try {
    // URLSearchParams otherwise tolerates malformed escapes and invalid UTF-8.
    decodeURIComponent(raw.replace(/\+/g, " "));
    const params = new URLSearchParams(raw);
    const keys = [...params.keys()];
    if (keys.length !== 4 || new Set(keys).size !== 4 || !keys.every((key) => LINK_KEYS.has(key)) || params.get("review") !== "1") return null;
    const revisionText = params.get("revision") ?? "";
    if (!/^(0|[1-9]\d*)$/.test(revisionText)) return null;
    const input = { eventId: params.get("event"), revision: Number(revisionText), text: params.get("text") };
    return validInput(input) ? input : null;
  } catch {
    return null;
  }
}
