# Sneak and Ah!Steroids integration review

Reviewed 2026-10-19. Changes were prepared locally; check Git history for commit status.

## Scope and ranking policy

- Sneak: `Y:/projs/walangstudio/sneak`, branch `feat/scoreosis`, base `57bba06`.
- Ah!Steroids: `Y:/projs/walangstudio/ahsteroids`, branch `feat/scoreosis`, base `47da8da`.
- Scoreosis: `F:/opt/projs/walangstudio/scoreosis`, branch `main`, base `db97e9b`.
- A platform means runtime: Web, Windows, Android. Each runtime has its own global and country boards and shared BEST. Providers do not split the default board. The existing API can narrow it with `channel=itch_io` or another registered provider.
- Both games now identify current builds as `itch_io`. The service registers their Web, Windows, and Android releases. Older direct builds remain registered.
- Local Top 10 and achievements remain personal. Local achievement progress is separate from server-verified progress.

## Findings addressed

| Finding | Resolution |
| --- | --- |
| Configured builds identified as `direct`; itch releases were absent from the registry. | Both games default to `itch_io`; six game/runtime builds registered and tested. |
| BEST displayed only the device's personal record. | Public runtime record shown as WEB BEST, WINDOWS BEST, etc.; LOCAL BEST is the explicit offline fallback. No guest registration required. Public records can lag by 30 seconds. |
| Vendored session code continued beyond the terminal tick and could revive a cancelled start. | Regenerated both clients from the corrected shared session implementation; regression tests exercise both cases. |
| Client accepted arbitrary plain HTTP API URLs. | Credentials are refused over plain HTTP, except exact loopback URLs in debug builds. |
| Native HTTPS certificate verification was not configured. A configuration-only fix exposed an engine defect. | Defold 1.13.1 allocates exactly the PEM length, then parses one extra byte. Failure clears its trust chain and can disable verification. The small `scoreosis_tls` extension supplies a NUL-terminated Lua string to the checked setter. Missing extension, missing roots, and failed initialization block Scoreosis HTTPS before credentials leave. The shim uses an internal API checked against this SDK; revalidate it on engine upgrades. |
| Sneak leaderboard stopped after the API's first 25 entries. | Navigation traverses all four server pages, including backward navigation and rank 100. |
| Long names overlapped or overflowed the games' existing panels. | Sneak uses bounded font-safe names. Ah!Steroids measures the existing font and shortens names to fit beside scores. |
| Achievement rows were crowded; Sneak omitted conditions and used unsupported placeholder glyphs. | Existing visual components retained. Sneak shows one complete achievement card per page. Ah!Steroids shows six per page with separate condition lines. Loading/unavailable verification is explicit. |
| Ah!Steroids test fixtures could contribute native extensions to normal builds. | Added the same `.defignore` exclusion for `/.internal` already used by Sneak. |
| Existing Web UI mock disagreed with DOM behavior; full-game backend test had a short timeout. | Corrected the mock's node/dataset behavior; aligned the full-run test timeout with other simulation tests. Assertions remain intact. |

## Verification

- Worker API, real game verification, ranking, timing, recovery, and achievements: 112 passed, zero failed. Four optional BadgeTrip adapter capability tests skipped.
- Shared Lua session/client: 20 checks plus five native transport checks under both LuaJIT and Lua 5.1, zero failures. Transport checks cover absent/failed TLS initialization and browser transport.
- Both HTML5 debug bundles built with Defold 1.13.1 after the TLS extension changes.
- Ah!Steroids real Defold debug-engine UI geometry and shared BEST checks passed. An actual self-signed HTTPS endpoint was rejected through the Scoreosis client and native TLS extension. Earlier tests reproduced the engine's intermittent failure before the shim.
- Sneak real Defold tests cover controller/verifier replay parity, UI font bounds at phone and desktop sizes, achievement navigation, shared BEST, and rank 100 navigation.
- Ah!Steroids Lua suite and 200-run cohort simulation passed; haptics/icon checks passed. Sneak audio, Web UI, and build-script checks passed.
- Worker lint, TypeScript, documentation build, and deployment dry build passed. No remote deployment performed.
- Browser visual inspection is unverified. Automatic approval review blocked headless Chrome and a request for five additional native launch repetitions; the returned reason was only "blocked by policy".

## Remaining boundaries

Both games still have a blank `scoreosis.url`. Configure the deployed HTTPS service before publishing; current builds deliberately remain offline without it. Production CORS must include the actual itch hosting origin. No credentials were inspected or changed.

Server simulation derives scores and achievement facts from validated inputs, rather than trusting submitted scores. It does not prove human play or official binaries. Platform/provider build labels are client claims, bots can submit legal real-time inputs, and VPNs can affect country. Guest credentials on itch's shared HTML5 origin are low-trust. See [SECURITY.md](docs/SECURITY.md) for controls and limits. These restrictions prevent an honest "hack-proof" guarantee.

The native PEM defect is visible in the pinned engine's [file loader](https://github.com/defold/defold/blob/574678c7d44be490d874fbed2d0ae6211feec4d9/engine/engine/src/engine.cpp#L667) and [TLS setter](https://github.com/defold/defold/blob/574678c7d44be490d874fbed2d0ae6211feec4d9/engine/dlib/src/dlib/sslsocket_mbedtls.cpp). The extension and native certificate rejection test must remain until an engine fix is verified.
