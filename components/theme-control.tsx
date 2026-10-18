"use client";

import { useEffect, useRef, useState } from "react";
import { normalizeThemePreference, resolveTheme, THEME_STORAGE_KEY, type ThemePreference } from "@/lib/theme";

export function ThemeControl() {
  // Keep the server and first client render identical. The head script applies
  // the saved colors before paint; this effect then reconciles the menu value.
  const [preference, setPreference] = useState<ThemePreference>("system");
  const preferenceRef = useRef<ThemePreference>("system");
  const mediaRef = useRef<MediaQueryList | null>(null);

  function apply(next: ThemePreference) {
    preferenceRef.current = next;
    setPreference(next);
    document.documentElement.dataset.theme = resolveTheme(next, mediaRef.current?.matches ?? false);
  }

  useEffect(() => {
    let media: MediaQueryList | null = null;
    try { media = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null; } catch { /* Use the light fallback. */ }
    mediaRef.current = media;
    let saved: ThemePreference = "system";
    try { saved = normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY)); } catch { /* Device mode still works. */ }
    apply(saved);

    const onSystemChange = () => {
      document.documentElement.dataset.theme = resolveTheme(preferenceRef.current, media?.matches ?? false);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
      try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
      apply(normalizeThemePreference(event.newValue));
    };
    media?.addEventListener?.("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media?.removeEventListener?.("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return <div className="theme-control">
    <label className="theme-control-label" htmlFor="appearance-theme">表示モード</label>
    <select id="appearance-theme" value={preference} onChange={event => {
      const next = normalizeThemePreference(event.target.value);
      apply(next);
      try { window.localStorage.setItem(THEME_STORAGE_KEY, next); } catch { /* Apply now even if saving is blocked. */ }
    }}>
      <option value="system">端末に合わせる</option>
      <option value="light">ライト</option>
      <option value="dark">ダーク</option>
    </select>
  </div>;
}
