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

Two reference shapes:

- Ah!Steroids `game/ranked.lua`: the sim is its own table, input bits are held buttons.
- Sneak `script/ranked.lua`: inputs are discrete actions packed into the bits (`first + 10 * second`, `buttons = 7`). The controller instance is the sim. Ranked actions are queued and applied at tick boundaries; local actions apply immediately. The session adapter's `step` advances time (`script/online.lua`).

- ebakuw8 `modules/ranked.lua`: one run is one stage, so the module exports `modes` (stage ids) and `new(seed, mode)` builds that stage; each mode has its own leaderboard. Up to three 4-bit input codes per tick (`first + 16 * second + 256 * third`, `buttons = 12`). The controller is the sim; ranked play queues codes and applies them at the tick boundary (local play applies them at once), and `ranked.advance` steps without dropping the events the game presents.

When the sim lives on a reused table, `new` must clear every saved field first. Sneak desynced at tick 60 because a counter from the previous run survived on the controller but not in the verifier's fresh `{}`.

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

Copies `scoreosis/*.lua`, `cacert.pem`, and the `scoreosis_tls` native extension into the game. Regenerate the vendored files through this command. The packer checks shared simulation dependencies for stale copies.

Games must include `/scoreosis/cacert.pem` in `[project] custom_resources`. The bundle contains public GTS, ISRG, and SSL.com roots imported from the Defold SDK's Mozilla bundle. Refresh it with `python tools/import-ca.py <bob.jar>`, then sync the client again.

Defold 1.13.1's file loader allocates exactly the PEM size, but its TLS setter reads one extra byte. Certificate loading can fail and silently disable verification. The small `scoreosis_tls` extension passes a NUL-terminated Lua string to the checked engine setter instead. `scoreosis.defold` refuses native HTTPS requests if initialization fails or the extension is absent. Keep this shim while using the affected engine; remove it only after verifying an engine fix with repeated certificate rejection tests. Web builds use the browser's certificate verification.

The client requires HTTPS. Debug Defold builds may use HTTP on `127.0.0.1:<port>` or `localhost:<port>` for local development. Release builds reject plain HTTP before sending credentials.

Both reference games default to `itch_io` for Web, Windows, and Android. Builds keep runtime and provider separate. A game's Web board uses `runtime=web` with no channel filter, sharing one ranking across Web providers. An explicit `channel=itch_io` narrows it to itch scores without mixing runtimes.

`client:platform_best(callback)` reads the platform record. Without a saved name, it uses the public leaderboard and its 30-second cache. Pass the saved public name as the fifth argument to `client.new`; named clients synchronize it through `ensure_player` and use authenticated `me=1` reads that bypass shared caching. Reference games expose only Global/Local for the current runtime. An empty Global record shows NONE.

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
  "builds": [{ "id": "mygame-web-itch_io-1.0.0", "ruleset": "<ruleset>", "runtime": "web", "channel": "itch_io" }]
}
```

3. `node tools/pack-game.mjs <id>` writes `games/<id>/rulesets/<ruleset>.json` and regenerates `games/rulesets.generated.ts`. Override the source path with `SCOREOSIS_SRC_<ID>`.
4. Check parity: `node tools/trace.mjs <bundle> <seed> 900 > a.txt` and `python tools/trace.py <bundle> <seed> 900 luajit > b.txt`, then compare.
5. Deploy. Builds register on deploy; there is no runtime upload of verifier code.

Build ids must be `<game>-<runtime>-<channel>-<version>`, matching the build's `runtime` and `channel`; the registry refuses anything else. The client library reads the leaderboard platform from the id.

A ruleset is the hash of every packed module. Any change makes a new ruleset. Put it on the same board when the change keeps scores comparable, or on a new board to start fresh.

## 5. Client flow

1. Load the guest token from the save; if absent, `POST /v1/guests`.
2. `POST /runs` with the build id. On error, play locally and show "Local only".
3. `M.new(seed)`, then step at 60 Hz with a fixed-step accumulator on wall-clock time.
4. Every 60 ticks send `inputs` with the checksum. Keep one request in flight; batch up to 120 ticks while waiting.
5. Pause: freeze, flush the partial chunk, `POST pause`. Resume: `POST resume`, then continue from the response.
6. At the terminal tick, flush and `POST finish` until it leaves `verifying` and `published` is not false.
7. Any rejection or expiry: keep playing locally, label the run Local only, never resubmit it.
8. Names: a guest has no public name and stays off every board until it picks one. After the first verified score or a new personal best, if `client:profile` returns no `display_name`, ask for one after the run ends (never mid-run) with submit and cancel; `client:set_name(name, cb)` saves it. Cancelling keeps the result stored and private. Offer the same entry later from a profile or settings screen. Never show a generated Guest name. Show the rule (2-16 letters, digits, spaces, hyphens) and that names are public.
9. Leaderboards never mix platforms. `client:leaderboard` defaults `runtime` to the build's own. Games show only that platform: no device or store filter. Show GLOBAL and LOCAL; country views and achievements are hidden in the reference games.

## 6. Modes

A game with levels or tracks exports `M.modes`, an ordered list of ids. The run start body must name one; results and bests key the board as `<board>/<mode>`, and `?mode=` picks the leaderboard. `session.new(client, game, now, mode)` sends it and passes it to `game.new(seed, mode)`. A game may also keep animating its sim after the terminal tick (an outro): the session checksums the finishing state.

## Automatic play

`scoreosis.autoplay.start(session, timer, callback)` attempts a session and calls back with the active session, or nil when startup fails or exceeds eight seconds. It returns a cancellation function for leaving the pending screen. Failed, timed-out, and cancelled starts are abandoned; late replies cannot replace local play. Both games use this path for Play and Retry, keeping validation states out of their visible UI. Local results are never promoted to Global. Overlapping starts share a pending credential registration; retrying does not create a competing installation identity.
