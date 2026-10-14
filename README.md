# Scoreosis

Verified leaderboards and achievements for walangstudio games, on Cloudflare Workers' free plan.

Clients upload button inputs, not scores. The server replays them through the game's own Lua simulation, compiled into a sandboxed Lua 5.1 Wasm VM, and ranks only what it verified. Achievements run on [BadgeTrip](https://github.com/walangstudio/badgetrip).

- Global and country leaderboards per platform; the API also filters by store.
- Guest identity per game installation.
- Server-approved pauses.
- Local and verified achievement progress, kept apart.

Games: Ah!Steroids, Sneak, ebakuw8 (one leaderboard per stage).

## Develop

Node 24, pnpm 11, Python 3.10+ with `lupa` for parity checks.

```bash
CI=true pnpm install
pnpm typecheck
pnpm lint
pnpm test
```

Rebuild the VM after editing `vm/sv.c` (needs `python -m pip install ziglang==0.16.0`):

```bash
pnpm build:vm
```

Repack a game after its ranked modules change:

```bash
node tools/pack-game.mjs ahsteroids
```

## Docs

- [Architecture](docs/ARCHITECTURE.md): components, verification, determinism, cost.
- [API](docs/API.md): routes, schemas, limits, errors.
- [Adding a game](docs/INTEGRATION.md): the ranked contract.
- [Security](docs/SECURITY.md): controls and known limits.
- [Operations](docs/OPERATIONS.md): deploy, capacity, moderation, retention.

## License

MIT. Copyright walangstudio.
