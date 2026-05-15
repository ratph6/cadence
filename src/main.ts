import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { auth, api, librespot, audioPipeline, eq } from "./api";
import { state } from "./store";
import { keybinds } from "./keybinds";
import { loadConfig, getConfig, patchConfig } from "./settings";
import { initPlayer, playback } from "./player";
import { loadPlugins } from "./plugins";
import { renderLogin } from "./ui/login";
import { renderApp } from "./ui/app";
import { startAutoDj } from "./auto-dj";
import { startGlobalKeys } from "./global-keys";
import { startCli } from "./cli";
import { startDiscordPresence } from "./discord-presence";
import { restoreActiveTheme } from "./themes";

// Tauri's dev menu doesn't reliably wire Cmd/Ctrl+R; install a manual
// handler so reload works from anywhere in the app.
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.code === "KeyR") {
    e.preventDefault();
    location.reload();
  }
}, true);

// Global right-click handling. The default Tauri/WebView menu (Back, Reload,
// Save Image As, etc.) is noise inside an app — always suppress it. Per-item
// custom menus (playlists, tracks) call e.preventDefault() in their own
// listeners, so we leave them alone via defaultPrevented. With the
// `enableContextMenu` feature flag on, an empty-area right-click pops a
// minimal menu whose only entry is Inspect (opens devtools via Rust).
function installGlobalContextMenu() {
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (!getConfig().features.enableContextMenu) return;
    showInspectMenu(e.clientX, e.clientY);
  });
  document.addEventListener("click", () => {
    const m = document.getElementById("global-ctx-menu");
    if (m) m.remove();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const m = document.getElementById("global-ctx-menu");
    if (m) m.remove();
  });
}

function showInspectMenu(x: number, y: number) {
  const existing = document.getElementById("global-ctx-menu");
  if (existing) existing.remove();
  const m = document.createElement("div");
  m.id = "global-ctx-menu";
  m.className = "ctx-menu";
  m.style.minWidth = "120px";
  m.innerHTML = `<button class="ctx-item" type="button">Inspect</button>`;
  document.body.appendChild(m);
  const rect = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  m.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`;
  m.querySelector("button")!.addEventListener("click", () => {
    m.remove();
    invoke("open_devtools").catch((err) => console.warn("open_devtools failed", err));
  });
}

function buildActions() {
  return {
    playPause: () => playback.togglePlay(),
    next: () => playback.next(),
    previous: () => playback.previous(),
    search: () => state.view.set("search"),
    volumeUp: () => bumpVolume(+0.05),
    volumeDown: () => bumpVolume(-0.05),
    settings: () => state.view.set("settings"),
    focus: () => state.view.set("focus"),
    toggleLayout: () => {},
    cycleTheme: () => {},
  };
}

export function rebindKeybinds(): void {
  keybinds.apply(getConfig().keybinds, buildActions());
}

async function boot() {
  const cfg = await loadConfig();

  const loggedIn = await auth.isLoggedIn();
  state.loggedIn.set(loggedIn);

  const root = document.getElementById("app")!;

  if (!loggedIn) {
    renderLogin(root);
    return;
  }

  if (typeof cfg.volume === "number") {
    state.volume.set(Math.max(0, Math.min(1, cfg.volume)));
  }

  // Re-apply imported theme before first paint so the user never sees a flash
  // of unstyled (default-palette) chrome.
  await restoreActiveTheme();

  renderApp(root);
  rebindKeybinds();
  keybinds.attach();
  installVolumePersist();
  installGlobalContextMenu();

  api.me().then((m) => state.me.set(m)).catch(() => {});
  startAutoDj();
  startGlobalKeys();
  startCli();
  startDiscordPresence();
  installWindowStatePersist();

  // System-tray menu events emitted from src-tauri/src/lib.rs (install_tray).
  // Subscribed once at boot — the tray persists for the lifetime of the app,
  // so no teardown path is needed.
  listen("tray:play_pause", () => playback.togglePlay()).catch(() => {});
  listen("tray:next", () => playback.next()).catch(() => {});
  listen("tray:prev", () => playback.previous()).catch(() => {});

  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    try {
      const ok = await auth.isLoggedIn();
      if (!ok) location.reload();
    } catch {}
  });

  const backend = cfg.audioBackend ?? "sdk";
  let bootedSdk = false;
  const startSdk = () => {
    if (bootedSdk) return;
    bootedSdk = true;
    if (cfg.features.webPlayback) {
      // Was firing initPlayer() and transferHere() in parallel — transferHere
      // ran before the SDK had a device id, so it either no-op'd or
      // transferred to whatever stale Connect device happened to be in the
      // list. Await initPlayer (which resolves once the SDK 'ready' event
      // fires with a device id) so the transfer targets *our* device on cold
      // start. Cuts ~1-3 s off the time-to-audio.
      initPlayer()
        .then(() => playback.transferHere())
        .catch((e) => console.warn("player init failed", e));
    }
  };

  if (backend === "librespot") {
    const eqOn = !!cfg.features.eqEnabled;
    const target = eqOn ? "Cadence (librespot+EQ)" : "Cadence (librespot)";
    const restoreEq = (cfg.eqGains && cfg.eqGains.length === 10)
      ? Promise.all(cfg.eqGains.map((g, i) => eq.setBand(i, g).catch(() => {})))
      : Promise.resolve();
    restoreEq
      .then(async () => {
        if (eqOn) await audioPipeline.start();
        else await librespot.start();
      })
      .then(() => waitForDeviceAndTransfer(target))
      .catch((e) => {
        console.warn("librespot/pipeline start failed:", e,
          "— falling back to Web Playback SDK");
        startSdk();
      });
  } else {
    startSdk();
  }

  if (cfg.plugins.length) loadPlugins(cfg.plugins);
}

function bumpVolume(delta: number) {
  playback.setVolume(state.volume.get() + delta);
}

// Poll the device list for librespot. Spotify needs a few seconds after
// librespot logs in before it shows up in `/me/player/devices`.
async function waitForDeviceAndTransfer(targetName: string) {
  const target = targetName.toLowerCase();
  for (let i = 0; i < 30; i++) {
    try {
      const r: any = await api.devices();
      const devs: any[] = r?.devices ?? [];
      const found = devs.find((d) => (d.name ?? "").toLowerCase() === target);
      if (found) {
        await api.transfer(found.id, false);
        state.deviceId.set(found.id);
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.warn(`device "${targetName}" never registered`);
}

function installVolumePersist() {
  let timer: number | undefined;
  let last: number | null = null;
  state.volume.subscribe((v) => {
    if (last !== null && Math.abs(last - v) < 0.005) return;
    last = v;
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(() => {
      patchConfig({ volume: v }).catch((e) => console.warn("[volume] save failed", e));
    }, 500);
  });
}

// Restore last window position + size on boot, then persist changes back to
// config (debounced) on resize/move. We use Physical units throughout — they
// already account for DPR, so a saved state replays at exactly the pixels the
// user left it. Tauri's `setSize`/`setPosition` accept either Logical or
// Physical; matching the units we read from avoids accidental DPR scaling.
async function installWindowStatePersist() {
  const { getCurrentWindow, PhysicalPosition, PhysicalSize } = await import(
    "@tauri-apps/api/window"
  );
  const w = getCurrentWindow();
  const saved = getConfig().windowState;
  if (saved) {
    try {
      if (
        typeof saved.width === "number" && saved.width > 0 &&
        typeof saved.height === "number" && saved.height > 0
      ) {
        await w.setSize(new PhysicalSize(saved.width, saved.height));
      }
      if (typeof saved.x === "number" && typeof saved.y === "number") {
        await w.setPosition(new PhysicalPosition(saved.x, saved.y));
      }
      if (saved.maximized) await w.maximize();
    } catch (e) {
      console.warn("[window-state] restore failed", e);
    }
  }

  let timer: number | undefined;
  const persist = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(async () => {
      try {
        const maximized = await w.isMaximized();
        // When maximized, outerSize/outerPosition reflect the maximized
        // bounds, not the user's "normal" size. Saving those would mean the
        // window can never shrink back below screen size after a restart.
        // Skip the size/position update while maximized — keep the prior
        // saved restore state and only flip the `maximized` flag.
        if (maximized) {
          const prev = getConfig().windowState;
          await patchConfig({
            windowState: {
              x: prev?.x ?? 0,
              y: prev?.y ?? 0,
              width: prev?.width ?? 1280,
              height: prev?.height ?? 800,
              maximized: true,
            },
          });
          return;
        }
        const pos = await w.outerPosition();
        const sz = await w.outerSize();
        await patchConfig({
          windowState: {
            x: pos.x, y: pos.y,
            width: sz.width, height: sz.height,
            maximized: false,
          },
        });
      } catch (e) {
        console.warn("[window-state] persist failed", e);
      }
    }, 400);
  };

  // Tauri returns unlisten fns we just hold — the window lives as long as
  // the app does, so we don't bother tearing them down.
  w.onResized(persist).catch(() => {});
  w.onMoved(persist).catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="padding:2rem;color:#f66;font:13px/1.45 monospace">${
    String(e).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!)
  }</pre>`;
});
