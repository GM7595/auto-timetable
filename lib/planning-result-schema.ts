import { z } from "zod";

const number = z.number().finite();
// Keep this dependency-free check aligned with member-roles and event snapshots.
const roleIcons = z.custom<Record<string, string>>().superRefine((value, context) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    context.addIssue({ code: "custom", message: "役職の絵文字は役職名との組で指定してください。" });
    return;
  }
  const entries = Object.entries(value);
  if (entries.length > 12) context.addIssue({ code: "custom", message: "役職の絵文字は12件まで指定できます。" });
  const labels = new Set<string>();
  for (const [label, icon] of entries) {
    const normalized = label.trim();
    if (!normalized || normalized.length > 40 || labels.has(normalized)) {
      context.addIssue({ code: "custom", path: [label], message: "役職名が無効または重複しています。" });
    }
    labels.add(normalized);
    const emoji = typeof icon === "string" ? icon.trim() : "";
    const valid = emoji.length > 0 && emoji.length <= 32
      && Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(emoji)).length === 1
      && (/^[#*0-9]\uFE0F?\u20E3$/u.test(emoji) || /^\p{Regional_Indicator}{2}$/u.test(emoji) || /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\u{E0020}-\u{E007F}]*$/u.test(emoji));
    if (!valid) context.addIssue({ code: "custom", path: [label], message: "絵文字を1つ選んでください。" });
  }
}).transform((value) => Object.fromEntries(Object.entries(value as Record<string, string>).map(([label, icon]) => [label.trim(), icon.trim()])));
const members = z.array(z.object({
  name: z.string().trim().min(1).max(160),
  familyName: z.string().trim().max(160).optional(),
  givenName: z.string().trim().max(160).optional(),
  roles: z.array(z.string().trim().min(1).max(40)).max(12)
    .refine((roles) => new Set(roles).size === roles.length, "同じ役割を重複して選択できません。"),
  roleNotRequired: z.boolean().optional(),
  roleIcons: roleIcons.optional(),
}).strict().superRefine((member, context) => {
  if (member.familyName !== undefined || member.givenName !== undefined) {
    if (!member.givenName) context.addIssue({ code: "custom", path: ["givenName"], message: "名を入力してください。" });
    const fullName = [member.familyName ?? "", member.givenName ?? ""].filter(Boolean).join(" ");
    if (member.name !== fullName) context.addIssue({ code: "custom", path: ["name"], message: "氏名と姓・名の組み合わせを一致させてください。" });
  }
  if (member.roles.length === 0 && member.roleNotRequired !== true) {
    context.addIssue({ code: "custom", path: ["roles"], message: "役職を選ぶか「役職なし」を指定してください。" });
  }
  if (member.roles.length > 0 && member.roleNotRequired === true) {
    context.addIssue({ code: "custom", path: ["roleNotRequired"], message: "役職と「役職なし」は同時に指定できません。" });
  }
  for (const label of Object.keys(member.roleIcons ?? {})) {
    if (!member.roles.includes(label)) context.addIssue({ code: "custom", path: ["roleIcons", label], message: "絵文字には選択済みの役職名を指定してください。" });
  }
})).max(30)
  .refine((entries) => new Set(entries.map((member) => member.name)).size === entries.length, "メンバー名が重複しています。");
const slot = z.object({
  id: z.string().min(1).max(120), title: z.string().max(160), group: z.string().max(160),
  kind: z.enum(["talk", "workshop", "live", "break", "other"]),
  durationMinutes: z.number().int().min(1).max(720), changeoverMinutes: z.number().int().min(0).max(180),
  people: z.array(z.string().max(160)).max(30), equipment: z.array(z.string().max(160)).max(30),
  members: members.optional(),
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
}).strict().superRefine((result, context) => {
  result.plans.forEach((plan, planIndex) => {
    const checkMembers = (entry: z.infer<typeof slot>, path: (string | number)[]) => {
      if (entry.members && (entry.members.length !== entry.people.length || entry.members.some((member, index) => member.name !== entry.people[index]))) {
        context.addIssue({ code: "custom", path: [...path, "members"], message: "メンバー名と出演者名を同じ順序で指定してください。" });
      }
    };
    plan.slots.forEach((entry, index) => checkMembers(entry, ["plans", planIndex, "slots", index]));
    plan.schedule.rows.forEach((entry, index) => checkMembers(entry, ["plans", planIndex, "schedule", "rows", index]));
  });
});
