import { getConfig, patchConfig } from "../../settings";
import { openUrl } from "@tauri-apps/plugin-opener";
import { listThemes, importTheme, applyTheme, deleteTheme } from "../../themes";
import { fmt } from "../util";
import { ui } from "../state";
import { applyFeatureClasses } from "../features";


export function renderSettings() {
  const cfg = getConfig();
  ui.viewEl.innerHTML = `
    <div class="page settings">
      <h1>Settings</h1>

      <h2 class="sub">Spotify Client ID</h2>
      <div class="row">
        <input id="cid-input" class="text-input" type="text" spellcheck="false"
               value="${fmt.esc(cfg.clientId ?? "")}" />
        <button id="cid-save">Save</button>
      </div>
      <p class="dim small">Stored in <code>config.json</code>.</p>

      <h2 class="sub">Audio backend</h2>
      <div class="row">
        <select id="backend-sel" class="text-input">
          <option value="sdk" ${(cfg.audioBackend ?? "sdk") === "sdk" ? "selected" : ""}>Web Playback SDK (default)</option>
          <option value="librespot" ${cfg.audioBackend === "librespot" ? "selected" : ""}>librespot (local audio)</option>
        </select>
        <span id="backend-status" class="dim small"></span>
      </div>
      <p class="dim small">
        Web SDK: official, DRM, gapless. <strong>librespot</strong>: reverse-engineered, local audio decode.
        Requires <code>librespot</code> on PATH (<code>cargo install librespot</code>). Violates Spotify ToS — small ban risk.
      </p>

      ${cfg.audioBackend === "librespot" ? `
        <h2 class="sub">Equalizer (librespot only)</h2>
        <label class="flag">
          <input type="checkbox" id="eq-enabled" ${cfg.features.eqEnabled ? "checked" : ""} />
          <span>Enable 10-band EQ <span class="dim small">(routes audio through internal pipe + cpal — ~30 ms extra latency)</span></span>
        </label>
        <div id="eq-panel" class="${cfg.features.eqEnabled ? "" : "dim"}">
          <div class="row" style="margin-top: 12px">
            <select id="eq-preset" class="text-input" style="max-width: 200px;">
              <option value="">— preset —</option>
              <option value="flat">Flat</option>
              <option value="bass_boost">Bass Boost</option>
              <option value="treble_boost">Treble Boost</option>
              <option value="vocal">Vocal</option>
              <option value="rock">Rock</option>
              <option value="pop">Pop</option>
              <option value="jazz">Jazz</option>
              <option value="classical">Classical</option>
              <option value="electronic">Electronic</option>
              <option value="loudness">Loudness</option>
            </select>
            <button id="eq-flat">Reset to flat</button>
          </div>
          <div id="eq-bands" class="eq-bands"></div>
        </div>
      ` : ""}

      <h2 class="sub">stats.fm</h2>
      <div class="row">
        <input id="sfm-user" class="text-input" type="text" spellcheck="false"
               placeholder="stats.fm username (or Spotify ID)"
               value="${fmt.esc(cfg.statsFmUser ?? "")}" />
        <button id="sfm-save">Save</button>
      </div>
      <p class="dim small">
        No API key needed. Public profile only. Sign up at
        <a href="https://stats.fm/" target="_blank" rel="noopener">stats.fm</a>
        and import your Spotify history first.
      </p>

      <h2 class="sub">Discord Rich Presence</h2>
      <div class="row">
        <input id="discord-cid" class="text-input" type="text" spellcheck="false"
               placeholder="Discord application ID"
               value="${fmt.esc(cfg.discordClientId ?? "")}" />
        <button id="discord-save">Save</button>
      </div>
      <p class="dim small">
        Register a free app at <a href="https://discord.com/developers/applications" target="_blank">discord.com/developers/applications</a>,
        copy its <code>Application ID</code>. Then enable the <code>discordRpc</code> feature flag and reload.
        Discord must be running locally.
      </p>

      <h2 class="sub">Global media keys</h2>
      <p class="dim small">Always active, even when window unfocused.</p>
      <div class="kbd-list">
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>A</kbd> &nbsp;previous</div>
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> &nbsp;play / pause</div>
        <div><kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd> &nbsp;next</div>
      </div>

      <h2 class="sub">In-app keybinds</h2>
      <p class="dim small">Click a row, press a new combo, Enter to commit, Esc to cancel.</p>
      <table class="kb">
        ${Object.entries(cfg.keybinds).map(([action, combos]) => `
          <tr data-action="${fmt.esc(action)}">
            <td>${fmt.esc(action)}</td>
            <td><button class="kb-btn">${fmt.esc((combos as string[]).join(" / "))}</button></td>
          </tr>`).join("")}
      </table>

      <h2 class="sub">Themes</h2>
      <p class="dim small">
        Import any Vencord or BetterDiscord <code>.css</code> / <code>.theme.css</code>
        file. Saved to disk under <code>themes/</code>; switch any time.
        Discord CSS variables are auto-aliased to Cadence's palette.
      </p>
      <div class="row" style="gap: 8px; flex-wrap: wrap;">
        <input type="file" id="theme-file" accept=".css,.theme.css,text/css" style="display: none;" />
        <button id="theme-import">Import theme…</button>
        <button id="theme-clear" class="ghost">Use default</button>
        <span id="theme-status" class="dim small"></span>
      </div>
      <ul id="theme-list" class="theme-list"></ul>

      <h2 class="sub">Features</h2>
      ${renderFeatureGroups(cfg.features)}
    </div>`;

  document.getElementById("cid-save")!.addEventListener("click", async () => {
    const v = (document.getElementById("cid-input") as HTMLInputElement).value.trim();
    await patchConfig({ clientId: v });
    flash("cid-save", "Saved ✓");
  });

  document.getElementById("discord-save")!.addEventListener("click", async () => {
    const v = (document.getElementById("discord-cid") as HTMLInputElement).value.trim();
    await patchConfig({ discordClientId: v });
    flash("discord-save", "Saved ✓");
  });

  document.getElementById("sfm-save")!.addEventListener("click", async () => {
    const u = (document.getElementById("sfm-user") as HTMLInputElement).value.trim();
    await patchConfig({ statsFmUser: u });
    flash("sfm-save", "Saved ✓");
  });

  // ---- Themes ----
  const themeFileInput = document.getElementById("theme-file") as HTMLInputElement;
  const themeStatus = document.getElementById("theme-status")!;
  const setStatus = (msg: string, ms = 2200) => {
    themeStatus.textContent = msg;
    if (ms > 0) setTimeout(() => { themeStatus.textContent = ""; }, ms);
  };
  const renderThemeList = async () => {
    const list = document.getElementById("theme-list");
    if (!list) return;
    try {
      const themes = await listThemes();
      const active = getConfig().activeTheme ?? null;
      if (!themes.length) {
        list.innerHTML = `<li class="dim small">No themes imported yet.</li>`;
        return;
      }
      list.innerHTML = themes.map((t) => {
        const isActive = t.name === active;
        const sizeKb = (t.size / 1024).toFixed(1);
        return `<li class="theme-row ${isActive ? "active" : ""}" data-name="${fmt.esc(t.name)}">
          <span class="theme-name">${fmt.esc(t.name)}</span>
          <span class="dim small">${sizeKb} KB</span>
          <button class="theme-apply" data-name="${fmt.esc(t.name)}">${isActive ? "Applied" : "Apply"}</button>
          <button class="theme-del ghost" data-name="${fmt.esc(t.name)}" title="Delete">×</button>
        </li>`;
      }).join("");
      list.querySelectorAll<HTMLButtonElement>(".theme-apply").forEach((b) => {
        b.addEventListener("click", async () => {
          await applyTheme(b.dataset.name!);
          setStatus(`Applied ${b.dataset.name}`);
          renderThemeList();
        });
      });
      list.querySelectorAll<HTMLButtonElement>(".theme-del").forEach((b) => {
        b.addEventListener("click", async () => {
          if (!confirm(`Delete theme "${b.dataset.name}"?`)) return;
          await deleteTheme(b.dataset.name!);
          renderThemeList();
        });
      });
    } catch (e) {
      list.innerHTML = `<li class="dim small">Couldn't list themes: ${fmt.esc(String(e))}</li>`;
    }
  };
  document.getElementById("theme-import")!.addEventListener("click", () => themeFileInput.click());
  themeFileInput.addEventListener("change", async () => {
    const files = themeFileInput.files;
    if (!files || !files.length) return;
    try {
      let lastName: string | null = null;
      for (const f of Array.from(files)) {
        lastName = await importTheme(f);
      }
      if (lastName) {
        await applyTheme(lastName);
        setStatus(`Imported & applied "${lastName}"`);
      }
    } catch (e) {
      setStatus(`Import failed: ${String(e)}`, 4000);
    } finally {
      themeFileInput.value = "";
      renderThemeList();
    }
  });
  document.getElementById("theme-clear")!.addEventListener("click", async () => {
    await applyTheme(null);
    setStatus("Reverted to default");
    renderThemeList();
  });
  renderThemeList();

  // External links inside the settings page should open in the browser, not
  // hijack the webview.
  ui.viewEl.querySelectorAll<HTMLAnchorElement>("a[href^='http']").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openUrl(a.href).catch((err) => console.warn("[opener]", err));
    });
  });

  // Audio backend selector — reload page after switching so boot logic
  // routes through the new path cleanly (Web SDK or librespot).
  const backendSel = document.getElementById("backend-sel") as HTMLSelectElement;
  const backendStatus = document.getElementById("backend-status")!;
  refreshBackendStatus(backendStatus);
  backendSel.addEventListener("change", async () => {
    const v = backendSel.value as "sdk" | "librespot";
    await patchConfig({ audioBackend: v });
    if (v === "sdk") {
      try { await (await import("../../api")).librespot.stop(); } catch {}
      try { await (await import("../../api")).audioPipeline.stop(); } catch {}
    }
    backendStatus.textContent = "Reloading…";
    setTimeout(() => location.reload(), 500);
  });

  // EQ panel (only present when audioBackend = librespot).
  if (cfg.audioBackend === "librespot") {
    mountEqPanel();
  }

  ui.viewEl.querySelectorAll<HTMLInputElement>("input[data-flag]").forEach((cb) => {
    cb.addEventListener("change", () => {
      patchConfig({
        features: { ...getConfig().features, [cb.dataset.flag!]: cb.checked },
      }).then(applyFeatureClasses);
    });
  });


  ui.viewEl.querySelectorAll<HTMLTableRowElement>("tr[data-action]").forEach((tr) => {
    const btn = tr.querySelector<HTMLButtonElement>(".kb-btn")!;
    btn.addEventListener("click", () => beginRebind(tr.dataset.action!, btn));
  });
}


interface FlagMeta { group: string; label: string; desc: string; }
const FLAG_META: Record<string, FlagMeta> = {
  webPlayback:      { group: "Playback",     label: "Web Playback SDK",     desc: "Spotify's official browser SDK. Required for in-app audio when audio backend = sdk." },
  autoQueueRelated: { group: "Playback",     label: "Auto-DJ",              desc: "Pre-queue a related track when nothing is set as context, so single-track plays don't loop." },
  eqEnabled:        { group: "Audio",        label: "10-band EQ",           desc: "Routes audio through a local pipe → biquad EQ → cpal. Requires audio backend = librespot." },
  showCovers:       { group: "Interface",    label: "Album covers",         desc: "Show artwork everywhere. Off = bandwidth saver / minimal aesthetic." },
  showRecents:      { group: "Interface",    label: "Recently played row",  desc: "Show the recently-played track list on the home screen." },
  showClock:        { group: "Interface",    label: "Clock on home",        desc: "Show the current time next to the greeting." },
  disableAnimations:{ group: "Interface",    label: "Disable animations",   desc: "Kill every CSS transition + animation. Helps perf on slow GPUs." },
  richArtwork:      { group: "Interface",    label: "Rich artwork",         desc: "Use the highest-resolution album image tier. Off = smaller payload." },
  cliMode:          { group: "Power user",   label: "Vim-style CLI",        desc: "Press `:` anywhere to open a command bar with autocomplete." },
  showMemoryGraph:  { group: "Power user",   label: "Memory graph",         desc: "Top-right mini chart showing JS heap usage in real time." },
  plugins:          { group: "Power user",   label: "Load plugins",         desc: "Load user JS plugins listed in config.json. They run with full app privileges — only enable for sources you trust." },
  enableContextMenu:{ group: "Power user",   label: "Right-click menu",     desc: "Show a custom right-click menu with an Inspect option. When off, right-clicking does nothing (default OS menu always suppressed)." },
  superBackground:  { group: "Super animated", label: "Galaxy background",   desc: "Fullscreen WebGL star-field behind the UI. Recolors with the active theme via hue shift." },
  superBackgroundMouse: { group: "Super animated", label: "Galaxy mouse repulsion", desc: "Stars warp away from the cursor. Off = static field that ignores the mouse." },
  superSliders:     { group: "Super animated", label: "Elastic sliders",     desc: "Volume + seek sliders pull elastically when dragged past the edges." },
  homeCatPhoto:     { group: "Home extras",  label: "Random cat",           desc: "Show a random cat photo on the home screen (cataas.com)." },
  homeDadJoke:      { group: "Home extras",  label: "Dad joke",             desc: "Rotating dad joke from icanhazdadjoke.com." },
  homeNews:         { group: "Home extras",  label: "The Hacker News",     desc: "Latest cybersecurity headlines from thehackernews.com (RSS via rss2json)." },
  homeVisualizer:   { group: "Home extras",  label: "Audio visualizer",    desc: "Real-time 8-band visualizer fed from PCM. Requires audio backend = librespot + EQ enabled." },
  discordRpc:       { group: "Integrations", label: "Discord Rich Presence",desc: "Push the current track to your Discord profile. Requires app ID in settings." },
};
const FLAG_GROUP_ORDER = ["Playback", "Audio", "Interface", "Super animated", "Home extras", "Power user", "Integrations"];

function renderFeatureGroups(features: Record<string, boolean>): string {
  const grouped: Record<string, string[]> = {};
  for (const k of Object.keys(features)) {
    // Drop legacy / unknown flags from the UI; their values stay in the
    // config.json on disk so we don't unintentionally wipe user state.
    if (!FLAG_META[k]) continue;
    const g = FLAG_META[k].group;
    (grouped[g] ??= []).push(k);
  }
  const groupNames = [
    ...FLAG_GROUP_ORDER.filter((g) => grouped[g]),
    ...Object.keys(grouped).filter((g) => !FLAG_GROUP_ORDER.includes(g)),
  ];
  return groupNames.map((g) => `
    <div class="flag-group">
      <div class="flag-group-h">${fmt.esc(g)}</div>
      ${grouped[g]!.map((k) => {
        const m = FLAG_META[k] ?? { label: k, desc: "" };
        return `
          <label class="flag-row" for="flag-${fmt.esc(k)}">
            <div class="flag-text">
              <div class="flag-label">${fmt.esc(m.label)}</div>
              ${m.desc ? `<div class="flag-desc dim small">${fmt.esc(m.desc)}</div>` : ""}
            </div>
            <span class="switch">
              <input type="checkbox" id="flag-${fmt.esc(k)}"
                     data-flag="${fmt.esc(k)}" ${features[k] ? "checked" : ""} />
              <span class="switch-track"><span class="switch-thumb"></span></span>
            </span>
          </label>`;
      }).join("")}
    </div>`).join("");
}


async function mountEqPanel() {
  const { eq } = await import("../../api");
  // Restore persisted gains into the Rust state before reading.
  const persisted = getConfig().eqGains;
  if (Array.isArray(persisted) && persisted.length === 10) {
    await Promise.all(persisted.map((g, i) => eq.setBand(i, g).catch(() => {})));
  }
  let st: any;
  try { st = await eq.get(); } catch { st = { gains_db: new Array(10).fill(0), bands_hz: [32,64,125,250,500,1000,2000,4000,8000,16000], enabled: true }; }
  const bandsEl = document.getElementById("eq-bands");
  const panel = document.getElementById("eq-panel");
  const enabledCb = document.getElementById("eq-enabled") as HTMLInputElement;
  const presetSel = document.getElementById("eq-preset") as HTMLSelectElement;
  const flatBtn = document.getElementById("eq-flat") as HTMLButtonElement;
  if (!bandsEl) return;

  const formatHz = (hz: number) =>
    hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${hz}`;

  const renderBands = (gains: number[]) => {
    bandsEl.innerHTML = st.bands_hz.map((hz: number, i: number) => {
      const v = gains[i] ?? 0;
      return `
        <div class="eq-band">
          <div class="eq-val small">${v >= 0 ? "+" : ""}${v.toFixed(1)}</div>
          <div class="eq-track-wrap">
            <div class="eq-zero-line"></div>
            <input type="range" orient="vertical" min="-18" max="18" step="0.5"
                   value="${v}" data-i="${i}" class="eq-slider" />
          </div>
          <div class="eq-label dim small">${formatHz(hz)}</div>
        </div>`;
    }).join("");
    bandsEl.querySelectorAll<HTMLInputElement>(".eq-slider").forEach((s) => {
      s.addEventListener("input", () => {
        const i = parseInt(s.dataset.i!);
        const v = parseFloat(s.value);
        eq.setBand(i, v).catch(() => {});
        const valEl = s.parentElement!.parentElement!.querySelector<HTMLElement>(".eq-val");
        if (valEl) valEl.textContent = `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
        scheduleEqSave();
      });
    });
  };
  renderBands(st.gains_db);

  enabledCb.addEventListener("change", async () => {
    await patchConfig({
      features: { ...getConfig().features, eqEnabled: enabledCb.checked },
    });
    panel?.classList.toggle("dim", !enabledCb.checked);
    flash("eq-enabled", "");
    // Setting takes effect on next app start (boot routes through pipeline
    // vs direct librespot). Tell user.
    const note = document.createElement("div");
    note.className = "dim small";
    note.style.marginTop = "8px";
    note.textContent = "Restart app to apply audio path change.";
    panel?.appendChild(note);
    setTimeout(() => note.remove(), 4000);
  });

  presetSel.addEventListener("change", async () => {
    const name = presetSel.value;
    if (!name) return;
    await eq.setPreset(name).catch(() => {});
    const fresh = await eq.get();
    renderBands(fresh.gains_db);
    presetSel.value = "";
    scheduleEqSave();
  });

  flatBtn.addEventListener("click", async () => {
    await eq.setPreset("flat");
    renderBands(new Array(10).fill(0));
    scheduleEqSave();
  });
}

let eqSaveTimer: number | undefined;
function scheduleEqSave() {
  if (eqSaveTimer !== undefined) clearTimeout(eqSaveTimer);
  eqSaveTimer = window.setTimeout(async () => {
    try {
      const { eq } = await import("../../api");
      const fresh = await eq.get();
      await patchConfig({ eqGains: fresh.gains_db });
    } catch {}
  }, 500);
}

async function refreshBackendStatus(el: HTMLElement) {
  try {
    const { librespot } = await import("../../api");
    const running = await librespot.status();
    el.textContent = running ? "librespot running" : "stopped";
    el.classList.toggle("ok", running);
  } catch {
    el.textContent = "—";
  }
}

function flash(id: string, text: string) {
  const b = document.getElementById(id) as HTMLButtonElement | null;
  if (!b) return;
  const orig = b.textContent;
  b.textContent = text;
  setTimeout(() => { b.textContent = orig; }, 1200);
}

let rebindAction: string | null = null;
let rebindBtn: HTMLButtonElement | null = null;
function beginRebind(action: string, btn: HTMLButtonElement) {
  rebindAction = action;
  rebindBtn = btn;
  btn.textContent = "press a key…";
  btn.classList.add("rebinding");
}
window.addEventListener("keydown", async (e) => {
  if (!rebindAction || !rebindBtn) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === "Escape") {
    rebindBtn.classList.remove("rebinding");
    const cfg = getConfig();
    rebindBtn.textContent = (cfg.keybinds[rebindAction] ?? []).join(" / ");
    rebindAction = null; rebindBtn = null;
    return;
  }
  if (e.key === "Enter") return;
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push("Mod");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  const combo = [...mods, e.code].join("+");
  rebindBtn.textContent = combo;
  const cfg = getConfig();
  await patchConfig({ keybinds: { ...cfg.keybinds, [rebindAction]: [combo] } });
  const { rebindKeybinds } = await import("../../main");
  rebindKeybinds();
  rebindBtn.classList.remove("rebinding");
  rebindAction = null; rebindBtn = null;
}, true);
