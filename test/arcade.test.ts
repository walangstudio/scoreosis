import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { pruneResults, publishResult } from '../src/leaderboard.js';
import { Player, api, guest, nameTheGuest, stubFor, useClock } from './client.js';
import { bundle } from './fixtures.js';

afterEach(() => vi.useRealTimers());

it('submits immutable names for individual verified runs without renaming the player', async () => {
  const clock = useClock();
  const player = await Player.create(12345);
  const start = await player.start('ahsteroids-web-itch_io-0.1.0', undefined, true);
  expect(start.body.arcade).toBe(true);
  await runInDurableObject(stubFor(player.token), (_, state) => {
    state.storage.sql.exec('UPDATE runs SET seed = 12345 WHERE id = ?', player.run.run_id);
  });
  player.vm.call('sv_start', `${bundle.entry}|12345`);
  const path = `/v1/games/ahsteroids/runs/${player.run.run_id}/entry`;
  const submit = (name: string, token = player.token) =>
    api(path, { token, body: { display_name: name } });
  expect((await submit('TEST-001')).status).toBe(409);
  const result = await player.playToEnd(clock);
  expect(result.body.status).toBe('finished');
  expect(result.body.score).toBeGreaterThan(0);
  expect((await submit('TEST-001', await guest())).status).toBe(404);
  expect((await submit('Guest123')).status).toBe(400);
  expect(
    (await api(path, { token: player.token, body: { display_name: 'TEST-001', score: 99999 } }))
      .status,
  ).toBe(400);
  const race = await Promise.all([submit('TEST-001'), submit('TEST-002')]);
  expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
  const name = race.find((r) => r.status === 200)?.body.display_name;
  expect((await submit(name)).status).toBe(200);
  expect((await submit('TEST-003')).status).toBe(409);
  expect(
    (await api('/v1/games/ahsteroids/me/profile', { token: player.token })).body.display_name,
  ).toBeNull();
  const board = await api('/v1/games/ahsteroids/leaderboards?runtime=web');
  expect(board.body.entries).toEqual([{ rank: 1, name, score: result.body.score }]);
  await nameTheGuest('ahsteroids', player.token, 'TEST-004');
  const privateBoard = await api('/v1/games/ahsteroids/leaderboards?runtime=web&me=1', {
    token: player.token,
  });
  expect(privateBoard.body.entries).toEqual(board.body.entries);
  const next = await Player.create(12345, player.token);
  expect((await next.start('ahsteroids-web-itch_io-0.1.0', undefined, true)).status).toBe(201);
  await runInDurableObject(stubFor(next.token), (_, state) => {
    state.storage.sql.exec('UPDATE runs SET seed = 12345 WHERE id = ?', next.run.run_id);
  });
  next.vm.call('sv_start', `${bundle.entry}|12345`);
  const nextResult = await next.playToEnd(clock);
  expect(nextResult.body.score).toBe(result.body.score);
  expect(
    (
      await api(`/v1/games/ahsteroids/runs/${next.run.run_id}/entry`, {
        token: player.token,
        body: { display_name: 'TEST-005' },
      })
    ).status,
  ).toBe(200);
  const both = await api('/v1/games/ahsteroids/leaderboards?runtime=web&me=1', {
    token: player.token,
  });
  expect(both.body.entries).toEqual([
    { rank: 1, name, score: result.body.score },
    { rank: 1, name: 'TEST-005', score: result.body.score },
  ]);
}, 60_000);

it('keeps previous entry names and the top 100 runs through retention', async () => {
  const token = await guest();
  const playerId = token.split('.')[0] ?? '';
  await nameTheGuest('ahsteroids', token, 'TEST-010');
  for (let score = 1; score <= 101; score++) {
    await publishResult(env.DB, {
      run_id: crypto.randomUUID(),
      game_id: 'ahsteroids',
      board: 'classic',
      ruleset: bundle.ruleset,
      player_id: playerId,
      score,
      runtime: 'web',
      channel: 'itch_io',
      country: 'NZ',
      accepted_at: score,
      facts: { score },
      ...(score === 101 ? { entry_name: 'TEST-011' } : {}),
    });
  }
  expect(await pruneResults(env.DB, 1000)).toBe(1);
  const board = await api('/v1/games/ahsteroids/leaderboards?country=NZ&me=1', { token });
  expect(board.body.entries.slice(0, 2)).toEqual([
    { rank: 1, name: 'TEST-011', score: 101 },
    { rank: 2, name: 'TEST-010', score: 100 },
  ]);
  await expect(
    env.DB.prepare("UPDATE results SET entry_name = 'TEST-099' WHERE player_id = ?")
      .bind(playerId)
      .run(),
  ).rejects.toThrow('immutable');
});
