# CLAUDE.md

Scoreosis: verified multi-game leaderboards and achievements. Cloudflare Workers + Durable Objects (SQLite) + D1, TypeScript 5.9, Lua 5.1 compiled to Wasm.

- `src/` - Worker (`index.ts`), `PlayerSession` Durable Object (`session.ts`), D1 leaderboards, BadgeTrip SQLite stores
- `src/vm/` - Wasm host, server driver (`driver.lua`), built `lua51.wasm`
- `vm/sv.c` - C glue for the sandboxed Lua state; `tools/build-vm.mjs` builds it with zig 0.16.0
- `scoreosis/` - Lua library shared with games (`detmath`, `codec`); games vendor it via `tools/sync-client.mjs`
- `games/<id>/` - `game.json` (builds, boards) and packed `rulesets/*.json`
- `migrations/` - D1 schema
- `test/` - vitest in workerd via `@cloudflare/vitest-plugin`

## The loop

```bash
npx tsc --noEmit
npx biome check .
CI=true npx vitest run
```

Parity check after touching `scoreosis/`, `driver.lua`, `vm/sv.c` or a game's ranked modules:

```bash
node tools/trace.mjs games/ahsteroids/rulesets/<r>.json 12345 900 > a.txt
python tools/trace.py games/ahsteroids/rulesets/<r>.json 12345 900 luajit | tr -d '\r' > b.txt
cmp a.txt b.txt
```

- Write the failing test first. Watch it fail for the right reason.
- Never hand-edit `games/*/rulesets/*.json`, `games/rulesets.generated.ts`, `src/vm/lua51.wasm` or `worker-configuration.d.ts`. Regenerate: `node tools/pack-game.mjs <id>`, `pnpm build:vm`, `npx wrangler types`.

## Architecture

Read docs/ARCHITECTURE.md first. Request path: Worker validates and routes -> player's Durable Object (`<game>:<player>`) checks the token hash, timing and sequence -> stores input -> advances the VM within `VERIFY_INSTRUCTIONS` -> on the terminal tick, one `ctx.storage.transaction` for BadgeTrip + run + outbox -> outbox publishes to D1.

- The server never accepts a score. Facts come from `sv_facts` of the server's own replay.
- Ranked Lua must be bit-deterministic: no platform math, no `math.random`, no `pairs`-order dependence. The packer and the VM both enforce it.
- A Lua error makes the VM unusable (`VmError`); drop it and reload from the checkpoint.
- Durable Object `Date.now()` is frozen during a request; tests drive time with `useClock()` (fake timers reach the objects in the same isolate).

| You need | Look in |
| --- | --- |
| Routes, auth parsing, CORS, admission | `src/index.ts` |
| Timing, pause, verify, finalize, outbox | `src/session.ts` |
| Error codes | `src/errors.ts`, docs/API.md |
| Achievement mapping | `src/achievements.ts` |
| Env vars and bindings | `wrangler.jsonc` |
| Game contract | docs/INTEGRATION.md |

## Failure log

- Insert detection on Durable Object SQLite uses `RETURNING`, never `cursor.rowsWritten`; it reported a duplicate `ON CONFLICT DO NOTHING` insert into the AUTOINCREMENT table as written.
- Re-read the run row after `expireIfStale`; handlers that kept the old row accepted input on expired runs.
- Storage from `runInDurableObject` cannot be used after the callback returns; route each call through `runInDurableObject` (see `test/store-contract.test.ts`).
- Public leaderboard responses are cached 30 s; tests that change rankings must query a filter combination not fetched before.
- Python on Windows prints CRLF; strip `\r` before comparing `trace.py` output with `trace.mjs`.
- Edit regex-bearing `tools/*.mjs` with the Edit tool; a Bash heredoc dropped backslashes from a regex in `pack-game.mjs`.
- Spend capacity (limiter, admission, D1) only after the credential check in the player's object; doing it in the Worker let forged tokens drain the daily quota.
- Resume shifts the timing baseline by the paused time only; resetting it to "now" let pause cycles forgive slow motion and bank lead.
- Keep every Lua VM call inside the verifier's try block; a corrupt checkpoint thrown from `load()` turned every request into a 500.
- Keep `useClock()`'s fake start far from the real date; workerd fires alarms on real time, and a near-now fake clock made alarm tests flaky.
- Give long loop tests an explicit timeout; a timed-out loop keeps advancing the shared fake clock and breaks the tests after it.
- Measure lag from the Worker's arrival time and anchor the baseline at the first chunk; local wrangler dev takes seconds per request and exposed every place server latency counted as player lag.
- Before packing a game whose sim lives on a reused table (Sneak's controller), check `new` on a used table matches `new` on `{}`; Sneak desynced at tick 60 from a leftover `next_obstacle_id`.
- Test browser timing with a delayed first chunk; a CORS preflight delays only the first POST to a run URL, and a 6-tick ahead slack rejected the next on-time chunk.
- Size the VM's Wasm stack and initial memory explicitly in `tools/build-vm.mjs`; zig's 16 MiB default stack made every loaded verifier 17 MiB.
