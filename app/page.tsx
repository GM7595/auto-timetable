"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpRight, Bot, CalendarDays, CalendarPlus, Check, CheckCircle2, ChevronDown, Clock3, Download, FileJson, FileSpreadsheet, History, Loader2, LockKeyhole, Pencil, Plug2, Plus, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import { demoState, createEmptyState } from "@/lib/demo";
import { computeSchedule, formatTime, generatePlans, parseIssue, parseTime } from "@/lib/planner";
import type { EventState, EventSlot, Plan, HistoryEntry } from "@/lib/types";
import { Timetable } from "@/components/timetable";
import { ThemeControl } from "@/components/theme-control";
import { dotMonitoringInstructions, dotSetupInstructions } from "@/lib/dots-instructions";
import { parseProposalReviewHash, type ProposalReviewLink } from "@/lib/proposal-review-link";
import type { AgentProposal } from "@/lib/agent-proposals";
import type { DecisionsConnectionResult, PlanningResult } from "@/lib/decisions";
import type { ChangeRequest } from "@/lib/change-requests";
import { getEventTiming, getTimedSchedule } from "@/lib/event-timing";

type SaveStatus = "loading" | "saved" | "saving" | "local" | "error";
type EventDeliveryStatus = { activeSubscriptions: number; pendingDeliveries: number; failedDeliveries?: number; lastDeliveredAt: string | null; lastFailure?: string | null };
type EventSummary = { id: string; name: string; date: string; location: string; startTime: number; endTime: number; slotCount: number; updatedAt: string };
const STORAGE_KEY = "cue.event.v1";
const KIND: Record<EventSlot["kind"], { label: string }> = {
  talk: { label: "トーク" },
  workshop: { label: "ワークショップ" },
  live: { label: "ライブ" },
  break: { label: "休憩" },
  other: { label: "その他" },
};
const uid = () => crypto.randomUUID();
const timeLabel = (at: string) => new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tokyo" });
const dateLabel = (date: string) => new Date(`${date}T00:00:00+09:00`).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "Asia/Tokyo" });
const peopleList = (text: string) => text.split(/[,、\n]/).map(x => x.trim()).filter(Boolean);
function historyItem(title: string, detail: string, kind: HistoryEntry["kind"] = "edit"): HistoryEntry {
  return { id: uid(), at: new Date().toISOString(), title, detail, kind };
}

function Dialog({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const elements = () => Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]') ?? []);
    (ref.current?.querySelector<HTMLElement>("input") ?? elements()[0])?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key === "Tab") {
        const all = elements();
        if (event.shiftKey && document.activeElement === all[0]) { event.preventDefault(); all.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === all.at(-1)) { event.preventDefault(); all[0]?.focus(); }
      }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}><header className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="閉じる"><X size={20} /></button></header>{children}</div></div>;
}

function SlotForm({ slot, currentStart, onSave, onClose, onDelete }: { slot: EventSlot | null; currentStart?: number; onSave: (slot: EventSlot) => void; onClose: () => void; onDelete?: () => void }) {
  const [error, setError] = useState("");
  return <Dialog title={slot ? "進行枠を編集" : "進行枠を追加"} subtitle="出演者・所要時間・準備条件をまとめて管理します。" onClose={onClose}>
    <form onSubmit={e => {
      e.preventDefault(); const data = new FormData(e.currentTarget);
      const earliest = String(data.get("earliest") || ""), latest = String(data.get("latest") || "");
      if (earliest && latest && parseTime(earliest) >= parseTime(latest)) { setError("出演可能時間の終了は開始より後にしてください。"); return; }
      const title = String(data.get("title") || "").trim();
      if (!title) { setError("タイトルを入力してください。"); return; }
      const locked = data.get("locked") === "on";
      onSave({ id: slot?.id ?? uid(), title, group: String(data.get("group") || "").trim(), kind: String(data.get("kind")) as EventSlot["kind"], durationMinutes: Number(data.get("duration")), changeoverMinutes: Number(data.get("changeover")), people: peopleList(String(data.get("people") || "")), equipment: peopleList(String(data.get("equipment") || "")), earliestStart: earliest ? parseTime(earliest) : undefined, latestEnd: latest ? parseTime(latest) : undefined, fixedStart: slot?.status === "done" || slot?.status === "active" ? slot.fixedStart ?? currentStart : locked ? slot?.fixedStart ?? currentStart : undefined, locked, status: slot?.status ?? "planned", energy: Number(data.get("energy")), notes: String(data.get("notes") || "").trim() });
    }}>
      <div className="form-body">
        <label className="field">タイトル <span className="required">必須</span><input name="title" placeholder="例：プロダクトデモ＆トーク" maxLength={160} required defaultValue={slot?.title} /></label>
        <label className="field">出演者・グループ名<input name="group" placeholder="例：チーム Horizon" maxLength={160} defaultValue={slot?.group} /></label>
        <div className="form-grid"><label className="field">本編の時間<div className="input-unit"><input type="number" min="1" max="240" name="duration" defaultValue={slot?.durationMinutes ?? 20} required /><span>分</span></div></label><label className="field">この枠の前の準備・転換<div className="input-unit"><input type="number" min="0" max="90" name="changeover" defaultValue={slot?.changeoverMinutes ?? 5} required /><span>分</span></div></label></div>
        <details className="advanced-fields"><summary>メンバー・機材・詳細条件{slot?.locked ? "（時刻固定）" : ""}</summary><div className="advanced-fields-body">
        <label className="field">カテゴリー<select name="kind" defaultValue={slot?.kind ?? "talk"}>{Object.entries(KIND).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <label className="field">担当メンバー<input name="people" placeholder="例：田中、鈴木、佐藤（読点で区切る）" defaultValue={slot?.people.join("、")} maxLength={1000} /></label>
        <label className="field">必要な設備・機材<input name="equipment" placeholder="例：マイク、プロジェクター" defaultValue={slot?.equipment.join("、")} maxLength={1000} /></label>
        <div className="field-section"><span>出演可能時間 <small>指定がない場合は空欄</small></span><div className="form-grid"><label className="field">この時刻以降<input type="time" name="earliest" defaultValue={slot?.earliestStart === undefined ? "" : formatTime(slot.earliestStart)} /></label><label className="field">この時刻までに終了<input type="time" name="latest" defaultValue={slot?.latestEnd === undefined ? "" : formatTime(slot.latestEnd)} /></label></div></div>
        <label className="field">雰囲気・エネルギー<select name="energy" defaultValue={slot?.energy ?? 3}><option value="1">1 — 落ち着いて聴く</option><option value="2">2 — ゆったり楽しむ</option><option value="3">3 — バランスよく</option><option value="4">4 — 活気をつくる</option><option value="5">5 — 会場を盛り上げる</option></select></label>
        <label className="field">メモ<textarea name="notes" rows={2} placeholder="出演条件や、進行上の希望など" defaultValue={slot?.notes} maxLength={2000} /></label>
        <label className="checkbox-field"><input type="checkbox" name="locked" defaultChecked={slot?.locked} /><LockKeyhole size={15} />出演時刻を固定する</label>
        </div></details>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="modal-footer"><div>{slot && onDelete && slot.status === "planned" && <button type="button" className="danger-link" onClick={onDelete}><Trash2 size={15} />この枠を削除</button>}</div><div><button type="button" className="button secondary" onClick={onClose}>キャンセル</button><button className="button primary" type="submit"><Check size={16} />{slot ? "変更を保存" : "追加する"}</button></div></footer>
    </form>
  </Dialog>;
}

function EventForm({ state, onSave, onClose }: { state: EventState; onSave: (state: EventState) => void; onClose: () => void }) {
  const [quiet, setQuiet] = useState(state.event.quietWindows), [error, setError] = useState("");
  return <Dialog title="イベント設定" subtitle="開催時間と、進行を組むための基本条件。" onClose={onClose}>
    <form onSubmit={e => {
      e.preventDefault(); const data = new FormData(e.currentTarget), startTime = parseTime(String(data.get("start"))), endTime = parseTime(String(data.get("end")));
      if (endTime <= startTime) { setError("終了時刻は開始より後にしてください。同日開催に対応しています。"); return; }
      if (quiet.some(q => q.end <= q.start || q.start < startTime || q.end > endTime)) { setError("音出し不可時間は開催時間内に指定してください。"); return; }
      onSave({ ...state, event: { ...state.event, name: String(data.get("name")).trim(), date: String(data.get("date")), location: String(data.get("location")).trim(), startTime, endTime, quietWindows: quiet } });
    }}><div className="form-body">
      <label className="field">イベント名<input name="name" defaultValue={state.event.name} required maxLength={160} /></label>
      <div className="form-grid"><label className="field">開催日<input name="date" type="date" defaultValue={state.event.date} required /></label><label className="field">会場<input name="location" defaultValue={state.event.location} placeholder="会場名" maxLength={160} /></label></div>
      <div className="form-grid"><label className="field">開始時刻<input name="start" type="time" defaultValue={formatTime(state.event.startTime)} required /></label><label className="field">音止め・終了時刻<input name="end" type="time" defaultValue={formatTime(state.event.endTime)} required /></label></div>
      <div className="field-section"><div className="section-line"><span>音出し不可時間</span><button className="text-button" type="button" onClick={() => setQuiet([...quiet, { id: uid(), label: "音出し不可", start: state.event.startTime + 60, end: state.event.startTime + 70 }])}><Plus size={14} />追加</button></div><p className="field-hint">この時間を避けて本編を配置します。</p>{quiet.map((q, i) => <div className="quiet-editor" key={q.id}><input aria-label={`音出し不可${i + 1}の名称`} value={q.label} onChange={e => setQuiet(quiet.map(x => x.id === q.id ? { ...x, label: e.target.value } : x))} maxLength={80} /><input aria-label={`音出し不可${i + 1}の開始`} type="time" value={formatTime(q.start)} onChange={e => setQuiet(quiet.map(x => x.id === q.id ? { ...x, start: parseTime(e.target.value) } : x))} required /><span>–</span><input aria-label={`音出し不可${i + 1}の終了`} type="time" value={formatTime(q.end)} onChange={e => setQuiet(quiet.map(x => x.id === q.id ? { ...x, end: parseTime(e.target.value) } : x))} required /><button type="button" className="icon-button" aria-label="音出し不可時間を削除" onClick={() => setQuiet(quiet.filter(x => x.id !== q.id))}><X size={16} /></button></div>)}</div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><span /><div><button className="button secondary" type="button" onClick={onClose}>キャンセル</button><button className="button primary" type="submit"><Check size={16} />設定を保存</button></div></footer></form>
  </Dialog>;
}

export default function Home() {
  const [state, setState] = useState<EventState>(demoState), stateRef = useRef(state);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("loading"), [storage, setStorage] = useState<"cloud" | "local">("local");
  const [aiConfigured, setAiConfigured] = useState(false), [filter, setFilter] = useState("all"), [panel, setPanel] = useState<"history" | "connections" | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const exportMenuRef = useRef<HTMLDetailsElement>(null);
  const [slotEditor, setSlotEditor] = useState<EventSlot | "new" | null>(null), [settingsOpen, setSettingsOpen] = useState(false), [resetOpen, setResetOpen] = useState(false), [newEventOpen, setNewEventOpen] = useState(false);
  const [issueText, setIssueText] = useState(""), [plannedText, setPlannedText] = useState(""), [planning, setPlanning] = useState(false), [plans, setPlans] = useState<Plan[]>([]), [previewPlan, setPreviewPlan] = useState<Plan | null>(null), [planError, setPlanError] = useState("");
  const [planMeta, setPlanMeta] = useState<Pick<PlanningResult, "engine" | "elapsedMs" | "aiStatus" | "notice" | "decisions"> | null>(null), [toast, setToast] = useState("");
  const [decisionCheck, setDecisionCheck] = useState<DecisionsConnectionResult | null>(null), [checkingDecision, setCheckingDecision] = useState(false);
  const [agentProposals, setAgentProposals] = useState<AgentProposal[]>([]), [agentLoadError, setAgentLoadError] = useState("");
  const saveQueue = useRef(Promise.resolve()), serverRevision = useRef(0), planBaseRevision = useRef<number | null>(null), toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handledReviewLink = useRef<string | null>(null);
  const planRequestInFlight = useRef(false);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]), [pendingChangeCount, setPendingChangeCount] = useState(0), [queueing, setQueueing] = useState(false);
  const queueRequestInFlight = useRef(false), queueRetry = useRef<{ eventId: string; revision: number; text: string; id: string } | null>(null);
  const [receivedEventDelivery, setEventDelivery] = useState<(EventDeliveryStatus & { eventId: string }) | null>(null);
  const [eventListOpen, setEventListOpen] = useState(false), [eventSummaries, setEventSummaries] = useState<EventSummary[]>([]), [eventListLoading, setEventListLoading] = useState(false), [eventSwitching, setEventSwitching] = useState(false);
  const [clockNow, setClockNow] = useState<number | null>(null), [eventListError, setEventListError] = useState("");
  const switchInFlight = useRef(false);
  const pendingSaves = useRef(0);
  const [activeProposalId, setActiveProposalId] = useState<string | null>(null), activeProposalRef = useRef<string | null>(null);
  const [proposalMutationId, setProposalMutationId] = useState<string | null>(null), proposalMutationInFlight = useRef(false);
  const [undoProposal, setUndoProposal] = useState<AgentProposal | null>(null), proposalInboxGeneration = useRef(0);
  const eventDelivery = receivedEventDelivery?.eventId === state.event.id ? receivedEventDelivery : null;
  const schedule = useMemo(() => computeSchedule(state), [state]);
  const visibleSchedule = previewPlan ? { ...previewPlan.schedule, rows: previewPlan.schedule.rows.map(row => ({ ...row, status: "planned" as const })) } : getTimedSchedule(state, schedule, clockNow ?? Number.NEGATIVE_INFINITY);
  const timing = clockNow === null ? null : getEventTiming(state, schedule, clockNow);
  const errors = schedule.violations.filter(x => x.severity === "error");
  const decisionHttpStatus = decisionCheck?.decisions?.status === "failed" ? decisionCheck.decisions.httpStatus : undefined;
  function notify(message: string, undo?: AgentProposal) { setToast(message); setUndoProposal(undo ?? null); if (toastTimeout.current) clearTimeout(toastTimeout.current); toastTimeout.current = setTimeout(() => { setToast(""); setUndoProposal(null); }, undo ? 10000 : 4500); }
  function menuAction(action: () => void) {
    for (const ref of [menuRef, exportMenuRef]) if (ref.current) ref.current.open = false;
    action();
  }
  function selectProposal(id: string | null) { activeProposalRef.current = id; setActiveProposalId(id); }
  function closePlans() { setPlans([]); setPreviewPlan(null); setPlanMeta(null); planBaseRevision.current = null; selectProposal(null); }
  function updateIssue(text: string) { setIssueText(text); closePlans(); setPlanError(""); }
  function removePlan(id: string) {
    const remaining = plans.filter(plan => plan.id !== id);
    if (!remaining.length) closePlans();
    else { setPlans(remaining); if (previewPlan?.id === id) setPreviewPlan(null); }
  }

  useEffect(() => {
    const menus = [menuRef, exportMenuRef];
    const outside = (event: MouseEvent) => {
      for (const ref of menus) if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const openMenu = menus.find(ref => ref.current?.open)?.current;
      if (event.key === "Escape" && openMenu) {
        event.preventDefault();
        for (const ref of menus) if (ref.current) ref.current.open = false;
        openMenu.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    document.addEventListener("click", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", outside); document.removeEventListener("keydown", escape); };
  }, []);

  useEffect(() => {
    let alive = true;
    async function load() {
      let local: EventState | null = null;
      try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) { const parsed = JSON.parse(raw); if (parsed.event && Array.isArray(parsed.slots) && Array.isArray(parsed.history) && Number.isInteger(parsed.revision)) local = parsed; } } catch { /* Ignore corrupt device drafts. */ }
      try {
        const response = await fetch("/api/event", { cache: "no-store" }); if (!response.ok) throw new Error("unavailable");
        const result = await response.json() as { state: EventState; aiConfigured?: boolean }; if (!alive) return;
        if (!result.state?.event || !Array.isArray(result.state.slots)) throw new Error("invalid");
        stateRef.current = result.state; setState(result.state); serverRevision.current = result.state.revision; setStorage("cloud"); setSaveStatus("saved"); setAiConfigured(Boolean(result.aiConfigured));
      } catch {
        if (!alive) return; const initial = local ?? structuredClone(demoState); stateRef.current = initial; setState(initial); setStorage("local"); setSaveStatus("local");
        try { const result = await (await fetch("/api/status")).json() as { decisionsConfigured?: boolean }; if (alive) setAiConfigured(Boolean(result.decisionsConfigured)); } catch { /* Keep device mode. */ }
      }
    }
    void load(); return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (storage !== "cloud") return;
    let alive = true;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      const generation = proposalInboxGeneration.current;
      try {
        const [response, inboxResponse] = await Promise.all([fetch("/api/agent", { cache: "no-store" }), fetch("/api/changes", { cache: "no-store" })]);
        if (!response.ok || !inboxResponse.ok) throw new Error("unavailable");
        const result = await response.json() as { proposals?: AgentProposal[] };
        const inbox = await inboxResponse.json() as { eventId?: string; requests?: ChangeRequest[]; pendingRequests?: ChangeRequest[]; pendingCount?: number; events?: EventDeliveryStatus | null };
        if (!alive || stateRef.current.event.id !== state.event.id) return;
        if (generation !== proposalInboxGeneration.current || proposalMutationInFlight.current) return;
        if (inbox.eventId !== state.event.id) { setAgentLoadError("別の画面でイベントが切り替わりました。再読み込みして最新のイベントを開いてください。"); return; }
        if (alive) { setAgentProposals(Array.isArray(result.proposals) ? result.proposals : []); setChangeRequests(Array.isArray(inbox.pendingRequests) ? inbox.pendingRequests : Array.isArray(inbox.requests) ? inbox.requests : []); setPendingChangeCount(Number.isSafeInteger(inbox.pendingCount) && inbox.pendingCount! >= 0 ? inbox.pendingCount! : 0); setEventDelivery(inbox.events ? { ...inbox.events, eventId: state.event.id } : null); setAgentLoadError(""); }
      } catch { if (alive) setAgentLoadError("エージェントの提案を取得できません。時間をおいて再度開いてください。"); }
    };
    void load();
    const interval = setInterval(() => void load(), 15000);
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { alive = false; clearInterval(interval); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [storage, state.event.id, state.revision]);

  useEffect(() => {
    if (storage !== "cloud" || saveStatus !== "saved" || planning || queueing) return;
    const review = () => {
      if (planRequestInFlight.current || queueRequestInFlight.current) return;
      const hash = window.location.hash;
      if (!hash || handledReviewLink.current === hash) return;
      const link = parseProposalReviewHash(hash);
      if (!link && !/^#review(?:=|&|$)/.test(hash)) return;
      handledReviewLink.current = hash;
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      if (!link) { setPlanError("再比較リンクが正しくありません。dotにリンクを作り直してもらってください。"); return; }
      const current = stateRef.current;
      if (link.eventId !== current.event.id) { setPlanError("別のイベントへの依頼です。現在のイベントでリンクを作り直してください。"); return; }
      updateIssue(link.text);
      setPanel(null);
      void requestPlans(link.text, true, link);
    };
    review();
    window.addEventListener("hashchange", review);
    return () => window.removeEventListener("hashchange", review);
  }, [storage, saveStatus, state.event.id, state.revision, planning, queueing]);

  useEffect(() => {
    const tick = () => setClockNow(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(interval); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, []);

  useEffect(() => {
    if (!eventListOpen || storage !== "cloud") return;
    let alive = true;
    setEventListLoading(true); setEventListError("");
    void (async () => {
      try {
        const response = await fetch("/api/events", { cache: "no-store" });
        const result = await response.json() as { events?: EventSummary[] };
        if (!response.ok || !Array.isArray(result.events)) throw new Error("unavailable");
        if (alive) setEventSummaries(result.events);
      } catch { if (alive) setEventListError("イベント一覧を読み込めませんでした。閉じてからもう一度開いてください。"); }
      finally { if (alive) setEventListLoading(false); }
    })();
    return () => { alive = false; };
  }, [eventListOpen, storage, state.event.id, state.revision]);

  async function switchEvent(eventId: string) {
    if (eventId === stateRef.current.event.id) { setEventListOpen(false); return; }
    if (switchInFlight.current || proposalMutationInFlight.current || pendingSaves.current > 0 || stateRef.current.revision !== serverRevision.current || planning || planRequestInFlight.current || queueRequestInFlight.current || queueing || saveStatus !== "saved" || storage !== "cloud") return;
    switchInFlight.current = true; setEventSwitching(true); setEventListError("");
    const snapshot = stateRef.current;
    try {
      const response = await fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventId, expectedRevision: serverRevision.current }) });
      const result = await response.json() as { state?: EventState; error?: string };
      if (!response.ok || !result.state || result.state.event.id !== eventId) throw new Error(result.error ?? "イベントを切り替えられませんでした。");
      if (stateRef.current !== snapshot) throw new Error("切り替え中に進行が変更されました。再読み込みして保存状態を確認してください。");
      stateRef.current = result.state; setState(result.state); serverRevision.current = result.state.revision;
      closePlans(); setPlanError(""); setIssueText(""); setPlannedText("");
      setAgentProposals([]); setChangeRequests([]); setPendingChangeCount(0); setEventDelivery(null); setAgentLoadError(""); setFilter("all"); setEventListOpen(false);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(result.state)); } catch { /* Cloud state is authoritative. */ }
      notify("イベントを切り替えました。");
    } catch (error) { setEventListError(error instanceof Error ? error.message : "イベントを切り替えられませんでした。"); }
    finally { switchInFlight.current = false; setEventSwitching(false); }
  }

  async function checkDecisionConnection() {
    if (checkingDecision) return;
    setCheckingDecision(true);
    try {
      const response = await fetch("/api/decisions/check", { method: "POST" });
      if (!response.ok) throw new Error("unavailable");
      const result = await response.json() as DecisionsConnectionResult;
      setDecisionCheck(result); setAiConfigured(result.configured);
    } catch { setDecisionCheck({ configured: aiConfigured, aiStatus: "fallback", notice: "接続確認を完了できませんでした。少し待って再度お試しください。" }); }
    finally { setCheckingDecision(false); }
  }

  async function queueChange() {
    const text = issueText.trim(), snapshot = stateRef.current;
    if (!text || proposalMutationInFlight.current || switchInFlight.current || pendingSaves.current > 0 || queueRequestInFlight.current || planRequestInFlight.current || planning || storage !== "cloud" || saveStatus !== "saved") return;
    queueRequestInFlight.current = true; setQueueing(true); setPlanError("");
    if (!queueRetry.current || queueRetry.current.eventId !== snapshot.event.id || queueRetry.current.revision !== snapshot.revision || queueRetry.current.text !== text) queueRetry.current = { eventId: snapshot.event.id, revision: snapshot.revision, text, id: uid() };
    try {
      const response = await fetch("/api/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, expectedRevision: snapshot.revision, requestId: queueRetry.current.id }) });
      const result = await response.json() as { request?: ChangeRequest; pendingCount?: number; events?: EventDeliveryStatus; error?: string };
      if (!response.ok || !result.request) throw new Error(response.ok ? "変更の受付を確認できませんでした。もう一度お試しください。" : result.error ?? "変更を受け付けられませんでした。再読み込みしてお試しください。");
      queueRetry.current = null;
      if (stateRef.current.event.id === snapshot.event.id && stateRef.current.revision === snapshot.revision) {
        const accepted = result.request;
        setChangeRequests(previous => [accepted, ...previous.filter(request => request.id !== accepted.id)].slice(0, 20));
        if (Number.isSafeInteger(result.pendingCount) && result.pendingCount! >= 0) setPendingChangeCount(result.pendingCount!);
        else if (accepted.status === "pending" && !changeRequests.some(request => request.id === accepted.id)) setPendingChangeCount(previous => previous + 1);
        if (result.events) setEventDelivery({ ...result.events, eventId: snapshot.event.id });
        updateIssue("");
      }
      notify("変更を受け付けました。イベント購読を設定したdotが候補を作成します。タイテは未反映です。");
    } catch { setPlanError("変更を受け付けられませんでした。入力内容は残っています。保存状態を確認して再度お試しください。"); }
    finally { queueRequestInFlight.current = false; setQueueing(false); }
  }

  function reviewAgentProposal(proposal: AgentProposal) {
    if (planRequestInFlight.current || proposalMutationInFlight.current || switchInFlight.current || planning) return;
    if (activeProposalRef.current === proposal.id) { closePlans(); return; }
    if (queueRequestInFlight.current) { notify("変更の受付中です。完了してから提案を確認してください。"); return; }
    const current = stateRef.current;
    if (proposal.eventId !== current.event.id || proposal.baseRevision > current.revision || saveStatus !== "saved") {
      notify("現在のイベントの保存状態を確認して、もう一度お試しください。"); return;
    }
    if (proposal.baseRevision < current.revision) {
      updateIssue(proposal.text);
      void requestPlans(proposal.text, true, { eventId: proposal.eventId, revision: proposal.baseRevision, text: proposal.text }, proposal.id);
      return;
    }
    if (proposal.result.plans.some(plan => computeSchedule(current, plan.slots).violations.some(v => v.severity === "error"))) {
      notify("現在の条件で成立しない提案です。最新の条件で再提案してください。"); return;
    }
    planBaseRevision.current = proposal.baseRevision;
    setIssueText(proposal.text); setPlannedText(proposal.text); setPlanError("");
    const original = computeSchedule(current), issue = proposal.result.issue;
    const reviewed = proposal.result.plans.map(plan => {
      const schedule = computeSchedule(current, plan.slots);
      if (issue.kind !== "shorten" || issue.slotId || !issue.minutes || issue.minutes <= 0) return { ...plan, schedule };
      const targetEnd = original.endsAt - issue.minutes;
      return { ...plan, schedule, shortening: { originalEnd: original.endsAt, targetEnd, requestedMinutes: issue.minutes, achievedMinutes: original.endsAt - schedule.endsAt, shortfallMinutes: Math.max(0, schedule.endsAt - targetEnd), contentReductionMinutes: original.contentMinutes - schedule.contentMinutes, met: schedule.endsAt <= targetEnd && !schedule.violations.some(violation => violation.severity === "error") } };
    });
    setPlans(reviewed); setPlanMeta(proposal.result);
    setPreviewPlan(null); selectProposal(proposal.id);
  }

  async function setProposalVisibility(proposal: AgentProposal, restore = false) {
    if (proposalMutationInFlight.current || planRequestInFlight.current || queueRequestInFlight.current || switchInFlight.current || pendingSaves.current > 0 || planning || saveStatus !== "saved" || storage !== "cloud" || proposal.eventId !== stateRef.current.event.id) return;
    const snapshot = stateRef.current;
    proposalMutationInFlight.current = true; proposalInboxGeneration.current += 1; setProposalMutationId(proposal.id);
    try {
      const response = await fetch("/api/agent", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: restore ? "restore" : "dismiss", proposalId: proposal.id, eventId: snapshot.event.id, expectedRevision: snapshot.revision }) });
      const result = await response.json() as { proposalId?: string; eventId?: string; dismissed?: boolean; error?: string };
      if (!response.ok || result.proposalId !== proposal.id || result.eventId !== snapshot.event.id || result.dismissed !== !restore) throw new Error(result.error ?? "提案の状態を更新できませんでした。");
      if (stateRef.current.event.id !== snapshot.event.id) return;
      if (restore) {
        setAgentProposals(previous => previous.some(entry => entry.id === proposal.id) ? previous : [proposal, ...previous]);
        notify("提案を元に戻しました。");
      } else {
        setAgentProposals(previous => previous.filter(entry => entry.id !== proposal.id));
        if (activeProposalRef.current === proposal.id) closePlans();
        notify("提案を削除しました。", proposal);
      }
    } catch { notify(restore ? "提案を元に戻せませんでした。もう一度お試しください。" : "提案を削除できませんでした。再読み込みして保存状態を確認してください。"); }
    finally { proposalMutationInFlight.current = false; proposalInboxGeneration.current += 1; setProposalMutationId(null); }
  }

  function commit(updated: EventState, entry: HistoryEntry) {
    if (switchInFlight.current) return;
    const previous = stateRef.current, nextState = { ...updated, revision: previous.revision + 1, history: [entry, ...(updated.event.id === previous.event.id ? previous.history : updated.history)].slice(0, 100) };
    if (nextState.event.id !== previous.event.id) { setEventDelivery(null); setPendingChangeCount(0); }
    stateRef.current = nextState; setState(nextState); closePlans(); setPlanError("");
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState)); } catch { notify("端末への保存に失敗しました。バックアップを書き出してください。"); }
    if (storage !== "cloud") { setSaveStatus("local"); return; }
    pendingSaves.current += 1; setSaveStatus("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const response = await fetch("/api/event", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: { ...nextState, revision: serverRevision.current }, expectedRevision: serverRevision.current }) });
        const result = await response.json() as { state?: EventState; error?: string };
        if (!response.ok) throw new Error(response.status === 409 ? "別の画面で更新されています。変更をJSONで保存してから再読み込みしてください。" : result.error ?? "クラウドへの保存に失敗しました。変更はこの端末に残っています。");
        serverRevision.current = result.state?.revision ?? nextState.revision;
        if (pendingSaves.current === 1) setSaveStatus(serverRevision.current === stateRef.current.revision ? "saved" : "error");
      } catch (error) { setSaveStatus("error"); notify(error instanceof Error ? error.message : "保存できませんでした。"); }
      finally { pendingSaves.current -= 1; }
    });
  }

  async function requestPlans(textOverride?: string, fromReviewLink = false, reviewLink?: ProposalReviewLink, sourceProposalId?: string) {
    const text = (textOverride ?? issueText).trim();
    if (!text || planning || proposalMutationInFlight.current || planRequestInFlight.current || queueRequestInFlight.current || switchInFlight.current || pendingSaves.current > 0) return;
    planRequestInFlight.current = true;
    setPlannedText(text);
    setPlanning(true); setPlanError(""); closePlans();
    if (sourceProposalId) { proposalMutationInFlight.current = true; proposalInboxGeneration.current += 1; setProposalMutationId(sourceProposalId); }
    const started = performance.now(); let snapshot = stateRef.current, refreshedOldRequest = false;
    try {
      if (reviewLink) {
        const response = await fetch("/api/event", { cache: "no-store" });
        if (!response.ok) throw new Error("unavailable");
        const latest = (await response.json() as { state: EventState }).state;
        if (!latest?.event || !Array.isArray(latest.slots) || !Number.isSafeInteger(latest.revision)) throw new Error("unavailable");
        if (stateRef.current !== snapshot) throw Object.assign(new Error("確認中に進行が変更されました。最新の条件で再作成してください。"), { userError: true });
        if (latest.event.id !== reviewLink.eventId) throw Object.assign(new Error("別のイベントへの依頼です。現在のイベントでリンクを作り直してください。"), { userError: true });
        if (latest.revision < reviewLink.revision) throw Object.assign(new Error("この依頼より新しい進行表を取得できませんでした。少し待ってもう一度開いてください。"), { userError: true });
        refreshedOldRequest = latest.revision > reviewLink.revision;
        snapshot = latest; stateRef.current = latest; setState(latest); serverRevision.current = latest.revision;
      }
      planBaseRevision.current = snapshot.revision;
      const response = await fetch(sourceProposalId ? "/api/agent" : "/api/plans", { method: sourceProposalId ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sourceProposalId ? { action: "refresh", proposalId: sourceProposalId, eventId: snapshot.event.id, expectedRevision: snapshot.revision } : { state: snapshot, text }) });
      const payload = await response.json() as PlanningResult & { error?: string; proposal?: AgentProposal };
      if (!response.ok) throw Object.assign(new Error(payload.error ?? "条件を読み取れませんでした。"), { userError: response.status < 500 });
      const result = sourceProposalId ? payload.proposal?.result : payload;
      if (!result || sourceProposalId && (payload.proposal?.id !== sourceProposalId || payload.proposal.eventId !== snapshot.event.id || payload.proposal.baseRevision !== snapshot.revision || payload.proposal.text !== text)) throw new Error("invalid_proposal");
      if (stateRef.current !== snapshot) throw Object.assign(new Error("作成中に進行が変更されました。最新の条件で再作成してください。"), { userError: true });
      if (sourceProposalId && payload.proposal) { const refreshed = payload.proposal; setAgentProposals(previous => previous.map(proposal => proposal.id === refreshed.id ? refreshed : proposal)); selectProposal(sourceProposalId); }
      setPlans(result.plans ?? []); setPlanMeta({ ...result, notice: [fromReviewLink ? refreshedOldRequest ? "更新前の依頼を最新の条件で再比較しました（未反映）。" : "依頼を現在の条件で再比較しました（未反映）。" : null, result.notice].filter(Boolean).join(" ") || undefined });
      if (!result.plans?.length) setPlanError("成立する調整案がありません。固定枠や出演可能時間を確認してください。");
    } catch (error) {
      if (stateRef.current !== snapshot) setPlanError("作成中に進行が変更されました。最新の条件で再作成してください。");
      else if (error instanceof Error && "userError" in error && error.userError) setPlanError(error.message);
      else if (fromReviewLink) setPlanError("最新の進行表で再比較できませんでした。接続を確認し、進行表を再読み込みしてください。");
      else {
        const issue = parseIssue(text, snapshot);
        if (!issue) setPlanError("「次の登壇者が15分遅れます」のように、対象と変更する時間を入力してください。現在は遅延・出演可能時刻・時間短縮に対応しています。");
        else { const generated = generatePlans(snapshot, issue); setPlans(generated); setPlanMeta({ engine: "rules", aiStatus: "fallback", elapsedMs: Math.round(performance.now() - started), notice: "サーバーに接続できないため、端末内の制約計算を使っています。" }); if (!generated.length) setPlanError("成立する案がありません。固定枠・出演可能時間・音止め時刻を確認してください。"); }
      }
    } finally { planRequestInFlight.current = false; setPlanning(false); if (sourceProposalId) { proposalMutationInFlight.current = false; proposalInboxGeneration.current += 1; setProposalMutationId(null); } }
  }
  function applyPlan(plan: Plan) {
    if (switchInFlight.current || proposalMutationInFlight.current) return;
    if (planBaseRevision.current !== stateRef.current.revision) { setPlans([]); setPreviewPlan(null); setPlanError("進行が変更されています。最新の条件で調整案を再作成してください。"); return; }
    if (plan.schedule.violations.some(v => v.severity === "error")) { notify("条件違反がある案は反映できません。"); return; }
    commit({ ...stateRef.current, slots: plan.slots }, historyItem(`${plan.title}を反映`, `${plannedText} — ${plan.changes.join("、")}`, "plan")); setIssueText(""); notify("タイムテーブルを更新しました。");
  }
  function exportFile(type: "csv" | "json") {
    const quote = (s: string | number) => '"' + String(s).replaceAll('"', '""') + '"';
    const content = type === "json" ? JSON.stringify(state, null, 2) : "\uFEFF" + ["開始,終了,タイトル,出演者・グループ,カテゴリー,本編(分),転換(分),メンバー,設備,メモ", ...schedule.rows.map(r => [formatTime(r.start), formatTime(r.end), r.title, r.group, KIND[r.kind].label, r.durationMinutes, r.changeoverMinutes, r.people.join(" / "), r.equipment.join(" / "), r.notes].map(quote).join(","))].join("\r\n");
    const url = URL.createObjectURL(new Blob([content], { type: type === "json" ? "application/json" : "text/csv;charset=utf-8" })), a = document.createElement("a"); a.href = url; a.download = `timetable-${state.event.date}.${type}`; a.click(); URL.revokeObjectURL(url); notify(type === "csv" ? "進行表をCSVで書き出しました。" : "イベントのバックアップを書き出しました。");
  }
  async function copy(text: string, success: string) { try { await navigator.clipboard.writeText(text); notify(success); } catch { notify("クリップボードを利用できません。ブラウザのURLをコピーしてください。"); } }
  function saveSlot(slot: EventSlot) {
    const current = stateRef.current, exists = current.slots.some(x => x.id === slot.id);
    let slots = exists ? current.slots.map(x => x.id === slot.id ? slot : x) : [...current.slots, slot];
    if (slot.locked && slot.fixedStart === undefined) {
      const anchor = computeSchedule({ ...current, slots }).rows.find(x => x.id === slot.id)?.start;
      slots = slots.map(x => x.id === slot.id ? { ...x, fixedStart: anchor } : x);
    }
    commit({ ...current, slots }, historyItem(exists ? "進行枠を更新" : "進行枠を追加", slot.title)); setSlotEditor(null); notify(exists ? "進行枠を更新しました。" : "新しい進行枠を追加しました。");
  }
  const filteredRows = visibleSchedule.rows.filter(r => filter === "all" || (filter === "remaining" ? r.status !== "done" : r.status === "done"));

  return <div className="minimal-app">
    <header className="minimal-topbar">
      <span className="minimal-brand">タイテ作成ツール</span>
      <div className="minimal-tools">
        <button type="button" className="button secondary small event-list-button" aria-label="イベント一覧" title="イベント一覧" disabled={saveStatus === "loading"} onClick={() => menuAction(() => setEventListOpen(true))}><CalendarDays size={15} aria-hidden="true" /><span>イベント</span></button>
        <button type="button" className="button secondary small new-event-button" aria-label="新しいイベント" title="新しいイベント" disabled={saveStatus !== "saved" && saveStatus !== "local" || eventSwitching || planning || queueing} onClick={() => menuAction(() => setNewEventOpen(true))}><CalendarPlus size={15} aria-hidden="true" /><span>新しいイベント</span></button>
        <ThemeControl />
        <details className="utility-menu" ref={menuRef}>
          <summary className="icon-button" aria-label="表示・連携設定" title="表示・連携設定"><Settings2 size={18} aria-hidden="true" /></summary>
          <div className="utility-popover">
            <button type="button" onClick={() => menuAction(() => setPanel("connections"))}><Plug2 size={15} aria-hidden="true" />連携・保存</button>
            <hr />
            <button type="button" onClick={() => menuAction(() => setResetOpen(true))}><RotateCcw size={15} aria-hidden="true" />サンプルに戻す</button>
          </div>
        </details>
      </div>
    </header>
    <main className="minimal-workspace">
      <div className="event-heading">
        <div className="event-identity"><div className="event-title-row"><h1>{state.event.name}</h1><button type="button" className="icon-button event-edit" aria-label="イベント設定" title="イベント設定を編集" disabled={saveStatus === "loading"} onClick={() => setSettingsOpen(true)}><Pencil size={16} aria-hidden="true" /></button></div><p className="event-details">{dateLabel(state.event.date)} · {formatTime(state.event.startTime)}–{formatTime(state.event.endTime)}{state.event.location && " · " + state.event.location}</p></div>
        <div className="event-actions"><span className={"save-status" + (saveStatus === "error" ? " error" : "")} role="status">{saveStatus === "loading" || saveStatus === "saving" ? <Loader2 size={13} className="spin" aria-hidden="true" /> : saveStatus === "saved" ? <CheckCircle2 size={13} aria-hidden="true" /> : null}{saveStatus === "loading" ? "読み込み中" : saveStatus === "saving" ? "保存中" : saveStatus === "saved" ? "保存済み" : saveStatus === "error" ? "クラウド未保存" : "端末に保存"}</span><button type="button" className="text-button" disabled={saveStatus === "loading"} onClick={() => setPanel("history")}><History size={15} aria-hidden="true" />変更履歴</button></div>
      </div>
      {timing && <p className={"event-clock event-clock-" + timing.phase} title="日本時間の現在時刻とタイムテーブルから自動表示します。実際の遅れは変更欄から反映してください。"><Clock3 size={13} aria-hidden="true" /><span>{timing.phase === "active" ? `進行中 · ${timing.label}` : timing.label}</span><small>予定時刻から自動表示 · 日本時間</small></p>}
      {errors.length > 0 && <div className="form-error" role="alert"><strong>進行条件を確認してください</strong>{errors.map((error, index) => <p key={index}>{error.message}</p>)}</div>}
      <form className="change-form" onSubmit={event => { event.preventDefault(); void requestPlans(); }}>
        <label htmlFor="issue-input" className="visually-hidden">変更・トラブルの内容</label>
        <input id="issue-input" value={issueText} onChange={event => updateIssue(event.target.value)} placeholder="変更を入力（例：次の登壇者が15分遅れます）" maxLength={1200} disabled={planning || queueing || !!proposalMutationId} autoComplete="off" />
        <button className="button primary" type="submit" disabled={planning || queueing || !!proposalMutationId || !issueText.trim() || !state.slots.length || saveStatus === "loading"}>{planning ? <><Loader2 size={15} className="spin" />確認中</> : "調整案を作る"}</button>
      </form>
      <div className="change-assist"><details className="change-examples"><summary>入力例</summary><div className="example-buttons">{["いまの進行が10分押しています", "次の登壇者が15分遅れます", "全体を10分短縮したい"].map(text => <button type="button" key={text} disabled={planning || queueing} onClick={() => { updateIssue(text); document.getElementById("issue-input")?.focus(); }}>{text}</button>)}</div></details><button type="button" className="text-button" disabled={planning || queueing || !issueText.trim() || !state.slots.length || storage !== "cloud" || saveStatus !== "saved"} onClick={() => void queueChange()}>{queueing ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}{queueing ? "受付中" : "dotに依頼"}</button></div>
      {changeRequests.some(request => request.eventId === state.event.id && request.status === "pending") && <details className="agent-inbox"><summary>dotへの依頼 · 未処理{pendingChangeCount}件</summary><div>{changeRequests.filter(request => request.eventId === state.event.id && request.status === "pending").map(request => <article key={request.id}><p>{request.text}</p><small>候補待ち · {new Date(request.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</small></article>)}<p className="field-hint">{eventDelivery?.activeSubscriptions ? `イベント購読${eventDelivery.activeSubscriptions}件 · 受信後の提案を待っています。` : "イベント購読が未設定です。dotにイベント監視の指示を送ってください。"}{eventDelivery?.pendingDeliveries ? ` 未通知${eventDelivery.pendingDeliveries}件。` : ""}</p></div></details>}
      {agentProposals.some(proposal => proposal.eventId === state.event.id) && <details className="agent-inbox"><summary>エージェントからの提案 · {agentProposals.filter(proposal => proposal.eventId === state.event.id).length}件</summary><div>{agentProposals.filter(proposal => proposal.eventId === state.event.id).map(proposal => {
        const stale = proposal.baseRevision !== state.revision;
        return <article key={proposal.id}><p>{proposal.text}</p><small>{new Date(proposal.updatedAt ?? proposal.createdAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}{proposal.updatedAt ? " 更新" : ""} · {stale ? "更新前の提案 · 最新条件で再比較できます" : proposal.result.engine === "decisions" ? "Decisions APIで比較済み" : "制約計算による候補"}</small><div className="agent-proposal-actions"><button type="button" className="button secondary small" aria-expanded={activeProposalId === proposal.id && plans.length > 0} disabled={planning || queueing || eventSwitching || !!proposalMutationId || saveStatus !== "saved" || proposal.baseRevision > state.revision} onClick={() => reviewAgentProposal(proposal)}>{stale ? "最新条件で再比較" : "提案を確認"}</button><button type="button" className="icon-button proposal-delete" aria-label={`提案を削除：${proposal.text}`} title="提案を削除" disabled={planning || queueing || eventSwitching || !!proposalMutationId || saveStatus !== "saved" || storage !== "cloud"} onClick={() => void setProposalVisibility(proposal)}><Trash2 size={15} aria-hidden="true" /></button></div></article>;
      })}</div></details>}
      {planError && <p className="form-error" role="alert">{planError}</p>}
      {!!plans.length && <section className="plan-results" aria-label="調整案">
        <header><h2>調整案</h2><span className="plan-meta">{planMeta?.engine === "decisions" ? `Decisions API · ${planMeta.decisions?.elapsedMs ?? planMeta.elapsedMs}ms` : "制約計算による候補"}</span><button className="icon-button" aria-label="調整案を閉じる" onClick={closePlans}><X size={17} /></button></header>
        <div className="plan-options">{plans.map(plan => {
          const invalid = plan.schedule.violations.some(violation => violation.severity === "error");
          return <article key={plan.id} className={"plan-option" + (previewPlan?.id === plan.id ? " selected" : "")}>
            <div className="plan-option-header"><h3>{plan.title}</h3><span>終了 {formatTime(plan.schedule.endsAt)}</span><button type="button" className="icon-button plan-delete" aria-label={`調整案を削除：${plan.title}`} title="この調整案を削除" onClick={() => removePlan(plan.id)}><Trash2 size={14} aria-hidden="true" /></button></div>
            <p>{plan.description}</p>
            {plan.shortening && <p className={plan.shortening.met ? "plan-goal" : "plan-warning"}>目標 {formatTime(plan.shortening.targetEnd)} · {plan.shortening.achievedMinutes >= 0 ? `終演${plan.shortening.achievedMinutes}分短縮` : `終演${-plan.shortening.achievedMinutes}分後ろ倒し`}{plan.shortening.met ? "（達成）" : plan.shortening.shortfallMinutes > 0 ? `（あと${plan.shortening.shortfallMinutes}分不足）` : "（制約違反のため未達）"}<small>演目時間の削減は{plan.shortening.contentReductionMinutes}分</small></p>}
            <details><summary>変更内容 · {plan.changes.length}件</summary><ul>{plan.changes.map((change, index) => <li key={index}>{change}</li>)}</ul></details>
            {!!plan.tradeoffs.length && <p className="plan-warning">{plan.tradeoffs[0]}</p>}
            <div className="plan-option-actions"><button className="button secondary small" onClick={() => setPreviewPlan(previewPlan?.id === plan.id ? null : plan)}>{previewPlan?.id === plan.id ? "比較を閉じる" : "表で比較"}</button><button className="button primary small" disabled={invalid} onClick={() => applyPlan(plan)}>{plan.shortening && !plan.shortening.met ? "未達案を反映" : "反映"}</button></div>
          </article>;
        })}</div>
        {planMeta?.notice && <p className="engine-note">{planMeta.notice}</p>}
      </section>}
      <section className="timetable-shell" aria-label="イベントの進行表">
        <div className="table-toolbar"><span className="table-count">タイムテーブル · {state.slots.length}枠</span><div className="table-tools" role="group" aria-label="タイムテーブルの操作">
          <button type="button" className="button secondary small" disabled={saveStatus === "loading"} onClick={() => setSlotEditor("new")}><Plus size={15} aria-hidden="true" />枠を追加</button>
          <details className="export-menu" ref={exportMenuRef}>
            <summary className="button secondary small" aria-label="書き出し"><Download size={15} aria-hidden="true" /><span>書き出し</span><ChevronDown size={12} aria-hidden="true" /></summary>
            <div className="export-popover">
              <button type="button" disabled={saveStatus === "loading"} onClick={() => menuAction(() => exportFile("csv"))}><FileSpreadsheet size={15} aria-hidden="true" />CSVを書き出す</button>
              <button type="button" disabled={saveStatus === "loading"} onClick={() => menuAction(() => exportFile("json"))}><FileJson size={15} aria-hidden="true" />バックアップ（JSON）</button>
            </div>
          </details>
          <label className="table-filter"><span className="visually-hidden">表示する進行枠</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">すべて</option><option value="remaining">未完了</option><option value="done">終了済み</option></select></label>
        </div></div>
        {previewPlan && <div className="preview-strip"><span>{previewPlan.title} · 未反映のプレビュー</span><button type="button" className="text-button" onClick={() => setPreviewPlan(null)}>元の表に戻す</button></div>}
        <Timetable rows={filteredRows} allRows={visibleSchedule.rows} originalRows={schedule.rows} preview={!!previewPlan} onEdit={id => { if (saveStatus !== "loading" && !eventSwitching) setSlotEditor(state.slots.find(slot => slot.id === id) ?? null); }} />
        {!!state.slots.length && <footer className="schedule-summary"><span>終了予定 <strong>{formatTime(visibleSchedule.endsAt)}</strong></span><span className={visibleSchedule.bufferMinutes < 0 ? "text-red" : ""}>{visibleSchedule.bufferMinutes >= 0 ? "終了時刻まで " + visibleSchedule.bufferMinutes + "分の余裕" : -visibleSchedule.bufferMinutes + "分超過"}</span></footer>}
      </section>
    </main>
    {slotEditor !== null && <SlotForm slot={slotEditor === "new" ? null : slotEditor} currentStart={slotEditor === "new" ? undefined : schedule.rows.find(slot => slot.id === slotEditor.id)?.start} onClose={() => setSlotEditor(null)} onSave={saveSlot} onDelete={slotEditor !== "new" ? () => { const current = stateRef.current; commit({ ...current, slots: current.slots.filter(slot => slot.id !== slotEditor.id) }, historyItem("進行枠を削除", slotEditor.title)); setSlotEditor(null); notify("進行枠を削除しました。"); } : undefined} />}
    {settingsOpen && <EventForm state={state} onClose={() => setSettingsOpen(false)} onSave={next => { commit(next, historyItem("イベント設定を更新", next.event.name + " · " + formatTime(next.event.startTime) + "–" + formatTime(next.event.endTime))); setSettingsOpen(false); notify("イベント設定を更新しました。"); }} />}
    {panel === "history" && <Dialog title="変更履歴" onClose={() => setPanel(null)}><div className="history-list">{state.history.length ? state.history.map(entry => <article key={entry.id}><h3>{entry.title}</h3><time>{new Date(entry.at).toLocaleDateString("ja-JP")} {timeLabel(entry.at)}</time><p>{entry.detail}</p></article>) : <p>まだ変更はありません。</p>}</div></Dialog>}
    {panel === "connections" && <Dialog title="連携・保存" onClose={() => setPanel(null)}><div className="connection-settings">
      <section><h3>Decisions API <span className="connection-status">{decisionCheck?.aiStatus === "used" ? "接続確認済み" : decisionCheck?.aiStatus === "fallback" ? "接続エラー" : aiConfigured ? "キー設定済み・未確認" : "未設定"}</span></h3><p>成立する候補をgpt-6-lunaで比較します。時間条件はコードで検証します。キー設定済みでも、認証や利用枠の状況によって比較に失敗することがあります。</p>{decisionCheck?.notice && <p role="status">{decisionCheck.notice}{decisionHttpStatus ? `（HTTP ${decisionHttpStatus}）` : ""}</p>}<button type="button" className="button secondary small" disabled={checkingDecision} onClick={() => void checkDecisionConnection()}>{checkingDecision ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <Plug2 size={14} aria-hidden="true" />}{checkingDecision ? "確認中" : "接続を確認"}</button><a className="text-button" href="https://developers.openai.com/api/docs/guides/decisions" target="_blank" rel="noreferrer">公式ドキュメント<ArrowUpRight size={13} /></a></section>
      <section>
        <h3>dots / MCP <span className="connection-status">{eventDelivery?.activeSubscriptions ? `イベント購読${eventDelivery.activeSubscriptions}件` : "イベント購読未設定"}</span></h3>
        <p>「dotに依頼」で変更を受け付けると、MCP Eventsで購読先へ通知します。dotが受信後にDecisionsで比較し、候補を保存します。定期的な確認は不要で、進行表には自動反映しません。</p>
        <p>「イベント監視の指示をコピー」をあなたのdotに送り、購読を登録してください。コピーだけでは監視は始まりません。購読数はMCP Eventsの登録数で、受信者がdotsであることや処理完了を示すものではありません。</p>
        {eventDelivery?.lastDeliveredAt && <p>直近の通知受領：{new Date(eventDelivery.lastDeliveredAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}（候補の作成完了とは別です）</p>}
        {!!eventDelivery?.pendingDeliveries && <p className="form-error">未通知のイベントが{eventDelivery.pendingDeliveries}件あります。購読と通知先の状態を確認してください。</p>}
        {!!eventDelivery?.lastFailure && <p className="form-error">通知エラーの記録があります。購読先の受信と候補の保存を確認してください。</p>}
        <div className="connection-actions">
          <button type="button" className="button secondary small" onClick={() => void copy(dotMonitoringInstructions(window.location.origin), "イベント監視の指示をコピーしました。dotの会話に貼り付けて購読を登録してください。")}>イベント監視の指示をコピー</button>
          <button type="button" className="text-button" onClick={() => void copy(dotSetupInstructions(window.location.origin), "dotsへの指示をコピーしました。dotの会話に貼り付けてください。")}>dotsへの指示をコピー</button>
          <button type="button" className="text-button" onClick={() => void copy(window.location.origin + "/mcp", "MCPのURLをコピーしました。")}>MCPのURLをコピー</button>
        </div>
        <p>会話からの比較と再比較リンクは既存の3ツールで利用できます。イベント通知からの提案保存にはpublish_change_proposalも必要です。</p>
        {agentLoadError && <p className="form-error">{agentLoadError}</p>}
        <a className="text-button" href="https://developers.openai.com/plugins/build/mcp-events" target="_blank" rel="noreferrer">イベント通知の仕組み<ArrowUpRight size={13} /></a>
      </section>
      <section><h3>保存</h3><p>{storage === "cloud" ? "イベントはクラウドに保存されています。" : "現在はこの端末に保存されています。"}</p><p>所有者専用の非公開アプリです。URLを共有しても閲覧権限は付与されません。</p></section>
    </div></Dialog>}
    {eventListOpen && <Dialog title="イベント一覧" subtitle="イベントごとにタイテと変更履歴を保存します。" onClose={() => { if (!eventSwitching) setEventListOpen(false); }}><div className="event-library">
      {storage !== "cloud" ? <p className="field-hint">端末内のイベントを表示しています。イベントの切り替えにはクラウドへの接続が必要です。</p> : eventListLoading ? <p className="field-hint" role="status">読み込み中…</p> : null}
      {eventListError && <p className="form-error" role="alert">{eventListError}</p>}
      {(storage === "cloud" ? eventSummaries : [{ ...state.event, slotCount: state.slots.length, updatedAt: "" }]).map(event => <button type="button" className={"event-library-row" + (event.id === state.event.id ? " selected" : "")} key={event.id} disabled={eventSwitching || planning || queueing || saveStatus !== "saved"} onClick={() => void switchEvent(event.id)}><CalendarDays size={18} aria-hidden="true" /><span><strong>{event.name}</strong><small>{dateLabel(event.date)} · {formatTime(event.startTime)}–{formatTime(event.endTime)} · {event.slotCount}枠{event.location ? ` · ${event.location}` : ""}</small></span>{event.id === state.event.id ? <span className="event-library-current"><Check size={14} aria-hidden="true" />表示中</span> : <ArrowUpRight size={16} aria-hidden="true" />}</button>)}
      {eventSwitching && <p className="field-hint" role="status">イベントを切り替えています…</p>}
      {storage === "cloud" && saveStatus !== "saved" && <p className="field-hint">現在のイベントの保存が完了すると切り替えられます。</p>}
    </div><footer className="modal-footer"><span /><button type="button" className="button primary" disabled={eventSwitching || planning || queueing || saveStatus !== "saved"} onClick={() => { setEventListOpen(false); setNewEventOpen(true); }}><CalendarPlus size={15} aria-hidden="true" />イベントを作成</button></footer></Dialog>}
    {resetOpen && <Dialog title="サンプルに戻しますか？" subtitle="現在のイベントは一覧に残して、新しいサンプルを開きます。" onClose={() => setResetOpen(false)}><div className="form-body"><button className="button secondary" onClick={() => exportFile("json")}><ArrowDownToLine size={15} />バックアップを書き出す</button></div><footer className="modal-footer"><span /><div><button className="button secondary" onClick={() => setResetOpen(false)}>キャンセル</button><button className="button primary" onClick={() => { const sample = structuredClone(demoState); sample.event.id = uid(); commit(sample, historyItem("サンプルイベントを読み込み", "Community Day 2026の進行をコピーしました。", "create")); setResetOpen(false); setFilter("all"); notify("サンプルイベントを開きました。元のイベントは一覧に残っています。"); }}>サンプルに戻す</button></div></footer></Dialog>}
    {newEventOpen && <Dialog title="新しいイベント" subtitle="現在のイベントは一覧に残して、空の表から始めます。" onClose={() => setNewEventOpen(false)}><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget), blank = createEmptyState(); blank.event.name = String(data.get("name")).trim(); blank.event.date = String(data.get("date")); blank.event.id = uid(); commit(blank, historyItem("イベントを作成", blank.event.name, "create")); setNewEventOpen(false); setFilter("all"); notify("新しいイベントを作成しました。元のイベントは一覧に残っています。"); }}><div className="form-body"><label className="field">イベント名<input name="name" placeholder="イベント名" required maxLength={160} /></label><label className="field">開催日<input name="date" type="date" required defaultValue={new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())} /></label><button className="text-button" type="button" onClick={() => exportFile("json")}>現在のイベントをバックアップ</button></div><footer className="modal-footer"><span /><div><button className="button secondary" type="button" onClick={() => setNewEventOpen(false)}>キャンセル</button><button className="button primary" type="submit">作成する</button></div></footer></form></Dialog>}
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span>{undoProposal && <button type="button" className="toast-undo" disabled={!!proposalMutationId} onClick={() => void setProposalVisibility(undoProposal, true)}>元に戻す</button>}<button aria-label="通知を閉じる" onClick={() => { setToast(""); setUndoProposal(null); }}><X size={14} /></button></div>}
  </div>;
}
