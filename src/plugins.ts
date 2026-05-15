// Minimal plugin loader.
//
// A "plugin" is a JS module exposed at a URL or a local file path that exports
// a default function `(ctx: PluginContext) => void`. Plugins run in the same
// origin as the app — this is a trust boundary, not a sandbox.

import { state } from "./store";
import { api } from "./api";

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

export async function loadPlugins(urls: string[]): Promise<void> {
  for (const url of urls) {
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
