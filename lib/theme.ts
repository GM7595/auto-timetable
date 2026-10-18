export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "timetable.theme.v1";

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

// This function is serialized into the document head. Keep it self-contained:
// it must work before React loads, even when device storage is unavailable.
export function initializeTheme(storageKey: string): void {
  let preference = "system";
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark") preference = stored;
  } catch { /* Follow the device if storage is blocked. */ }
  let systemDark = false;
  try {
    systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  } catch { /* Fall back to light on older or restricted browsers. */ }
  document.documentElement.dataset.theme = preference === "dark" || (preference === "system" && systemDark) ? "dark" : "light";
}

export const THEME_INIT_SCRIPT = `(${initializeTheme.toString()})(${JSON.stringify(THEME_STORAGE_KEY)});`;
