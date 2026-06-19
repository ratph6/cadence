import { api } from "../api";
import { state } from "../store";
import { pollSuppressedUntil } from "../player";

// ----------------------------------------------------------------- polling

export function startPolling() {
  // In-flight dedupe — without this, a slow network or paused renderer can
  // queue up several pending playback/queue fetches that all resolve at once
  // and thrash state subscribers. Skip the next tick if one is still pending.
  let playbackInFlight = false;
  let queueInFlight = false;
  const pollPlayback = () => {
    if (playbackInFlight) return;
    playbackInFlight = true;
    api.playbackState()
      .then((s: any) => { if (s) state.playback.set(s); })
      .catch(() => {})
      .finally(() => { playbackInFlight = false; });
  };
  const pollQueue = () => {
    if (queueInFlight) return;
    queueInFlight = true;
    api.queueGet()
      .then((r: any) => state.queue.set(r?.queue ?? []))
      .catch(() => {})
      .finally(() => { queueInFlight = false; });
  };
  // Skip polls while the window is hidden — saves API quota and CPU. When
  // the user comes back, kick a fresh poll immediately so state isn't stale.
  setInterval(() => {
    if (document.hidden) return;
    if (performance.now() < pollSuppressedUntil()) return;
    pollPlayback();
  }, 5000);
  setInterval(() => {
    if (document.hidden) return;
    pollQueue();
  }, 4000);
  pollPlayback();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollPlayback();
    pollQueue();
  });
}
