// Config-driven keybind manager.
//
// Bindings are arrays of strings using KeyboardEvent.code names plus modifiers,
// joined with `+`. Examples:
//   "Space"
//   "KeyJ"
//   "Mod+KeyK"          (Cmd on macOS, Ctrl elsewhere)
//   "Mod+Shift+KeyT"
//
// We intentionally use `code` (physical key) rather than `key`, so layouts
// like Dvorak/AZERTY don't break the defaults.

type Action = () => void;

const isMac = navigator.platform.toLowerCase().includes("mac");

function normalize(combo: string): string {
  // canonical order: Mod, Ctrl, Alt, Shift, then code
  const parts = combo.split("+").map((s) => s.trim());
  const mods = new Set<string>();
  let code = "";
  for (const p of parts) {
    if (p === "Mod" || p === "Ctrl" || p === "Alt" || p === "Shift" || p === "Meta") {
      mods.add(p);
    } else {
      code = p;
    }
  }
  const order = ["Mod", "Ctrl", "Alt", "Shift", "Meta"].filter((m) => mods.has(m));
  return [...order, code].join("+");
}

function eventCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  const meta = isMac ? e.metaKey : e.ctrlKey;
  if (meta) mods.push("Mod");
  if (!isMac && e.metaKey) mods.push("Meta");
  if (isMac && e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, e.code].join("+");
}

export class Keybinds {
  private map = new Map<string, Action>();

  bind(combos: string[], fn: Action): void {
    for (const c of combos) this.map.set(normalize(c), fn);
  }

  apply(config: Record<string, string[]>, actions: Record<string, Action>): void {
    this.map.clear();
    for (const [name, fn] of Object.entries(actions)) {
      const combos = config[name];
      if (combos) this.bind(combos, fn);
    }
  }

  attach(): () => void {
    const handler = (e: KeyboardEvent) => {
      const combo = eventCombo(e);
      const fn = this.map.get(combo);
      if (!fn) return;

      // When typing in an input, only fire combos that include a modifier —
      // otherwise plain keys (Space, J, K) would steal characters.
      const t = e.target as HTMLElement | null;
      const inEditable =
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || (t as any).isContentEditable);
      const hasMod = e.metaKey || e.ctrlKey || e.altKey;
      if (inEditable && !hasMod) return;

      e.preventDefault();
      fn();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }
}

export const keybinds = new Keybinds();
