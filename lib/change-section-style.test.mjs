import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]{6})\b/gi)].map(([, name, value]) => [name, value]));
const themes = {
  light: tokens(css.match(/:root\s*\{([^}]+)\}/)[1]),
  dark: tokens(css.match(/:root\[data-theme="dark"\]\s*\{([^}]+)\}/)[1]),
};
function luminance(color) {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
}
function contrast(a, b) {
  const levels = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (levels[0] + .05) / (levels[1] + .05);
}

test("the adjustment section has its own teal palette in both themes", () => {
  for (const [name, theme] of Object.entries(themes)) {
    for (const token of ["change-bg", "change-border", "change-accent", "change-hover", "change-on-accent"]) assert.ok(theme[token], `${name} defines ${token}`);
    assert.notEqual(theme["change-bg"], theme.background);
    assert.notEqual(theme["change-bg"], theme.surface);
    for (const token of ["primary", "accent-text", "success"]) assert.notEqual(theme["change-accent"], theme[token], `${name} adjustment accent is distinct from ${token}`);
    const accent = theme["change-accent"];
    const [r, g, b] = [1, 3, 5].map(index => parseInt(accent.slice(index, index + 2), 16));
    assert.ok(g > b && b > r, `${name} accent should remain teal, not purple or yellow`);
  }
});

test("adjustment headings, links, input hints and button labels remain readable", () => {
  for (const [name, theme] of Object.entries(themes)) {
    for (const [text, background] of [
      ["change-accent", "change-bg"], ["change-hover", "change-bg"], ["secondary", "change-bg"],
      ["foreground", "surface"], ["secondary", "surface"],
      ["change-on-accent", "change-accent"], ["change-on-accent", "change-hover"],
      ["secondary", "surface-subtle"],
    ]) assert.ok(contrast(theme[text], theme[background]) >= 4.5, `${name}: ${text} on ${background} meets text contrast`);
  }
});

test("only the adjustment section receives the filled panel, teal actions and compact heading", () => {
  assert.match(css, /\.change-section \{[^}]*background:var\(--change-bg\);[^}]*border:1px solid var\(--change-border\);[^}]*border-left:3px solid var\(--change-accent\);[^}]*border-radius:7px;/);
  assert.match(css, /\.change-section>h2 \{[^}]*color:var\(--change-accent\);[^}]*font-size:13px;/);
  assert.match(css, /\.change-section \.change-form \.button\.primary \{[^}]*color:var\(--change-on-accent\);[^}]*background:var\(--change-accent\);/);
  assert.match(css, /\.change-section \.change-form \.button\.primary:disabled \{[^}]*color:var\(--secondary\);[^}]*background:var\(--surface-subtle\);[^}]*opacity:1;/);
  assert.match(css, /\.change-section \.change-assist \{ margin:8px 0 0; \}/);
  assert.match(css, /\.change-section \.example-buttons button:hover:not\(:disabled\) \{[^}]*color:var\(--change-accent\);/);
  assert.doesNotMatch(css, /\.plan-results[^\{]*\{[^}]*--change-|\.timetable-shell[^\{]*\{[^}]*--change-/);
});

test("the section retains flexible mobile inputs and wrapping examples without adding fixed dimensions", () => {
  assert.match(css, /\.change-form \{[^}]*display:flex;[^}]*gap:8px;[^}]*margin:0;/);
  assert.match(css, /\.change-form input \{[^}]*flex:1;[^}]*width:100%;/);
  assert.match(css, /\.example-buttons \{[^}]*flex-wrap:wrap;/);
  assert.match(css, /\.change-section \{ margin-top:19px; padding:11px 12px; \}/);
  assert.doesNotMatch(css, /\.change-section(?:>h2)?\s*\{[^}]*(?:width:\d+px|height:\d+px)/);
});
