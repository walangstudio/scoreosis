# Scoreosis

[![release](https://img.shields.io/github/v/release/walangstudio/scoreosis?include_prereleases&sort=semver)](https://github.com/walangstudio/scoreosis/releases)
[![license](https://img.shields.io/github/license/walangstudio/scoreosis)](LICENSE)
![typescript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
[![CI](https://github.com/walangstudio/scoreosis/actions/workflows/ci.yml/badge.svg)](https://github.com/walangstudio/scoreosis/actions/workflows/ci.yml)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)

Verified leaderboards and achievements for games, on Cloudflare Workers' free plan.

Clients upload button inputs, not scores. The server replays them through the game's own Lua simulation, in a sandboxed Lua 5.1 Wasm VM, and ranks only what it verified. Achievements run on [BadgeTrip](https://github.com/walangstudio/badgetrip).

> **Status:** early (0.x). Deployed on Cloudflare Workers; not yet measured under real load. Changes are listed in the [CHANGELOG](CHANGELOG.md).

## Why

A leaderboard that accepts a score from the client is a leaderboard of whoever edited the request. Scoreosis never accepts one. The game and the server run the same deterministic simulation; the client streams its inputs every second with a checksum, and the server replays them in real time.

- **Fabricated scores, modified clients, speed hacks, slow motion, rewritten history** are rejected. [Security](docs/SECURITY.md) lists each control and its test.
- **Bots that play legal inputs in real time** are not detected. Nothing on the server can tell them from people.

## Features

- **Global and country leaderboards per platform.** Web, Windows, Android and the rest rank separately; the API also filters by store. Each player appears once with their best run.
- **Modes.** A game with stages or tracks gets one board per mode.
- **Achievements, local and verified.** Verified progress runs on the BadgeTrip engine, committed in one transaction with the run result. Games track local progress with the same rules and show both.
- **Guest identity** per game installation. No accounts, no personal data.
- **Server-approved pauses** that cannot be used to slow the game down.
- **Free plan first.** Admission control stops new ranked runs before the daily quota runs out; games fall back to local play.
- **Lua client library** for the game side: HTTP client, ranked session, local progress, Defold bindings.

Games: Ah!Steroids, Sneak, ebakuw8.

## Quick start

```sh
CI=true pnpm install
npx wrangler d1 migrations apply scoreosis-dev --local
npx wrangler dev --port 8787
curl http://127.0.0.1:8787/v1/health
```

[Getting started](docs/guide/getting-started.md) walks through a guest, a leaderboard and pointing a game at it.

## Deploy

```sh
npx wrangler d1 create scoreosis-production   # put the id in wrangler.jsonc
npx wrangler d1 migrations apply scoreosis-production --remote --env production
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN --env production
pnpm deploy:production
```

[Deploy to Cloudflare](docs/guide/cloudflare.md) covers staging, origins, custom domains and updates. [Other hosting](docs/guide/hosting.md) explains what ties Scoreosis to Cloudflare and what running it elsewhere takes.

## How it works

1. The game creates a guest and starts a ranked run. The server returns a seed.
2. The game steps its simulation at 60 Hz and sends each second of button inputs with a state checksum.
3. The player's Durable Object checks timing and sequence, stores the inputs and replays them in the verifier.
4. A checksum mismatch rejects the run. At the terminal tick, one transaction records the result, the BadgeTrip achievements and an outbox row.
5. The outbox publishes the result to D1, where leaderboards read it.

[Architecture](docs/ARCHITECTURE.md) has the details, the determinism rules and the cost per second of play.

## Documentation

The docs are published at [walangstudio.github.io/scoreosis](https://walangstudio.github.io/scoreosis/). The same files live in [`docs/`](docs).

| Doc | Covers |
|---|---|
| [Getting started](docs/guide/getting-started.md) | Run it locally, create a guest, point a game at it |
| [Deploy to Cloudflare](docs/guide/cloudflare.md) | Staging and production, secrets, origins, custom domain |
| [Configuration](docs/guide/configuration.md) | Variables, secrets, bindings, fixed limits, game registration |
| [Other hosting](docs/guide/hosting.md) | What depends on Cloudflare and the alternatives |
| [Adding a game](docs/INTEGRATION.md) | The ranked contract, determinism rules, packing, client flow |
| [API](docs/API.md) | Routes, schemas, limits, errors |
| [Architecture](docs/ARCHITECTURE.md) | Components, verification, determinism, cost |
| [Security](docs/SECURITY.md) | Controls and known limits |
| [Operations](docs/OPERATIONS.md) | Capacity, moderation, retention |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |

## Development

Requires Node 24, pnpm 11, and Python 3.10+ with `lupa` for the Lua tests.

```sh
CI=true pnpm install
pnpm typecheck
pnpm lint
pnpm test                  # vitest inside workerd
python tools/test-lua.py   # Lua client library under LuaJIT and Lua 5.1
pnpm docs:dev              # the docs site at localhost:5173/scoreosis/
```

Rebuild the VM after editing `vm/sv.c` (needs `python -m pip install ziglang==0.16.0`):

```sh
pnpm build:vm
```

Repack a game after its ranked modules change:

```sh
node tools/pack-game.mjs sneak
```

### Releasing

Bump `version` in `package.json`, add a dated `## [x.y.z]` entry to the [CHANGELOG](CHANGELOG.md), merge to `main`, then tag:

```sh
git tag -a vX.Y.Z -m vX.Y.Z
git push origin vX.Y.Z
```

The [release workflow](.github/workflows/release.yml) checks the tag against `package.json` and the changelog, runs the full gate, and creates the GitHub release from the changelog entry. The [deploy workflow](.github/workflows/deploy.yml) ships every push to `main` to staging and every tag to production once Cloudflare credentials are set ([how](docs/guide/cloudflare.md#deploy-from-github-actions)).

## License

[MIT](LICENSE). Copyright walangstudio.
