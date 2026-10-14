---
layout: home

hero:
  name: Scoreosis
  text: Verified leaderboards for games
  tagline: Clients upload button inputs, not scores. The server replays every run through the game's own simulation and ranks only what it verified.
  image:
    src: /medal.svg
    alt: A medal, the BadgeTrip icon used as the Scoreosis logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Deploy to Cloudflare
      link: /guide/cloudflare
    - theme: alt
      text: GitHub
      link: https://github.com/walangstudio/scoreosis

features:
  - title: Replayed, not trusted
    details: The game's ranked Lua runs on the server in a sandboxed Lua 5.1 Wasm VM. A score exists only if the server's own replay produced it.
  - title: Real time, enforced
    details: Inputs arrive every second and are checked against the clock. Speed hacks, slow motion and rewritten history are rejected.
  - title: Global and country boards per platform
    details: Web, Windows, Android and the rest rank separately. Country comes from the request, not the client.
  - title: Achievements on BadgeTrip
    details: Verified achievements run on the BadgeTrip engine, atomically with the run result. Local progress stays separate.
  - title: Free plan first
    details: One Worker, one Durable Object per player, one D1 database. Admission control stops new runs before the daily quota runs out.
  - title: Any Lua game
    details: Built for Defold games. A game exposes one deterministic module; the packer checks it and registers its builds.
---
