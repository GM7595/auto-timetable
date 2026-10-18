import { z } from "zod";

const number = z.number().finite();
const slot = z.object({
  id: z.string().min(1).max(120), title: z.string().max(160), group: z.string().max(160),
  kind: z.enum(["talk", "workshop", "live", "break", "other"]),
  durationMinutes: z.number().int().min(1).max(720), changeoverMinutes: z.number().int().min(0).max(180),
  people: z.array(z.string().max(160)).max(30), equipment: z.array(z.string().max(160)).max(30),
  earliestStart: number.optional(), latestEnd: number.optional(), fixedStart: number.optional(),
  locked: z.boolean(), status: z.enum(["planned", "active", "done"]), energy: number, notes: z.string().max(2000),
}).strict();
const scheduledSlot = slot.extend({ start: number, end: number, changeoverStart: number, waitMinutes: number, violations: z.array(z.string().max(2000)).max(100) });

// Both proposal reads and inbox acknowledgement use the same strict contract.
// A malformed persisted result must never make an intake item disappear.
export const planningResultSchema = z.object({
  plans: z.array(z.object({
    id: z.string().min(1).max(120), title: z.string().max(2000), description: z.string().max(2000),
    slots: z.array(slot).max(80),
    schedule: z.object({
      rows: z.array(scheduledSlot).max(80), endsAt: number, contentMinutes: number, changeoverMinutes: number,
      violations: z.array(z.object({ code: z.string().max(120), message: z.string().max(2000), slotId: z.string().max(120).optional(), severity: z.enum(["error", "warning"]) }).strict()).max(500),
      bufferMinutes: number,
    }).strict(),
    changes: z.array(z.string().max(2000)).max(200), tradeoffs: z.array(z.string().max(2000)).max(200), score: number,
    shortening: z.object({
      originalEnd: number, targetEnd: number, requestedMinutes: number,
      achievedMinutes: number, shortfallMinutes: number, contentReductionMinutes: number, met: z.boolean(),
    }).strict().optional(),
  }).strict()).min(1).max(3),
  issue: z.object({ kind: z.enum(["delay", "unavailable", "shorten", "note"]), slotId: z.string().max(120).optional(), minutes: number.optional(), until: number.optional(), text: z.string().max(2000) }).strict(),
  engine: z.enum(["decisions", "rules"]), aiStatus: z.enum(["used", "not-configured", "not-needed", "fallback"]),
  elapsedMs: number, notice: z.string().max(4000).optional(),
  decisions: z.object({
    status: z.enum(["used", "failed"]), model: z.string().max(120), elapsedMs: number,
    failureKind: z.enum(["authentication", "permission", "quota", "rate-limit", "timeout", "transport", "invalid-response", "upstream"]).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z.enum(["invalid_api_key", "insufficient_quota", "rate_limit_exceeded", "model_not_found", "permission_denied", "invalid_request_error", "unsupported_country_region_territory", "unknown"]).optional(),
  }).strict().optional(),
}).strict();
