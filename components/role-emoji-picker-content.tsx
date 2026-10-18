"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
import EmojiPicker, { Categories, type EmojiClickData } from "emoji-picker-react";
import japaneseEmojiData from "emoji-picker-react/data/emojis-ja";
import { ROLE_EMOJI_LABELS } from "@/lib/emoji-picker-labels";
import { isMemberRoleIcon } from "@/lib/member-roles";

// Do not filter the dataset: every built-in Unicode category remains available.
const categories = [
  { category: Categories.SUGGESTED, name: "最近使った絵文字" },
  { category: Categories.SMILEYS_PEOPLE, name: "顔・人" },
  { category: Categories.ANIMALS_NATURE, name: "動物・自然" },
  { category: Categories.FOOD_DRINK, name: "食べ物・飲み物" },
  { category: Categories.TRAVEL_PLACES, name: "旅行・場所" },
  { category: Categories.ACTIVITIES, name: "アクティビティ" },
  { category: Categories.OBJECTS, name: "もの" },
  { category: Categories.SYMBOLS, name: "記号" },
  { category: Categories.FLAGS, name: "旗" },
];

export function RoleEmojiPickerContent({ selected, onSelect }: { selected: string; onSelect: (emoji: string) => void }) {
  const [colorScheme, setColorScheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setColorScheme(root.dataset.theme === "dark" ? "dark" : "light");
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  function preventSearchSubmit(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || event.target === event.currentTarget) return;
    const target = event.target as HTMLElement;
    if (target.getAttribute("data-epr-part") !== "search-input") return;
    // The picker selects search results itself. Never let its text input submit
    // the enclosing slot form, and never interrupt Japanese IME confirmation.
    event.stopPropagation();
    if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.preventDefault();
  }

  return <div className="role-emoji-picker" lang="ja" data-selected-emoji={selected} onKeyDown={preventSearchSubmit} onKeyDownCapture={event => {
    // A composing Enter must not reach the library's result-selection shortcut.
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.stopPropagation();
  }}>
    <EmojiPicker
      className="role-emoji-picker-panel"
      aria-label="絵文字を選択"
      lang="ja"
      emojiData={japaneseEmojiData}
      labels={ROLE_EMOJI_LABELS}
      categories={categories}
      emojiStyle="native"
      colorScheme={colorScheme}
      width="100%"
      height={360}
      style={{ minWidth: 0, maxWidth: "100%" }}
      suggestedEmojisMode="recent"
      previewConfig={{ showPreview: true, defaultCaption: "絵文字を選んでください" }}
      onEmojiClick={(emoji: EmojiClickData) => {
        if (!emoji.isCustom && isMemberRoleIcon(emoji.emoji)) onSelect(emoji.emoji);
      }}
    />
  </div>;
}
