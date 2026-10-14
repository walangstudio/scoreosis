# Deploy to Cloudflare

Scoreosis is a Cloudflare Worker with one Durable Object class and one D1 database. It fits the Workers Free plan; nothing here needs a paid plan.

`wrangler.jsonc` defines two environments, `staging` and `production`, with separate Workers, Durable Object namespaces, D1 databases, rate-limit namespaces and secrets. Deploy staging first and soak it with a real game before production.

## What you need

- A Cloudflare account. The free plan works.
- A clone with dependencies installed (`CI=true pnpm install`).
- For production: a domain on Cloudflare, if you want leaderboard caching (see [Custom domain](#custom-domain)).

## 1. Log in

```sh
npx wrangler login
```

## 2. Create the databases

```sh
npx wrangler d1 create scoreosis-staging
npx wrangler d1 create scoreosis-production
```

Each command prints a `database_id`. Put them in `wrangler.jsonc`, replacing `REPLACE_WITH_STAGING_D1_ID` and `REPLACE_WITH_PRODUCTION_D1_ID`.

## 3. Apply the schema

```sh
npx wrangler d1 migrations apply scoreosis-staging --remote --env staging
npx wrangler d1 migrations apply scoreosis-production --remote --env production
```

The Durable Objects create their own SQLite tables on first use; no step is needed for them.

## 4. Set the admin secret

```sh
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN --env staging
openssl rand -hex 32 | npx wrangler secret put ADMIN_TOKEN --env production
```

Keep each token in your password manager. Admin routes refuse every request while the secret is missing or shorter than 32 characters. Never ship it in a game.

## 5. Allow your game's origins

Browser builds call the API cross-origin. Set `ALLOWED_ORIGINS` per environment in `wrangler.jsonc`, comma separated, for example `"https://html-classic.itch.zone,https://games.example.com"`. Native builds send no origin and need no entry.

## 6. Deploy

```sh
pnpm deploy:staging
curl https://scoreosis-staging.<your-subdomain>.workers.dev/v1/health
```

The Worker is named `scoreosis-staging` (and `scoreosis-production`): wrangler appends the environment name. `/v1/health` lists the registered games.

Then point a staging build of the game at that URL (`[scoreosis] url` in its settings) and play ranked runs. Read Workers Observability while it runs; [Operations](../OPERATIONS.md#before-raising-limits) lists what to check before raising limits.

```sh
pnpm deploy:production
```

## Deploy from GitHub Actions

`.github/workflows/deploy.yml` runs the full test gate, applies D1 migrations and deploys:

| Trigger | Environment |
| --- | --- |
| Push to `main` | staging |
| Tag `v*` | production |
| Run workflow by hand | staging or production, your choice |

It stays inactive until you finish steps 2 to 5 above (databases with their ids committed in `wrangler.jsonc`, admin secrets, origins) and then give the repository access to Cloudflare:

1. In the Cloudflare dashboard, create an API token from the **Edit Cloudflare Workers** template and make sure it includes **D1: Edit**.
2. In the GitHub repository settings, add the variable `CLOUDFLARE_ACCOUNT_ID` (your account id, from the dashboard sidebar) and the secret `CLOUDFLARE_API_TOKEN`.
3. Optional: under **Environments**, add required reviewers to `production` so a tag waits for approval before it deploys.

```sh
gh variable set CLOUDFLARE_ACCOUNT_ID --body <account-id>
gh secret set CLOUDFLARE_API_TOKEN
```

## Custom domain

The leaderboard response cache uses the Cache API, which only works on a custom domain. On `*.workers.dev` every board request reads D1. To serve production from your own domain, add to `env.production` in `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "scores.example.com", "custom_domain": true }]
```

and deploy again. Cloudflare creates the DNS record and certificate.

## Updating

- **New game build or ruleset:** register it in `games/<id>/game.json` (see [Adding a game](../INTEGRATION.md)), run the tests, deploy. Verifier code ships only with a deploy.
- **D1 schema change:** back up with `npx wrangler d1 export scoreosis-production --remote --output backup.sql`, add a new numbered file under `migrations/`, apply to staging, test, then production. Never edit an applied migration.
- **Durable Object schema change:** additive only. New tables go in `SCHEMA` in `src/session.ts`; new columns on existing tables also go in `ADDED_COLUMNS`, which adds them to objects created before.

## Free plan budget

One second of ranked play costs about one Worker request, one Durable Object request and 1.1 SQLite rows written. With the free daily allowances shared across the account, that is roughly 25 player-hours of ranked play per day. `MAX_RUNS_PER_DAY` stops new ranked runs before the quota runs out; games then play locally. [Architecture](../ARCHITECTURE.md#free-plan-budget) has the arithmetic.
