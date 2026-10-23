# Player-chosen names - implementation handoff

Date: 2026-10-22
Owner: Scoreosis, with client integration in Sneak and Ah!Steroids.
Status: Requirements and implementation plan only. This handoff does not implement naming or deploy changes.

Read [UI_SIMPLIFICATION_PLAN.md](UI_SIMPLIFICATION_PLAN.md) for the newer presentation requirements: a single Play action with automatic online scoring, Global/Local only, no verification labels, and no achievements UI in this release. Keep naming and progress integrity from this handoff; references to achievement data do not require displaying achievements.

## User requirement

Players must choose their leaderboard name. Do not show or automatically assign `Guest-XXXXXX` as their public identity. Both games need name entry when a player earns a new personal high score. Use `kitty` for every live test identity.

This supersedes generated Guest names in `CLAUDE_HANDOFF.md` and examples elsewhere. Installation-scoped bearer credentials can remain an internal authentication mechanism; a display name is not an account, password, or proof of identity. Do not add an account system to solve display names.

## Working directories and current state

| Project | Path | Branch at inspection |
| --- | --- | --- |
| Scoreosis | `F:/opt/projs/walangstudio/scoreosis` | `main` |
| Sneak | `Y:/projs/walangstudio/sneak` | `feat/scoreosis` |
| Ah!Steroids | `Y:/projs/walangstudio/ahsteroids` | `feat/scoreosis` |

At handoff creation, all three checkouts contained uncommitted work from the prior integration review. Those changes may now be committed. Recheck status and preserve unrelated media and documentation. Read applicable agent instructions and related history before changing implementation. Read `IMPLEMENTATION_REVIEW.md`, `CLAUDE.md`, and `docs/ARCHITECTURE.md` for context.

Production URL supplied by the user: `https://scoreosis.walang.studio`.

Both games still have blank `[scoreosis] url` settings and default to `channel = itch_io`. On 2026-10-22, read-only production requests from this environment returned HTTP 403, including `/v1/health`. No live test identity or score was created. Deployed behavior could not be verified; do not assume local source exactly matches production.

## Evidence and files to inspect

- `src/index.ts`: `POST /v1/guests` constructs `Guest-${playerId.slice(0, 6).toUpperCase()}`. No player profile/name mutation route exists in the inspected source.
- `src/leaderboard.ts`, `migrations/`: D1 player names, result projections, ranking eligibility, and best-score queries.
- `src/session.ts`: credential checks, verified results, authoritative achievements, and publication outbox. Preserve their invariants.
- `scoreosis/client.lua`: `ensure_guest` saves only the token; add profile operations using existing authenticated transport.
- `tools/sync-client.mjs`: regenerate shared Lua, certificates, and `scoreosis_tls` into both games. Never edit vendored copies manually.
- Sneak: `script/online.lua`, `script/records.lua`, `script/save.lua`, `main/controller.script`, `gui/overlay.gui_script`, and the existing Web UI bridge.
- Ah!Steroids: `game/online.lua`, `game/save.lua`, `main/game.gui_script`, `game/locales/en.lua`, and the existing Web UI bridge.
- Tests: `test/api.test.ts`, `test/rankings.test.ts`, `test/flow.test.ts`, `test/lua/`, Sneak's `tools/test_input.ps1`, Ah!Steroids' `tests/ui.lua` and `tools/test_ui.ps1`.

## Required behavior

1. Let local play start without registration or a name dialog.
2. After the first completed score or a later new personal best, prompt an unnamed player to enter a name. A global number-one score is not required. Provide an explicit submit action and a cancel/back action.
3. Persist a successfully saved name and reuse it across that player's future results and achievements in the same game. Provide an existing-style profile/settings action to enter or change it later.
4. A named player does not need to re-enter their name for every new record. Names are per game under the current identity model; do not claim cross-device or cross-game recovery.
5. A verified ranked result can finish and be stored before name entry. Keep it out of public rankings until a valid chosen name exists. Cancelling the dialog keeps progress and allows naming later. Do not substitute Guest, Anonymous, or another generated public label.
6. Local-only/offline scores stay local. Name entry must never promote them into verified results or verified achievements. A locally chosen name may be retained for later server validation and retry, with pending status shown honestly.
7. Do not pause active ranked gameplay or delay input uploads for a name dialog. Show it after the run has ended; preserve the existing verification/result states.
8. Keep each game's existing fonts, panel geometry, controls, focus behavior, localization patterns, and sound feedback. Keyboard, gamepad, touch, and mobile text entry must work. Input must not also steer ships or move the ninja behind the modal.

## Server and client design

Implement an authenticated current-player profile API. Recommended routes:

| Route | Contract |
| --- | --- |
| `GET /v1/games/:game/me/profile` | Return the authenticated player's chosen display name, or an explicit unset state. Use `private, no-store`. |
| `PATCH /v1/games/:game/me/profile` | Body `{ "display_name": "kitty" }`. Validate, authenticate, update only the caller's profile, and return the canonical saved name. |

Mirror existing route, error, validation, and test patterns rather than adding a separate framework. Keep `/v1/guests` compatible if existing installations need it; its internal credential function does not require a visible Guest identity. Stop generating public names for new players and document the unnamed state.

Suggested initial name policy: 2-16 ASCII letters, digits, and single interior spaces after trimming/collapsing whitespace. Preserve chosen casing in storage; Sneak can render uppercase using its existing font. Reserve generated `Guest-...` identifiers. Names need not be unique and must never identify or authenticate an account. State the policy in the UI and API documentation. Do not claim a character allowlist prevents offensive names; preserve existing moderation controls.

Enforce body/name limits and validation on the server, regardless of client validation. Reject control characters, markup, unsupported characters, empty names, and overlong values. Use bound SQL parameters and render names as plain text. Reject caller-supplied ownership fields rather than allowing a player ID to select the updated row. Failed validation must not change the previous name.

Check the bearer credential and game scope before consuming mutation capacity or writing. Bound name-change frequency using existing infrastructure; make concurrent updates obey that bound. Return stable errors clients can display. Do not use a display name as an SQL key or merge players who choose the same name.

Add an explicit persisted chosen-name state, such as nullable `name_set_at`, rather than inferring it indefinitely from a display-name prefix. Migrate old generated-name players as unnamed without deleting their IDs, credentials, runs, scores, or achievements. A successful authenticated name update makes retained verified results eligible for publication/ranking again. Existing tokens must still work.

Use the same name-eligibility rule for board entries, per-player rank, and shared platform BEST. Hidden unnamed players must not consume rank positions or appear under a generated name. Preserve correct ties, filtering, pagination, and moderation. Account for the existing 30-second public cache on first naming and later renaming; document the delay or invalidate through a tested mechanism.

If publication happens before naming, retain a recoverable record/outbox state. Name saving must expose only already verified results, exactly once, and must not issue achievement rewards again. Choose the smallest change consistent with the existing D1/outbox architecture. Do not discard terminal runs while waiting for user input.

Add shared Lua profile methods, then regenerate both clients. Handle missing credentials, unnamed state, validation errors, unavailable networking, retry, and cancellation. Do not send admin tokens or service secrets to games.

## Existing ranking and security requirements stay in force

- Separate games and runtime platforms. All Web providers share the default Web board and BEST; the API can narrow by provider. Current releases use `itch_io`.
- Preserve Local Top 10 and the 12 achievements per game, with distinct Local and Verified progress. Renaming must not reset or duplicate them.
- Scores and facts come from server simulation, never from a name/profile request or an offline save.
- Keep HTTPS enforcement and the existing native TLS initialization shim. A missing/failed verifier blocks native HTTPS; do not remove it to make production requests work.
- Platform/provider labels remain client claims. Legal-input bots and stolen bearer credentials remain possible. Do not claim names make the system hack-proof or authenticate the human.
- Names are public. Tell players not to enter personal information. Do not log bearer credentials or raw request bodies.

## Implementation sequence and acceptance checks

1. Reproduce current generated names and missing name entry locally. Add failing profile, ownership, migration, and unnamed-ranking checks first.
2. Implement the migration, profile API, naming validation, mutation throttling, and consistent ranking eligibility. Verify existing credentials and verified progress survive migration and rename.
3. Extend the shared Lua client and its tests. Sync through the generator; compare vendored files with their source.
4. Add name entry and later editing to both games using their existing design and input conventions. Reproduce and check each actual high-score flow end to end.
5. Test absent/forged tokens, wrong-game tokens, invalid names, oversized bodies, duplicate names on different IDs, concurrent updates, cancelled dialogs, network failures, restart persistence, and rename cache behavior.
6. Verify an unnamed verified high score stays stored but private, becomes ranked after naming, and keeps the same ID, score, runtime/provider classification, and achievements. Verify local scores never enter the global board.
7. Run backend lint, typecheck, all tests, both Lua runtimes, documentation build, game suites, native UI checks, and both Web builds. Report actual results and skipped checks. Test mobile keyboard/gamepad focus and long accepted names visually when available.
8. Update API/integration docs, old Guest-name requirements, release notes, and game documentation. Validate the production endpoint and hosting CORS before pointing release builds at it. Treat the observed 403 as unresolved until its source is identified; do not bypass access controls or weaken TLS.

Keep ordinary automated tests isolated from production by overriding the test fixtures' endpoint or transport. Do not silently create live generated-name players. Use `kitty` for authorized live test identities; retain their stable IDs to avoid repeated identities. Never fabricate a production score to test naming. Use real verified gameplay or test the full flow locally.

Definition of done: both games accept and remember a chosen name, verified public scores use it, unnamed players never appear as Guest, existing identities/progress survive, and the profile API cannot rename another player or alter scores/achievements. Implement and verify locally; a production rollout or live migration is a separate release task. The current request is to prepare this handoff.
