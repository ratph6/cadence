// Tiny pub/sub store. Single source of truth, manual subscribers — no diffing,
// no proxies, no framework. We only re-render the parts that explicitly listen
// to a given key, which keeps perf predictable.

type Listener<T> = (v: T) => void;

export class Signal<T> {
  private _v: T;
  private ls = new Set<Listener<T>>();
  constructor(v: T) {
    this._v = v;
  }
  get(): T {
    return this._v;
  }
  set(v: T): void {
    if (Object.is(this._v, v)) return;
    this._v = v;
    this.ls.forEach((l) => l(v));
  }
  update(fn: (v: T) => T): void {
    this.set(fn(this._v));
  }
  subscribe(l: Listener<T>): () => void {
    this.ls.add(l);
    l(this._v);
    return () => this.ls.delete(l);
  }
}

export type View = "home" | "search" | "settings" | "focus" | "playlists";

export const state = {
  loggedIn: new Signal<boolean>(false),
  me: new Signal<any | null>(null),
  deviceId: new Signal<string | null>(null),
  playback: new Signal<any | null>(null),
  queue: new Signal<any[]>([]),
  searchResults: new Signal<any | null>(null),
  view: new Signal<View>("home"),
  volume: new Signal<number>(0.6),
  openPlaylistId: new Signal<string | null>(null),
};
