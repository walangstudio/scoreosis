# Architecture

Scoreosis accepts a score only after replaying the run's inputs through the game's own simulation on the server. Clients send button inputs, never scores.

## Components

| Component | Owns |
| --- | --- |
| Worker (`src/index.ts`) | Routing, token parsing, request validation, CORS, edge throttles, admission, public leaderboard queries and their 30 s cache. |
| `PlayerSession` Durable Object (`src/session.ts`), one per game and player | Credential hash, ranked runs, input log, verifier VM, checkpoints, timing and pause rules, BadgeTrip state, publication outbox. |
| Verifier VM (`vm/sv.c`, `src/vm/`) | Lua 5.1.5 compiled to Wasm with no I/O, OS, loader or platform math. Instruction and memory caps. |
| Game rulesets (`games/<id>/rulesets/*.json`) | The game's ranked Lua modules, packed and hashed from the game repository. |
| D1 (`migrations/`) | Players, accepted results, personal bests, disabled rulesets, daily admissions. A projection; never the source of truth. |
| BadgeTrip core | Achievement rules, progress, event deduplication. Scoreosis supplies SQLite stores (`src/badgetrip-sqlite.ts`). |
| Lua client library (`scoreosis/`) | Shared with games: `detmath`, `codec`. Vendored into each game by `tools/sync-client.mjs`. |

## A ranked run

1. `POST /runs`: the Worker checks the build, the disabled-ruleset list and daily capacity, then the player's object creates the run with a server seed and timing baseline.
2. The client starts the ranked simulation with that seed and steps it at 60 Hz. Every second it sends the ticks' button bitmasks and its state checksum.
3. The object checks sequence, continuity and timing, stores the chunk, then advances the verifier within a per-request instruction budget (`VERIFY_INSTRUCTIONS`). Unverified input stays queued; later requests and alarms drain it.
4. The verifier's checksum must match the client's. A mismatch means the client played a different game: the run is rejected as `desync`.
5. When the server's simulation reaches its terminal state, one storage transaction records the BadgeTrip event, achievements, the run result and an outbox row. Any failure rolls all of it back.
6. After commit, the outbox publishes to D1 in one batch: insert the result (idempotent by run id) and raise the personal best only if higher. Failures retry from the object's alarm with backoff.

## Determinism

The client and server execute identical Lua. Two rules make that bit exact:

- Ranked modules use only IEEE-exact arithmetic. `scoreosis/detmath.lua` provides `sin`, `cos`, `atan`, `atan2` from `+ - * /` and `floor`. The packer rejects `math.sin` and friends, `math.random`, `^`, and host libraries; the server VM removes them, so a miss fails loudly.
- State is serialized by `scoreosis/codec.lua`: numbers round-trip exactly through `frexp`, table keys are sorted.

`tools/trace.mjs` (Wasm) and `tools/trace.py` (LuaJIT and PUC Lua 5.1 via lupa) print per-second checksums for the same inputs. Ah!Steroids matched bit for bit on 21 runs (15 random-input seeds, 6 steady-turn seeds) on Windows x64. Native ARM64 Android, iOS and Defold HTML5 still need the same comparison on devices.

## Verifier cost

Measured in Node (V8, same engine as Workers) on Windows x64:

| Case | CPU per second of play | Lua instructions |
| --- | --- | --- |
| Ah!Steroids, opening minute | ~3 ms | ~350k |
| Ah!Steroids worst case: 52 asteroids, 62 bullets | ~64 ms | ~7.5M |

About 116k Lua instructions per millisecond. Checkpoints are 6-35 KiB, written every 10 s of play. The per-request budget caps work so a request stays inside the Durable Object CPU limit; on the free plan that limit is not documented separately from Workers' 10 ms, so the default budget is 1M instructions (~9 ms). Measure in staging before raising it.

## Free plan budget

One second of ranked play costs one Worker request, one Durable Object request and about 1.1 SQLite rows written. With the documented free allowances (100k Worker requests, 100k Durable Object requests, 100k rows written per day, account-wide), Scoreosis alone supports roughly 25 player-hours of ranked play per day. `MAX_RUNS_PER_DAY` stops new runs before that; running sessions continue. It counts runs, not seconds, so set it from the measured average run length: 25 player-hours at a 2-minute average is about 750 runs. Raising capacity needs fewer requests per second of play (a longer chunk interval with a wider window, or WebSocket transport, which Cloudflare bills at 20 messages per request) or a paid plan.

## Trust limits

The verifier rejects fabricated scores, impossible inputs, altered rules or seeds, speed and slow-motion manipulation, rewritten history and duplicate rewards. It cannot tell a bot that produces legal inputs from a person, cannot see assistance during pauses, and cannot prove which build or platform sent the run: build ids and platform labels are claims, and a public build can be impersonated. Country comes from Cloudflare's request metadata at run start; a VPN changes it.
