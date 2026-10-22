# Sneak and Ah!Steroids - simpler scores UI

Date: 2026-10-22
Status: Implementation plan. No game UI or gameplay changes are included in this document.

This is the latest product direction. It supersedes earlier requirements to expose Country, Achievements, separate Play/Ranked modes, and verification status in either game. Keep the player-chosen-name requirements in `NAMED_PLAYERS_HANDOFF.md`.

## Release scope

- One **Play** action. Online play automatically uses Scoreosis in the background; players never choose a ranked mode.
- One **High Scores** menu entry, with exactly two views: **Global** and **Local**.
- **Global remains separated by runtime platform**, confirmed by the user. Web players share the Web board across providers; Windows and Android have their own boards. Keep the runtime filter in requests, but hide runtime/provider controls and platform labels from the UI. Current provider remains `itch_io`.
- Global displays each named player's best accepted score. Local displays this device's best ten runs. Do not merge the two datasets.
- Remove achievements from the current release UI. This includes buttons, tabs, catalogs, progress columns, unlock messages, and result-screen achievement counts. Do not replace them with a Coming Soon item.
- Remove visible Ranked, Verified, Verifying, Local Only, and server-validation terminology everywhere: menu, HUD, pause, results, score rows, accessibility text, and Web overlays. Keep technical states internally.
- Preserve saved scores, identities, achievement progress, server verification, and backend filters. This is a presentation and play-flow change, not a data purge.

## Screen design

### Main menu

Keep each game's existing background, title, fonts, artwork, and secondary menu items. Collapse Play and Ranked into a single prominent Play button. Place High Scores directly below it, then retain the existing help/settings/about actions. Reflow spacing and focus order; do not leave a hole where Ranked used to be.

Keep the shared top-score number, labeled **TOP SCORE**, without Web/Windows or verification prefixes. It follows the same runtime scope as Global. If no global record can be loaded, show a neutral `...` placeholder instead of presenting a personal score as the global record. An empty, successfully loaded board may show zero. Personal records remain visible in Local.

### High Scores

Use one coherent score panel, not a list of feature destinations:

```text
                  HIGH SCORES
              GLOBAL       LOCAL

       1       KITTY               12,450
       2       MIKA                 9,800
       3       RIN                  7,250
       ...

              YOU  #12   4,600
          PREV       1/4       NEXT
                      BACK
```

Names and numbers above are layout examples, not test results or production entries. Keep normal score formatting appropriate to each game.

- Global is the initial view. Switching Global/Local preserves logical selection and resets paging appropriately.
- Global rows contain rank, player name, and right-aligned score. Use one modest accent for the current player's row, not a verification badge. Show their rank below the list when outside the visible page and the API returns it.
- Local rows contain place, date, and score using existing saved history. No Verified suffix, provenance column, or extra achievement information.
- Keep the top 100 Global entries and local top ten accessible, using paging only when needed. Do not regress Sneak to the first 25 results.
- Hide inactive paging controls where practical. Keep stable row heights and alignment across both views. Long names must fit without colliding with scores.
- Empty state: **No scores yet**. Loading state: **Loading scores...**. Failure state: **Scores unavailable**, with a simple retry action. Keep protocol errors in logs, not in the player's score table.

### Match each game's existing style

**Sneak:** use its centered pixel-art panel, pixel font, crisp borders, and restrained existing accent colors. Create a proper score layout within the current overlay system rather than squeezing more metadata into its generic eight-line list. Keep names, numbers, and controls readable on portrait phones; avoid tiny type and decorative icon clutter.

**Ah!Steroids:** retain the existing space background, framed panel, typography, and cyan/coral accents. Replace four tabs with two properly sized, centered tabs. Keep generous row spacing and aligned score columns; do not leave the old Country/Achievements positions empty.

Use the existing controls and assets. No new icon pack, achievement art, visual framework, or dashboard-style cards are needed for this release.

### Results and pause

Results focus on score, personal-best celebration when applicable, Retry, High Scores, and Menu. Keep existing game-specific run statistics if already useful. Remove verification badges, achievement announcements, and backend reason-code explanations.

Pause remains an ordinary pause screen. The existing server pause/resume handshake still runs when needed, but the UI does not call it a ranked pause. Disable repeated actions during an outstanding transition without exposing implementation details.

## One automatic play path

1. Play attempts a Scoreosis session automatically using the existing installation credential, server seed, and input-upload pipeline.
2. Bound the connection wait; target at most two seconds before allowing local play if startup cannot complete. No mode-selection dialog or second Play choice. Cancel/abandon a late server start so it cannot revive a local run.
3. If connected, send inputs and finish the run through the current verifier. Do not accept a client-supplied score as a shortcut.
4. If connection, capacity, or validation fails, gameplay continues and the completed score remains local. Never silently publish an offline or rejected run. Use a short message such as **Score saved on this device** only when a failed online save needs explanation; no permanent HUD banner.
5. Retry uses this same automatic path, regardless of the previous run's network outcome. Do not preserve a visible or player-selectable ranked/local mode.
6. Check that network availability does not unexpectedly change controls, tutorials, difficulty, or framing. Ah!Steroids currently uses a fixed reference arena for server sessions and a different local-arena path; resolve that controller/presentation choice consistently without changing verifier physics merely to simplify the menu.
7. Player naming still follows the named-player handoff: prompt after a qualifying personal record if unnamed, remember the chosen name, and do not publish generated Guest names. Naming must not block or interrupt an active run. Offline scores never become eligible just because a name was saved.

The user's "always ranked" requirement means automatic participation whenever an online session can be established. It does not permit unverified offline scores into Global. Local history and network-failure fallback remain available without a separate mode.

## Hide achievements now; design them later

Keep existing catalogs, saved progress, and backend evaluation intact. Remove the visible achievement experience and its client-side catalog/progress fetches. Do not delete or reset progress to hide a screen.

Future work, outside this release: author game-specific badge graphics using Sneak's pixel-art language and Ah!Steroids' ship/asteroid/planet motifs. Distinguish locally earned and server-earned badges with muted versus full accent colors, without a Verified label. Use a fill/outline difference as well so color is not the only accessible cue. Review actual visual mockups before implementing a new achievement screen. No achievement art or screen should be built during this simplification task.

## Implementation map

| Project | Changes to inspect and make |
| --- | --- |
| Sneak | `gui/overlay.gui_script`: one Play action, High Scores panel, two score views. `main/controller.script`: automatic session startup/retry, remove status/achievement presentation. `script/records.lua`: expose Global/Local only; preserve paging and local writes. `gui/hud.gui_script` and the Web UI bridge: remove badges and inaccessible/hidden menu actions. |
| Ah!Steroids | `main/game.gui_script`: menu layout, single play path, two score tabs, ordinary pause/results, no achievement notifications or score provenance suffixes. `game/locales/en.lua`: player-facing copy. `game/save.lua`: preserve historical data and internal flags. Inspect the Web UI bridge and controls for old actions. |
| Shared client | Existing runtime-scoped `leaderboard` and `platform_best` already match the confirmed scope. Keep TLS and server-validation behavior. If shared code must change, edit Scoreosis source and regenerate both games through `tools/sync-client.mjs`; never hand-edit vendors. |
| Scoreosis service | Keep country/provider filters, achievements, and result validation available internally. No API removal, schema purge, or new leaderboard algorithm is required just to simplify the games. Integrate the separate player-name work. |

## Verification and delivery

- Capture the current menu, score screen, HUD, pause, and results as the visual baseline. The previous screenshot helper failed with `failed to write kernel assets`; resolve tool availability or report visual checks as unverified. Do not fabricate screenshots.
- Implement in both games without touching unrelated media/docs edits. Check the latest branch status first; naming work may now be in progress.
- Update existing tests rather than retaining assertions for removed buttons, four tabs, achievement cards, or verification labels. Add checks for single-Play startup, startup timeout, a late start reply, network loss, Retry, and ordinary pause/resume.
- Check that only Global/Local are reachable by pointer, keyboard, gamepad, touch, and accessibility/Web controls. No hidden Country/Achievements action may remain focusable or invoke a screen through a stale bridge command.
- Verify runtime separation remains active, all providers for the runtime share Global, paging reaches rank 100, and unnamed players cannot appear under generated names after the naming work ships.
- Verify local top ten and stored achievement progress survive upgrades and restarts; hidden achievements issue no UI notifications or unnecessary progress/catalog requests.
- Visually inspect phone portrait, phone landscape, and desktop in both games. Check typography, alignment, long names, empty/error states, focus, touch targets, and gamepad navigation. A passing geometry test alone is insufficient design approval.
- Run the backend checks when shared/service code changes, both game suites, existing UI/input checks, and both Web builds. Record actual results. Keep automated tests isolated from production; any authorized live test identity must be `kitty`.
- Update game documentation and release notes to describe automatic online scoring and Global/Local only. Commit scoped changes locally. Production rollout and live-data migration are separate release work.

Done means both games look and behave like simple arcade games: Play, named top scores, and personal local history. Achievements and verification machinery are absent from the visible experience while the integrity protections remain in place.
