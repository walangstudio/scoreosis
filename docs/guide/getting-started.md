# Getting started

Run Scoreosis on your machine, create a guest and read a leaderboard. Everything runs locally through `wrangler dev`; no Cloudflare account is needed.

## Requirements

- Node 24 and pnpm 11.
- Python 3.10+ with `lupa` (`pip install lupa`) for the Lua tests and parity checks. Optional for running the server.
- zig 0.16.0 (`pip install ziglang==0.16.0`), only to rebuild the Lua VM after editing `vm/sv.c`.

## Run it

```sh
git clone https://github.com/walangstudio/scoreosis
cd scoreosis
CI=true pnpm install
npx wrangler d1 migrations apply scoreosis-dev --local
echo "ADMIN_TOKEN=$(openssl rand -hex 32)" > .dev.vars
npx wrangler dev --port 8787
```

`CI=true` stops pnpm 11 from asking for a terminal. `.dev.vars` holds local secrets and is ignored by git.

Check it:

```sh
curl http://127.0.0.1:8787/v1/health
# {"ok":true,"games":["ahsteroids","ebakuw8","sneak"]}

curl -X POST http://127.0.0.1:8787/v1/guests \
  -H 'content-type: application/json' \
  -d '{"game_id":"sneak","build_id":"sneak-web-direct-0.2.0"}'
# {"player_id":"…","token":"…","display_name":"Guest-…"}

curl 'http://127.0.0.1:8787/v1/games/sneak/leaderboards?runtime=web'
```

A browser game served from another origin needs that origin in `ALLOWED_ORIGINS`:

```sh
npx wrangler dev --port 8787 --var "ALLOWED_ORIGINS:http://127.0.0.1:8774"
```

## Point a game at it

Games read the server URL from their own settings. The Defold games use a `[scoreosis]` section in `game.project` or a settings override:

```ini
[scoreosis]
url = http://127.0.0.1:8787
channel = direct
```

The build id the game sends must be registered in `games/<id>/game.json`. Ranked play against a local server then works end to end: the game uploads inputs every second, the server replays them, and verified scores appear on the board.

## Run the tests

```sh
pnpm typecheck
pnpm lint
pnpm test                  # vitest inside workerd
python tools/test-lua.py   # the Lua client library under LuaJIT and Lua 5.1
```

## Next

- [Deploy to Cloudflare](cloudflare.md)
- [Configuration](configuration.md): every setting and binding.
- [Adding a game](../INTEGRATION.md): the ranked contract a game implements.
