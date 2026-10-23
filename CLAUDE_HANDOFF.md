# Scoreosis implementation handoff for Claude

For environment testing, read [STAGING_CONNECTIVITY_REVIEW.md](STAGING_CONNECTIVITY_REVIEW.md). Both supplied API hosts returned Cloudflare error 1010 on 2026-10-23. Ah!Steroids has an explicit staging-targeted preview build; score submission is still blocked. All live test identities must use `kitty`.

## Latest product direction - simpler game UI

Read [UI_SIMPLIFICATION_PLAN.md](UI_SIMPLIFICATION_PLAN.md) first. The user's latest instruction is one automatic Play flow, only Global and Local scores, no visible verification labels, and no achievements UI for this release. Global stays separated by runtime platform, as explicitly confirmed. This supersedes conflicting presentation requirements below; preserve server validation and saved progress.

## Current priority - player-chosen names

Read [NAMED_PLAYERS_HANDOFF.md](NAMED_PLAYERS_HANDOFF.md) first. The user's 2026-10-22 instruction supersedes this document's generated Guest-name behavior: players must choose their public name, including through a high-score prompt. Production is now at `https://scoreosis.walang.studio`; older deployment-status statements below are historical. Use `kitty` for any authorized live test identity.

Date: 2026-10-14
Project: Scoreosis
Intended repository: walangstudio/scoreosis
Status: Implemented locally (not deployed, not pushed). Ah!Steroids and Sneak run verified ranked play end to end against `wrangler dev`. ebakuw8 is registered with per-stage modes; its server flow test verifies, but a browser run has not yet reached VERIFIED (local `wrangler dev` answered in seconds under load).

Gaps found while implementing, now covered:

- Sneak's sim lives on the controller instance; a reused table leaked `next_obstacle_id` and desynced at tick 60. `sim.new_game` clears every saved field.
- Sneak inputs are discrete actions, not held buttons: two per tick, `first + 10 * second`, `buttons = 7`.
- Lag is measured from the Worker's arrival time with the baseline anchored at the first chunk; local dev latency counted as player lag otherwise.
- A browser's CORS preflight delays only the first chunk; until the first pause a chunk may move the baseline earlier (never before run creation), or the next on-time chunk failed as ahead of real time.
- Each verifier VM reserved 17 MiB (zig's default 16 MiB stack); it is now about 3 MiB.

Still unverified: Durable Object CPU on the free plan, native ARM64/iOS parity, and a staging deploy. Free-tier capacity is about 25 player-hours per day at 1 s chunks.

Build a reusable Cloudflare service for verified game leaderboards and achievements. Integrate Ah!Steroids first, then Sneak. Reuse BadgeTrip for achievements. This handoff is sufficient to continue without the originating conversation.

## Confirmed requirements

- Support multiple games from the first release. Isolate each game's identities, sessions, rulesets, results, and achievements.
- Provide local, global, and country leaderboards. Treat country as the first regional grouping.
- Support independent runtime platform and distribution channel filters, including their combinations.
- Start with guest identities per game installation. Defer account linking, cross-device recovery, friend groups, and continent boards.
- Require online verified gameplay for competitive results. Offline scores and achievements remain local.
- Allow server-approved pauses in ranked runs.
- Ship the complete initial achievement catalog below, with separate Local and Verified progress.
- Deploy within Cloudflare's free tiers. Do not automatically upgrade billing, add a paid dependency, or weaken verification to stay free.
- Keep the public platform reusable. Game-specific simulation and achievement definitions belong in registered integrations.

The user's security goal is resistance to cheating. Do not promise absolute hack-proof operation. The service must reject fabricated results, impossible gameplay, altered rules, manipulated timing, and duplicate rewards. Bots producing legal inputs, assisted play, stolen credentials, and public build impersonation remain possible. Server-approved pauses provide additional thinking time.

## Workspace and existing evidence

The project directory is F:/opt/projs/walangstudio/scoreosis, beside BadgeTrip. The game repositories were inspected at the Y: paths below. Do not assume the drives are equivalent; resolve actual source paths before implementation.

| Source | Location | Relevant facts |
| --- | --- | --- |
| BadgeTrip | F:/opt/projs/walangstudio/badgetrip | Released 0.1.0 at inspected commit fb24313. Dependency-free TypeScript core, achievements, progress, tiers, event deduplication, store interfaces, and store contract tests. |
| Ah!Steroids | Y:/projs/walangstudio/ahsteroids | Defold game. game/simulation.lua exposes new_game and step. game/rng.lua supplies independent seeded RNG. Existing fixed step is 1/60 second. |
| Sneak | Y:/projs/walangstudio/sneak | Defold game. main/controller.script combines gameplay and rendering. script/save.lua already maintains a local top 10. Gameplay uses global math.random and variable frame timing. |

On 2026-10-12, Ah!Steroids passed 47 test groups through python tests/run_with_lupa.py. Both 100-run cohorts also passed through python tests/run_with_lupa.py tests/cohort.lua. These are historical baseline results, not evidence that the future server verifier works.

Sneak's engine suite, Wasm compatibility, Worker resource use, and cross-platform verification parity remain implementation gates. Both game repositories had existing uncommitted media or documentation changes. Reinspect their current status and preserve user work.

Read applicable AGENTS.md files, related history, build scripts, and release documentation before editing. Search history for related patterns and reuse the latest relevant design.

## Architecture

Use TypeScript Workers, D1, and SQLite-backed Durable Objects. Avoid KV as the authoritative competitive store.

| Component | Owns |
| --- | --- |
| HTTP Worker | Authentication, validation, routing, public ranking queries, and edge abuse throttling. |
| D1 | Game and build registration, profiles, accepted result summaries, and indexed leaderboard projections. |
| One Durable Object per game and player | Active session coordination, simulation checkpoints, exact session limits, authoritative BadgeTrip state, and durable publication outbox. |
| BadgeTrip core | Achievement definitions, rule evaluation, catalog, progress, and event deduplication. |
| Defold games | Local simulation and presentation, input capture, local saves, HTTP transport, and native leaderboard and achievement screens. |

Use built-in Defold HTTP requests initially. Upload input chunks every second. No WebSocket dependency is required for the first version. Never expose BadgeTrip's unrestricted emit, replay, or seed methods to game clients.

Keep persistence adapters in Scoreosis. BadgeTrip explicitly leaves storage to consuming applications. Do not add Cloudflare-specific persistence to BadgeTrip merely for this integration.

### Registered games and builds

Use stable game IDs sneak and ahsteroids. Register each game's versioned ruleset, verifier artifact, and achievement definitions through administrator-controlled configuration. A new game must reuse authentication, sessions, ranking infrastructure, and achievement integration.

Each registered build has game_id, build_id, ruleset_version, runtime_platform, and distribution_channel. Register only supported combinations actually released.

Runtime values: web, windows, android, ios, macos, linux.

Distribution values: itch_io, google_play, steam, direct, unknown.

Resolve platform metadata from the registered build at run creation. Clients cannot override country, runtime, channel, or rules after the run starts. Build IDs and platform labels are not device attestation: an attacker can impersonate a public build. Document this limit and do not advertise platform identity as cryptographically proven.

Never execute uploaded scripts or dynamically trust a game's claimed verification result. Verifiers are reviewed artifacts packaged into the service by the administrator.

### Public interfaces

Use a versioned JSON HTTP API:

| Route | Behavior |
| --- | --- |
| POST /v1/guests | Validate game and build; create an installation-scoped guest and return its credential once. |
| POST /v1/games/:gameId/runs | Start an authorized run and return server-issued ID, seed, ruleset, timing baseline, and expiry. |
| POST /v1/games/:gameId/runs/:runId/inputs | Submit ordered input chunks; return durable acknowledgment and authoritative checkpoint information. |
| POST /v1/games/:gameId/runs/:runId/pause | Flush outstanding input and request an authoritative pause. |
| POST /v1/games/:gameId/runs/:runId/resume | Resume an approved pause and receive a new timing baseline. |
| POST /v1/games/:gameId/runs/:runId/finish | Request finalization; accept only a server-verified terminal run. |
| GET /v1/games/:gameId/leaderboards | Return filtered ranking pages; include the authenticated player's rank when requested. |
| GET /v1/games/:gameId/me/achievements | Return the catalog and authoritative verified progress. |

Inputs contain sequence numbers, simulation ticks, and normalized controls. Server state determines score, survival, level, achievement facts, and terminal state. Derive player identity from authentication, never from a caller-supplied actor field.

Document request and response schemas, limits, stable error codes, and retry behavior in the service API documentation. Generate types through the project's tooling; do not manually edit generated files.

## Leaderboards and platform grouping

- Provide Local, Global, and Country views for each game.
- Online boards rank all-time personal-best scores within a compatible ruleset.
- Runtime and distribution filters are independent and optional. Default to all runtimes and channels.
- Support country plus runtime plus channel together. Do not collapse runtime and store into a single platform field.
- Preserve best results for each game, player, ruleset, country, runtime, and channel tuple. Aggregate filtered tuples to one best result per player. A better Windows score must not overwrite the player's Android best.
- Keep different games and incompatible rulesets out of the same competitive board.
- Return the top 100 in pages of 25, plus the player's rank. Equal scores share rank; server acceptance time and a stable ID determine display order among ties.
- Cache public ranking responses for 30 seconds. Include every active filter and ruleset in the cache key. Keep private player data out of shared caches.
- Obtain country from Cloudflare request metadata at run creation. Unknown country participates in Global only. A VPN can change apparent country; do not describe it as verified residence.
- Keep existing local records and settings. Add a local top-10 history to Ah!Steroids; retain Sneak's top 10. Old records and offline runs cannot be promoted into verified rankings.

Guests are per installation and game for v1. Explain that clearing application data or reinstalling can lose online identity. Do not imply cross-game or cross-device identity is already supported.

## Gameplay verification

### Shared simulation

Execute the same trusted Lua gameplay modules in Defold and in a bundled Lua 5.1 WebAssembly interpreter on the server. Prototype the interpreter integration before building the full service. Do not substitute an independently maintained JavaScript simulation.

Disable filesystem, operating-system, network, and arbitrary code-loading facilities in the server interpreter. Load only packaged trusted modules. Bound instruction work, memory, entities, payloads, and simulation catch-up.

Package simulation artifacts reproducibly from their owning game sources. Version the rules and verifier together. Do not maintain manually copied server forks that can silently drift.

For Ah!Steroids, reuse game/simulation.lua and game/rng.lua. Fix ranked world dimensions at 1920 by 1080. The current game changes world width with the screen; ranked resizing must change presentation only. Local play keeps its existing responsive arena.

For Sneak, extract a pure simulation from main/controller.script, reusing existing AI, vision, obstacle, difficulty, and scoring logic. Separate simulation timers from animation, sound, haptics, and engine objects. Preserve food/chop scoring caps and first-action gameplay behavior.

Use 60 Hz simulation ticks. Give each run independent deterministic RNG state, with cosmetic randomness in a separate stream. Normalize the same input intents for keyboard, controller, touch, and server playback. Preserve legal gameplay semantics; validate burst inputs against the actual rules rather than assuming every fast player is cheating.

Floating-point and math-library differences between native Defold, HTML5, and Wasm must be tested. Compare canonical traces and checkpoints across all three targets. Resolve material divergence before enabling ranked play; do not relax acceptance checks to hide it.

### Timing and pauses

- Issue the run ID, seed, ruleset, and timing baseline on the server.
- Upload inputs once per second, with at most one unacknowledged chunk per run.
- Accept input evidence within a maximum 1.5-second timing window. Reject future ticks, rewritten history, gaps beyond the window, and attempts to upload arbitrarily slow gameplay later.
- Persist the input/checkpoint sequence before acknowledgment. Identical retries return the original acknowledgment. Conflicting retries fail.
- Permit one active ranked run per game and player.
- A pause takes effect only at the server-acknowledged checkpoint after all pending input is flushed. The client waits for approval before treating simulation time as frozen.
- Reject gameplay input while paused. Resume with a fresh server timing baseline.
- Default limits: 15 minutes per pause, 60 minutes total paused time, and 24-hour absolute session expiry.
- Connection loss beyond the timing window, expiry, or failed verification ends competitive eligibility. Preserve local play and clearly display Local only.
- Tutorial and menu time do not count as survival. Preserve Sneak's first-action gate and ensure it cannot generate score or achievements before play starts.

Online evidence constrains fabricated results and time manipulation. It does not prove that a human produced the controls or eliminate assistance during pauses.

## BadgeTrip integration and recovery

BadgeTrip's existing project function appends the event before applying points, streaks, and achievements. With independent store writes, a failure after append can leave partial effects, and retrying the event ID can skip unfinished processing. Do not treat event deduplication alone as whole-event atomicity.

Implement the four BadgeTrip store interfaces against the player's Durable Object SQLite storage. Run all achievement processing for a completed verified run, the run-finalization marker, and the publication outbox write inside one asynchronous ctx.storage.transaction callback. Await the entire engine operation inside it. No network requests belong inside that transaction. Serialize finalization for the player and test rollback after each stage.

Do not use transactionSync with an asynchronous BadgeTrip callback. Cloudflare documents that asynchronous transactions can include SQLite operations through ctx.storage. Run the BadgeTrip store contract suite against the actual adapters.

After the local transaction commits, publish accepted result projections to D1 using a durable outbox. Use run IDs as idempotency keys and a D1 batch transaction for related result and personal-best updates. Retry transient failures through alarms. Keep a Pending publication state until the D1 result is committed. An outbox retry must neither duplicate rewards nor overwrite a better score with a worse one.

Derive BadgeTrip events from authoritative simulation facts only. Use run-scoped event IDs and game-scoped achievement IDs. Aggregate at run completion where semantics allow; do not write an achievement event for every simulation frame.

BadgeTrip's score leaderboard uses accumulated values. Scoreosis owns arcade personal-best rankings and country/runtime/channel filters. Do not bend cumulative scoring into best-run semantics or add achievement points to competitive game scores.

## Initial achievement catalog

Ship the following 12 achievements per game. IDs are stable within the game namespace. Implement the same conditions for local and verified progress, while keeping their storage and trust separate.

| Sneak ID | Condition |
| --- | --- |
| clear_1 | Clear level 1. |
| clear_5 | Clear level 5. |
| clear_10 | Clear level 10. |
| score_100 | Score at least 100 in one run. |
| score_500 | Score at least 500 in one run. |
| first_chop | Successfully remove a snake segment with a strike. |
| food_10 | Destroy 10 food cumulatively. |
| spike_bait | Bait one snake stun from a spike. |
| cover_10 | Break 10 destructible cover blocks cumulatively. |
| silent_clear | Clear one level without entering pursuit during that level. |
| food_only_clear | Clear one level using food damage only, without direct chop damage during that level. |
| clears_100 | Clear 100 levels cumulatively. |

| Ah!Steroids ID | Condition |
| --- | --- |
| survive_60 | Survive 60 active seconds in one run. |
| survive_120 | Survive 120 active seconds in one run. |
| score_5000 | Score at least 5,000 in one run. |
| score_20000 | Score at least 20,000 in one run. |
| kills_1 | Earn the first credited asteroid kill. |
| kills_100 | Earn 100 credited asteroid kills cumulatively. |
| kills_1000 | Earn 1,000 credited asteroid kills cumulatively. |
| large_kill | Earn a credited large-asteroid kill. |
| steroid | Activate steroid overdrive. |
| mastery_3 | Earn three mastery bonuses in one run. |
| close_saves_10 | Make 10 close saves in one run. |
| fleet_60 | Survive 60 active seconds without losing either ship. |

Use simulation-defined credit, mastery, and close-save rules. Do not count uncredited environmental destruction as player kills. Paused time never advances survival achievements.

Verified cumulative progress and unlocks commit only with a valid finished run. Failed or abandoned runs remain local. Keep Local and Verified labels visible; an offline unlock never becomes verified merely because the client reports it later.

Achievements are cosmetic. Provide progress, accessible labels, keyboard/controller navigation, and reduced-motion behavior. Render native Defold screens rather than trying to embed BadgeTrip's JavaScript UI components into the game.

## Security and operational limits

- Require HTTPS and certificate verification for native clients. Never ship administrative secrets or shared score-signing keys in game builds.
- Generate high-entropy installation credentials; return the credential once and store only its hash server-side. Treat the client copy as a bearer credential that can be stolen.
- Enforce game/player/run ownership on every private operation. Never accept an actor, region, score, or achievement claim as authoritative.
- Validate finite numeric values, enums, lengths, sequence order, legal actions, and supported ruleset/build combinations at trust boundaries.
- Limit input requests to 16 KiB before full parsing; use smaller route-specific limits for other JSON requests. Bound event count and processed ticks independently of byte size.
- Use prepared SQL, unique keys for idempotency, and atomic updates. Keep CORS to approved web origins, while recognizing that CORS does not authenticate native or scripted clients.
- Use edge rate limiting for abuse reduction and exact Durable Object counters for session invariants. Cloudflare's rate-limit binding is location-local and eventually consistent.
- Apply conservative IP throttles alongside credentials, considering shared networks. Do not assume guest registration prevents one attacker creating many accounts.
- Reject unsupported builds and unavailable verifiers. Never fall back to trusted-client score acceptance.
- Keep administration separate and authenticated. Support hiding banned profiles, suppressing results, and disabling compromised rulesets. Document how to revoke affected achievement state if needed.
- Do not log raw credentials, authorization headers, or unnecessary IP/location data.

Retain raw gameplay input traces for seven days and accepted result summaries for 90 days. Retain personal bests and achievement state indefinitely. Keep BadgeTrip event facts required for lifetime rules separate from expiring input traces; never prune facts in a way that silently resets cumulative progress. Preserve the minimal accepted-result provenance attached to retained personal bests.

Use bounded cleanup batches. Expired sessions cannot remain active indefinitely. Take and verify a recoverable database export before destructive migrations.

### Free tier budget

During research on 2026-10-12, the documented limits included:

| Product | Free allowance |
| --- | --- |
| Workers | 100,000 requests/day; 10 ms CPU per HTTP invocation. |
| D1 | 5 million rows read/day; 100,000 rows written/day; 5 GB total storage. |
| SQLite Durable Objects | Separate request, duration, row-operation, and storage allowances; 100,000 requests/day and 13,000 GB-seconds/day were documented. |

These allowances are account-wide, and service usage competes with other projects. The Worker gateway and Durable Object runtime have distinct limits. Recheck current official documentation before pinning budgets or deployment settings.

Measure CPU, requests, row reads/writes, checkpoint sizes, and storage growth per player-minute in a real free-plan staging deployment. Include indexes, retries, cleanup, BadgeTrip processing, and outbox publication. Do not infer free capacity solely from a local benchmark.

Use conservative admission controls and explicit capacity errors before normal workload exhausts the account budget. Stop new ranked admissions first; preserve active sessions where possible. If verification cannot complete, fall back to local status rather than publishing unverified results. Do not promise unlimited availability or immunity to quota-exhaustion attacks on a free service.

Expose health, structured rejection reasons, verification latency, publication backlog, CPU, and quota metrics. Retain no secrets in logs. Deploy staging and production with separate resources and credentials.

## Implementation sequence and acceptance gates

1. Reinspect sources and git history. Preserve unrelated work. Create the Scoreosis project and architecture/API/security documentation.
2. Prototype Ah!Steroids in the selected Lua 5.1 Wasm runtime inside Workers/Durable Objects. Verify trusted module loading, serialization, restoration, CPU, and memory before implementing the complete service.
3. Establish identical canonical traces across native Defold, HTML5, and server Wasm. Fix ranked arena dimensions and simulation differences before admitting public scores.
4. Implement game/build registration, guest authentication, bounded input transport, durable sessions, and approved pause/resume.
5. Implement BadgeTrip SQLite adapters, rollback-safe finalization, and the D1 publication outbox.
6. Implement World/Country rankings and independent runtime/channel filters. Add local history, native screens, and the complete Ah!Steroids achievement catalog.
7. Extract Sneak's pure simulation. Preserve gameplay through trace and engine tests, then integrate the same backend and its achievement catalog.
8. Run security/recovery checks, all relevant builds and tests, and visual QA. Release Ah!Steroids first, then Sneak after equivalent gates pass.

Every gate must produce runnable evidence. If the selected verifier cannot meet free-runtime constraints or reliable parity, keep ranking disabled and report the measured blocker. Do not quietly substitute plausibility checks for simulation verification.

### Required validation

- Isolation: another player's token, another game's token, and mismatched game/build/ruleset cannot access or finalize a run.
- Integrity: forged scores, modified saves, altered seeds, illegal actions, future ticks, rewritten history, conflicting retries, and unsupported builds are rejected.
- Timing: slow/fast clocks, missing chunks, delayed uploads, approved pauses, input during pause, expired pauses, and disconnects behave as specified.
- Recovery: checkpoint restoration, eviction, concurrent finish requests, transaction failure after event append, D1 failure, alarm retry, and publication reordering cause no lost or duplicate verified rewards.
- Rankings: ties, pagination, country unknown, each runtime, each store, combined filters, and preserved per-platform personal bests return correct results and isolated cache entries.
- Achievements: each of the 24 definitions has a runnable boundary check, cumulative progress counts once, failed runs do not grant verified progress, and paused/tutorial time does not advance survival.
- Compatibility: identical gameplay traces across Web, Windows, Android, and Wasm; screen resizing never changes ranked physics.
- Persistence/UI: old saves retain scores/settings, local-only status is clear, controls work across input methods, and the layout is visually inspected on desktop and mobile.

Run Ah!Steroids' existing headless suites, Sneak's engine/input and build checks, BadgeTrip's store contract tests, and Scoreosis' tests against the actual Workers storage environment. Run complete builds and repository CI gates with CI tool versions before shipping. Record exact commands and results.

## Working instructions for Claude

Honor applicable repository instructions and the user's global AGENTS.md policy. Key requirements from the originating conversation:

- Never use the em dash character. Never add an agent co-author or agent trailer to commits.
- Never manually edit generated files. Regenerate through their tools.
- Prefer the least code that fully solves the problem, using existing patterns and installed/native capabilities. Do not add speculative frameworks or unrelated refactors.
- For bug fixes, reproduce the problem end to end first. Fix observed lint failures, test failures, flakiness, and clearly broken UI.
- Review the change, fix findings, build, and run all tests. Run PR-gating CI jobs locally using CI's tool versions.
- Before a versioned release, update the dated changelog, relevant documentation, manifests, version references, and stale counts. Do not bump versions merely to create this handoff.
- When running Claude Code, use magent specialists for software work: architecture, delivery planning, debugging, security, performance, QA, and DevOps as applicable. Use teams for substantial independent work.
- Use F:/bin/ghc.bat from inside the repository for GitHub identity switching. Do not guess the correct account or modify identities manually when that helper applies.
- Check local time and weekday before any push or merge. Do not automatically push or merge on weekdays from 07:00 to 16:00 local time unless explicitly ordered or a holiday is confirmed. Follow the user's instruction to defer and schedule outside that window.
- Commit messages stay short, 1-3 lines. Verify the committed tree before pushing and confirm PR checks afterward.

This task creates the handoff only. No repository initialization, dependencies, application implementation, deployment, commit, push, or PR has been performed by the handoff author. Continue implementation under the user's subsequent authorization and existing project workflow.

## Research references

- [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [SQLite Durable Object storage and transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- [Workers rate limiting behavior](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Wasm in Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)
- [Defold Lua runtime](https://defold.com/manuals/lua/)
- [Lua 5.1 reference](https://www.lua.org/manual/5.1/manual.html)
- [Workers leaderboard template](https://github.com/gelemias/leaderboard-platform): reference only; its documented simulation verification is optional and trusted acceptance is unsuitable unchanged.
- [LootLocker pricing](https://lootlocker.com/pricing/): the researched free Personal plan was limited to eligible organizations and 10,000 monthly active users; self-hosting required an Enterprise License.
- [Nakama Docker deployment](https://heroiclabs.com/docs/install-docker-quickstart/) and [RankDrop](https://github.com/Brainzy/RankDrop): require server/database deployments outside the free Workers runtime.

**TL;DR:** Build Scoreosis as a multi-game service with verified competition, independent runtime/store rankings, and BadgeTrip achievements. Prove simulation parity and free-tier feasibility before accepting public ranked scores.
