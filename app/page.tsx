"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, CheckCircle2, Loader2, LockKeyhole, MoreHorizontal, Plus, Trash2, X } from "lucide-react";
import { demoState, createEmptyState } from "@/lib/demo";
import { computeSchedule, formatTime, generatePlans, parseIssue, parseTime } from "@/lib/planner";
import type { EventState, EventSlot, Plan, HistoryEntry } from "@/lib/types";
import { Timetable } from "@/components/timetable";
import { ThemeControl } from "@/components/theme-control";

type SaveStatus = "loading" | "saved" | "saving" | "local" | "error";
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
  const [slotEditor, setSlotEditor] = useState<EventSlot | "new" | null>(null), [settingsOpen, setSettingsOpen] = useState(false), [resetOpen, setResetOpen] = useState(false), [newEventOpen, setNewEventOpen] = useState(false);
  const [issueText, setIssueText] = useState(""), [plannedText, setPlannedText] = useState(""), [planning, setPlanning] = useState(false), [plans, setPlans] = useState<Plan[]>([]), [previewPlan, setPreviewPlan] = useState<Plan | null>(null), [planError, setPlanError] = useState("");
  const [planMeta, setPlanMeta] = useState<{ engine: string; elapsedMs: number; notice?: string } | null>(null), [toast, setToast] = useState("");
  const saveQueue = useRef(Promise.resolve()), serverRevision = useRef(0), planBaseRevision = useRef<number | null>(null), toastTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedule = useMemo(() => computeSchedule(state), [state]), visibleSchedule = previewPlan?.schedule ?? schedule;
  const active = schedule.rows.find(x => x.status === "active");
  const errors = schedule.violations.filter(x => x.severity === "error");
  function notify(message: string) { setToast(message); if (toastTimeout.current) clearTimeout(toastTimeout.current); toastTimeout.current = setTimeout(() => setToast(""), 4500); }
  function menuAction(action: () => void) { if (menuRef.current) menuRef.current.open = false; action(); }
  function updateIssue(text: string) { setIssueText(text); setPlans([]); setPreviewPlan(null); setPlanMeta(null); setPlanError(""); }

  useEffect(() => {
    const outside = (event: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false; };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menuRef.current?.open) { menuRef.current.open = false; menuRef.current.querySelector<HTMLElement>("summary")?.focus(); } };
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

  function commit(updated: EventState, entry: HistoryEntry) {
    const previous = stateRef.current, nextState = { ...updated, revision: previous.revision + 1, history: [entry, ...previous.history].slice(0, 100) };
    stateRef.current = nextState; setState(nextState); setPlans([]); setPreviewPlan(null); setPlanMeta(null); setPlanError("");
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState)); } catch { notify("端末への保存に失敗しました。バックアップを書き出してください。"); }
    if (storage !== "cloud") { setSaveStatus("local"); return; }
    setSaveStatus("saving");
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const response = await fetch("/api/event", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: { ...nextState, revision: serverRevision.current }, expectedRevision: serverRevision.current }) });
        const result = await response.json() as { state?: EventState; error?: string };
        if (!response.ok) throw new Error(response.status === 409 ? "別の画面で更新されています。変更をJSONで保存してから再読み込みしてください。" : result.error ?? "クラウドへの保存に失敗しました。変更はこの端末に残っています。");
        serverRevision.current = result.state?.revision ?? nextState.revision; setSaveStatus("saved");
      } catch (error) { setSaveStatus("error"); notify(error instanceof Error ? error.message : "保存できませんでした。"); }
    });
  }

  async function requestPlans() {
    if (!issueText.trim() || planning) return;
    const text = issueText.trim(); setPlannedText(text);
    setPlanning(true); setPlanError(""); setPlans([]); setPreviewPlan(null); setPlanMeta(null);
    const started = performance.now(), snapshot = stateRef.current; planBaseRevision.current = snapshot.revision;
    try {
      const response = await fetch("/api/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: snapshot, text }) });
      const result = await response.json() as { plans?: Plan[]; engine: string; elapsedMs: number; notice?: string; error?: string };
      if (!response.ok) throw Object.assign(new Error(result.error ?? "条件を読み取れませんでした。"), { userError: response.status < 500 });
      if (stateRef.current.revision !== snapshot.revision) throw Object.assign(new Error("作成中に進行が変更されました。最新の条件で再作成してください。"), { userError: true });
      setPlans(result.plans ?? []); setPlanMeta({ engine: result.engine, elapsedMs: result.elapsedMs, notice: result.notice });
      if (!result.plans?.length) setPlanError("成立する調整案がありません。固定枠や出演可能時間を確認してください。");
    } catch (error) {
      if (stateRef.current.revision !== snapshot.revision) setPlanError("作成中に進行が変更されました。最新の条件で再作成してください。");
      else if (error instanceof Error && "userError" in error && error.userError) setPlanError(error.message);
      else {
        const issue = parseIssue(text, snapshot);
        if (!issue) setPlanError("「次の登壇者が15分遅れます」のように、対象と変更する時間を入力してください。現在は遅延・出演可能時刻・時間短縮に対応しています。");
        else { const generated = generatePlans(snapshot, issue); setPlans(generated); setPlanMeta({ engine: "rules", elapsedMs: Math.round(performance.now() - started), notice: "サーバーに接続できないため、端末内の制約計算を使っています。" }); if (!generated.length) setPlanError("成立する案がありません。固定枠・出演可能時間・音止め時刻を確認してください。"); }
      }
    } finally { setPlanning(false); }
  }
  function applyPlan(plan: Plan) {
    if (planBaseRevision.current !== stateRef.current.revision) { setPlans([]); setPreviewPlan(null); setPlanError("進行が変更されています。最新の条件で調整案を再作成してください。"); return; }
    if (plan.schedule.violations.some(v => v.severity === "error")) { notify("条件違反がある案は反映できません。"); return; }
    commit({ ...stateRef.current, slots: plan.slots }, historyItem(`${plan.title}を反映`, `${plannedText} — ${plan.changes.join("、")}`, "plan")); setIssueText(""); notify("タイムテーブルを更新しました。");
  }
  function finishActive() {
    if (saveStatus === "loading") return;
    const current = stateRef.current, currentSchedule = computeSchedule(current), index = current.slots.findIndex(x => x.status === "active"), nextIndex = current.slots.findIndex((x, i) => i > index && x.status === "planned");
    const slots = current.slots.map((x, i) => i === index ? { ...x, status: "done" as const, fixedStart: currentSchedule.rows.find(r => r.id === x.id)?.start } : i === nextIndex ? { ...x, status: "active" as const, fixedStart: currentSchedule.rows.find(r => r.id === x.id)?.start } : x);
    commit({ ...current, slots }, historyItem(index >= 0 ? `${current.slots[index].title}が終了` : "イベントを開始", nextIndex >= 0 ? `次の進行：${current.slots[nextIndex].title}` : "すべての進行枠が終了しました。", "progress"));
    notify(nextIndex >= 0 ? `「${current.slots[nextIndex].title}」へ進みました。` : "すべての進行が終了しました。お疲れさまでした。");
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
        <span className={"save-status" + (saveStatus === "error" ? " error" : "")} role="status">{saveStatus === "loading" ? "読み込み中" : saveStatus === "saving" ? "保存中" : saveStatus === "saved" ? "保存済み" : saveStatus === "error" ? "クラウド未保存" : "端末に保存"}</span>
        <details className="utility-menu" ref={menuRef}>
          <summary className="icon-button" aria-label="その他の操作"><MoreHorizontal size={20} /></summary>
          <div className="utility-popover">
            <ThemeControl />
            <button type="button" onClick={() => menuAction(() => setSettingsOpen(true))}>イベント設定</button>
            <button type="button" onClick={() => menuAction(() => setPanel("history"))}>変更履歴</button>
            <button type="button" onClick={() => menuAction(() => exportFile("csv"))}>CSVを書き出す</button>
            <button type="button" onClick={() => menuAction(() => exportFile("json"))}>バックアップを書き出す</button>
            <button type="button" onClick={() => menuAction(() => setPanel("connections"))}>連携・保存</button>
            <hr />
            <button type="button" onClick={() => menuAction(() => setNewEventOpen(true))}>新しいイベント</button>
            <button type="button" onClick={() => menuAction(() => setResetOpen(true))}>サンプルに戻す</button>
          </div>
        </details>
      </div>
    </header>
    <main className="minimal-workspace">
      <div className="event-heading">
        <div><h1>{state.event.name}</h1><p className="event-details">{dateLabel(state.event.date)} · {formatTime(state.event.startTime)}–{formatTime(state.event.endTime)}{state.event.location && " · " + state.event.location}</p></div>
        <div className="event-actions">{!active && state.slots.some(x => x.status === "planned") && !previewPlan && <button className="button secondary" disabled={saveStatus === "loading"} onClick={finishActive}>進行を開始</button>}<button className="button secondary" disabled={saveStatus === "loading"} onClick={() => setSlotEditor("new")}><Plus size={15} />枠を追加</button></div>
      </div>
      {errors.length > 0 && <div className="form-error" role="alert"><strong>進行条件を確認してください</strong>{errors.map((error, index) => <p key={index}>{error.message}</p>)}</div>}
      <form className="change-form" onSubmit={event => { event.preventDefault(); void requestPlans(); }}>
        <label htmlFor="issue-input" className="visually-hidden">変更・トラブルの内容</label>
        <input id="issue-input" value={issueText} onChange={event => updateIssue(event.target.value)} placeholder="変更を入力（例：次の登壇者が15分遅れます）" maxLength={1200} disabled={planning} autoComplete="off" />
        <button className="button primary" type="submit" disabled={planning || !issueText.trim() || !state.slots.length || saveStatus === "loading"}>{planning ? <><Loader2 size={15} className="spin" />確認中</> : "調整案を作る"}</button>
      </form>
      <details className="change-examples"><summary>入力例</summary><div className="example-buttons">{["いまの進行が10分押しています", "次の登壇者が15分遅れます", "全体を10分短縮したい"].map(text => <button type="button" key={text} disabled={planning} onClick={() => { updateIssue(text); document.getElementById("issue-input")?.focus(); }}>{text}</button>)}</div></details>
      {planError && <p className="form-error" role="alert">{planError}</p>}
      {!!plans.length && <section className="plan-results" aria-label="調整案">
        <header><h2>調整案</h2><span className="plan-meta">{planMeta?.engine === "decisions" ? "Decisions APIで比較" : "制約計算による候補"}</span><button className="icon-button" aria-label="調整案を閉じる" onClick={() => { setPlans([]); setPreviewPlan(null); setPlanMeta(null); }}><X size={17} /></button></header>
        <div className="plan-options">{plans.map(plan => {
          const invalid = plan.schedule.violations.some(violation => violation.severity === "error");
          return <article key={plan.id} className={"plan-option" + (previewPlan?.id === plan.id ? " selected" : "")}>
            <div className="plan-option-header"><h3>{plan.title}</h3><span>終了 {formatTime(plan.schedule.endsAt)}</span></div>
            <p>{plan.description}</p>
            <details><summary>変更内容 · {plan.changes.length}件</summary><ul>{plan.changes.map((change, index) => <li key={index}>{change}</li>)}</ul></details>
            {!!plan.tradeoffs.length && <p className="plan-warning">{plan.tradeoffs[0]}</p>}
            <div className="plan-option-actions"><button className="button secondary small" onClick={() => setPreviewPlan(previewPlan?.id === plan.id ? null : plan)}>{previewPlan?.id === plan.id ? "比較を閉じる" : "表で比較"}</button><button className="button primary small" disabled={invalid} onClick={() => applyPlan(plan)}>反映</button></div>
          </article>;
        })}</div>
        {planMeta?.notice && <p className="engine-note">{planMeta.notice}</p>}
      </section>}
      <section className="timetable-shell" aria-label="イベントの進行表">
        <div className="table-toolbar"><span className="table-count">タイムテーブル · {state.slots.length}枠</span><label className="table-filter"><span className="visually-hidden">表示する進行枠</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">すべて</option><option value="remaining">未完了</option><option value="done">終了済み</option></select></label></div>
        {previewPlan && <div className="preview-strip"><span>{previewPlan.title} · 未反映のプレビュー</span><button type="button" className="text-button" onClick={() => setPreviewPlan(null)}>元の表に戻す</button></div>}
        <Timetable rows={filteredRows} allRows={visibleSchedule.rows} originalRows={schedule.rows} preview={!!previewPlan} onEdit={id => { if (saveStatus !== "loading") setSlotEditor(state.slots.find(slot => slot.id === id) ?? null); }} onFinishActive={finishActive} />
        {!!state.slots.length && <footer className="schedule-summary"><span>終了予定 <strong>{formatTime(visibleSchedule.endsAt)}</strong></span><span className={visibleSchedule.bufferMinutes < 0 ? "text-red" : ""}>{visibleSchedule.bufferMinutes >= 0 ? "終了時刻まで " + visibleSchedule.bufferMinutes + "分の余裕" : -visibleSchedule.bufferMinutes + "分超過"}</span></footer>}
      </section>
    </main>
    {slotEditor !== null && <SlotForm slot={slotEditor === "new" ? null : slotEditor} currentStart={slotEditor === "new" ? undefined : schedule.rows.find(slot => slot.id === slotEditor.id)?.start} onClose={() => setSlotEditor(null)} onSave={saveSlot} onDelete={slotEditor !== "new" ? () => { const current = stateRef.current; commit({ ...current, slots: current.slots.filter(slot => slot.id !== slotEditor.id) }, historyItem("進行枠を削除", slotEditor.title)); setSlotEditor(null); notify("進行枠を削除しました。"); } : undefined} />}
    {settingsOpen && <EventForm state={state} onClose={() => setSettingsOpen(false)} onSave={next => { commit(next, historyItem("イベント設定を更新", next.event.name + " · " + formatTime(next.event.startTime) + "–" + formatTime(next.event.endTime))); setSettingsOpen(false); notify("イベント設定を更新しました。"); }} />}
    {panel === "history" && <Dialog title="変更履歴" onClose={() => setPanel(null)}><div className="history-list">{state.history.length ? state.history.map(entry => <article key={entry.id}><h3>{entry.title}</h3><time>{new Date(entry.at).toLocaleDateString("ja-JP")} {timeLabel(entry.at)}</time><p>{entry.detail}</p></article>) : <p>まだ変更はありません。</p>}</div></Dialog>}
    {panel === "connections" && <Dialog title="連携・保存" onClose={() => setPanel(null)}><div className="connection-settings">
      <section><h3>Decisions API <span className="connection-status">{aiConfigured ? "キー設定済み" : "未設定"}</span></h3><p>{aiConfigured ? "成立する候補の比較に使用します。時間条件は通常の計算で検証します。" : "現在は制約計算のみで動作しています。AIによる選択は行っていません。"}</p><a className="text-button" href="https://developers.openai.com/api/docs/guides/decisions" target="_blank" rel="noreferrer">公式ドキュメント<ArrowUpRight size={13} /></a></section>
      <section><h3>dots / MCP <span className="connection-status">自動監視は未接続</span></h3><p>進行情報の取得と変更案の提案に対応しています。自動での監視・反映は行いません。</p><button className="text-button" onClick={() => void copy(window.location.origin + "/mcp", "MCPのURLをコピーしました。")}>MCPのURLをコピー</button></section>
      <section><h3>保存</h3><p>{storage === "cloud" ? "イベントはクラウドに保存されています。" : "現在はこの端末に保存されています。"}</p><p>所有者専用の非公開アプリです。URLを共有しても閲覧権限は付与されません。</p><button className="text-button" onClick={() => exportFile("json")}>バックアップを書き出す</button></section>
    </div></Dialog>}
    {resetOpen && <Dialog title="サンプルに戻しますか？" subtitle="現在のイベントを置き換えます。必要なら先にバックアップしてください。" onClose={() => setResetOpen(false)}><div className="form-body"><button className="button secondary" onClick={() => exportFile("json")}><ArrowDownToLine size={15} />バックアップを書き出す</button></div><footer className="modal-footer"><span /><div><button className="button secondary" onClick={() => setResetOpen(false)}>キャンセル</button><button className="button primary" onClick={() => { commit(structuredClone(demoState), historyItem("サンプルイベントを読み込み", "Community Day 2026の進行に戻しました。", "create")); setResetOpen(false); setFilter("all"); notify("サンプルイベントに戻しました。"); }}>サンプルに戻す</button></div></footer></Dialog>}
    {newEventOpen && <Dialog title="新しいイベント" subtitle="現在のイベントを置き換えて、空の表から始めます。" onClose={() => setNewEventOpen(false)}><form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget), blank = createEmptyState(); blank.event.name = String(data.get("name")).trim(); blank.event.id = uid(); commit(blank, historyItem("イベントを作成", blank.event.name, "create")); setNewEventOpen(false); setFilter("all"); notify("新しいイベントを作成しました。"); }}><div className="form-body"><label className="field">イベント名<input name="name" placeholder="イベント名" required maxLength={160} /></label><button className="text-button" type="button" onClick={() => exportFile("json")}>現在のイベントをバックアップ</button></div><footer className="modal-footer"><span /><div><button className="button secondary" type="button" onClick={() => setNewEventOpen(false)}>キャンセル</button><button className="button primary" type="submit">作成する</button></div></footer></form></Dialog>}
    {toast && <div className="toast" role="status"><CheckCircle2 size={17} /><span>{toast}</span><button aria-label="通知を閉じる" onClick={() => setToast("")}><X size={14} /></button></div>}
  </div>;
}
