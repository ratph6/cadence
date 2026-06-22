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
import { dlog } from "./log";

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

// Memory of recent plays — kept in addition to switchedFor so we don't
// rotate back to a track played 5 minutes ago.
const recentlyPlayed: string[] = [];
function rememberPlayed(uri: string) {
  recentlyPlayed.push(uri);
  if (recentlyPlayed.length > 40) recentlyPlayed.shift();
}

interface Pool { uri: string; weight: number; }

async function pickRelated(track: any): Promise<string | null> {
  // Strong avoid: skip the current track + recently played + last queued so
  // we don't rotate in circles.
  const strongAvoid = new Set<string>([track.uri, ...recentlyPlayed]);
  if (lastQueuedNext) strongAvoid.add(lastQueuedNext);

  const uri = await pickFromPool(track, strongAvoid);
  if (uri) return uri;

  // Starvation guard: a small library (liked songs / artist catalog < the
  // recentlyPlayed window) lets `strongAvoid` swallow the entire pool, which
  // used to fail permanently. Relax to only avoid the current track and retry.
  console.warn("[auto-dj] pool exhausted under strong avoid, relaxing");
  return pickFromPool(track, new Set<string>([track.uri]));
}

async function pickFromPool(track: any, avoid: Set<string>): Promise<string | null> {
  const pool: Pool[] = [];
  const seedArtistId: string | undefined = track?.artists?.[0]?.id;
  const seedArtistName: string | undefined = track?.artists?.[0]?.name;

  // Stages 1, 2, 4 are independent — fire them concurrently so a slow/rate-
  // limited endpoint doesn't serialize the whole pre-fetch (was up to 6
  // sequential round-trips, blowing past the 1.5s end-of-track override).
  const jobs: Promise<void>[] = [];

  // ---- (1) Same artist top tracks — strongest signal of vibe match.
  if (seedArtistId) {
    jobs.push((async () => {
      try {
        const r = await api.raw("GET", `/artists/${seedArtistId}/top-tracks`,
          [["market", "from_token"]]);
        for (const t of r?.tracks ?? []) {
          if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 4 });
        }
      } catch { /* fall through */ }
    })());
  }

  // ---- (2) Featured artists on the seed track — same collab vibe.
  for (const a of (track?.artists ?? []).slice(1, 4)) {
    if (!a?.id) continue;
    jobs.push((async () => {
      try {
        const r = await api.raw("GET", `/artists/${a.id}/top-tracks`,
          [["market", "from_token"]]);
        for (const t of r?.tracks ?? []) {
          if (t?.uri && !avoid.has(t.uri)) pool.push({ uri: t.uri, weight: 3 });
        }
      } catch { /* fall through */ }
    })());
  }

  // (3) related-artists removed — Spotify deprecated the endpoint Nov 2024.
  // Dev-mode tokens get 404 in ~all cases; was wasting an HTTP round-trip.

  // ---- (4) User top tracks (taste anchor).
  jobs.push((async () => {
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
  })());

  await Promise.all(jobs);

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
        // [0, total-1] inclusive — the old `total - 1` upper bound could never
        // pick the last liked track.
        const offset = Math.min(total - 1, Math.floor(Math.random() * total));
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
  dlog("[auto-dj] switching to", next);
  lastQueuedNext = next;
  const target = next;
  try {
    await playback.start({ uris: [target] });
  } catch (e) {
    // Shouldn't normally throw (enqueueStart swallows API errors), but guard
    // anyway so a rejection doesn't strand the guard.
    console.warn("[auto-dj] switch start threw, will retry", e);
    switchedFor = null;
    pendingNext = target;
    return;
  }
  // enqueueStart swallows API errors internally (429 / no-device), so a failed
  // switch leaves us silently looping with switchedFor pinned → no retry ever.
  // Verify the switch actually took via the mirrored state; if we're still on
  // the same track, self-heal by releasing the guard so the next loop boundary
  // (or tick) retries with the pick we already have.
  setTimeout(() => {
    if (curUri === currentUri && switchedFor === currentUri) {
      console.warn("[auto-dj] switch didn't take, resetting guard for retry");
      switchedFor = null;
      pendingNext = target;
    }
  }, 4000);
}

let started = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoDj(): void {
  // Idempotent — a second call would stack a duplicate subscriber + interval.
  if (started) return;
  started = true;
  // Mirror playback state so the tick() loop can act independently of the
  // 5s polling interval (which is too coarse to reliably catch loop edges).
  state.playback.subscribe(async (p) => {
    if (getConfig().features?.autoQueueRelated === false) return;
    if (!p) {
      curUri = null;
      return;
    }
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
      // Drop any pre-fetch left over from the previous track — it was picked
      // to follow the OLD track, not this one. Leaving it set both plays the
      // wrong follow-up and blocks this track's own pre-fetch (the `!pendingNext`
      // guard below). This track pre-fetches its own pick a few lines down.
      pendingNext = null;
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
      dlog("[auto-dj] reset detected (pos", curPos, "→", newPos, "), overriding");
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
      // Mark before awaiting so concurrent events don't double-fetch; release
      // on failure so a transient API error doesn't permanently block this
      // track's pre-fetch (leaving only the slow synchronous end-of-track path).
      rememberFetched(track.uri);
      const forUri = track.uri;
      pickRelated(track).then((next) => {
        if (next) {
          if (!pendingNext && curUri === forUri) {
            pendingNext = next;
            dlog("[auto-dj] pre-fetched", next, "for", forUri);
          }
        } else {
          fetchedFor.delete(forUri); // allow retry
        }
      });
    }
  });

  // Independent tick — runs every 500ms, computes predicted position via
  // drift math (same as nowplaying.ts), and forces the override at 1.5s
  // remaining. This is timing-reliable regardless of polling cadence.
  tickTimer = setInterval(() => {
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
        const forUri = curUri;
        rememberFetched(forUri);
        pickRelated(t).then((next) => {
          if (next) {
            if (!pendingNext && curUri === forUri) {
              pendingNext = next;
              dlog("[auto-dj] tick pre-fetched", next, "for", forUri);
            }
          } else {
            fetchedFor.delete(forUri); // allow retry
          }
        });
      }
    }

    if (remaining < 1500) {
      dlog("[auto-dj] tick: end of track (remaining", Math.round(remaining), "ms), overriding");
      trySwitch(curUri);
    }
  }, 500);
}

/** Stop the tick loop. The playback subscriber stays (cheap, fires only on
 *  playback changes); the interval is the part worth tearing down. */
export function stopAutoDj(): void {
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  started = false;
}
