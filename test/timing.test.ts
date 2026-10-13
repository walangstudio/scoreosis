import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player, api, useClock } from './client.js';

afterEach(() => {
  vi.useRealTimers();
});

const pause = (p: Player) =>
  api(`/v1/games/ahsteroids/runs/${p.run.run_id}/pause`, {
    token: p.token,
    body: { tick: p.tick },
  });
const resume = (p: Player) =>
  api(`/v1/games/ahsteroids/runs/${p.run.run_id}/resume`, { token: p.token, body: {} });

describe('timing', () => {
  it('rejects a client running slower than real time', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    const statuses = [];
    for (let s = 0; s < 4; s++) {
      clock.advance(1000);
      statuses.push((await player.send(player.play(30))).status);
    }
    // Half speed falls 30 ticks further behind each second; the 1.5 s window holds 90.
    expect(statuses).toEqual([200, 200, 200, 422]);
  });

  it('tolerates network delay within the 1.5 second window', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
    clock.advance(2400);
    expect((await player.send(player.play())).status).toBe(200);
  });

  it('ends eligibility after a disconnect longer than the window', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    clock.advance(5000);
    const res = await player.send(player.play(120));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'run_not_active',
      details: { reason: 'connection_lost' },
    });
  });

  it('freezes time during an approved pause and rejects input while paused', async () => {
    const clock = useClock();
    const player = await Player.create(99);
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    const paused = await pause(player);
    expect(paused.status).toBe(200);
    expect(paused.body.status).toBe('paused');
    clock.advance(1000);
    const during = await player.send({ seq: player.seq, from_tick: player.tick, inputs: '60:0' });
    expect(during.body.error.code).toBe('run_not_active');
    clock.advance(10 * 60_000);
    const resumed = await resume(player);
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('active');
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
  });

  it('requires all input to be flushed before pausing', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    player.play();
    const res = await pause(player);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('sequence_conflict');
  });

  it('expires a pause longer than 15 minutes', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    await pause(player);
    clock.advance(16 * 60_000);
    const res = await resume(player);
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'pause_too_long' });
  });

  it('caps total paused time at 60 minutes', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    for (let i = 0; i < 4; i++) {
      clock.advance(1000);
      expect((await player.send(player.play(30))).status).toBe(200);
      expect((await pause(player)).status).toBe(200);
      clock.advance(14 * 60_000);
      expect((await resume(player)).status).toBe(200);
    }
    clock.advance(1000);
    await player.send(player.play(30));
    await pause(player);
    clock.advance(5 * 60_000);
    const res = await resume(player);
    expect(res.body.error.details).toEqual({ reason: 'pause_total_exceeded' });
  });
});
