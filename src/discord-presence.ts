// Discord rich presence subscriber. When features.discordRpc is on AND
// settings.discordClientId is set, we connect to the local Discord client
// and push the current track ~every 5 seconds (or whenever the track or
// pause state changes — whichever is sooner).

import { discord } from "./api";
import { state } from "./store";
import { getConfig } from "./settings";

const PUSH_INTERVAL_MS = 5000;

let connected = false;
let lastPushTs = 0;
let lastUri: string | null = null;
let lastPaused: boolean | null = null;

export async function startDiscordPresence(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.features?.discordRpc) return;
  const cid = (cfg.discordClientId ?? "").trim();
  if (!cid) {
    console.warn("[discord] discordRpc enabled but no clientId set");
    return;
  }
  try {
    await discord.connect(cid);
    connected = true;
  } catch (e) {
    console.warn("[discord] connect failed:", e);
    return;
  }

  state.playback.subscribe((p) => {
    if (!connected || !p) return;
    const t = p.track_window?.current_track ?? p.item;
    const uri: string | null = t?.uri ?? null;
    const paused: boolean = p.paused ?? !(p.is_playing ?? false);

    const now = performance.now();
    const trackChanged = uri !== lastUri;
    const pauseChanged = paused !== lastPaused;
    if (!trackChanged && !pauseChanged && now - lastPushTs < PUSH_INTERVAL_MS) {
      return;
    }
    lastPushTs = now;
    lastUri = uri;
    lastPaused = paused;

    if (!t) {
      discord.clear().catch(() => {});
      return;
    }

    const id = (t.uri ?? "").split(":").pop() ?? "";
    const trackUrl = id ? `https://open.spotify.com/track/${id}` : undefined;
    const coverUrl = t.album?.images?.[0]?.url;

    discord.set({
      title: t.name ?? "",
      artist: (t.artists ?? []).map((a: any) => a.name).join(", "),
      album: t.album?.name ?? "",
      durationMs: t.duration_ms ?? 0,
      positionMs: p.progress_ms ?? p.position ?? 0,
      paused,
      trackUrl,
      coverUrl,
    }).catch((e) => console.warn("[discord] set failed:", e));
  });

  // Disconnect on page hide so we don't leak the IPC connection across reloads.
  window.addEventListener("beforeunload", () => {
    discord.disconnect().catch(() => {});
  });
}

export async function stopDiscordPresence(): Promise<void> {
  connected = false;
  await discord.disconnect().catch(() => {});
}
