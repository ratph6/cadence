// Thin invoke() wrappers — no parsing, just typing.

import { invoke } from "@tauri-apps/api/core";

export const api = {
  search: (q: string, types?: string, limit?: number) =>
    invoke<any>("api_search", { q, types, limit }),
  me: () => invoke<any>("api_me"),
  devices: () => invoke<any>("api_devices"),
  playbackState: () => invoke<any>("api_playback_state"),
  play: (args: {
    deviceId?: string;
    uris?: string[];
    contextUri?: string;
    positionMs?: number;
  }) => invoke<any>("api_play", args),
  pause: (deviceId?: string) => invoke<any>("api_pause", { deviceId }),
  next: (deviceId?: string) => invoke<any>("api_next", { deviceId }),
  previous: (deviceId?: string) => invoke<any>("api_previous", { deviceId }),
  queueAdd: (uri: string, deviceId?: string) =>
    invoke<any>("api_queue_add", { uri, deviceId }),
  queueGet: () => invoke<any>("api_queue_get"),
  transfer: (deviceId: string, play = false) =>
    invoke<any>("api_transfer", { deviceId, play }),
  raw: (
    method: string,
    path: string,
    query?: [string, string][],
    body?: unknown,
  ) => invoke<any>("api_request", { method, path, query, body }),
};

export const auth = {
  startLogin: () => invoke<void>("start_login"),
  isLoggedIn: () => invoke<boolean>("is_logged_in"),
  logout: () => invoke<void>("logout"),
  accessToken: () => invoke<string>("access_token"),
};

export const config = {
  load: () => invoke<any>("config_load"),
  save: (value: any) => invoke<void>("config_save", { value }),
};

export const librespot = {
  start: () => invoke<string>("librespot_start"),
  stop: () => invoke<void>("librespot_stop"),
  status: () => invoke<boolean>("librespot_status"),
  deviceName: () => invoke<string>("librespot_device_name"),
};

export const audioPipeline = {
  start: () => invoke<void>("audio_pipeline_start"),
  stop: () => invoke<void>("audio_pipeline_stop"),
  status: () => invoke<boolean>("audio_pipeline_status"),
};

export interface EqState {
  gains_db: number[];
  enabled: boolean;
  bands_hz: number[];
}
export const eq = {
  get: () => invoke<EqState>("eq_get"),
  setBand: (idx: number, gainDb: number) =>
    invoke<void>("eq_set_band", { idx, gainDb }),
  setEnabled: (enabled: boolean) => invoke<void>("eq_set_enabled", { enabled }),
  setPreset: (name: string) => invoke<void>("eq_set_preset", { name }),
};

export const spectrum = {
  get: () => invoke<number[]>("spectrum_get"),
};

export interface DiscordPresence {
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  positionMs: number;
  paused: boolean;
  trackUrl?: string;
  coverUrl?: string;
}
export const discord = {
  connect: (clientId: string) => invoke<void>("discord_connect", { clientId }),
  disconnect: () => invoke<void>("discord_disconnect"),
  status: () => invoke<boolean>("discord_status"),
  set: (p: DiscordPresence) => invoke<void>("discord_set", {
    payload: {
      title: p.title,
      artist: p.artist,
      album: p.album,
      duration_ms: p.durationMs,
      position_ms: p.positionMs,
      paused: p.paused,
      track_url: p.trackUrl,
      cover_url: p.coverUrl,
    },
  }),
  clear: () => invoke<void>("discord_clear"),
};

export interface ProcessMemory {
  rss: number;
  virt: number;
}
export const sys = {
  processMemory: () => invoke<ProcessMemory>("process_memory"),
};
