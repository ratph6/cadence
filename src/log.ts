// Debug-gated logging. `dlog` is a no-op in production builds (Vite sets
// import.meta.env.DEV = false), so informational tracing doesn't spam the
// release console. Genuine problems should still use console.warn/console.error
// directly so they survive in production.
const DEBUG = import.meta.env.DEV;

export function dlog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}
