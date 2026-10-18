import type { EventSlot, EventState } from "./types";

const slot = (value: Partial<EventSlot> & Pick<EventSlot, "id" | "title" | "durationMinutes">): EventSlot => ({
  group: "運営", kind: "talk", changeoverMinutes: 5, people: [], equipment: [], locked: false, status: "planned", energy: 3, notes: "", ...value,
});

export function createEmptyState(): EventState {
  return {
    event: { id: "my-event", name: "新しいイベント", date: "2026-11-14", location: "", startTime: 14 * 60, endTime: 17 * 60 + 30, quietWindows: [] },
    slots: [], history: [], revision: 0,
  };
}

export const demoState: EventState = {
  event: {
    id: "community-day-2026", name: "Community Day 2026", date: "2026-11-14", location: "Shibuya Community Hall", startTime: 14 * 60, endTime: 17 * 60 + 30,
    quietWindows: [{ id: "quiet-afternoon", label: "会場の音止め", start: 15 * 60 + 30, end: 15 * 60 + 40 }],
  },
  slots: [
    slot({ id: "opening", title: "オープニング", group: "Community Day", durationMinutes: 10, changeoverMinutes: 0, people: ["田中"], equipment: ["マイク"], status: "done", locked: true, fixedStart: 840, energy: 3 }),
    slot({ id: "keynote", title: "アイデアから、最初の一歩へ", group: "佐藤 みのり", durationMinutes: 25, people: ["佐藤"], equipment: ["マイク", "プロジェクター"], status: "done", locked: true, fixedStart: 855, energy: 3, notes: "キーノート。スライドあり。" }),
    slot({ id: "workshop", title: "みんなでつくるワークショップ", group: "Studio Loop", kind: "workshop", durationMinutes: 30, people: ["鈴木", "山本"], equipment: ["マイク", "プロジェクター", "テーブル"], status: "active", fixedStart: 885, energy: 4, notes: "進行中。参加者と一緒に手を動かすセッション。" }),
    slot({ id: "lightning", title: "ライトニングトーク", group: "Local Makers", durationMinutes: 10, people: ["高橋", "伊藤"], equipment: ["マイク", "プロジェクター"], energy: 4, notes: "2人の登壇者によるショートトーク。" }),
    slot({ id: "break", title: "コーヒーブレイク", group: "自由交流", kind: "break", durationMinutes: 10, changeoverMinutes: 0, energy: 2, notes: "15:30–15:40は会場の音止め。" }),
    slot({ id: "panel", title: "コミュニティのこれから", group: "Cross Talk", durationMinutes: 25, people: ["田中", "佐藤", "加藤"], equipment: ["マイク", "チェア"], earliestStart: 15 * 60 + 40, latestEnd: 17 * 60, energy: 3, notes: "佐藤さんは17時まで出演可能。" }),
    slot({ id: "live", title: "アコースティックライブ", group: "Evening Notes", kind: "live", durationMinutes: 20, people: ["渡辺", "小林"], equipment: ["マイク", "ギター", "キーボード"], energy: 5, notes: "ギターとキーボードの2人編成。" }),
    slot({ id: "closing", title: "クロージング＆集合写真", group: "Community Day", kind: "other", durationMinutes: 10, people: ["田中"], equipment: ["マイク"], energy: 4, notes: "終演後に全員で集合写真。" }),
  ],
  history: [
    { id: "seed-3", at: "2026-11-14T14:45:00+09:00", title: "ワークショップがスタート", detail: "最初の2枠は予定どおり終了しました。", kind: "progress" },
    { id: "seed-2", at: "2026-11-13T18:20:00+09:00", title: "出演条件を反映", detail: "パネリストの出演可能時刻と会場の音止め条件を確認。", kind: "edit" },
    { id: "seed-1", at: "2026-11-12T10:00:00+09:00", title: "タイムテーブルを作成", detail: "8枠のプログラムを登録しました。", kind: "create" },
  ],
  revision: 3,
};
