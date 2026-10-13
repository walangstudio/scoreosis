# Adding a game

A game joins Scoreosis by exposing one Lua module, the ranked contract, that both the game and the server run.

## 1. Ranked contract v1

```lua
local M = {}
M.contract = 1
M.buttons = 4                 -- input bits per tick, 1..16
M.achievements = {            -- optional; ids are stable forever
	{ id = "score_5000", fact = "score", mode = "run", gte = 5000,
	  name = "Five Grand", description = "Score at least 5,000 in one run." },
	{ id = "kills_100", fact = "kills", mode = "total", gte = 100,
	  name = "Rock Breaker", description = "Earn 100 credited kills." },
}
function M.new(seed) end      -- server-issued seed -> sim
function M.step(sim, bits) end-- one 1/60 s tick with a button bitmask
function M.finished(sim) end  -- true at the terminal tick
function M.facts(sim) end     -- flat table of integers; must include score
function M.save(sim) end      -- plain data: numbers, strings, booleans, tables
function M.load(data) end     -- inverse of save
return M
```

- `mode = "run"`: the best single-run value reaches `gte`. `mode = "total"`: the sum over verified runs reaches `gte`.
- Facts are integers. Count ticks, not seconds.
- `step` must be the only way time passes. Menus, tutorials and pauses live outside the module.
- Input bits describe intents (left, right, fire), already normalized from keyboard, pad or touch.

Ah!Steroids' `game/ranked.lua` is the reference.

## 2. Determinism rules

The packer enforces these; the server VM removes the forbidden functions.

- No `math.sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `exp`, `log`, `pow`, no `^`. Use `scoreosis.detmath`.
- No `math.random`. Seed your own generator from `M.new(seed)`, with a separate stream for anything cosmetic.
- No `os`, `io`, `debug`, `package`, `loadstring`, `setfenv`.
- Only literal `require "name"`.
- Never let behavior depend on `pairs` order. Use arrays and `ipairs`.
- No engine calls: no `go`, `gui`, `vmath`, `hash`, `sound`. Rendering reads the sim; the sim never reads the screen. Fix arena size in ranked mode.

## 3. Vendor the client library

```bash
node tools/sync-client.mjs <game-checkout>
```

Copies `scoreosis/*.lua` into the game. The packer refuses a stale copy.

## 4. Pack and register

1. Commit the ranked modules in the game repository.
2. Add `games/<id>/game.json`:

```json
{
  "id": "mygame",
  "name": "My Game",
  "source": "Y:/projs/walangstudio/mygame",
  "entry": "game.ranked",
  "boards": { "classic": ["<ruleset>"] },
  "builds": [{ "id": "mygame-web-itch-1.0.0", "ruleset": "<ruleset>", "runtime": "web", "channel": "itch_io" }]
}
```

3. `node tools/pack-game.mjs <id>` writes `games/<id>/rulesets/<ruleset>.json` and regenerates `games/rulesets.generated.ts`. Override the source path with `SCOREOSIS_SRC_<ID>`.
4. Check parity: `node tools/trace.mjs <bundle> <seed> 900 > a.txt` and `python tools/trace.py <bundle> <seed> 900 luajit > b.txt`, then compare.
5. Deploy. Builds register on deploy; there is no runtime upload of verifier code.

A ruleset is the hash of every packed module. Any change makes a new ruleset. Put it on the same board when the change keeps scores comparable, or on a new board to start fresh.

## 5. Client flow

1. Load the guest token from the save; if absent, `POST /v1/guests`.
2. `POST /runs` with the build id. On error, play locally and show "Local only".
3. `M.new(seed)`, then step at 60 Hz with a fixed-step accumulator on wall-clock time.
4. Every 60 ticks send `inputs` with the checksum. Keep one request in flight; batch up to 120 ticks while waiting.
5. Pause: freeze, flush the partial chunk, `POST pause`. Resume: `POST resume`, then continue from the response.
6. At the terminal tick, flush and `POST finish` until it leaves `verifying`.
7. Any rejection or expiry: keep playing locally, label the run Local only, never resubmit it.
