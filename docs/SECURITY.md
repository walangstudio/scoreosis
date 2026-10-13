# Security

Goal: competitive results come only from legal, real-time gameplay of a registered ruleset. Not a goal, and not claimed: proving a human played, or that a run came from an official build.

## Controls

| Threat | Control | Test |
| --- | --- | --- |
| Fabricated score or facts | The server computes score and facts from inputs; client claims are ignored. | `integrity.test.ts` |
| Modified client simulation, altered seed or rules | State checksum per chunk must match the verifier. | `integrity.test.ts` |
| Illegal actions | Input bits bounded by the ruleset's button count; rules enforced by the simulation. | `integrity.test.ts` |
| Speed hacks | Input may lead real time by at most 6 ticks + 0.5%. | `integrity.test.ts` |
| Slow motion, late upload, rewritten history | Input must arrive within 1.5 s; sequence and tick continuity; an accepted `seq` is immutable. | `timing.test.ts`, `integrity.test.ts` |
| Pause abuse | Server-approved pauses only, at the flushed tick; 15 min each, 60 min total, 24 h session. | `timing.test.ts` |
| Duplicate rewards | Event id per run; one storage transaction for rewards and outbox; personal bests only increase. | `recovery.test.ts`, `achievements.test.ts` |
| Another player's run | Each run lives in its owner's object; the token secret is checked there. | `integrity.test.ts` |
| Malicious Lua or bytecode | Verifier code is packed by the administrator and deployed. Binary chunks are refused; I/O, loaders and debug are absent; instruction and memory caps. | `vm.test.ts` |
| Request floods | Body limits before parsing, per-address guest throttle, per-player run throttle, daily admission cap. | `api.test.ts` |

## Credentials

- A guest token is `<player_id>.<secret>`, 256 random bits of secret. Only its SHA-256 is stored, in the player's object. The token is returned once. It is a bearer credential: anything that reads the game's save can use it.
- `ADMIN_TOKEN` is a Worker secret of at least 32 characters, compared as hashes. Never ship it or any signing key in a game build.
- Native clients must use HTTPS with certificate verification.

## Known limits

- Bots and assistance that produce legal inputs in real time pass verification.
- Players can think during pauses.
- Build ids and platform labels are claims. Platform boards are labels, not attestation.
- Country is Cloudflare's view of the request at run start; a VPN changes it.
- Guest creation cannot stop one person making many guests; throttles slow it.
- Cloudflare's rate-limit binding is per location and eventually consistent. Exact invariants (one active run, sequences) live in the player's object.
- A free plan can be exhausted by abuse. Capacity errors stop new ranked runs; local play continues.

## Logging

Structured events only (`src/log.ts`). Never log tokens, authorization headers or IP addresses.

## Revoking achievements

Achievement state lives in each player's object (`bt_achievements`, `bt_scores`, `bt_events`). To revoke after a compromised ruleset: disable the ruleset (`POST /v1/admin/games/:game/rulesets/:ruleset/disable`), then for each affected player run a one-off script with `wrangler` against the object that deletes the run's `bt_events` row and recomputes `bt_scores` and `bt_achievements` by replaying the remaining events through a fresh engine. No endpoint does this automatically; it rewrites player progress and needs review per incident.
