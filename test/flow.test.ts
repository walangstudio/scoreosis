import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player, api, nameTheGuest, useClock } from './client.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('verified ranked run', () => {
  it('plays a full Ah!Steroids run and publishes the server-verified result', async () => {
    const clock = useClock();
    const player = await Player.create(12345);
    const start = await player.start('ahsteroids-web-itch_io-0.1.0');
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ tick_rate: 60, board: 'classic' });

    const result = await player.playToEnd(clock);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('finished');
    const clientFacts = Object.fromEntries(
      player.vm
        .call('sv_facts')
        .split('\n')
        .map((l) => l.split('='))
        .map(([k, v]) => [k, Number(v)]),
    );
    expect(result.body.facts).toEqual(clientFacts);
    expect(result.body.published).toBe(true);

    // Verified but unnamed: stored, not ranked.
    const unnamed = await api('/v1/games/ahsteroids/leaderboards?runtime=web&me=1', {
      token: player.token,
    });
    expect(unnamed.body.entries).toEqual([]);
    expect(unnamed.body.me).toBeNull();
    await nameTheGuest('ahsteroids', player.token);

    const board = await api('/v1/games/ahsteroids/leaderboards?runtime=web&channel=itch_io&me=1', {
      token: player.token,
    });
    expect(board.status).toBe(200);
    expect(board.body.entries).toEqual([{ rank: 1, name: 'kitty', score: clientFacts.score }]);
    expect(board.body.me).toEqual({ rank: 1, score: clientFacts.score });

    const achievements = await api('/v1/games/ahsteroids/me/achievements', { token: player.token });
    expect(achievements.status).toBe(200);
    expect(achievements.body.achievements).toHaveLength(12);
    const kills = achievements.body.achievements.find((a: { id: string }) => a.id === 'kills_100');
    expect(kills.progress).toEqual({
      current: clientFacts.kills,
      target: 100,
      percent: clientFacts.kills,
    });
  }, 60_000);

  it('verifies an ebakuw8 stage run on that stage board only', async () => {
    const clock = useClock();
    const player = await Player.create(4242, undefined, 'ebakuw8');
    await nameTheGuest('ebakuw8', player.token);
    const start = await player.start('ebakuw8-web-direct-0.3.0', 'diner');
    expect(start.status).toBe(201);
    expect(start.body).toMatchObject({ board: 'stages', mode: 'diner' });

    const result = await player.playToEnd(clock);
    expect(result.body.status).toBe('finished');
    const score = Number(
      player.vm
        .call('sv_facts')
        .split('\n')
        .find((l) => l.startsWith('score='))
        ?.split('=')[1],
    );
    expect(result.body.score).toBe(score);

    const board = (mode: string) =>
      api(`/v1/games/ebakuw8/leaderboards?mode=${mode}&runtime=web&me=1`, { token: player.token });
    const diner = await board('diner');
    expect(diner.body).toMatchObject({ board: 'stages', mode: 'diner', me: { rank: 1, score } });
    const train = await board('train');
    expect(train.body.entries).toEqual([]);
    expect(train.body.me).toBeNull();
    const windows = await api('/v1/games/ebakuw8/leaderboards?mode=diner&runtime=windows');
    expect(windows.body.entries).toEqual([]);
  }, 120_000);

  it('verifies a Sneak run on its own board and achievements', async () => {
    const clock = useClock();
    const player = await Player.create(777, undefined, 'sneak');
    expect((await player.start('sneak-web-itch_io-0.2.0')).status).toBe(201);

    const result = await player.playToEnd(clock);
    expect(result.body.status).toBe('finished');
    const clientFacts = Object.fromEntries(
      player.vm
        .call('sv_facts')
        .split('\n')
        .map((l) => l.split('='))
        .map(([k, v]) => [k, Number(v)]),
    );
    expect(result.body.facts).toEqual(clientFacts);
    expect(clientFacts).toHaveProperty('food');

    await nameTheGuest('sneak', player.token);
    const board = await api('/v1/games/sneak/leaderboards?runtime=web&channel=itch_io&me=1', {
      token: player.token,
    });
    expect(board.body.me).toEqual(
      clientFacts.score > 0 ? { rank: 1, score: clientFacts.score } : null,
    );
    const achievements = await api('/v1/games/sneak/me/achievements', { token: player.token });
    expect(achievements.body.achievements).toHaveLength(12);
    const food = achievements.body.achievements.find((a: { id: string }) => a.id === 'food_10');
    expect(food.progress).toMatchObject({
      current: Math.min(food.progress.target, clientFacts.food),
      target: 10,
    });
  }, 60_000);
});
