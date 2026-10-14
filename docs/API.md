# Scoreosis API v1

JSON over HTTPS. Request bodies are JSON objects; responses are JSON. Private routes take `Authorization: Bearer <token>` from `POST /v1/guests`.

## Errors

Every failure has the same envelope and a stable `code`:

```json
{ "error": { "code": "timing_rejected", "message": "input arrived too late", "details": {} } }
```

| Code | Status | Meaning | Retry |
| --- | --- | --- | --- |
| `bad_request` | 400 | Malformed body, parameter or input runs. | No. Fix the request. |
| `payload_too_large` | 413 | Body over the route limit. | No. |
| `unauthorized` | 401 | Missing, malformed or wrong token. | No. Recreate the guest only if the token is lost. |
| `forbidden` | 403 | Administrator credential required. | No. |
| `not_found` / `unknown_game` | 404 | No such route, run or game. A run belongs to one player. | No. |
| `unsupported_build` | 422 | Build not registered for ranked play. | No. Play locally. |
| `ruleset_disabled` | 422 | Ranked play disabled for this build's ruleset. | No. Play locally. |
| `run_active` | 409 | The player already has an active run. | Finish or abandon it. |
| `run_not_active` | 409 | The run is paused, expired, rejected or finished. `details.reason` says why. | No. The run is local only. |
| `sequence_conflict` | 409 | Wrong `seq`/`from_tick`, or a different body for an accepted `seq`. | Resend the chunk the server expects. |
| `timing_rejected` | 422 | Input ahead of real time or older than the 1.5 s window. The run is rejected. | No. |
| `run_rejected` | 422 | The server refused the run. | No. |
| `rate_limited` | 429 | Too many requests. | After `Retry-After`. |
| `capacity` | 503 | Daily ranked capacity reached. | After `Retry-After`; play locally meanwhile. |
| `internal` | 500 | Server fault. | Same request, with backoff. |

Network failures and 5xx on `inputs` are retried with the identical body: the server returns the original acknowledgment for an accepted `seq`.

## Limits

| Limit | Value |
| --- | --- |
| Input request body | 16 KiB |
| Other JSON bodies | 2 KiB |
| Ticks per input chunk | 120 (60 expected) |
| Tick rate | 60 Hz |
| Timing window | 90 ticks (1.5 s) behind real time; 6 ticks + 0.1% (at most 60 ticks) ahead |
| Single pause | 15 min |
| Total paused time | 60 min |
| Session expiry | 24 h after start |
| Leaderboard | top 100, pages of 25 |
| Guest creation | 5 per minute per address |
| Run starts | 30 per minute per player |
| Any route but health | 300 per minute per address (IPv6 per /64) |

## Routes

### `GET /v1/health`

`{ "ok": true, "games": ["ahsteroids"] }`

### `GET /v1/games/:game`

Game name, boards, modes (empty for a game without them), runtime and channel values, and the public achievement catalog.

### `POST /v1/guests`

Body `{ "game_id": "ahsteroids", "build_id": "ahsteroids-web-itch-0.2.0" }`.

`201 { "player_id", "token", "display_name" }`. The token is shown once; store it in the game's save. A guest belongs to one game installation. Clearing app data loses it.

### `POST /v1/games/:game/runs`

Body `{ "build_id", "mode" }`. `mode` is required for a game with modes (one of its `modes`, such as an ebakuw8 stage) and refused otherwise. `201`:

```json
{
  "run_id": "…", "seed": 123456789, "ruleset": "96cf239671ce4856", "board": "classic",
  "tick_rate": 60, "chunk_max_ticks": 120, "window_ticks": 90,
  "server_time": 1760356800000, "expires_at": 1760443200000
}
```

Start the ranked simulation with `seed` (and `mode`) when this response arrives. Tick 0 is the baseline; a moded response also echoes `mode`.

### `POST /v1/games/:game/runs/:run/inputs`

```json
{ "seq": 0, "from_tick": 0, "inputs": "20:1,40:0", "checksum": 1234567 }
```

- `seq` starts at 0 and increases by one. At most one unacknowledged chunk.
- `from_tick` is the first tick in the chunk; it equals the previous chunk's end.
- `inputs` is `count:bits` runs, one button bitmask per tick, bits below `2^buttons`.
- `checksum` (optional, recommended) is `codec.checksum(codec.encode(game.save(sim)))` after the chunk's last tick.
- `elapsed_ms` (first chunk only, recommended, 0 to 86400000) is the client's wall time since it started ticking. The first chunk anchors the timing baseline, so a slow start response is not counted as lag. The anchor never precedes run creation and is at most 5 s after it.
- Send everything buffered as soon as the previous chunk is acknowledged and at least 60 ticks are waiting; a slow acknowledgment must not age the next chunk.
- After the terminal tick, send nothing further.

`200`:

```json
{ "run_id": "…", "status": "active", "seq": 0, "ticks_received": 60, "verified_tick": 60 }
```

`status` becomes `finished` (or `verifying` while it catches up) once the server reaches the terminal tick, and `rejected` with `reason` on desync or input after the end. `verified_tick` may lag `ticks_received`; the verifier catches up in later requests.

### `POST …/runs/:run/pause`

Body `{ "tick" }`, the last tick sent. Freeze the game, flush all input, then send this within 2 s of the last chunk (or of the last resume, if nothing was sent since; before the first chunk, within 7 s of the run start). The pause takes effect at that moment, so the flush and pause round trips count as paused time.

### `POST …/runs/:run/resume`

`200` with the acknowledgment, `server_time` and `expected_tick`. The pause removes only the paused time from the timing baseline; lag or lead from before it carries over. Resume ticking when the response arrives and catch up to `expected_tick`, which covers time lost to the pause round trips.

### `POST …/runs/:run/finish`

Body `{ "tick" }`, the terminal tick. Responses:

- `{ "status": "verifying", "verified_tick", "ticks_received", "retry_after_ms" }`: poll again.
- `{ "status": "finished", "score", "facts", "unlocked", "published" }`: verified. `published: false` means the leaderboard update is pending and will be retried.
- `{ "status": "rejected" | "expired", "reason" }`: local only.

Rejection reasons: `desync`, `not_terminal`, `input_after_end`, `timing`, `verifier_error`, `abandoned`. Expiry reasons: `connection_lost`, `pause_too_long`, `pause_total_exceeded`, `session_expired`.

### `POST …/runs/:run/abandon`

Ends the run as local only.

### `GET /v1/games/:game/leaderboards`

Query: `board` (default the newest), `mode` (moded games: each mode ranks separately; default the newest ruleset's first; refused for a game without modes), `country` (ISO 3166-1 alpha-2), `runtime` (`web`, `windows`, `android`, `ios`, `macos`, `linux`), `channel` (`itch_io`, `google_play`, `steam`, `direct`, `unknown`), `page` (0-3), `me=1` (needs the token).

```json
{
  "game": "ahsteroids", "board": "classic",
  "filters": { "country": null, "runtime": "android", "channel": null },
  "page": 0, "page_size": 25,
  "entries": [{ "rank": 1, "name": "Guest-4F2A10", "score": 18450 }],
  "me": { "rank": 37, "score": 9120 }
}
```

Each player appears once with their best score inside the filter. Games show their own platform by default (`runtime` = the build's); the client library fills it in. Equal scores share a rank; earlier acceptance lists first. Responses without `me` are cached publicly for 30 s. `me` is `null` when the player has no result in the filter.

### `GET /v1/games/:game/me/achievements`

Verified achievements with progress: `{ "achievements": [{ "id", "name", "description", "unlocked", "unlocked_at", "progress": { "current", "target", "percent" } }] }`.

### Administration

`Authorization: Bearer <ADMIN_TOKEN>`.

- `POST /v1/admin/games/:game/players/:player/hide` `{ "hidden": true }`
- `POST /v1/admin/games/:game/runs/:run/suppress`
- `POST /v1/admin/games/:game/rulesets/:ruleset/disable` (also suppresses that ruleset's results)

Suppressing a run or disabling a ruleset also applies to results published later, including runs still in progress. Moderation reaches cached leaderboard pages within 30 s.
