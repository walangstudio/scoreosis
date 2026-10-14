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
    for (let s = 0; s < 5; s++) {
      clock.advance(1000);
      statuses.push((await player.send(player.play(30))).status);
    }
    // The first chunk anchors real time; half speed then falls 30 ticks further
    // behind each second, and the 1.5 s window holds 90.
    expect(statuses).toEqual([200, 200, 200, 200, 422]);
  });

  it('does not count start-up latency as lag', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1300); // the start response took a while to arrive
    for (let s = 0; s < 5; s++) {
      clock.advance(1000);
      expect((await player.send(player.play())).status).toBe(200);
    }
  });

  it('anchors on the reported start time so a first-second hitch can be caught up', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(800); // start response latency
    clock.advance(1500); // the client hitched: 1.5 s passed but it only ticked 60
    const first = { ...player.play(), elapsed_ms: 1500 };
    expect((await player.send(first)).status).toBe(200);
    clock.advance(500); // it catches up to tick 120 by 2.0 s of play
    expect((await player.send(player.play())).status).toBe(200);
  });

  it('does not reject the next chunk when the first was delayed in transit', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    clock.advance(300); // a browser's first POST to the run waits on a CORS preflight
    expect((await player.send({ ...player.play(), elapsed_ms: 1000 })).status).toBe(200);
    clock.advance(750); // the second chunk, sent at 2.0 s of play, needs no preflight
    expect((await player.send(player.play())).status).toBe(200);
  });

  it('rejects input ahead of the time since the run began', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
    const res = await player.send(player.play(120));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('input is ahead of real time');
  });

  it('does not turn paused time into lead', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
    expect((await pause(player)).status).toBe(200);
    clock.advance(4 * 60_000);
    expect((await resume(player)).status).toBe(200);
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
    const res = await player.send(player.play(120));
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('input is ahead of real time');
  });

  it('survives a start response slower than the loss window', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(4500); // the start response itself took this long
    clock.advance(1000);
    const res = await player.send({ ...player.play(), elapsed_ms: 1000 });
    expect(res.status).toBe(200);
  });

  it('caps the start-up grace so a late first chunk is still rejected', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(10_000);
    const res = await player.send(player.play());
    expect(res.status).toBe(409);
    expect(res.body.error.details).toEqual({ reason: 'connection_lost' });
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

  it('does not let pause and resume cycles forgive slow motion', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    let rejected = false;
    for (let s = 0; s < 40 && !rejected; s++) {
      clock.advance(1000);
      const sent = await player.send(player.play(10));
      if (sent.status !== 200) {
        rejected = true;
        break;
      }
      const paused = await pause(player);
      const resumed = await resume(player);
      rejected = paused.status !== 200 || resumed.status !== 200;
    }
    expect(rejected).toBe(true);
  });

  it('does not let pause and resume cycles bank extra lead', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    let rejected = false;
    for (let s = 0; s < 40 && !rejected; s++) {
      clock.advance(1000);
      rejected = (await player.send(player.play(65))).status !== 200;
      if (!rejected)
        rejected = (await pause(player)).status !== 200 || (await resume(player)).status !== 200;
    }
    expect(rejected).toBe(true);
  });

  it('returns the expected tick on resume so a client can catch up', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play(60));
    clock.advance(1000);
    await player.send(player.play(40));
    await pause(player);
    clock.advance(60_000);
    const resumed = await resume(player);
    expect(resumed.body.expected_tick).toBe(120);
  });

  it('starts a pause at the last input, so the pause round trips are not lag', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    clock.advance(900);
    await player.send(player.play(30)); // partial flush after freezing at tick 90
    clock.advance(1600); // flush ack, CORS preflight and the pause request
    expect((await pause(player)).status).toBe(200);
    clock.advance(30_000);
    const resumed = await resume(player);
    expect(resumed.body.expected_tick).toBeLessThanOrEqual(player.tick + 90);
    clock.advance(1000);
    expect((await player.send(player.play())).status).toBe(200);
  });

  it('rejects a pause sent long after the last input', async () => {
    const clock = useClock();
    const player = await Player.create();
    await player.start();
    clock.advance(1000);
    await player.send(player.play());
    clock.advance(2500);
    const res = await pause(player);
    expect(res.status).toBe(422);
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
      expect((await player.send(player.play(60))).status).toBe(200);
      expect((await pause(player)).status).toBe(200);
      clock.advance(14 * 60_000);
      expect((await resume(player)).status).toBe(200);
    }
    clock.advance(1000);
    await player.send(player.play(60));
    await pause(player);
    clock.advance(5 * 60_000);
    const res = await resume(player);
    expect(res.body.error.details).toEqual({ reason: 'pause_total_exceeded' });
  });
});
