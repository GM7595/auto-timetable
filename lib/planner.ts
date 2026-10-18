import type { EventSlot, EventState, Issue, Plan, Schedule, ScheduledSlot, Violation } from "./types";

export type { Issue, Plan, Schedule } from "./types";

export function formatTime(minutes: number): string {
  if (!Number.isFinite(minutes)) return "--:--";
  const value = Math.max(0, Math.round(minutes));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

/** Invalid input returns NaN, so callers can keep the previous valid time. */
export function parseTime(value: string): number {
  const match = value.trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : Number.NaN;
}

function afterQuiet(state: EventState, slot: EventSlot, start: number): number {
  if (slot.kind === "break") return start;
  let result = start;
  const windows = [...state.event.quietWindows].sort((a, b) => a.start - b.start);
  // Moving beyond one window can expose another. No program is split silently.
  for (const window of windows) {
    if (result < window.end && result + slot.durationMinutes > window.start) result = window.end;
  }
  return result;
}

function baselineStarts(state: EventState): Map<string, number> {
  const starts = new Map<string, number>();
  let cursor = state.event.startTime;
  state.slots.forEach((slot, index) => {
    const setup = index === 0 ? 0 : Math.max(0, slot.changeoverMinutes);
    const start = immutable(slot) && slot.fixedStart !== undefined
      ? slot.fixedStart
      : afterQuiet(state, slot, Math.max(cursor + setup, slot.earliestStart ?? 0));
    starts.set(slot.id, start);
    cursor = Math.max(cursor, start + Math.max(0, slot.durationMinutes));
  });
  return starts;
}

function immutable(slot: EventSlot): boolean {
  return slot.locked || slot.status !== "planned";
}

export function computeSchedule(state: EventState, slots: EventSlot[] = state.slots): Schedule {
  const anchors = baselineStarts(state);
  const original = new Map(state.slots.map((slot) => [slot.id, slot]));
  const violations: Violation[] = [];
  const rows: ScheduledSlot[] = [];
  const seen = new Set<string>();
  let cursor = state.event.startTime;
  let contentMinutes = 0;
  let changeoverMinutes = 0;

  slots.forEach((slot, index) => {
    const messages: string[] = [];
    const add = (code: string, message: string, severity: "error" | "warning" = "error") => {
      violations.push({ code, message, slotId: slot.id, severity });
      messages.push(message);
    };
    if (seen.has(slot.id)) add("duplicate-slot", `「${slot.title}」が重複しています。`);
    seen.add(slot.id);
    if (!Number.isFinite(slot.durationMinutes) || slot.durationMinutes <= 0) add("invalid-duration", `「${slot.title}」の所要時間を1分以上にしてください。`);
    if (!Number.isFinite(slot.changeoverMinutes) || slot.changeoverMinutes < 0) add("invalid-changeover", `「${slot.title}」の転換時間が不正です。`);
    const duration = Number.isFinite(slot.durationMinutes) ? Math.max(0, slot.durationMinutes) : 0;
    const setup = index === 0 ? 0 : Number.isFinite(slot.changeoverMinutes) ? Math.max(0, slot.changeoverMinutes) : 0;
    const changeoverStart = cursor;
    const readyAt = Math.max(cursor + setup, slot.earliestStart ?? 0);
    const anchor = anchors.get(slot.id);
    const fixed = immutable(original.get(slot.id) ?? slot) && anchor !== undefined;
    const start = fixed ? anchor : afterQuiet(state, slot, readyAt);
    const end = start + duration;
    if (fixed && start < cursor + setup) add("fixed-overlap", `「${slot.title}」の固定開始 ${formatTime(start)} に転換が間に合いません。`);
    if (slot.earliestStart !== undefined && start < slot.earliestStart) add("unavailable", `「${slot.title}」は ${formatTime(slot.earliestStart)} より前に開始できません。`);
    if (slot.latestEnd !== undefined && end > slot.latestEnd) add("availability", `「${slot.title}」が出演可能時刻 ${formatTime(slot.latestEnd)} を超えます。`);
    if (end > state.event.endTime) add("hard-end", `「${slot.title}」が終了時刻を ${end - state.event.endTime} 分超えます。`);
    if (slot.kind !== "break") {
      for (const window of state.event.quietWindows) {
        if (start < window.end && end > window.start) add("quiet-window", `「${slot.title}」が ${window.label}（${formatTime(window.start)}–${formatTime(window.end)}）と重なります。`);
      }
    }
    const previous = rows.at(-1);
    const sharedPeople = previous?.people.filter((person) => slot.people.includes(person)) ?? [];
    if (previous && sharedPeople.length > 0 && start - previous.end < 10 && slot.kind !== "break") {
      add("performer-rest", `${sharedPeople.join("・")}さんが続けて出演します。準備時間は ${Math.max(0, start - previous.end)} 分です。`, "warning");
    }
    rows.push({ ...slot, start, end, changeoverStart, waitMinutes: Math.max(0, start - cursor - setup), violations: messages });
    cursor = Math.max(cursor, end);
    contentMinutes += duration;
    changeoverMinutes += setup;
  });
  for (const slot of state.slots) {
    if (immutable(slot) && !seen.has(slot.id)) violations.push({ code: "missing-fixed", message: `固定された「${slot.title}」が除かれています。`, slotId: slot.id, severity: "error" });
  }
  if (state.event.endTime <= state.event.startTime) violations.push({ code: "invalid-event-window", message: "終了時刻は開始時刻より後にしてください。", severity: "error" });
  return { rows, endsAt: cursor, contentMinutes, changeoverMinutes, violations, bufferMinutes: state.event.endTime - cursor };
}

const normalize = (value: string) => value.toLowerCase().replace(/[\s　「」『』【】()（）・]/g, "");

export function parseIssue(text: string, state: EventState): Issue | null {
  const clean = text.trim();
  if (!clean) return null;
  const comparable = normalize(clean);
  const matches = state.slots.filter((slot) => normalize(slot.title).length > 1 && comparable.includes(normalize(slot.title)) || normalize(slot.group).length > 1 && comparable.includes(normalize(slot.group)));
  let slot = matches.length === 1 ? matches[0] : undefined;
  if (matches.length > 1) return null;
  if (!slot && /次の|次組|next/i.test(clean)) slot = state.slots.find((item) => item.status === "planned" && item.kind !== "break");
  const minuteMatch = clean.match(/(\d{1,3})\s*(?:分|minutes?|mins?)/i);
  const minutes = minuteMatch ? Number(minuteMatch[1]) : undefined;
  if (/短縮|短く|shorten|reduce/i.test(clean) && minutes && minutes > 0) {
    if (slot?.status === "done") return null;
    // “10分に短縮” specifies a target duration; store the reduction consistently.
    const reduction = slot && /\d+\s*分に/.test(clean) ? slot.durationMinutes - minutes : minutes;
    return reduction > 0 ? { kind: "shorten", slotId: slot?.id, minutes: reduction, text: clean } : null;
  }
  const time = clean.match(/(\d{1,2})[:：](\d{2})|(?:(\d{1,2})時(?:(\d{1,2})分)?)/);
  const hours = time ? Number(time[1] ?? time[3]) : undefined;
  const minutePart = time ? Number(time[2] ?? time[4] ?? 0) : undefined;
  const until = hours !== undefined && minutePart !== undefined && hours < 24 && minutePart < 60 ? hours * 60 + minutePart : undefined;
  const afterTime = time ? clean.slice((time.index ?? 0) + time[0].length).trim() : "";
  const blockedUntil = /まで/.test(afterTime) && /不在|無理|できません|できない|不可|揃わ/.test(afterTime) || /(?:unavailable|not available|cannot|can't).*until/i.test(clean);
  const availableFrom = /^(?:以降|から)/.test(afterTime) && /可能|出演|開始|変更|にして|大丈夫|できます/.test(afterTime) && !/無理|できません|できない|不可|不在/.test(afterTime);
  if (slot && until !== undefined && (blockedUntil || availableFrom)) {
    if (slot.status !== "planned") return null;
    return { kind: "unavailable", slotId: slot.id, until, text: clean };
  }
  // An explicit event finish goal is not a performer's availability condition.
  if (!slot && until !== undefined && /終演|全体|イベント|進行表|終了/.test(clean)
    && /終演|終了|終わ|終え/.test(clean) && !/不在|無理|できません|できない|不可|揃わ/.test(clean)) {
    const reduction = computeSchedule(state).endsAt - until;
    if (reduction > 0) return { kind: "shorten", minutes: reduction, text: clean };
  }
  if (/遅|押し|押して|delay|behind|late/i.test(clean) && minutes && minutes > 0) {
    if (!slot) {
      if (!/全体|進行|いま|今|現在|schedule|running/i.test(clean)) return null;
      slot = state.slots.find((item) => item.status === "active") ?? state.slots.find((item) => item.status === "planned");
    }
    if (!slot || slot.status === "done") return null;
    return { kind: "delay", slotId: slot.id, minutes, text: clean };
  }
  return null;
}

function cloneSlots(slots: EventSlot[]): EventSlot[] {
  return slots.map((slot) => ({ ...slot, people: [...slot.people], equipment: [...slot.equipment] }));
}

function applyIssue(state: EventState, issue: Issue): { slots: EventSlot[]; changes: string[]; tradeoffs: string[] } {
  const slots = cloneSlots(state.slots);
  const changes: string[] = [];
  const tradeoffs: string[] = [];
  const target = slots.find((slot) => slot.id === issue.slotId);
  const old = computeSchedule(state);
  if (issue.kind === "delay" && target && issue.minutes && issue.minutes > 0) {
    if (target.status === "active") {
      target.durationMinutes += issue.minutes;
      changes.push(`進行中の「${target.title}」を ${issue.minutes} 分延長`);
    } else if (target.status === "planned") {
      const row = old.rows.find((item) => item.id === target.id)!;
      target.earliestStart = Math.max(target.earliestStart ?? 0, row.start + issue.minutes);
      changes.push(`「${target.title}」の開始可能時刻を ${formatTime(target.earliestStart)} に変更`);
    }
  } else if (issue.kind === "unavailable" && target && target.status === "planned" && issue.until !== undefined) {
    target.earliestStart = Math.max(target.earliestStart ?? 0, issue.until);
    changes.push(`「${target.title}」は ${formatTime(target.earliestStart)} 以降に出演`);
  } else if (issue.kind === "shorten" && issue.minutes && issue.minutes > 0) {
    let remaining = issue.minutes;
    const eligible = target ? [target] : [...slots.filter((slot) => slot.kind === "break"), ...slots.filter((slot) => slot.kind !== "break")];
    for (const slot of eligible) {
      if (immutable(slot)) continue;
      const capacity = target ? slot.durationMinutes - 1 : slot.kind === "break" ? Math.max(0, slot.durationMinutes - 5) : Math.floor(slot.durationMinutes * 0.2);
      const reduction = Math.min(remaining, capacity);
      if (reduction <= 0) continue;
      slot.durationMinutes -= reduction;
      remaining -= reduction;
      changes.push(`「${slot.title}」を ${reduction} 分短縮（${slot.durationMinutes} 分に変更）`);
      if (remaining === 0) break;
    }
    if (remaining > 0) tradeoffs.push(`固定枠と最低所要時間を守るため、希望の短縮まであと ${remaining} 分不足します。`);
    if (changes.length) tradeoffs.push("短縮する内容は、適用前に出演者・登壇者と確認してください。");
  }
  return { slots, changes, tradeoffs };
}

function signature(slots: EventSlot[]): string {
  return slots.map((slot) => `${slot.id}:${slot.durationMinutes}:${slot.earliestStart ?? ""}`).join("|");
}

const MAX_CANDIDATES = 800;

function reductionCapacity(slot: EventSlot): number {
  if (immutable(slot)) return 0;
  return slot.kind === "break" ? Math.max(0, slot.durationMinutes - 5) : Math.max(0, Math.floor(slot.durationMinutes * 0.2));
}

/**
 * Allocate cuts against the actual finish, not the sum of program durations.
 * Earlier cuts can disappear into a fixed start, availability wait, or quiet
 * window. A bounded set of priority orders explores different allocations;
 * restoring unnecessary cuts keeps a successful plan from over-cutting content.
 */
function shortenToFinish(state: EventState, order: EventSlot[], targetEnd: number, priorities: string[]): EventSlot[] {
  const originals = new Map(state.slots.map((slot) => [slot.id, slot]));
  const slots = cloneSlots(order).map((slot) => ({ ...slot, durationMinutes: originals.get(slot.id)?.durationMinutes ?? slot.durationMinutes }));
  const byId = new Map(slots.map((slot) => [slot.id, slot]));
  const changes: { slot: EventSlot; original: number }[] = [];
  for (const id of priorities) {
    const current = computeSchedule(state, slots);
    if (current.endsAt <= targetEnd && !current.violations.some((item) => item.severity === "error")) break;
    const slot = byId.get(id);
    const original = originals.get(id);
    if (!slot || !original) continue;
    const capacity = reductionCapacity(original);
    if (capacity <= 0) continue;
    changes.push({ slot, original: original.durationMinutes });
    slot.durationMinutes = original.durationMinutes - capacity;
  }
  // Use the target if reachable, otherwise preserve the best attainable finish.
  const shortest = computeSchedule(state, slots);
  const acceptableEnd = Math.max(targetEnd, shortest.endsAt);
  const maxErrors = shortest.violations.filter((item) => item.severity === "error").length;
  for (const change of changes.reverse()) {
    let lower = change.slot.durationMinutes;
    let upper = change.original;
    while (lower < upper) {
      const duration = Math.ceil((lower + upper) / 2);
      change.slot.durationMinutes = duration;
      const schedule = computeSchedule(state, slots);
      if (schedule.endsAt <= acceptableEnd && schedule.violations.filter((item) => item.severity === "error").length <= maxErrors) lower = duration;
      else upper = duration - 1;
    }
    change.slot.durationMinutes = lower;
  }
  return slots;
}

function shorteningAllocations(state: EventState, slots: EventSlot[], targetEnd: number): EventSlot[][] {
  const eligible = slots.filter((slot) => reductionCapacity(slot) > 0);
  const forward = eligible.map((slot) => slot.id);
  const reverse = [...forward].reverse();
  const breaksFirst = [...eligible.filter((slot) => slot.kind === "break"), ...eligible.filter((slot) => slot.kind !== "break")].map((slot) => slot.id);
  const priorities = [reverse, forward, breaksFirst];
  // Sample starting points rather than enumerating factorial allocations.
  for (let index = 0; index < Math.min(eligible.length, 8); index += 1) {
    const id = forward[Math.floor(index * eligible.length / Math.min(eligible.length, 8))];
    priorities.push([id, ...reverse.filter((value) => value !== id)]);
  }
  return priorities.map((priority) => shortenToFinish(state, slots, targetEnd, priority));
}

function costs(state: EventState, slots: EventSlot[]) {
  const schedule = computeSchedule(state, slots);
  const originals = new Map(state.slots.map((slot, index) => [slot.id, index]));
  let movement = 0;
  let flow = 0;
  let equipment = 0;
  let closingCost = 0;
  slots.forEach((slot, index) => {
    movement += Math.abs((originals.get(slot.id) ?? index) - index);
    // Explicit closing titles carry a soft sequencing preference. This remains
    // overridable by availability/end-time constraints and permits teardown later.
    if (/クロージング|閉会|終演挨拶|\bclosing\b|\bwrap[\s-]?up\b/i.test(slot.title)) {
      closingCost += slots.slice(index + 1).filter((later) => later.kind !== "break" && !/クロージング|閉会|撤収|片付|退場|集合写真|\bclosing\b|\bcleanup\b|\bteardown\b|\bphoto\b/i.test(later.title)).length * 250;
    }
    const previous = slots[index - 1];
    if (!previous || slot.kind === "break" || previous.kind === "break") return;
    // This heuristic suggests variety; it does not claim to predict audience response.
    flow += Math.max(0, Math.abs(slot.energy - previous.energy) - 2);
    if (slot.kind === previous.kind) flow += 0.6;
    const shared = slot.equipment.filter((item) => previous.equipment.includes(item)).length;
    equipment += new Set([...slot.equipment, ...previous.equipment]).size - shared;
  });
  const errorCount = schedule.violations.filter((item) => item.severity === "error").length;
  const warnings = schedule.violations.filter((item) => item.severity === "warning").length;
  const wait = schedule.rows.reduce((sum, row) => sum + row.waitMinutes, 0);
  return { schedule, movement, flow, equipment, common: errorCount * 100_000 + Math.max(0, -schedule.bufferMinutes) * 1000 + warnings * 10 + wait * 2 + Math.min(closingCost, 20_000) };
}

export function generatePlans(state: EventState, issue: Issue): Plan[] {
  if (issue.kind === "note") return [];
  const originalSchedule = computeSchedule(state);
  const overallShortening = issue.kind === "shorten" && !issue.slotId && !!issue.minutes && issue.minutes > 0;
  const targetEnd = originalSchedule.endsAt - (overallShortening ? issue.minutes! : 0);
  const applied = overallShortening ? { slots: cloneSlots(state.slots), changes: [], tradeoffs: [] } : applyIssue(state, issue);
  if (applied.changes.length === 0 && !overallShortening) return [];
  // Anchors must survive applying/saving a reordered plan. Derived starts alone
  // would be recalculated from the new order and could move a locked entry.
  const anchors = baselineStarts(state);
  for (const slot of applied.slots) {
    if (immutable(slot)) slot.fixedStart = anchors.get(slot.id);
  }
  const movable = applied.slots.map((slot, index) => immutable(slot) ? -1 : index).filter((index) => index >= 0);
  // A bounded beam also handles events with many entries without factorial work.
  const seeds = overallShortening
    ? [applied.slots, ...shorteningAllocations(state, applied.slots, targetEnd)]
    : [applied.slots];
  const candidates = new Map<string, EventSlot[]>(seeds.map((slots) => [signature(slots), slots]));
  const costCache = new Map<string, ReturnType<typeof costs>>();
  const evaluate = (slots: EventSlot[]) => {
    const key = signature(slots);
    let value = costCache.get(key);
    if (!value) {
      value = costs(state, slots);
      costCache.set(key, value);
    }
    return value;
  };
  const reduction = (slots: EventSlot[]) => originalSchedule.contentMinutes - slots.reduce((sum, slot) => sum + slot.durationMinutes, 0);
  const compareGoal = (a: ReturnType<typeof costs>, b: ReturnType<typeof costs>, aSlots: EventSlot[], bSlots: EventSlot[]) => {
    if (!overallShortening) return 0;
    const aErrors = a.schedule.violations.filter((item) => item.severity === "error").length;
    const bErrors = b.schedule.violations.filter((item) => item.severity === "error").length;
    return Number(aErrors > 0) - Number(bErrors > 0)
      || (aErrors > 0 && bErrors > 0 ? a.common - b.common : 0)
      || Math.max(0, a.schedule.endsAt - targetEnd) - Math.max(0, b.schedule.endsAt - targetEnd)
      || reduction(aSlots) - reduction(bSlots);
  };
  let frontier = [...candidates.values()];
  expand:
  for (let round = 0; round < Math.min(movable.length, 3); round += 1) {
    const expanded: EventSlot[][] = [];
    for (const candidate of frontier) {
      for (let a = 0; a < movable.length; a += 1) {
        for (let b = a + 1; b < movable.length; b += 1) {
          const next = [...candidate];
          [next[movable[a]], next[movable[b]]] = [next[movable[b]], next[movable[a]]];
          const key = signature(next);
          if (candidates.has(key)) continue;
          candidates.set(key, next);
          expanded.push(next);
          if (candidates.size >= MAX_CANDIDATES) break expand;
          // A newly useful order may need a different allocation of cuts. Keep
          // this branch in the same finite candidate budget as order changes.
          if (overallShortening) {
            const allocated = shortenToFinish(state, next, targetEnd, [...next].reverse().map((slot) => slot.id));
            const allocatedKey = signature(allocated);
            if (!candidates.has(allocatedKey)) {
              candidates.set(allocatedKey, allocated);
              expanded.push(allocated);
              if (candidates.size >= MAX_CANDIDATES) break expand;
            }
          }
        }
      }
    }
    frontier = expanded.sort((a, b) => {
      const ca = evaluate(a);
      const cb = evaluate(b);
      return compareGoal(ca, cb, a, b) || ca.common + ca.movement - cb.common - cb.movement || signature(a).localeCompare(signature(b));
    }).slice(0, 24);
    if (!frontier.length) break;
  }
  const evaluated = [...candidates.values()].map((slots) => ({ slots, ...evaluate(slots) }));
  const policies = [
    { id: "minimal", title: "変更を最小限に", description: "決まっている出演順をできるだけ維持します。", weight: (value: typeof evaluated[number]) => value.movement * 5 + value.flow },
    { id: "flow", title: "体験の流れを重視", description: "構成の変化と出演者の準備時間を考慮します。", weight: (value: typeof evaluated[number]) => value.flow * 8 + value.movement * 0.4 },
    { id: "transition", title: "転換をスムーズに", description: "共通の機材を使う枠を近づける案です。", weight: (value: typeof evaluated[number]) => value.equipment * 4 + value.movement * 0.4 },
  ];
  const selected = new Set<string>();
  const plans: Plan[] = [];
  // Once a safe goal-met candidate exists, do not fill remaining policy cards
  // with alternatives that silently miss the requested finish.
  const feasible = overallShortening ? evaluated.filter((item) => !item.schedule.violations.some((violation) => violation.severity === "error")) : [];
  const bestShortfall = feasible.length ? Math.min(...feasible.map((item) => Math.max(0, item.schedule.endsAt - targetEnd))) : undefined;
  const pool = bestShortfall === undefined ? evaluated : feasible.filter((item) => Math.max(0, item.schedule.endsAt - targetEnd) === bestShortfall);
  for (const policy of policies) {
    const ranked = [...pool].sort((a, b) => compareGoal(a, b, a.slots, b.slots) || a.common + policy.weight(a) - b.common - policy.weight(b) || signature(a.slots).localeCompare(signature(b.slots)));
    const best = ranked.find((item) => !selected.has(signature(item.slots)) && item.common < 100_000) ?? (plans.length === 0 ? ranked[0] : undefined);
    if (!best) continue;
    selected.add(signature(best.slots));
    const changes = overallShortening ? best.slots.flatMap((slot) => {
      const original = state.slots.find((item) => item.id === slot.id)!;
      const cut = original.durationMinutes - slot.durationMinutes;
      return cut > 0 ? [`「${slot.title}」を ${cut} 分短縮（${slot.durationMinutes} 分に変更）`] : [];
    }) : [...applied.changes];
    const oldRows = originalSchedule.rows;
    for (const row of best.schedule.rows) {
      const previous = oldRows.find((item) => item.id === row.id);
      if (previous && row.start !== previous.start) changes.push(`「${row.title}」を ${formatTime(previous.start)} → ${formatTime(row.start)} に変更`);
    }
    const errors = best.schedule.violations.filter((item) => item.severity === "error");
    const tradeoffs = overallShortening ? [] : [...applied.tradeoffs];
    const shortening: Plan["shortening"] = overallShortening ? {
      originalEnd: originalSchedule.endsAt,
      targetEnd,
      requestedMinutes: issue.minutes!,
      achievedMinutes: originalSchedule.endsAt - best.schedule.endsAt,
      shortfallMinutes: Math.max(0, best.schedule.endsAt - targetEnd),
      contentReductionMinutes: reduction(best.slots),
      met: errors.length === 0 && best.schedule.endsAt <= targetEnd,
    } : undefined;
    if (shortening) {
      if (!shortening.met) tradeoffs.push(`終演目標 ${formatTime(targetEnd)} に対し ${formatTime(best.schedule.endsAt)} 終了です。実際の前倒しは ${shortening.achievedMinutes} 分、目標まであと ${shortening.shortfallMinutes} 分不足します（内容の短縮は ${shortening.contentReductionMinutes} 分）。`);
      if (shortening.contentReductionMinutes > 0) tradeoffs.push("短縮する内容は、適用前に出演者・登壇者と確認してください。");
      if (errors.length && shortening.shortfallMinutes === 0) tradeoffs.push("終演目標の時刻には収まりますが、制約違反があるため目標達成とは扱いません。");
    }
    if (best.movement > 0) tradeoffs.push("出演順が変わるため、対象者への共有が必要です。");
    if (best.schedule.rows.some((row) => row.waitMinutes > 0)) tradeoffs.push("出演可能時刻・音止め条件に合わせた待ち時間があります。");
    if (errors.length) tradeoffs.push("すべての条件を満たす案が見つかりません。赤い制約を確認してください。");
    const description = shortening ? `${policy.description} 終演 ${formatTime(shortening.originalEnd)} → ${formatTime(best.schedule.endsAt)}（目標 ${formatTime(targetEnd)}・${shortening.met ? "達成" : "未達"}）。` : policy.description;
    plans.push({ id: policy.id, title: policy.title, description, slots: cloneSlots(best.slots), schedule: best.schedule, changes, tradeoffs, score: Math.max(0, Math.round(100 - best.common / 20 - policy.weight(best))), ...(shortening ? { shortening } : {}) });
  }
  return plans;
}
