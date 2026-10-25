# Global score integration handoff

Completed on 2026-10-24. Production was not changed.

## Fixes

- Both games synchronize their saved public player name with Scoreosis. Unnamed players remain private until named. Local-only scores are never uploaded later.
- Named leaderboard reads use authenticated `me=1`, bypassing shared caching so newly published results and names appear immediately. Public reads retain the 30-second cache.
- Session startup allows eight seconds for registration, name synchronization and run creation. Measured staging cold setup exceeded the previous two-second cutoff.
- Finish polling waits for publication before notifying the game. Server replay, checksums and timing enforcement remain unchanged.
- Debug/editor builds use staging, release scripts use production. Local stays in the browser profile/origin/device, or the native device. Global remains separated by runtime and combines Web providers; current builds use itch_io.

## Evidence

- Before testing, staging had zero accepted Sneak results. The earlier Local score of 2 was not accepted online and cannot be promoted without its verified replay.
- A genuine Sneak input replay as kitty finished at 2 and appeared at rank 1 on staging, both before and after deployment. The final replay used 161 ticks in three paced chunks. The server returned finished, score 2, published true. No score was inserted manually.
- Final startup timings: registration 1.437 seconds, name sync 1.344 seconds, run creation 1.328 seconds.
- Score-publication deployment: c3ba13f1-1b63-4756-bf6d-f65c796bc8d6. API: https://scoreosis-staging.walang.studio.
- Scoreosis: lint/typecheck passed; 125 API tests passed, four optional tests skipped; all Lua suites passed in LuaJIT and Lua 5.1; docs build passed. Node 24.16 and Python 3.12 used the installed pinned CI tools.
- Both games: simulation, online identity, browser name-form tests and native UI suites passed. Ah!Steroids Web and Windows debug bundles built and contain the staging URL.
- Ah!Steroids staging and production Web board reads returned HTTP 200 with empty entries at verification time. There is no minimum above 2.

## Game integration status

Sneak f1efe92 includes scrolling game bricks, a solid high-contrast selection and mouse hover; reduced motion freezes the backdrop. Its 305 native input/UI checks and Web/Windows debug builds passed. Ah!Steroids integration is committed as da6a696. Browser/desktop automation surfaces were unavailable; native geometry checks do not replace visual inspection on a device.

Preserve existing Sneak .gitignore and docs/GAME_DESIGN.md changes and both repositories' untracked media. SDK copies are generated with tools/sync-client.mjs; edit this repository first. No branches have been pushed.

Ah!Steroids documents a default Web preview on port 8097. A live staging read returned HTTP 200 without the required CORS header for that origin. The allowlist and regression now include 127.0.0.1:8097 and localhost:8097 in staging only. Production CORS is unchanged. The preview server launch was blocked by automatic approval review; built bundles remain available in the game dist directories.

## Shutdown checkpoint - 2026-10-25

The user requested a checkpoint within 10 minutes at approximately 09:41 Asia/Shanghai. Stop before 09:51 rather than leaving unsaved work.

Completed in this session:

- Sneak commit 56962a2: How to Play now says AVOID THE SNAKE AND SPIKES; the whole body is dangerous. Keyboard/gamepad pages use action/input columns. Touch has the existing D-pad and sword illustrations plus compact gesture instructions. Accessible menu text includes the bindings.
- Sneak: 306 native input/UI checks passed, including phone/desktop layout checks; Lua simulation and browser accessibility/name tests passed. Web and Windows debug bundles rebuilt. Preview remains http://127.0.0.1:8774/.
- Scoreosis commit 77fced7: positive-score filtering in the shared ranking query removes existing and future zero-score entries from public boards and personal ranks. Verified zero-run facts remain stored.
- Live staging reproduction showed ABC at score 0. After deployment, a fresh Web leaderboard request showed only the two existing kitty scores of 2, with no ABC/zero row. Staging version cb7ec41c-5480-4f94-963d-9062f46b8e15. Production unchanged.
- Updated the full-run tests to handle legitimate randomly seeded zero-score games as unranked. Latest API suite: 126 passed, 4 optional skips. Lint and typecheck passed.

Outstanding, explicitly requested by the user:

1. Clear both games' Local test history in the user's actual browser profile. Do not claim this is done. Computer Use previously stopped because it could not determine Chrome's URL. Native UI tests use isolated save files; those are not the user's browser Local data. Preserve unrelated settings, achievements and online credentials. The origin of older Local kitty/ABC rows remains unverified; YOU is a legacy fallback label added by us.
2. Use test-<number> for local automated test players. Existing fixtures still use KITTY; rename them and update assertions. Current local forms and Scoreosis public name validation reject hyphens, and Sneak's leaderboard formatter strips them. Resolve validation/display consistently before submitting such names; do not silently substitute spaces. Check font glyph coverage through tools/export_font.py, never edit generated fonts by hand. No new live runs were created this session.
3. The user dislikes the scrolling-brick backdrop. We proposed a dimmed real game board/attract screen, but only the controls recommendation was approved for implementation. Present a visual mockup before another background redesign.
4. Visually inspect the rebuilt keyboard/gamepad/touch screens on a real browser/device. Native geometry checks passed but visual approval is still outstanding.

Preserve Sneak's pre-existing .gitignore, docs/GAME_DESIGN.md and media changes. No pushes, production deployments or OS shutdown commands were issued.
