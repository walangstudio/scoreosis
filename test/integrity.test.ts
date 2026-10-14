import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player, api, guest, useClock } from './client.js';
import { BUILD } from './fixtures.js';

afterEach(() => {
  vi.useRealTimers();
});

const runPath = (p: Player, action: string) =>
  `/v1/games/ahsteroids/runs/${p.run.run_id}/${action}`;

describe('isolation', () => {
  it("rejects another player's token on a run", async () => {
    const clock = useClock();
    const owner = await Player.create();
    await owner.start();
    clock.advance(1000);
    const intruder = await guest();
    const res = await api(runPath(owner, 'inputs'), { token: intruder, body: owner.play() });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    const finish = await api(runPath(owner, 'finish'), { token: intruder, body: { tick: 0 } });
    expect(finish.status).toBe(404);
  });

  it('rejects a forged secret and malformed tokens', async () => {
    const token = await guest();
    const forged = `${token.split('.')[0]}.${'A'.repeat(43)}`;
    for (const t of [forged, 'nonsense', '']) {
      const res = await api('/v1/games/ahsteroids/runs', {
        token: t,
        body: { build_id: BUILD },
      });
      expect(res.status).toBe(401);
    }
  });

  it('does not spend daily capacity or create storage for forged tokens', async () => {
    const used = async () =>
      (
        await env.DB.prepare('SELECT sum(runs_started) AS n FROM usage').first<{
          n: number | null;
        }>()
      )?.n ?? 0;
    const before = await used();
    for (let i = 0; i < 5; i++) {
      const id = crypto.randomUUID().replace(/-/g, '');
      const res = await api('/v1/games/ahsteroids/runs', {
        token: `${id}.${'B'.repeat(43)}`,
        body: { build_id: BUILD },
      });
      expect(res.status).toBe(401);
    }
    expect(await used()).toBe(before);
  });

  it('scopes credentials to one game', async () => {
    const token = await guest();
    const res = await api('/v1/games/sneak/runs', {
      token,
      body: { build_id: 'sneak-web-direct-0.2.0' },
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect((await api('/v1/games/nope/runs', { token, body: { build_id: BUILD } })).status).toBe(
      404,
    );
  });

  it('requires a known mode for moded games and refuses one elsewhere', async () => {
    const build = 'ebakuw8-web-direct-0.3.0';
    const token = await guest('ebakuw8', build);
    for (const body of [{ build_id: build }, { build_id: build, mode: 'mars' }]) {
      const res = await api('/v1/games/ebakuw8/runs', { token, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    const plain = await api('/v1/games/ahsteroids/runs', {
      token: await guest(),
      body: { build_id: BUILD, mode: 'train' },
    });
    expect(plain.status).toBe(400);
    expect((await api('/v1/games/ebakuw8/leaderboards?mode=mars')).status).toBe(400);
    expect((await api('/v1/games/ahsteroids/leaderboards?mode=train')).status).toBe(400);
  });

  it('rejects unregistered builds for guests and runs', async () => {
    const res = await api('/v1/guests', {
      body: { game_id: 'ahsteroids', build_id: 'ahsteroids-cracked' },
    });
    expect(res.status).toBe(422);
    const player = await Player.create();
    const run = await player.start('ahsteroids-cracked');
    expect(run.status).toBe(422);
    expect(run.body.error.code).toBe('unsupported_build');
  });
});

describe('integrity', () => {
  it('ignores client-claimed scores and rejects a client whose state diverges', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    const chunk = { ...player.play(), score: 999999, checksum: 1 };
    const res = await player.send(chunk);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', reason: 'desync' });
    clock.advance(1000);
    const next = await player.send(player.play());
    expect(next.body.error.code).toBe('run_not_active');
  });

  it('rejects illegal button bits and malformed input', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    for (const inputs of ['60:16', '0:1', '60', 'x:1', '60:1,', '200:1']) {
      const res = await player.send({ seq: 0, from_tick: 0, inputs });
      expect(res.status, inputs).toBe(400);
    }
  });

  it('rejects input from the future', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(500);
    const res = await player.send(player.play(60));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('timing_rejected');
  });

  it('accepts identical retries and refuses rewritten history', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    const chunk = player.play();
    const first = await player.send(chunk);
    const retry = await player.send(chunk);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);
    const rewritten = await player.send({ ...chunk, inputs: '60:3' });
    expect(rewritten.status).toBe(409);
    expect(rewritten.body.error.code).toBe('sequence_conflict');
  });

  it('refuses sequence gaps and tick gaps', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    expect((await player.send({ seq: 1, from_tick: 0, inputs: '60:0' })).status).toBe(409);
    expect((await player.send({ seq: 0, from_tick: 5, inputs: '55:0' })).status).toBe(409);
  });

  it('rejects oversized input bodies before parsing', async () => {
    useClock();
    const player = await Player.create();
    await player.start();
    const res = await player.send({ seq: 0, from_tick: 0, inputs: '1:1,'.repeat(5000) });
    expect(res.status).toBe(413);
  });

  it('allows one active ranked run per player', async () => {
    useClock();
    const player = await Player.create();
    expect((await player.start()).status).toBe(201);
    const second = await api('/v1/games/ahsteroids/runs', {
      token: player.token,
      body: { build_id: BUILD },
    });
    expect(second.status).toBe(409);
    await api(runPath(player, 'abandon'), { token: player.token, body: {} });
    expect((await player.start()).status).toBe(201);
  });

  it('rejects finishing a run that has not reached a terminal state', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    const res = await player.finish();
    expect(res.body).toEqual({ status: 'rejected', reason: 'not_terminal' });
  });
});
