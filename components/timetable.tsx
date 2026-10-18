"use client";

import { AlertCircle, LockKeyhole, Pencil, UserRound, UsersRound } from "lucide-react";
import { getMemberRole, getSlotMembers } from "@/lib/member-roles";
import { formatTime } from "@/lib/planner";
import type { ScheduledSlot } from "@/lib/types";

export interface TimetableProps {
  rows: ScheduledSlot[];
  allRows: ScheduledSlot[];
  originalRows: ScheduledSlot[];
  preview: boolean;
  onEdit: (id: string) => void;
  /** @deprecated Progress follows the event's Japan-time schedule. */
  onFinishActive?: () => void;
}

function TimeRange({ start, end }: { start: number; end: number }) {
  return <span className="run-table-range">{formatTime(start)}<span className="run-table-dash">–</span>{formatTime(end)}</span>;
}

/** Dense running order: preparation and waiting remain real, separate intervals. */
export function Timetable({ rows, allRows, originalRows, preview, onEdit }: TimetableProps) {
  const indexes = new Map(allRows.map((row, index) => [row.id, index]));
  const originals = new Map(originalRows.map((row, index) => [row.id, { row, index }]));

  return <div className="run-table-scroll" role="region" aria-label="イベントのタイムテーブル。横にスクロールできます" tabIndex={0}>
    <table className="run-table">
      <caption className="run-table-caption">イベントの進行表。転換・準備と待機は、本編とは別の行で表示しています。時刻は日本時間です。</caption>
      <colgroup><col className="run-table-col-time" /><col /><col className="run-table-col-duration" /></colgroup>
      <thead><tr><th scope="col">時間</th><th scope="col">内容</th><th scope="col">所要</th></tr></thead>
      {rows.length ? rows.map(row => {
        // A comparison is an unapplied proposal, never the running event.
        const status = preview ? "planned" : row.status;
        const index = indexes.get(row.id) ?? 0;
        const original = originals.get(row.id);
        const changedTime = preview && !!original && (original.row.start !== row.start || original.row.end !== row.end);
        const changedDuration = preview && !!original && original.row.durationMinutes !== row.durationMinutes;
        const changedOrder = preview && !!original && original.index !== index;
        const changed = changedTime || changedDuration || changedOrder || (preview && !original);
        const setup = index === 0 ? 0 : Math.max(0, row.changeoverMinutes);
        const prepEnd = row.changeoverStart + setup;
        const group = row.group.trim();
        const title = row.title.trim() || group || "名称未設定";
        const members = getSlotMembers(row);
        return <tbody className="run-table-slot" key={row.id}>
          {setup > 0 && <tr className="run-table-transition">
            <td className="run-table-time"><TimeRange start={row.changeoverStart} end={prepEnd} /></td>
            <td><span className="run-table-prep-label">転換・準備</span><span className="run-table-prep-target">{group || row.title}</span></td>
            <td className="run-table-duration">{setup}<span>分</span></td>
          </tr>}
          {row.waitMinutes > 0 && <tr className="run-table-wait">
            <td className="run-table-time"><TimeRange start={prepEnd} end={row.start} /></td>
            <td>時間調整・待機</td>
            <td className="run-table-duration">{row.waitMinutes}<span>分</span></td>
          </tr>}
          <tr aria-current={status === "active" ? "step" : undefined} className={`run-table-main run-table-${status}${changed ? " run-table-changed" : ""}${row.violations.length ? " run-table-invalid" : ""}`}>
            <td className="run-table-time"><TimeRange start={row.start} end={row.end} />{changedTime && original && <span className="run-table-old-time">旧 {formatTime(original.row.start)}–{formatTime(original.row.end)}</span>}</td>
            <td className="run-table-content"><div className="run-table-title-line">{row.locked && <span className="run-table-fixed" role="img" aria-label="出演時刻を固定" title="出演時刻を固定"><LockKeyhole size={13} aria-hidden="true" /></span>}<strong>{title}</strong>{changed && <span className="run-table-change-badge">変更</span>}<button type="button" className="run-table-edit" onClick={() => onEdit(row.id)} aria-label={`${title}を編集`} title="編集"><Pencil size={14} aria-hidden="true" /></button></div>{group && group !== title && <span className="run-table-group"><UsersRound size={13} aria-hidden="true" /><span>{group}</span></span>}
              {members.length > 0 && <ul className="run-table-members" aria-label="メンバー">{members.map(member => <li className="run-table-member" key={member.name}>
                <span className="run-table-member-name"><UserRound size={12} aria-hidden="true" /><span>{member.name}</span></span>
                {member.roles.map(value => {
                  const role = getMemberRole(value, member.roleIcons);
                  return <span className="run-table-member-role" key={value} title={role.name}><span aria-hidden="true">{role.icon}</span><span>{role.label}</span>{role.name !== role.label && <span className="run-table-visually-hidden">（{role.name}）</span>}</span>;
                })}
              </li>)}</ul>}
              {changedOrder && original && <span className="run-table-order">順番 {original.index + 1} → {index + 1}</span>}
              {!!row.violations.length && <ul className="run-table-warnings">{row.violations.map((violation, warningIndex) => <li key={warningIndex}><AlertCircle size={13} /><span>{violation}</span></li>)}</ul>}
            </td>
            <td className="run-table-duration">{row.durationMinutes}<span>分</span>{changedDuration && original && <small>旧{original.row.durationMinutes}分</small>}</td>
          </tr>
        </tbody>;
      }) : <tbody><tr><td colSpan={3} className="run-table-empty">表示する進行枠がありません。</td></tr></tbody>}
    </table>
  </div>;
}
