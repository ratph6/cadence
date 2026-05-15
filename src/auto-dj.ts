// Auto-DJ: when a track plays without a context (i.e. not from a playlist/
// album/artist), Spotify just loops it. We override that by pre-fetching a
// "relevant" follow-up and forcing it via playback.start() either at end-of-
// track or when we detect the loop boundary (URI same, position resets).
//
// Why not /me/player/queue? Spotify doesn't reliably drain the queue when no
// context is set; the same track plays again. playback.start() with a single
// URI starts a fresh single-track session — solid behavior.

import { state } from "./store";
import { api } from "./api";
import { getConfig } from "./settings";
import { playback } from "./player";

const fetchedFor = new Set<string>();
function rememberFetched(uri: string) {
  fetchedFor.add(uri);
  if (fetchedFor.size > 64) {
    const drop = fetchedFor.values().next().value;
    if (drop) fetchedFor.delete(drop);
  }
}

let pendingNext: string | null = null;
let switchedFor: string | null = null;
let lastQueuedNext: string | null = null;

// Mirror of playback state, kept in sync with state.playback. Updated on
// every event so the tick() loop can predict position via drift math.
let curUri: string | null = null;
let curPos = 0;
let curDur = 0;
let curSync = performance.now();
let curPaused = true;
let curCtxUri: string | null | undefined = null;

function isRealContext(ctxUri: string | null | undefined): boolean {
  if (!ctxUri) return false;
  // spotify:track:XYZ → not a real context (single-track playback)
  return !ctxUri.startsWith("spotify:track:");
}

function pickRandomUri(items: any[], avoid: Set<string>): string | null {
  const pool = items.filter((t: any) => t?.uri && !avoid.has(t.uri));
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)].uri;
}

// Memory of recent plays — kept in addition to switchedFor so we don't
// rotate back to a track played 5 minutes ago.
const recentlyPlayed: string[] = [];
function rememberPlayed(uri: string) {
  recentlyPlayed.push(uri);
  if (recentlyPlayed.length > 40) recentlyPlayed.shift();
}

interface Pool { uri: string; weight: number; }

async function pickRelated(track: any): Promise<string | null> {
  const avoid = new Set<string>([track.uri, ...recentlyPlayed]);
  if (lastQueuedNext) avoid.add(lastQueuedNext);

  const pool: Pool[] = [];
  const seedArtistId: string | undefined = track?.artists?.[0]?.id;
  const seedArtistName: string | undefined = track?.artists?.[0]?.name;

  // ---- (1) Same artist top tracks — strongest signal of vibe match.
  if (seedArtistId) {
    try {
      const r = await api.raw("GET", `/artists/${seedArtistId}/top-tracks`,
        [["market", "from_token"]]);
      for (const t of r?.tracks ?? []) {
        if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 4 });
      }
    } catch { /* fall through */ }
  }

  // ---- (2) Featured artists on the seed track — same collab vibe.
  for (const a of (track?.artists ?? []).slice(1, 4)) {
    if (!a?.id) continue;
    try {
      const r = await api.raw("GET", `/artists/${a.id}/top-tracks`,
        [["market", "from_token"]]);
      for (const t of r?.tracks ?? []) {
        if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 3 });
      }
    } catch { /* fall through */ }
  }

  // (3) related-artists removed — Spotify deprecated the endpoint Nov 2024.
  // Dev-mode tokens get 404 in ~all cases; was wasting an HTTP round-trip.

  // ---- (4) User top tracks (taste anchor).
  try {
    const [s, m] = await Promise.all([
      api.raw("GET", "/me/top/tracks", [["limit", "20"], ["time_range", "short_term"]]),
      api.raw("GET", "/me/top/tracks", [["limit", "20"], ["time_range", "medium_term"]]),
    ]);
    for (const r of [s, m]) {
      for (const t of r?.items ?? []) {
        if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 1.5 });
      }
    }
  } catch { /* fall through */ }

  // ---- (5) Search by artist name as last-resort same-artist fallback.
  if (pool.length === 0 && seedArtistName) {
    try {
      const r = await api.search(`artist:"${seedArtistName}"`, "track", 20);
      for (const t of r?.tracks?.items ?? []) {
        if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 2 });
      }
    } catch { /* fall through */ }
  }

  // ---- (6) Liked songs random (deepest fallback).
  if (pool.length === 0) {
    try {
      const total = (await api.raw("GET", "/me/tracks", [["limit", "1"]]))?.total ?? 0;
      if (total > 0) {
        const offset = Math.floor(Math.random() * Math.max(1, total - 1));
        const r = await api.raw("GET", "/me/tracks",
          [["offset", String(offset)], ["limit", "1"]]);
        const t = r?.items?.[0]?.track;
        if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 1 });
      }
    } catch { /* fall through */ }
  }

  if (!pool.length) return null;

  // Dedup, summing weights so frequently-recommended URIs rise.
  const merged = new Map<string, number>();
  for (const p of pool) merged.set(p.uri, (merged.get(p.uri) ?? 0) + p.weight);
  const entries = [...merged.entries()];
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [uri, w] of entries) {
    r -= w;
    if (r <= 0) return uri;
  }
  return entries[entries.length - 1]![0];
}

async function trySwitch(currentUri: string) {
  if (switchedFor === currentUri) return;
  switchedFor = currentUri;
  let next = pendingNext;
  pendingNext = null;
  if (!next) {
    // No pre-fetch landed in time; fetch synchronously now.
    const cur = state.playback.get();
    const t = cur?.track_window?.current_track ?? cur?.item;
    if (t) next = await pickRelated(t);
  }
  if (!next) {
    console.warn("[auto-dj] no related track found, looping continues");
    switchedFor = null; // allow retry next loop
    return;
  }
  console.log("[auto-dj] switching to", next);
  lastQueuedNext = next;
  playback.start({ uris: [next] });
}

export function startAutoDj(): void {
  // Mirror playback state so the tick() loop can act independently of the
  // 5s polling interval (which is too coarse to reliably catch loop edges).
  state.playback.subscribe(async (p) => {
    if (getConfig().features?.autoQueueRelated === false) return;
    if (!p) {
      curUri = null;
      return;
    }
    const t = p?.track_window?.current_track ?? p?.item;

    const track = p?.track_window?.current_track ?? p?.item;
    if (!track?.uri) {
      curUri = null;
      return;
    }

    const ctxUri: string | null | undefined =
      p?.context?.uri ?? p?.context?.metadata?.uri;

    const newPos = p?.progress_ms ?? p?.position ?? 0;
    const newDur = track.duration_ms ?? p?.duration ?? 0;
    const newPaused = p?.paused ?? !(p?.is_playing ?? false);

    // Switching to a new track resets the "we already switched" guard.
    if (track.uri !== curUri) {
      switchedFor = null;
      if (curUri) rememberPlayed(curUri);
    }

    // ---- Early-end detection ----
    // The track was playing somewhere past the start, and now position has
    // reset to 0 (often with paused=true). That's our cue: Spotify either
    // looped-then-paused, or the SDK device dropped the stream early. Either
    // way, the user wants the next track. Fire BEFORE we update curPaused
    // (the tick path bails when paused).
    const sameTrack = track.uri === curUri;
    const reset = sameTrack && curPos > 5_000 && newPos < 1_500;
    if (reset && !isRealContext(ctxUri) && switchedFor !== track.uri) {
      console.log("[auto-dj] reset detected (pos", curPos, "→", newPos, "), overriding");
      trySwitch(track.uri);
    }

    curUri = track.uri;
    curPos = newPos;
    curDur = newDur;
    curSync = performance.now();
    curPaused = newPaused;
    curCtxUri = ctxUri;

    if (isRealContext(ctxUri)) {
      pendingNext = null;
      switchedFor = null;
      return;
    }

    // Pre-fetch immediately on every new track, so the next URI is ready
    // even if the track dies early (SDK Widevine issues, network glitches).
    if (!fetchedFor.has(track.uri)) {
      rememberFetched(track.uri);
      pickRelated(track).then((next) => {
        if (next && !pendingNext) {
          pendingNext = next;
          console.log("[auto-dj] pre-fetched", next, "for", track.uri);
        }
      });
    }
  });

  // Independent tick — runs every 500ms, computes predicted position via
  // drift math (same as nowplaying.ts), and forces the override at 1.5s
  // remaining. This is timing-reliable regardless of polling cadence.
  let tickCount = 0;
  setInterval(() => {
    tickCount++;
    if (getConfig().features?.autoQueueRelated === false) return;
    if (!curUri || curPaused || !curDur) return;
    if (isRealContext(curCtxUri)) return;
    if (switchedFor === curUri) return;

    const drift = performance.now() - curSync;
    const predicted = Math.min(curDur, curPos + drift);
    const remaining = curDur - predicted;

    // Pre-fetch lazily here too, in case the polling subscriber missed the 60% mark.
    if (predicted / curDur > 0.6 && !fetchedFor.has(curUri)) {
      const cur = state.playback.get();
      const t = cur?.track_window?.current_track ?? cur?.item;
      if (t) {
        rememberFetched(curUri);
        pickRelated(t).then((next) => {
          if (next && !pendingNext) {
            pendingNext = next;
            console.log("[auto-dj] tick pre-fetched", next, "for", curUri);
          }
        });
      }
    }

    if (remaining < 1500) {
      console.log("[auto-dj] tick: end of track (remaining", Math.round(remaining), "ms), overriding");
      trySwitch(curUri);
    }
  }, 500);
}
