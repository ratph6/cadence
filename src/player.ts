// Web Playback SDK glue. Premium accounts only; free accounts can still
// control external Spotify Connect devices via the API commands.
//
// We load the SDK script lazily and create exactly one player per session.

import { auth, api } from "./api";
import { state } from "./store";

declare global {
  interface Window {
    Spotify: any;
    onSpotifyWebPlaybackSDKReady: () => void;
  }
}

let player: any | null = null;
let loadPromise: Promise<void> | null = null;

function loadSdk(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    if (window.Spotify) return resolve();
    // The SDK looks up window.onSpotifyWebPlaybackSDKReady during its own
    // initial eval — must be defined BEFORE we append the script.
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://sdk.scdn.co/spotify-player.js";
    s.async = true;
    s.onerror = () => reject(new Error("Failed to load Web Playback SDK"));
    document.head.appendChild(s);
  });
  return loadPromise;
}

export async function initPlayer(): Promise<string | null> {
  if (player) return state.deviceId.get();
  await loadSdk();

  // Construct with the user's persisted slider value (tapered, to match
  // the runtime gain path). Hard-coding 0.6 here meant that on every
  // restart the SDK started playing at ~60% amplitude for the first
  // second or two — until the first player_state_changed listener ran
  // and re-applied the actual slider value — which manifested as audio
  // blasting loud then snapping quiet on launch.
  const initialSlider = state.volume.get();
  const initialVolume =
    typeof initialSlider === "number" ? sliderToApi(initialSlider) : sliderToApi(0.6);
  player = new window.Spotify.Player({
    name: "Cadence",
    getOAuthToken: (cb: (t: string) => void) => {
      auth.accessToken().then(cb).catch((e) => console.error("token", e));
    },
    volume: initialVolume,
  });

  player.addListener("ready", ({ device_id }: any) => {
    state.deviceId.set(device_id);
  });
  player.addListener("not_ready", () => state.deviceId.set(null));
  player.addListener("player_state_changed", (s: any) => {
    if (!s) return;
    // SDK payload uses different field names than the Web API
    // (shuffle vs shuffle_state, repeat_mode 0|1|2 vs repeat_state off|context|track,
    // paused vs is_playing). Merge with the previous state so Web-API-only fields
    // (e.g. device, repeat_state when SDK omits it) survive, and translate the
    // SDK names to the Web API names the UI subscribes to.
    const prev = state.playback.get() ?? {};
    const repeatMap = ["off", "context", "track"] as const;
    state.playback.set({
      ...prev,
      ...s,
      is_playing: !s.paused,
      shuffle_state: typeof s.shuffle === "boolean" ? s.shuffle : prev.shuffle_state,
      repeat_state: typeof s.repeat_mode === "number"
        ? repeatMap[s.repeat_mode] ?? "off"
        : prev.repeat_state,
      progress_ms: typeof s.position === "number" ? s.position : prev.progress_ms,
    });

    // The SDK resets its internal audio gain back to the construction-time
    // `volume` across some track transitions (skip, auto-advance) — so audio
    // gets louder on every skip even though the slider hasn't moved. Re-apply
    // the user's slider value (tapered, to match the API path) whenever state
    // changes so the gain stays put.
    const slider = state.volume.get();
    if (typeof slider === "number" && player) {
      const target = sliderToApi(slider);
      player.getVolume()
        .then((cur: number) => {
          if (Math.abs(cur - target) > 0.01) {
            return player.setVolume(target);
          }
        })
        .catch(() => {});
    }
  });
  player.addListener("initialization_error", (e: any) => console.error("init", e));
  player.addListener("authentication_error", (e: any) => console.error("auth", e));
  player.addListener("account_error", (e: any) => {
    console.warn("account_error (likely non-Premium)", e);
  });

  const ok = await player.connect();
  if (!ok) console.warn("Web Playback SDK connect() returned false");
  return state.deviceId.get();
}

// Transport always goes through the Web API so it works regardless of which
// device is active (SDK device, phone, speaker, etc.). The SDK is just one
// Connect device we *can* be on.

async function ensureDevice(): Promise<void> {
  // Already on an active device? leave it alone.
  try {
    const r = await api.devices();
    const devices: any[] = r?.devices ?? [];
    if (devices.some((d) => d.is_active)) return;
    let id = state.deviceId.get();
    if (!id) {
      const target =
        devices.find((d) => !d.is_restricted) ?? devices[0];
      id = target?.id ?? null;
    }
    if (!id) {
      console.warn("[playback] no devices available — open Spotify on a device");
      return;
    }
    await api.transfer(id, false);
  } catch (e) {
    console.warn("[playback] ensureDevice failed", e);
  }
}

// After we mutate playback, suppress the periodic poll briefly so that a
// stale `is_playing` value from Spotify's eventual-consistency layer doesn't
// flip the UI back. Read by nowplaying.ts via `pollSuppressedUntil()`.
let suppressUntil = 0;
export function pollSuppressedUntil(): number { return suppressUntil; }
export function suppressPollFor(ms: number) {
  suppressUntil = Math.max(suppressUntil, performance.now() + ms);
}

/** Spotify's `/me/player/volume` is linear amplitude, but human loudness
 *  perception is logarithmic — slider at 30% felt almost as loud as 100%
 *  on the Web API path. Taper to make the slider feel perceptual. */
export function sliderToApi(slider01: number): number {
  return Math.max(0, Math.min(1, slider01 * slider01));
}
export function apiToSlider(api01: number): number {
  return Math.max(0, Math.min(1, Math.sqrt(api01)));
}

let volApiTimer: number | undefined;
function scheduleVolumeApi(vol: number) {
  if (volApiTimer !== undefined) clearTimeout(volApiTimer);
  volApiTimer = window.setTimeout(() => {
    const tapered = sliderToApi(vol);
    api.raw("PUT", "/me/player/volume",
      [["volume_percent", String(Math.round(tapered * 100))]])
      .catch(() => {});
  }, 250);
}

async function reconcile(delay: number) {
  // For commands where the new state isn't predictable client-side
  // (next/prev/seek), pull fresh state once propagation has settled.
  setTimeout(async () => {
    try {
      const s = await api.playbackState();
      if (s) state.playback.set(s);
    } catch {}
  }, delay);
}

async function withDeviceFallback(
  fn: () => Promise<unknown>,
  opts: { reconcileMs?: number } = {},
): Promise<void> {
  suppressUntil = performance.now() + 3000;
  try {
    await fn();
  } catch (e: any) {
    const msg = String(e);
    // Only retry-via-transfer for errors that genuinely mean "no/wrong
    // device". 403/Restriction is also returned for things like skip-limit
    // on free accounts or premium-required gates — transferring there would
    // pause playback and seek to 0 (which is exactly the bug users hit when
    // skipping inside a playlist).
    const retryable =
      msg.includes("404") ||
      msg.includes("NO_ACTIVE_DEVICE");
    if (retryable) {
      await ensureDevice();
      try { await fn(); } catch (e2) { console.warn("[playback] retry failed", e2); }
    } else {
      console.warn("[playback]", e);
    }
  }
  if (opts.reconcileMs !== undefined) reconcile(opts.reconcileMs);
}

function setOptimisticPlaying(playing: boolean) {
  const p = state.playback.get();
  if (!p) return;
  state.playback.set({ ...p, is_playing: playing, paused: !playing });
}

function sdkIsActive(): boolean {
  if (!player) return false;
  const sdkId = state.deviceId.get();
  if (!sdkId) return false;
  const activeId = state.playback.get()?.device?.id;
  return !!activeId && activeId === sdkId;
}

/** True when the SDK has actually loaded a track into its local pipeline. Right
 *  after a Connect transfer (e.g. on app boot) the SDK is the active device but
 *  has *no* track loaded — calling sdk.resume()/togglePlay() in that window
 *  silently no-ops, dropping the user's playlist context. Detect that case and
 *  force the HTTP path which is server-side authoritative. */
function sdkHasLoadedTrack(): boolean {
  if (!player) return false;
  // We mirror the SDK's track_window.current_track into state.playback via
  // player_state_changed. If it's missing, the SDK never received a state
  // event yet, which means no track is queued locally.
  const cur = state.playback.get()?.track_window?.current_track;
  return !!cur?.uri;
}

async function runLocalOrApi(
  local: (sdk: any) => Promise<unknown> | unknown,
  remote: () => Promise<unknown>,
  reconcileMs: number,
): Promise<void> {
  suppressUntil = performance.now() + 3000;
  if (sdkIsActive()) {
    try {
      await local(player);
      reconcile(reconcileMs);
      return;
    } catch (e) {
      console.warn("[playback] SDK local op failed; falling back to HTTP", e);
    }
  }
  await withDeviceFallback(remote, { reconcileMs });
}

// ----------------------------------------------------------------- skip coalescing
//
// Mashing the next/prev button used to fire one HTTP /me/player/{next,previous}
// per click. Spotify executes them sequentially and the optimistic UI updates
// fight the reconciles, so the player would "tweak out" — keep skipping for
// seconds after the user stopped, with the title flickering between tracks.
//
// Strategy: at most one skip in flight at a time. Extra clicks bump a pending
// counter (capped at 5 — past that mashing is meaningless). When the in-flight
// call resolves, if there's still pending work, fire the next one. The
// reconcile poll is also delayed until the burst finishes, so the seekbar
// doesn't snap to a stale "track from 800 ms ago" mid-burst.
// Net-counter design: every click bumps `skipNet` (+1 next, -1 prev). After a
// short debounce, we ship the cumulative delta — mashing N times in 200 ms
// = N hops, mashing next-prev-next-prev cancels to 0. Optimistic UI advances
// through a snapshot of the queue captured at the start of the burst so the
// title visibly moves per click, instead of just re-flashing the same value.
let skipNet = 0;
let skipDebounceTimer: number | undefined;
let skipFlushAt = 0;
let skipQueueSnap: any[] = [];
let skipQueueIdx = 0;
let skipDraining = false;
const SKIP_DEBOUNCE_MS = 180;
const SKIP_MAX_BURST_MS = 800;
const SKIP_NET_CAP = 10;

function applyBurstOptimistic(dir: "next" | "previous") {
  const p = state.playback.get();
  if (!p) return;
  const base = {
    ...p,
    is_playing: true,
    paused: false,
    progress_ms: 0,
    position: 0,
  };
  if (dir === "next") {
    // skipQueueIdx is 1-based here (incremented before this call), so
    // index 1 → snapshot[0] = the next track that *would* play after one hop.
    const t = skipQueueSnap[skipQueueIdx - 1] ?? null;
    if (t) {
      state.playback.set({
        ...base,
        item: t,
        track_window: { ...(p.track_window ?? {}), current_track: t },
        duration: t.duration_ms,
      });
      return;
    }
  }
  state.playback.set(base);
}

function scheduleSkipDrain(immediate: boolean = false) {
  if (skipDebounceTimer !== undefined) clearTimeout(skipDebounceTimer);
  if (immediate) {
    skipDebounceTimer = window.setTimeout(drainSkips, 0);
    return;
  }
  // Fire after SKIP_DEBOUNCE_MS of quiet, but never wait longer than
  // SKIP_MAX_BURST_MS from the burst start — guarantees forward progress
  // even if the user keeps mashing.
  const remaining = Math.max(0, skipFlushAt - performance.now());
  const delay = Math.min(SKIP_DEBOUNCE_MS, remaining);
  skipDebounceTimer = window.setTimeout(drainSkips, delay);
}

async function drainSkips() {
  if (skipDraining) return;
  skipDraining = true;
  try {
    // Loop in case more clicks land mid-await; we want the final cumulative
    // delta to settle, not a partial one.
    while (skipNet !== 0) {
      const count = skipNet > 0 ? skipNet : -skipNet;
      const dir: "next" | "previous" = skipNet > 0 ? "next" : "previous";
      skipNet = 0;
      // Spotify has no "skip N" endpoint; firing in parallel races the
      // server-side queue cursor. Sequential is the safe path.
      // withDeviceFallback sets suppressUntil per iter, so the poll stays
      // suppressed through the end of the burst.
      for (let i = 0; i < count; i++) {
        await withDeviceFallback(() =>
          dir === "next" ? api.next() : api.previous(),
        );
      }
    }
  } finally {
    skipDraining = false;
    skipQueueSnap = [];
    skipQueueIdx = 0;
    reconcile(800);
  }
}

function coalescedSkip(dir: "next" | "previous"): void {
  // Fast path: when the SDK is the active device, skipping is a local
  // operation — no HTTP roundtrip, no rate-limit risk. Fire per click,
  // skip the debounce + coalesce machinery entirely. The SDK emits
  // player_state_changed so the UI updates without our optimistic shim.
  if (sdkIsActive() && player) {
    suppressUntil = performance.now() + 3000;
    const op = dir === "next" ? player.nextTrack() : player.previousTrack();
    Promise.resolve(op).catch((e) => {
      console.warn("[playback] SDK skip failed; falling back to HTTP", e);
      httpCoalescedSkip(dir);
    });
    return;
  }
  httpCoalescedSkip(dir);
}

function httpCoalescedSkip(dir: "next" | "previous"): void {
  // Capture the queue at burst start; subsequent clicks index through the
  // snapshot so the title visibly advances per press instead of repeatedly
  // showing queue[0].
  const burstStart = skipNet === 0 && !skipDraining;
  if (burstStart) {
    skipQueueSnap = (state.queue.get() ?? []).slice();
    skipQueueIdx = 0;
    skipFlushAt = performance.now() + SKIP_MAX_BURST_MS;
  }
  if (dir === "next") {
    if (skipNet < SKIP_NET_CAP) skipNet += 1;
    if (skipQueueIdx < skipQueueSnap.length) skipQueueIdx += 1;
  } else {
    if (skipNet > -SKIP_NET_CAP) skipNet -= 1;
    if (skipQueueIdx > 0) skipQueueIdx -= 1;
  }
  applyBurstOptimistic(dir);
  // First click of a burst fires immediately; subsequent clicks debounce
  // to coalesce. Avoids the 180 ms baseline lag on every single press.
  scheduleSkipDrain(burstStart);
}

export const playback = {
  togglePlay: async () => {
    const p = state.playback.get();
    // Treat "unknown" as paused so a click resumes; ?? on `!p?.paused`
    // alone would always be a defined boolean.
    const playing = p?.is_playing ?? !(p?.paused ?? true);
    setOptimisticPlaying(!playing);
    // Pause via SDK is fine (the SDK already has the track loaded if we're
    // mid-playing). For *resume*, the SDK may not have a track loaded
    // (fresh boot, post-transfer) so the local togglePlay is a no-op that
    // drops the playlist context; route resume through the Web API which
    // is authoritative for Spotify's "currently playing context".
    const useLocal = playing || sdkHasLoadedTrack();
    if (useLocal) {
      await runLocalOrApi(
        (sdk) => sdk.togglePlay(),
        () => playing ? api.pause() : api.play({}),
        400,
      );
    } else {
      await withDeviceFallback(() => api.play({}), { reconcileMs: 400 });
    }
  },
  play: async () => {
    setOptimisticPlaying(true);
    // Same reasoning as togglePlay: only call sdk.resume() when the SDK
    // actually has a track loaded; otherwise let Spotify's server-side
    // current-context resume the playlist correctly.
    if (sdkHasLoadedTrack()) {
      await runLocalOrApi(
        (sdk) => sdk.resume(),
        () => api.play({}),
        400,
      );
    } else {
      await withDeviceFallback(() => api.play({}), { reconcileMs: 400 });
    }
  },
  pause: async () => {
    setOptimisticPlaying(false);
    await runLocalOrApi(
      (sdk) => sdk.pause(),
      () => api.pause(),
      400,
    );
  },
  // next/prev/seek change the *track* — refetch shortly after so the now-playing
  // strip catches the new track + position. We also optimistically reset the
  // progress to 0 (and, for `next`, swap in the queue head as the predicted
  // next track) so the seek bar + title flip immediately instead of staring
  // at the old track for 600-1200 ms while Spotify's eventual-consistency
  // settles.
  next: () => coalescedSkip("next"),
  previous: () => coalescedSkip("previous"),
  seek: (ms: number) =>
    runLocalOrApi(
      (sdk) => sdk.seek(Math.round(ms)),
      () => api.raw("PUT", "/me/player/seek", [["position_ms", String(Math.round(ms))]]),
      800,
    ),
  setVolume: (v: number) => {
    const vol = Math.max(0, Math.min(1, v));
    state.volume.set(vol);
    // SDK volume change is local (no network), apply immediately for smooth
    // dragging. The Web API call hits a rate-limited endpoint and was being
    // fired on every pixel of slider movement, which manifested as audio
    // stuttering on drag — debounce so only the final value goes over the
    // wire.
    //
    // Apply the same perceptual taper to the SDK gain as the Web API path
    // (sliderToApi). Otherwise the SDK plays at the raw linear slider value
    // while Spotify Connect records the tapered value — and when a periodic
    // poll reads device.volume_percent back, apiToSlider(...) gives a
    // different number than the slider was at, drifting the thumb. The next
    // click then snaps the SDK gain to that drifted position, which is the
    // "press-and-hold changes volume even without moving" symptom.
    const tapered = sliderToApi(vol);
    player?.setVolume(tapered);
    scheduleVolumeApi(vol);
  },
  /** Make this app the active device (requires Premium). */
  transferHere: () => ensureDevice(),
  /** Unified "play this" — auto-handles missing-device retry.
   *  Pass `optimisticTrack` from a search result/playlist row to update the
   *  now-playing strip instantly while the API call is in-flight. */
  start: (args: {
    uris?: string[];
    contextUri?: string;
    offsetUri?: string;
    positionMs?: number;
    optimisticTrack?: any;
  }) => {
    // Synchronous UI swap — happens on click, before any await.
    if (args.optimisticTrack) {
      state.playback.set({
        is_playing: true,
        paused: false,
        progress_ms: 0,
        position: 0,
        item: args.optimisticTrack,
        track_window: { current_track: args.optimisticTrack },
        duration: args.optimisticTrack.duration_ms,
      });
    } else {
      setOptimisticPlaying(true);
    }
    return withDeviceFallback(async () => {
      const did = state.deviceId.get() ?? undefined;
      const q: [string, string][] = did ? [["device_id", did]] : [];
      const body: Record<string, unknown> = {};
      if (args.uris) body.uris = args.uris;
      if (args.contextUri) body.context_uri = args.contextUri;
      if (args.offsetUri) body.offset = { uri: args.offsetUri };
      if (args.positionMs !== undefined) body.position_ms = args.positionMs;
      await api.raw("PUT", "/me/player/play", q, body);
    }, { reconcileMs: 1200 });
  },
};
