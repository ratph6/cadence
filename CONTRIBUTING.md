# Contributing to Cadence

Thanks for your interest in improving Cadence. This is a small project — issues and PRs are welcome.

## Getting set up

See the [README](README.md#what-you-need-to-install) for the full toolchain (Rust, Node 20+, a C/C++ toolchain). In short:

```bash
git clone https://github.com/ratph6/cadence.git
cd cadence
npm install
npm run tauri dev
```

You'll need a Spotify Client ID — the README's [Spotify app registration](README.md#register-a-spotify-app) section walks through it.

## Before you open a PR

- **Type-check the frontend:** `npm run build` (runs `tsc --noEmit` then the Vite build).
- **Check the backend:** `cargo check` and `cargo clippy` from `src-tauri/`.
- **Format Rust:** `cargo fmt` from `src-tauri/`.
- Keep changes focused. One topic per PR makes review tractable.
- Match the surrounding style: the codebase favors small, commented modules and explains *why* in comments rather than *what*.

## Reporting bugs

Open an issue with:

- What you did, what you expected, what happened.
- OS + version, and whether you're on the Web SDK or librespot backend.
- Relevant dev-console output (`F12` / Ctrl+Shift+I in a dev build).

## Security

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
