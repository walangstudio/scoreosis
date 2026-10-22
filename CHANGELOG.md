# Changelog

All notable changes to Scoreosis are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## Unreleased

- 2026-10-19: Register itch builds for Sneak and Ah!Steroids on Web, Windows, and Android; preserve shared platform boards and optional provider filters.
- Reject insecure client URLs before sending credentials; vendor public issuer roots for native certificate verification.

## [0.1.1] - 2026-10-21

### Fixed

- Lua client: a catch-up frame no longer steps or uploads past the terminal tick.
- Lua client: abandoning while a run is starting abandons the run the server creates late, instead of resuming it.

### Changed

- Deploys run only from `main` (staging) and `v*` tags (production); the workflow creates the D1 database, registers the workers.dev subdomain and uploads `ADMIN_TOKEN` from the GitHub environment.
- Hosted at `scoreosis.walang.studio` and `scoreosis-staging.walang.studio`.

## [0.1.0] - 2026-10-14

First release.

### Added

- **Verified ranked runs.** A Cloudflare Worker and one `PlayerSession` Durable Object per game and player. Clients send button inputs every second with a state checksum; the server replays them through the game's own ranked Lua and computes the score and facts itself.
- **Verifier VM.** Lua 5.1.5 compiled to Wasm with no I/O, OS, loader, debug or platform math, and instruction and memory caps. About 3 MiB per loaded verifier. Checkpoints every 10 s of play; a fault rejects only that run.
- **Timing rules.** Input may not lead real time or arrive more than 1.5 s late. The first chunk anchors the baseline, so start-up and CORS latency do not count as lag. Server-approved pauses of up to 15 min each and 60 min per run remove only the paused time.
- **Leaderboards** in D1: global and country, per runtime and store, one entry per player with their best run, 30 s edge cache. Per-mode boards for games with stages.
- **Achievements on BadgeTrip 0.1.0.** SQLite stores for the BadgeTrip engine in each player's object. Achievements, the run result and the publication outbox commit in one transaction.
- **Guests.** Anonymous per-installation identity; only the token's SHA-256 is stored.
- **Capacity and abuse controls.** Per-address, guest and run throttles; daily ranked admission spent only after the credential check; body limits before parsing.
- **Moderation.** Hide a player, suppress a run, disable a ruleset. Also applied to results published later.
- **Retention.** Raw inputs kept 7 days, accepted results 90 days unless a personal best references them.
- **Lua client library** (`scoreosis/`): HTTP client, ranked session with pause, resume and abandon, local achievement progress, Defold bindings, deterministic math and state codec. Vendored into games with `tools/sync-client.mjs`.
- **Game tooling.** `tools/pack-game.mjs` packs a game's ranked modules from a committed tree into a hashed ruleset and refuses non-deterministic code. `tools/trace.mjs` and `tools/trace.py` compare checksums between the Wasm VM, LuaJIT and PUC Lua.
- **Games:** Ah!Steroids, Sneak and ebakuw8 (one board per stage).
- **Docs site** at [walangstudio.github.io/scoreosis](https://walangstudio.github.io/scoreosis/): getting started, deploying to Cloudflare, configuration, other hosting, the game contract, API, architecture, security and operations.
- CI, docs, release and Cloudflare deploy workflows. Deploys stay off until the repository has Cloudflare credentials.

### Known limits

- Not yet deployed or measured on Cloudflare. Free-plan CPU per request and the ~25 player-hours per day estimate need a staging soak.
- Verification parity was measured on Windows x64 only; native ARM64 Android, iOS and HTML5 on devices are unverified.
- Bots that produce legal inputs in real time pass verification.
