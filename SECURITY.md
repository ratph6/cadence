# Security Policy

## Reporting a vulnerability

Please report security issues **privately**, not via public GitHub issues.

Use GitHub's [private vulnerability reporting](https://github.com/ratph6/cadence/security/advisories/new) for this repository, or contact the maintainer directly. Include a description, reproduction steps, and the affected version/commit. You'll get an acknowledgement as soon as practical.

## Scope and threat model

Cadence is a desktop client that talks to Spotify on behalf of the logged-in user. A few things worth knowing:

- **OAuth tokens** are stored in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux), never on disk in plaintext, and never exposed to the renderer's JS heap beyond the short-lived Web Playback SDK callback.
- **API requests** are proxied through the Rust backend, which attaches the bearer token only to `*.spotify.com` hosts.
- **The librespot backend** passes the access token to the `librespot` subprocess as a command-line argument because librespot offers no other channel for it. On a shared multi-user machine, other local users could read it from the process list. Cadence's supported model is a single-user machine; the token is short-lived (~1h) and scoped to the logged-in user.
- **Plugins** (`plugins` feature flag, off by default) and **imported themes** run/load user-supplied content. Plugins execute with full app privileges; theme `@import`s are restricted to `https`. Treat both as untrusted code/markup and only enable sources you trust.

## Supported versions

This is a pre-1.0 project; security fixes target the latest commit on `main`.
