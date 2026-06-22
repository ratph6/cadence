// OS-level global shortcuts. Work even when the app is in the background.
//
// Defaults:
//   Ctrl+Alt+A → previous
//   Ctrl+Alt+D → next
//   Ctrl+Alt+S → play/pause
//
// (On macOS Tauri's "Ctrl" + "Alt" map to the literal Control and Option keys,
// not Cmd. Cmd+Alt+letter would clash with system shortcuts.)

import {
  register,
  unregisterAll,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { playback } from "./player";
import { dlog } from "./log";

async function toggleCliWindow(): Promise<void> {
  // Lazy-create the CLI window on first Alt+Space instead of preloading it
  // at app boot. A hidden webview still holds a full Chromium process tree
  // (~150-300 MB) — by deferring creation we keep idle memory under the
  // main window only. Once created the window persists for the rest of
  // the session so subsequent Alt+Space presses are an instant toggle.
  const existing = await WebviewWindow.getByLabel("cli");
  if (existing) {
    try { await existing.emit("cli-window:toggle"); } catch (e) {
      console.warn("[global-keys] toggle emit failed", e);
    }
    return;
  }
  try {
    // cli-window.ts auto-calls show() on initial boot, which repositions
    // near the top of the active monitor and focuses the input. We create
    // with `visible: true` so the window appears right away — the JS-side
    // positioning runs a tick later and tweaks it into place.
    // No OS-level Acrylic/Mica — the blur layer ended up stacking with the
    // CSS card and rendered as a too-bright frosted rectangle on Win11
    // regardless of tint. The window stays fully transparent and the visible
    // bar is the CSS card itself: a solid darker pill with rounded corners.
    new WebviewWindow("cli", {
      url: "cli.html",
      width: 720,
      height: 56,
      decorations: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      visible: true,
      center: true,
      focus: true,
      shadow: false,
      title: "Cadence CLI",
    });
  } catch (e) {
    console.warn("[global-keys] cli window create failed", e);
  }
}

const BINDS: Array<{ combo: string; fn: () => void; label: string }> = [
  { combo: "Ctrl+Alt+A", fn: () => playback.previous(),   label: "global previous" },
  { combo: "Ctrl+Alt+D", fn: () => playback.next(),       label: "global next" },
  { combo: "Ctrl+Alt+S", fn: () => playback.togglePlay(), label: "global play/pause" },
  { combo: "Alt+Space",  fn: () => { toggleCliWindow().catch(() => {}); }, label: "open CLI" },
];

export async function startGlobalKeys(): Promise<void> {
  // Clean slate — survive HMR / re-runs without "already registered" errors.
  try { await unregisterAll(); } catch (err) {
    console.warn("[global-keys] unregisterAll failed:", err);
  }
  for (const { combo, fn, label } of BINDS) {
    try {
      // After unregisterAll our handle is dropped, but if another app on the
      // OS already grabbed the same combo (Discord push-to-mute, OBS, etc.),
      // isRegistered returns true and Tauri will refuse to register. Try
      // anyway and surface the error — better than silent failure.
      const already = await isRegistered(combo);
      if (already) {
        console.warn(`[global-keys] ${combo} (${label}) already held by another process — skipping`);
        continue;
      }
      await register(combo, (e) => {
        if ((e as any)?.state && (e as any).state !== "Pressed") return;
        fn();
      });
      dlog(`[global-keys] registered ${combo} → ${label}`);
    } catch (err) {
      console.warn(`[global-keys] failed to register ${label} (${combo}):`, err);
    }
  }
}
