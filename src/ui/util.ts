// Shared view-layer helpers extracted from app.ts so every UI module can
// import them without pulling in the whole app shell.

export const BRAND = "Cadence";

export const fmt = {
  ms: (ms: number) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },
  esc: (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    ),
};

export const idFromUri = (uri: string) => uri.split(":").pop() ?? uri;
export const currentTrack = (p: any) => p?.track_window?.current_track ?? p?.item ?? null;
export const currentDuration = (p: any) => currentTrack(p)?.duration_ms ?? p?.duration ?? 0;
