# Operations

Staging and production are separate Workers, D1 databases, Durable Object namespaces and secrets (`env.staging`, `env.production` in `wrangler.jsonc`). Everything fits the Workers Free plan; nothing here upgrades billing.

## First deployment

```bash
npx wrangler login
npx wrangler d1 create scoreosis-staging          # put the id in wrangler.jsonc env.staging
npx wrangler d1 create scoreosis-production       # and env.production
npx wrangler d1 migrations apply scoreosis-staging --remote --env staging
npx wrangler secret put ADMIN_TOKEN --env staging  # 32+ random characters
npm run deploy:staging
curl https://scoreosis-staging.<account>.workers.dev/v1/health
```

Repeat with `production`. The leaderboard cache uses the Cache API, which only works on a custom domain; on `*.workers.dev` every board request reads D1.

## Before raising limits

For the arcade-entry rollout, apply migration `0003_arcade_entries.sql` before deploying the Worker, then ship the game clients. The migration freezes the current names on existing personal-best records; it does not rename them or republish historical non-best runs. Previously overwritten names cannot be reconstructed. New clients require the server's `arcade: true` acknowledgment and play locally if the server has not been upgraded.

Run a staging soak with a real client and read Workers Observability:

- CPU per `inputs` request and per alarm (`VERIFY_INSTRUCTIONS` caps verifier work; ~116k instructions per ms).
- Durable Object requests, rows written and stored bytes per player-minute.
- `run_rejected` reasons, `desync`, `verifier_error`, `publish_retry`, `capacity_reached` events.
- D1 rows read per `me=1` leaderboard request. Those reads skip the cache and scan every named positive result in the filter, so their cost grows with stored results.

Set `MAX_RUNS_PER_DAY` from the measured rows written per run, leaving room for other projects on the account. `MAX_RUNS_PER_ADDRESS` caps one network address's share; `address_limit_reached` events show addresses hitting it.

## Schema changes

1. `npx wrangler d1 export scoreosis-production --remote --output backup.sql` and check the file opens.
2. Add a numbered file under `migrations/`; never edit an applied one.
3. Apply to staging, run the suite against staging, then production.

Durable Object SQLite tables are created with `CREATE TABLE IF NOT EXISTS` when a player registers, and checked again each time an object loads. Additive changes only: a new column on an existing table also goes in `ADDED_COLUMNS` in `src/session.ts`, which adds it to older objects.

## Adding a build or ruleset

See [INTEGRATION.md](INTEGRATION.md). Pack from a committed game tree (the packer refuses dirty modules unless `--allow-dirty`), add the build to `game.json`, run the tests, deploy.

## Moderation

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"hidden":true}' https://<host>/v1/admin/games/<game>/players/<player>/hide
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/v1/admin/games/<game>/runs/<run>/suppress
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/v1/admin/games/<game>/rulesets/<ruleset>/disable
```

## Retention

| Data | Kept | Where |
| --- | --- | --- |
| Raw input traces | 7 days after the run ends | Player object, deleted by its alarm |
| Checkpoints | Until the run ends | Player object |
| Accepted results | 90 days, longer while a personal best references them or they rank in the top 100 of their game/board/country/runtime/provider tuple | D1, pruned by the daily cron in batches of 500 |
| Personal bests, achievements, BadgeTrip events | Indefinitely | D1 / player object |
| Run summaries | Indefinitely | Player object |
