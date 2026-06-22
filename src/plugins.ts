// Minimal plugin loader.
//
// A "plugin" is a JS module exposed at a URL or a local file path that exports
// a default function `(ctx: PluginContext) => void`. Plugins run in the same
// origin as the app — this is a trust boundary, not a sandbox.

import { state } from "./store";
import { api } from "./api";
import { getConfig } from "./settings";

export interface PluginContext {
  state: typeof state;
  api: typeof api;
  registerCommand: (name: string, fn: () => void) => void;
}

const commands = new Map<string, () => void>();

export function runCommand(name: string): boolean {
  const fn = commands.get(name);
  if (!fn) return false;
  fn();
  return true;
}

// A plugin URL is trusted only if it's a same-origin/relative path or an
// explicit https source. We reject http:, file:, data:, blob: etc. so a
// tampered config can't pull code over plaintext or from a local file.
function isAllowedPluginUrl(url: string): boolean {
  if (url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export async function loadPlugins(urls: string[]): Promise<void> {
  if (!urls.length) return;
  // Plugins execute in the app's own origin with full access to `state` and
  // `api` — this is a trust boundary, not a sandbox. Keep it off unless the
  // user explicitly opts in via the `plugins` feature flag.
  if (getConfig().features?.plugins !== true) {
    console.warn(
      `[plugins] ${urls.length} plugin(s) configured but the "plugins" feature is ` +
        `disabled — skipping. Enable it in settings only if you trust these sources.`,
    );
    return;
  }
  console.warn(
    "[plugins] loading user plugins — these run with full app privileges:",
    urls,
  );
  for (const url of urls) {
    if (!isAllowedPluginUrl(url)) {
      console.warn("[plugins] refusing to load non-https/non-local plugin:", url);
      continue;
    }
    try {
      const mod = await import(/* @vite-ignore */ url);
      const fn = mod.default ?? mod.activate;
      if (typeof fn === "function") {
        fn({
          state,
          api,
          registerCommand: (n, f) => commands.set(n, f),
        } satisfies PluginContext);
      }
    } catch (e) {
      console.warn("plugin failed", url, e);
    }
  }
}
