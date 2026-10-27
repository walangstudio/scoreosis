# Changelog

All notable changes to Scoreosis are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), and versions follow [SemVer](https://semver.org/).

## [0.3.1] - 2026-10-27

### Security

- One network address (IPv4 address or IPv6 /64) may start at most `MAX_RUNS_PER_ADDRESS` ranked runs per UTC day (75 production, 50 staging), however many guests it creates. Previously one guest could start and abandon runs until the global `MAX_RUNS_PER_DAY` allowance was gone. Over the share, run start returns `429 address_limit` with `Retry-After` set to the next UTC midnight, and the game plays locally. The address is stored only as an HMAC under the new `ADDRESS_KEY` secret and pruned by the daily job (D1 migration `0004`). Over-share attempts write nothing.
- IPv6 rate-limit keys parse every spelling of an address; IPv4-mapped IPv6 counts as its IPv4 address.
- Deploys require the `ADDRESS_KEY` secret on each GitHub environment.
- A player starting two runs at once spends one admission slot, not two.
- Missing or malformed run limits stop ranked starts with `capacity` and log `admission_misconfigured` instead of a retryable 500. `MAX_RUNS_PER_DAY = 0` pauses ranked play.
- Security docs name the remaining limits: legal-input bots with the start seed, client-claimed platform labels, shared itch browser storage.

## [0.3.0] - 2026-10-27

### Added

- Arcade entry names: each verified run keeps the name it was submitted with, fixed once set (D1 migration `0003`). Renaming later leaves earlier entries unchanged. Migration `0003` names existing personal bests from their player's current name; unnamed players' earlier runs stay unranked.
- Authenticated leaderboard responses include the row position of the player's latest named entry, so games highlight the new score.
- itch builds Ah!Steroids 0.1.1 and Sneak 0.2.1 on their existing verified rulesets. Older builds stay accepted.
- Staging CORS allows the local game previews (ports 8774, 8775, 8097) and itch. Production still allows itch only.

### Changed

- Names accept single hyphens between segments (`test-001`). Length, character and reserved-name rules unchanged.
- Zero scores are left off every board and personal rank. Verified zero-score runs are still stored.
- Authenticated (`me=1`) leaderboard reads bypass the shared cache, so new results and names show at once. Their D1 read cost grows with stored results; watch it in Operations before raising limits.
- Run start checks the disabled-ruleset list and reserves daily quota in one D1 round trip. Disabled builds use no quota.
- Lua client: syncs the saved public name, waits for publication before reporting a result, and allows eight seconds for online startup.

## [0.2.0] - 2026-10-23

### Added

- Players choose their public name: `GET` and `PATCH /v1/games/:game/me/profile`. 2-16 ASCII letters, digits and single spaces; names starting with `guest` are reserved; one change per minute.
- Lua client: `client:profile` and `client:set_name`.
- Shared automatic-play helper with a two-second startup deadline and cancellation/late-reply protection.
- itch builds for Sneak and Ah!Steroids on Web, Windows and Android; shared platform boards keep optional provider filters.

### Changed

- New guests get no generated `Guest-…` name; `POST /v1/guests` returns `display_name: null`.
- Unnamed players stay off every board, take no rank and are absent from the platform record. Their verified results and achievements are kept and rank as soon as they choose a name. Players created before 0.2.0 start unnamed (D1 migration `0002`).
- Browser CORS allows `PATCH`.
- Lua client shares a pending guest registration across overlapping starts, so a retry cannot create a second identity.

### Security

- Lua client rejects non-HTTPS URLs before sending credentials; native builds verify certificates against vendored public roots.

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
