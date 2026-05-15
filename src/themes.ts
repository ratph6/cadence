import { invoke } from "@tauri-apps/api/core";
import { patchConfig, getConfig } from "./settings";

export interface ThemeMeta { name: string; size: number; }

const STYLE_ID = "cadence-imported-theme";
const FONT_STYLE_ID = "cadence-imported-theme-fonts";

// ----------------------------------------------------------------- variable map
//
// Vencord/BD themes redefine Discord CSS variables under wildly varying
// selectors — :root, .theme-dark, body.theme-dark, .appMount-XXX, etc. A
// static `var(--xxx, default)` bridge can only see vars defined at the SAME
// element scope, so anything scoped under a different selector silently
// fell through and looked like the theme didn't apply.
//
// Approach: inject the theme verbatim, then ASK THE BROWSER for the computed
// values of every var we care about (read from <body>, which inherits the
// whole cascade). Mirror those values to Cadence's own var names inline on
// :root. Works regardless of which selector the theme used because
// getComputedStyle resolves the entire cascade for us.
//
// Map is intentionally exhaustive — most popular Vencord themes (Cattppuccin,
// Midnight, Equicord, Solana, Synthwave, etc.) touch some subset of these.
// Multiple Discord vars can map to the same Cadence var; first match wins.
const VAR_MAP: Array<[string, string]> = [
  // bg — deepest. Visual-refresh `lowest` is the darkest token.
  ["--background-base-lowest",          "--bg"],
  ["--bg-overlay-color",                "--bg"],
  ["--bg-base-primary",                 "--bg"],
  ["--background-primary",              "--bg"],
  ["--primary-800",                     "--bg"],
  ["--primary-700",                     "--bg"],
  // bg-2 — next darkest (sidebar / channel list)
  ["--background-base-lower",           "--bg-2"],
  ["--background-tertiary",             "--bg-2"],
  ["--primary-660",                     "--bg-2"],
  ["--primary-630",                     "--bg-2"],
  // panel — card / input surface
  ["--background-base-low",             "--panel"],
  ["--background-secondary",            "--panel"],
  ["--card-primary-background",         "--panel"],
  ["--input-background",                "--panel"],
  ["--modal-background",                "--panel"],
  ["--popover-background",              "--panel"],
  ["--primary-600",                     "--panel"],
  // panel-2 — elevated surface (floating / alt)
  ["--background-base-medium",          "--panel-2"],
  ["--background-secondary-alt",        "--panel-2"],
  ["--background-floating",             "--panel-2"],
  ["--card-secondary-background",       "--panel-2"],
  ["--primary-560",                     "--panel-2"],
  ["--primary-500",                     "--panel-2"],
  // hover — brightest surface
  ["--background-base-high",            "--hover"],
  ["--background-modifier-hover",       "--hover"],
  ["--background-modifier-active",      "--hover"],
  ["--primary-400",                     "--hover"],
  // borders
  ["--background-modifier-selected",    "--border-2"],
  ["--background-modifier-accent",      "--border"],
  // text
  ["--text-default",                    "--text"],
  ["--text-normal",                     "--text"],
  ["--text-primary",                    "--text"],
  ["--header-primary",                  "--text"],
  ["--interactive-active",              "--text"],
  ["--interactive-hover",               "--text"],
  ["--text-link",                       "--accent"],
  ["--header-secondary",                "--text-dim"],
  ["--interactive-normal",              "--text-dim"],
  ["--text-muted",                      "--text-mute"],
  ["--text-tertiary",                   "--text-mute"],
  ["--text-positive",                   "--accent"],
  ["--text-danger",                     "--danger"],
  ["--status-danger",                   "--danger"],
  ["--text-warning",                    "--danger"],
  // brand / accent
  ["--brand-experiment",                "--accent"],
  ["--brand-500",                       "--accent"],
  ["--button-positive-background",      "--accent"],
  ["--brand-560",                       "--accent-d"],
  ["--brand-600",                       "--accent-d"],
  ["--button-positive-background-hover","--accent-d"],
];

const ORIGINAL_DEFAULTS: Record<string, string> = {
  "--bg":        "#0e0e10",
  "--bg-2":      "#141417",
  "--panel":     "#1a1a1e",
  "--panel-2":   "#222227",
  "--hover":     "#2a2a30",
  "--border":    "rgba(255,255,255,.06)",
  "--border-2":  "rgba(255,255,255,.10)",
  "--text":      "#ebebee",
  "--text-dim":  "#8a8a93",
  "--text-mute": "#5a5a62",
  "--accent":    "#1ed760",
  "--accent-d":  "#169f48",
  "--danger":    "#f56565",
};

function syncCadenceVarsFromTheme() {
  const body = document.body;
  if (!body) return;
  const cs = getComputedStyle(body);
  const root = document.documentElement;
  const written = new Set<string>();
  // Pass 1: explicit Discord → Cadence mapping. First match wins per
  // Cadence var, so the most-canonical Discord var always provides the
  // colour even if multiple aliases were defined.
  for (const [discordVar, cadenceVar] of VAR_MAP) {
    if (written.has(cadenceVar)) continue;
    const v = cs.getPropertyValue(discordVar).trim();
    if (v) {
      root.style.setProperty(cadenceVar, v);
      written.add(cadenceVar);
    }
  }
  for (const cadVar of Object.keys(ORIGINAL_DEFAULTS)) {
    if (!written.has(cadVar)) root.style.removeProperty(cadVar);
  }
}

// Pass 2: harvest EVERY `--xxx: yyy` declaration from the theme CSS and
// re-publish them at :root via a SINGLE injected stylesheet (not inline
// styles — inline writes accumulate in the element's StyleAttribute object
// and were swelling the V8 heap). One stylesheet, one parsed rule, no
// per-property objects on the root element.
//
// Capped at MAX_HARVEST so a pathological theme with thousands of vars
// (some auto-generated palette tools dump these) can't blow the budget.
const HARVEST_STYLE_ID = "cadence-imported-theme-harvest";
const MAX_HARVEST = 400;
function harvestVarsFromCss(css: string) {
  let host = document.getElementById(HARVEST_STYLE_ID) as HTMLStyleElement | null;
  if (!host) {
    host = document.createElement("style");
    host.id = HARVEST_STYLE_ID;
    document.head.appendChild(host);
  }
  // Match every custom property declaration anywhere in the CSS. Conservative
  // regex — `--ident: value;` value continues until ; or }.
  const re = /(--[A-Za-z0-9_-]+)\s*:\s*([^;}]+?)\s*(?=;|\})/g;
  const found = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = m[1]!;
    if (name.startsWith("--theme-bg-")) continue;
    if (name in ORIGINAL_DEFAULTS) continue; // we own these
    found.set(name, m[2]!);
    if (found.size >= MAX_HARVEST) break;
  }
  if (!found.size) { host.textContent = ""; return; }
  // Build one :root rule with all the vars. Compact, single-rule cost.
  const decls: string[] = [];
  for (const [k, v] of found) decls.push(`${k}:${v}`);
  host.textContent = `:root{${decls.join(";")}}`;
}

function clearCadenceVarOverrides() {
  const root = document.documentElement;
  for (const cadVar of Object.keys(ORIGINAL_DEFAULTS)) {
    root.style.removeProperty(cadVar);
  }
  // Drop the harvested-vars stylesheet entirely so its rules leave the CSSOM.
  document.getElementById(HARVEST_STYLE_ID)?.remove();
  root.style.removeProperty("font-family");
  root.style.removeProperty("--theme-font");
}

// ----------------------------------------------------------------- font sync
//
// Themes commonly redefine Discord font tokens. Mirror them to body so the
// whole UI picks up the theme's chosen typeface.
const FONT_VARS = [
  "--font-primary",
  "--font-display",
  "--font-headline",
  "--font-body",
  "--font-headline-deprecated",
];

function syncFontFromTheme() {
  const cs = getComputedStyle(document.body);
  const root = document.documentElement;
  for (const v of FONT_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val) {
      root.style.setProperty("--theme-font", val);
      // Body font-family comes from base.css; override inline so the theme
      // wins without us having to re-author every selector that uses font.
      root.style.setProperty("font-family", val);
      return;
    }
  }
}

// ----------------------------------------------------------------- background image
//
// Vencord background-image vars from the wider plugin ecosystem. If any of
// these resolves to a URL, that's the theme's intended desktop wallpaper.
const BG_IMAGE_VARS = [
  "--bg-overlay-image",
  "--main-image",
  "--bg-image",
  "--background-image",
  "--bg-img",
  "--background-overlay",
  "--custom-background",
  "--app-bg-image",
];

const BG_TUNING_VARS = {
  blur: ["--bg-image-blur", "--bg-blur", "--main-blur"],
  saturation: ["--bg-image-saturation", "--bg-saturation", "--main-saturation"],
  brightness: ["--bg-image-brightness", "--bg-brightness", "--main-brightness"],
  opacity: ["--bg-overlay-opacity", "--bg-opacity"],
};

function readFirst(cs: CSSStyleDeclaration, vars: string[]): string {
  for (const v of vars) {
    const x = cs.getPropertyValue(v).trim();
    if (x) return x;
  }
  return "";
}

function syncBackgroundImageFromTheme(themeCss: string) {
  const body = document.body;
  const html = document.documentElement;
  const cs = getComputedStyle(body);

  let bgImg = "";
  for (const v of BG_IMAGE_VARS) {
    const val = cs.getPropertyValue(v).trim();
    if (val && val !== "none" && val.includes("url(")) { bgImg = val; break; }
  }
  // Fallback: scan ALL background-image declarations in the raw theme CSS,
  // pick the first url() that isn't a data: scheme used for icons.
  if (!bgImg) {
    // Match url() inside any `background` or `background-image` property.
    const re = /background(?:-image)?\s*:[^;]*url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(themeCss))) {
      const url = m[2]!;
      // Skip tiny SVG/PNG icons embedded as data URIs.
      if (url.startsWith("data:") && url.length < 200) continue;
      bgImg = `url("${url}")`;
      break;
    }
  }

  if (!bgImg) { clearBackgroundImage(); return; }

  const blur = readFirst(cs, BG_TUNING_VARS.blur);
  const sat = readFirst(cs, BG_TUNING_VARS.saturation);
  const bright = readFirst(cs, BG_TUNING_VARS.brightness);
  const opacity = readFirst(cs, BG_TUNING_VARS.opacity);

  // Apply to both html + body so themes that target either selector still see
  // the picture render. Use !important to beat base.css's `body { background:
  // var(--bg) }` shorthand which would otherwise reset background-image:none.
  for (const el of [html, body] as HTMLElement[]) {
    el.style.setProperty("background-image", bgImg, "important");
    el.style.setProperty("background-size", "cover", "important");
    el.style.setProperty("background-position", "center center", "important");
    el.style.setProperty("background-attachment", "fixed", "important");
    el.style.setProperty("background-repeat", "no-repeat", "important");
  }

  // Filter overlay — only mark .has-theme-bg-fx when there's actually a
  // filter/opacity to apply. Without that the ::before overlay would paint
  // the wallpaper a SECOND time (body already paints it once), doubling
  // GPU surface for a 4K image (~60 MB extra). Saves a chunk of memory
  // for the common no-filter case.
  const parts: string[] = [];
  if (blur) parts.push(`blur(${blur})`);
  if (sat) parts.push(`saturate(${sat})`);
  if (bright) parts.push(`brightness(${bright})`);
  const hasFx = parts.length > 0 || !!opacity;
  if (parts.length) html.style.setProperty("--theme-bg-filter", parts.join(" "));
  else              html.style.removeProperty("--theme-bg-filter");
  if (opacity)      html.style.setProperty("--theme-bg-opacity", opacity);
  else              html.style.removeProperty("--theme-bg-opacity");

  html.classList.add("has-theme-bg");
  html.classList.toggle("has-theme-bg-fx", hasFx);
}

function clearBackgroundImage() {
  for (const el of [document.documentElement, document.body] as HTMLElement[]) {
    if (!el) continue;
    el.style.removeProperty("background-image");
    el.style.removeProperty("background-size");
    el.style.removeProperty("background-position");
    el.style.removeProperty("background-attachment");
    el.style.removeProperty("background-repeat");
  }
  document.documentElement.classList.remove("has-theme-bg");
  document.documentElement.classList.remove("has-theme-bg-fx");
  document.documentElement.style.removeProperty("--theme-bg-filter");
  document.documentElement.style.removeProperty("--theme-bg-opacity");
}

// ----------------------------------------------------------------- @import inlining
//
// Many real-world themes are a 1-line shim that just `@import url(https://...);`
// the actual content from a CDN/GitHub raw URL. Browsers WILL fetch those, but
// the result lives in a separate stylesheet so getComputedStyle on a
// just-injected `<style>` may race the fetch — the bridge sees defaults.
//
// Resolve every `@import` recursively (depth cap 3, max 8 imports) ahead of
// time and inline the fetched content into a single string. Drop the original
// @import statements so the browser doesn't re-fetch them.
async function inlineImports(css: string, depth = 0, seen = new Set<string>()): Promise<string> {
  if (depth >= 3) return css.replace(/@import[^;]+;/g, "");
  // @import url(X);  /  @import "X";  /  @import url("X");  etc.
  const re = /@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?\s*;?/gi;
  const matches = Array.from(css.matchAll(re)).slice(0, 8);
  if (!matches.length) return css;
  const replacements = await Promise.all(matches.map(async (m) => {
    const url = m[1]!;
    if (seen.has(url)) return { full: m[0], inline: "" };
    seen.add(url);
    try {
      const r = await fetch(url, { cache: "force-cache" });
      if (!r.ok) return { full: m[0], inline: "" };
      const txt = await r.text();
      const recursed = await inlineImports(txt, depth + 1, seen);
      // Resolve relative url() inside the fetched CSS to the absolute origin.
      const base = new URL(url);
      const rewritten = recursed.replace(
        /url\(\s*(['"]?)((?!data:|https?:|\/\/)[^'")]+)\1\s*\)/gi,
        (_, q: string, rel: string) => `url(${q}${new URL(rel, base).toString()}${q})`,
      );
      return { full: m[0], inline: `\n/* inlined from ${url} */\n${rewritten}\n` };
    } catch {
      return { full: m[0], inline: "" };
    }
  }));
  let out = css;
  for (const { full, inline } of replacements) {
    out = out.replace(full, inline);
  }
  return out;
}

// ----------------------------------------------------------------- meta + utils

/** Strip BD/Vencord meta header for preview text. */
export function readThemeName(content: string, fallback: string): string {
  const meta = content.match(/@name\s+([^\r\n*]+)/);
  if (meta?.[1]) return meta[1].trim();
  return fallback;
}

function styleEl(): HTMLStyleElement {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  // Re-append so it stays last in <head>: any base.css HMR update pushed
  // afterwards would otherwise win the cascade.
  document.head.appendChild(el);
  return el;
}

/** Mark <html> + <body> with every Discord wrapper class real-world themes
 *  expect to find. Safe — if the theme doesn't reference one of these, the
 *  rule simply doesn't match anything. */
function markThemeRoot(on: boolean) {
  const classes = [
    "theme-dark", "theme-darker", "theme-midnight", "visual-refresh",
    "platform-win", "full-motion", "density-default", "user-theme-base",
  ];
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    for (const c of classes) el.classList.toggle(c, on);
  }
}

/** Apply a theme by content. Resolves @imports first so the cascade is
 *  complete before we sync vars / bg / fonts. */
export async function applyThemeCss(rawCss: string) {
  markThemeRoot(true);
  const resolved = await inlineImports(rawCss);
  styleEl().textContent = resolved;
  // Two rAFs gives the browser time to apply the new <style> rules + finish
  // any @font-face load before we read computed styles.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    syncCadenceVarsFromTheme();
    harvestVarsFromCss(resolved);
    syncBackgroundImageFromTheme(resolved);
    syncFontFromTheme();
  }));
}

export function clearTheme() {
  markThemeRoot(false);
  clearCadenceVarOverrides();
  clearBackgroundImage();
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(FONT_STYLE_ID)?.remove();
}

export async function listThemes(): Promise<ThemeMeta[]> {
  return await invoke<ThemeMeta[]>("theme_list");
}

export async function importTheme(file: File): Promise<string> {
  const content = await file.text();
  const baseName = file.name.replace(/\.(theme\.css|css)$/i, "");
  const name = readThemeName(content, baseName);
  await invoke<string>("theme_save", { name, content });
  return name;
}

export async function applyTheme(name: string | null): Promise<void> {
  if (!name) {
    clearTheme();
    await patchConfig({ activeTheme: undefined as any });
    return;
  }
  const content = await invoke<string>("theme_read", { name });
  await applyThemeCss(content);
  await patchConfig({ activeTheme: name });
}

export async function deleteTheme(name: string): Promise<void> {
  await invoke("theme_delete", { name });
  if (getConfig().activeTheme === name) {
    clearTheme();
    await patchConfig({ activeTheme: undefined as any });
  }
}

/** Re-apply the previously-active theme from config on boot. */
export async function restoreActiveTheme(): Promise<void> {
  const name = getConfig().activeTheme;
  if (!name) return;
  try {
    const content = await invoke<string>("theme_read", { name });
    await applyThemeCss(content);
  } catch (e) {
    console.warn("[theme] restore failed", e);
  }
}
