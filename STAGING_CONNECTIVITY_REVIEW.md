# Staging connection check

Date: 2026-10-23
Result: Edge access blocks API tests. No players, runs, or scores were created.

## Confirmed endpoints

- Production: `https://scoreosis.walang.studio`
- Staging: `https://scoreosis-staging.walang.studio`
- Authorized live test display name: `kitty`. Do not create generated Guest test entries.

Read-only requests to production health, staging health, staging Ah!Steroids metadata, and the staging Web leaderboard all returned HTTP 403. The JSON error reported:

```json
{
  "error_code": 1010,
  "error_name": "browser_signature_banned",
  "title": "Error 1010: Access denied",
  "detail": "The site owner has blocked access based on your browser's signature."
}
```

This response comes from Cloudflare rather than the inspected Scoreosis error-envelope format. Health is a public route in the checked source. This is not evidence of a bad player token or a failed score-verification run.

Cloudflare documents [error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/) and [Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/). The latter supports selective configuration for API traffic.

## Game build configuration

Ah!Steroids previously had a blank `[scoreosis] url`. It was not connected to either environment by default.

Its repository now has explicit `config/scoreosis.staging.ini` and `config/scoreosis.production.ini` settings files. The latest local Web debug preview was rebuilt using the staging settings. The compiled `build/default/game.projectc` was checked and contains `https://scoreosis-staging.walang.studio`.

No Ah!Steroids visual layout changed during this connection check. No production deployment or production data mutation occurred. A successful build proves which URL it targets; it does not prove the remote API accepts requests.

## Required before score testing

1. Inspect the staging host's security events and the rule responsible for error 1010. Correct the staging API policy for legitimate game clients. Do not disguise the client, bypass a browser warning, or disable protections across the whole zone as a test workaround.
2. A narrowly scoped policy candidate for owner review is host `scoreosis-staging.walang.studio` plus paths beginning `/v1/`, with a selective Browser Integrity Check exception only. Preserve the Worker's token authentication, rate limits, admission budget, and verifier. No such remote policy change has been made.
3. Check the deployed staging CORS configuration. The local staging `ALLOWED_ORIGINS` value in `wrangler.jsonc` is empty, so the checked Worker would not emit a usable allow-origin header for the local browser preview. Explicit preview candidates are `http://127.0.0.1:8775` for Ah!Steroids and, when needed, `http://127.0.0.1:8774` for Sneak. itch browser testing uses `https://html-classic.itch.zone`. Do not use a wildcard as a substitute for an intended-origin list.
4. Confirm the deployed player-name contract. The inspected local API still generates Guest names and has no profile/name route. The separate named-player handoff remains outstanding. Do not assume deployment matches local source, and do not create a live unnamed identity to discover its behavior.
5. Once access, CORS, and naming are ready, use `kitty` for a real staging run through the game. Confirm input upload, finish, leaderboard publication, runtime separation, persistence, and invalid-input rejection. Do not insert a fabricated score through admin/database access to make the test pass.

Production rollout should follow staging validation. This report records the blocker and the concrete next checks; it is not a successful score-submission test.
