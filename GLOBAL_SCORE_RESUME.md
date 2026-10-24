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
