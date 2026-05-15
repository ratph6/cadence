import { defineConfig } from "vite";

// Tauri expects a fixed port and host
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    hmr: { protocol: "ws", host: "127.0.0.1", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: ["es2022", "chrome110", "safari16"],
    minify: "esbuild",
    sourcemap: false,
    cssMinify: true,
    rollupOptions: {
      // Multi-page build: the main UI (`index.html`) plus the standalone
      // Alt+Space CLI window (`cli.html`). Both share the same base.css so
      // the styling stays in sync automatically.
      input: {
        main: "index.html",
        cli: "cli.html",
      },
    },
  },
});
