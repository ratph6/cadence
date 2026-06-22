import { config } from "./api";

export interface AppConfig {
  clientId: string;
  theme?: string;
  layout?: string;
  customCss?: string;
  keybinds: Record<string, string[]>;
  features: Record<string, boolean>;
  plugins: string[];
  pinnedPlaylists?: string[];
  volume?: number;
  crossfadeMs?: number;
  audioBackend?: "sdk" | "librespot";
  eqGains?: number[];
  discordClientId?: string;
  statsFmUser?: string;
  activeTheme?: string;
  windowState?: {
    x: number;
    y: number;
    width: number;
    height: number;
    maximized?: boolean;
  };
}

const DEFAULT_FEATURES: Record<string, boolean> = {
  webPlayback: true,
  richArtwork: true,
  autoQueueRelated: true,
  showCovers: true,
  cliMode: false,
  discordRpc: false,
  eqEnabled: false,
  showRecents: true,
  showClock: true,
  disableAnimations: false,
  showMemoryGraph: false,
  homeCatPhoto: false,
  homeDadJoke: false,
  homeNews: false,
  homeVisualizer: false,
  enableContextMenu: false,
  superBackground: false,
  superBackgroundMouse: true,
  superSliders: false,
  plugins: false,
};

let current: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  current = (await config.load()) as AppConfig;
  current.features = { ...DEFAULT_FEATURES, ...(current.features ?? {}) };
  return current;
}

export function getConfig(): AppConfig {
  if (!current) throw new Error("config not loaded");
  return current;
}

export async function patchConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  current = { ...getConfig(), ...patch };
  await config.save(current);
  return current;
}
