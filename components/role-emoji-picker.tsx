"use client";

import { lazy, Suspense } from "react";

// Keep the picker engine and both bundled dictionaries out of the initial app
// chunk. A stable, module-scoped loader shares the chunk across every member.
const LazyRoleEmojiPicker = lazy(() => import("./role-emoji-picker-content").then(module => ({ default: module.RoleEmojiPickerContent })));

export function RoleEmojiPicker({ selected, onSelect }: { selected: string; onSelect: (emoji: string) => void }) {
  return <div className="role-emoji-picker-container" style={{ width: "100%", minWidth: 0, maxWidth: "100%" }}>
    <Suspense fallback={<p className="member-role-emoji-heading" role="status">絵文字を読み込み中…</p>}>
      <LazyRoleEmojiPicker selected={selected} onSelect={onSelect} />
    </Suspense>
  </div>;
}
