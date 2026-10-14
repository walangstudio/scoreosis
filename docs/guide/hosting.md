# Other hosting

Cloudflare Workers is the only supported host. Scoreosis is built on three Cloudflare services that its correctness depends on, not just its deployment:

| Service | What Scoreosis relies on |
| --- | --- |
| Durable Objects with SQLite storage | One single-threaded object per player. Sequence checks, one active run, timing and the atomic finalization transaction (BadgeTrip state, run result and outbox in one commit) all assume a single writer per player. |
| D1 | The leaderboard projection and the daily admission counter. |
| Rate-limit bindings, Cache API, cron triggers | Request throttles, the 30 s leaderboard cache, daily retention cleanup. |

Requests also read `request.cf.country` for country boards, which only Cloudflare's edge sets.

## Your options

**Cloudflare, free or paid plan.** The supported target. As of 0.1.0 it is tested in workerd through `wrangler dev` and the test suite; no staging deploy has been measured yet. See [Deploy to Cloudflare](cloudflare.md).

**`wrangler dev` on your own machine or server.** Runs the whole service locally, Durable Objects, D1 and rate limits included, with state on disk (`--persist-to <dir>`). Good for development, LAN play and testing a game before release. It is a development server: plain HTTP by default, no country data, and not built or tested for public traffic.

```sh
npx wrangler d1 migrations apply scoreosis-dev --local --persist-to ./state
npx wrangler dev --ip 0.0.0.0 --port 8787 --persist-to ./state
```

**[workerd](https://github.com/cloudflare/workerd), the open-source Workers runtime.** Its README lists self-hosting Workers applications as a use case. Scoreosis has not been run on it. You would have to provide your own replacements for D1, the rate-limit bindings, the Cache API and cron, plus TLS and the country header. workerd's README also says it is not a hardened sandbox; Scoreosis runs untrusted input through its Lua VM, so run it inside a VM or container boundary.

**Node, Deno, Bun, a VPS or another serverless platform.** Not supported. A port would replace the Durable Object with a store that guarantees one writer per player and transactional finalization (for example SQLite or Postgres with a per-player lock), D1 with an SQL database, and the rate limits and cache with your own. The verifier itself (`src/vm/`, a Wasm module) and the game rulesets are portable; the session logic in `src/session.ts` is the part to rewrite.

## What a game needs from any host

- HTTPS with a valid certificate. Native clients verify it.
- CORS for each browser origin that serves the game (`ALLOWED_ORIGINS`).
- Responses within about a second. Timing allows 1.5 s of input delay; a slow host rejects honest players as `timing`.
