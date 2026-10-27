# Configuration

Server settings live in `wrangler.jsonc`, per environment. Games and builds live in `games/<id>/game.json`. Nothing is configured at runtime: change a file, run the tests, deploy.

## Variables

Set in `vars` (top level for local dev, `env.staging.vars` and `env.production.vars` for deploys). Values are strings.

| Variable | Default | What it does |
| --- | --- | --- |
| `VERIFY_INSTRUCTIONS` | `1000000` | Lua instructions the verifier may spend per request, about 9 ms of CPU. Unverified input queues and drains in later requests and alarms. Must be an integer of at least 10000. Raise it only after measuring CPU in staging. |
| `MAX_RUNS_PER_DAY` | `750` (staging `500`) | New ranked runs admitted per UTC day across all games. Runs in progress always continue. Set it from measured rows written per run and the share of the account's free quota you can spend. `0` pauses ranked play (`capacity`). A missing or malformed value fails every ranked start with 500 `internal`. |
| `MAX_RUNS_PER_ADDRESS` | `75` (staging `50`) | Share of `MAX_RUNS_PER_DAY` one network address (IPv4 address or IPv6 /64) may start per UTC day, whatever the number of guests. Stored as a keyed hash (`ADDRESS_KEY`), pruned after a day. Raise it if many legitimate players share one address. Requests without a `cf-connecting-ip` header (a self-hosted `wrangler dev` reached directly) all share one address, and off Cloudflare a client can set that header itself. At least `1`; a missing or malformed value fails every ranked start with 500 `internal`. |
| `ALLOWED_ORIGINS` | empty | Comma-separated browser origins allowed to call the API. Empty allows none; native clients send no origin. |

## Secrets

| Secret | What it does |
| --- | --- |
| `ADMIN_TOKEN` | Bearer token for `/v1/admin/*`. At least 32 characters; admin routes are disabled without it. Set with `wrangler secret put ADMIN_TOKEN --env <env>`; locally in `.dev.vars`. |
| `ADDRESS_KEY` | HMAC key for the per-address run share; the stored address is HMAC-SHA256 of the UTC day and the address. At least 32 characters. Ranked run starts fail while it is missing. Set with `wrangler secret put ADDRESS_KEY --env <env>`; locally in `.dev.vars`. |

## Bindings

The names are fixed; the code reads them.

| Binding | Kind | Purpose |
| --- | --- | --- |
| `PLAYERS` | Durable Object, class `PlayerSession`, SQLite storage | One object per game and player: credential, runs, verifier, achievements, publication outbox. |
| `DB` | D1 | Players, accepted results, personal bests, disabled rulesets, daily admissions. |
| `IP_LIMITER` | Rate limit, 300 per 60 s | Every route, per client address (IPv6 per /64). |
| `GUEST_LIMITER` | Rate limit, 5 per 60 s | Guest creation, per address. |
| `API_LIMITER` | Rate limit, 30 per 60 s | Run starts, per player, after the credential check. |

Each environment's rate limits need their own `namespace_id`, an integer unique in your account. Change `limit` and `period` to tune them; the period must be 10 or 60 seconds.

## Cron

`triggers.crons` runs the daily cleanup (`17 3 * * *`, UTC): it prunes accepted results older than 90 days, 500 at a time, retaining personal bests and the top 100 named entries per game/board/country/runtime/provider tuple. [Operations](../OPERATIONS.md#retention) lists everything kept and for how long.

## Fixed limits

These are constants in `src/session.ts` and `src/index.ts`, not settings. Changing them changes what counts as legal play, so they are part of the anti-cheat contract.

| Limit | Value |
| --- | --- |
| Tick rate | 60 Hz |
| Ticks per input chunk | 120 max, 60 expected |
| Late input window | 90 ticks (1.5 s) |
| Input ahead of real time | 6 ticks + 0.1%, at most 60 |
| Pause | 15 min each, 60 min per run |
| Run lifetime | 24 h |
| Leaderboard page | 25 rows, pages 0-3 |
| Leaderboard cache | 30 s |
| Raw input retention | 7 days after the run ends |

## Games and builds

`games/<id>/game.json` registers a game:

```json
{
  "id": "sneak",
  "name": "Sneak",
  "source": "Y:/projs/walangstudio/sneak",
  "entry": "script.ranked",
  "boards": { "classic": ["7411b66ea8266106"] },
  "builds": [
    { "id": "sneak-web-direct-0.2.0", "ruleset": "7411b66ea8266106", "runtime": "web", "channel": "direct" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Lowercase letters, digits and `_`, up to 32. |
| `source` | Path to the game checkout the packer reads. Override with `SCOREOSIS_SRC_<ID>`. |
| `entry` | The ranked module, as `require` names it. |
| `boards` | Board name to the rulesets ranked on it. Rulesets with comparable scores share a board; a new board starts fresh. |
| `builds[].id` | `<game>-<runtime>-<channel>-<version>`. The registry refuses any other shape. |
| `builds[].runtime` | `web`, `windows`, `android`, `ios`, `macos`, `linux`. Leaderboards rank each runtime separately. |
| `builds[].channel` | `itch_io`, `google_play`, `steam`, `direct`, `unknown`. |

Rulesets are packed with `node tools/pack-game.mjs <id>`, which writes `games/<id>/rulesets/<ruleset>.json` and regenerates `games/rulesets.generated.ts`. Never edit either by hand. See [Adding a game](../INTEGRATION.md).

## Game client settings

The Lua client library takes the server URL and build id from the game. The Defold games read them from `game.project` (or a `--settings` override at build time):

```ini
[scoreosis]
url = https://scores.example.com
channel = direct
```

An empty `url` turns ranked play off; the game plays locally. The build id is assembled from the game id, the platform, `channel` and `project.version`, and must match a registered build.
