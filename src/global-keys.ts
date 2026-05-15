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

async function toggleCliWindow(): Promise<void> {
  // The CLI window is declared in tauri.conf.json with label "cli". Looking
  // it up here (instead of holding a reference) is HMR-safe and survives
  // window reloads.
  const w = await WebviewWindow.getByLabel("cli");
  if (!w) {
    console.warn("[global-keys] cli window not found");
    return;
  }
  // Emit a single event that the cli-window.ts side translates into the
  // right action (it knows whether it's currently visible). Keeps the
  // toggle logic in one place.
  try { await w.emit("cli-window:toggle"); } catch (e) {
    console.warn("[global-keys] toggle emit failed", e);
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
      console.log(`[global-keys] registered ${combo} → ${label}`);
    } catch (err) {
      console.warn(`[global-keys] failed to register ${label} (${combo}):`, err);
    }
  }
}
