import { afterEach, describe, expect, it, vi } from 'vitest';
import { Player, api, useClock } from './client.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('verified ranked run', () => {
  it('plays a full Ah!Steroids run and publishes the server-verified result', async () => {
    const clock = useClock();
    const player = await Player.create(12345);
    const start = await player.start();
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

    const board = await api('/v1/games/ahsteroids/leaderboards?me=1', { token: player.token });
    expect(board.status).toBe(200);
    expect(board.body.entries).toEqual([
      { rank: 1, name: expect.stringMatching(/^Guest-/), score: clientFacts.score },
    ]);
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
  });
});
