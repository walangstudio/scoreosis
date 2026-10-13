import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { type PublishedResult, publishResult } from '../src/leaderboard.js';
import { api } from './client.js';

const ADMIN = { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789' };
let n = 0;

async function player(name: string): Promise<string> {
  const id = (++n).toString(16).padStart(32, '0');
  await env.DB.prepare(
    "INSERT INTO players (game_id, player_id, display_name, created_at) VALUES ('ahsteroids', ?, ?, 0)",
  )
    .bind(id, name)
    .run();
  return id;
}

async function result(playerId: string, score: number, extra: Partial<PublishedResult> = {}) {
  const r: PublishedResult = {
    run_id: crypto.randomUUID(),
    game_id: 'ahsteroids',
    board: 'classic',
    ruleset: '45629a5a0139f70a',
    player_id: playerId,
    score,
    runtime: 'web',
    channel: 'itch_io',
    country: 'PH',
    accepted_at: ++n,
    facts: { score },
    ...extra,
  };
  await publishResult(env.DB, r);
  return r;
}

const board = async (query = '') => (await api(`/v1/games/ahsteroids/leaderboards${query}`)).body;
const names = (body: { entries: { name: string }[] }) => body.entries.map((e) => e.name);

describe('leaderboards', () => {
  const ids: Record<string, string> = {};
  const id = (name: string) => ids[name] ?? '';

  beforeAll(async () => {
    for (const name of ['ana', 'ben', 'cy', 'dee', 'eli', 'fay']) ids[name] = await player(name);
    await result(id('ana'), 500, { runtime: 'windows', channel: 'steam', country: 'US' });
    await result(id('ana'), 300, { runtime: 'android', channel: 'google_play', country: 'PH' });
    await result(id('ben'), 400, { country: null });
    await result(id('cy'), 400, { runtime: 'android', channel: 'google_play' });
    await result(id('dee'), 350, { runtime: 'android', channel: 'direct', country: 'JP' });
    await result(id('eli'), 200);
    await result(id('fay'), 100);
  });

  it('ranks one personal best per player, ties share a rank in acceptance order', async () => {
    const body = await board();
    expect(body.entries).toEqual([
      { rank: 1, name: 'ana', score: 500 },
      { rank: 2, name: 'ben', score: 400 },
      { rank: 2, name: 'cy', score: 400 },
      { rank: 4, name: 'dee', score: 350 },
      { rank: 5, name: 'eli', score: 200 },
      { rank: 6, name: 'fay', score: 100 },
    ]);
  });

  it('keeps per-platform personal bests and filters runtime and channel independently', async () => {
    expect(names(await board('?runtime=android'))).toEqual(['cy', 'dee', 'ana']);
    expect((await board('?runtime=android')).entries[2]).toEqual({
      rank: 3,
      name: 'ana',
      score: 300,
    });
    expect(names(await board('?channel=google_play'))).toEqual(['cy', 'ana']);
    expect(names(await board('?runtime=android&channel=direct'))).toEqual(['dee']);
    expect(names(await board('?runtime=web&channel=itch_io'))).toEqual(['ben', 'eli', 'fay']);
  });

  it('filters by country and leaves unknown countries on the world board only', async () => {
    expect(names(await board('?country=PH'))).toEqual(['cy', 'ana', 'eli', 'fay']);
    expect(names(await board('?country=PH&runtime=android'))).toEqual(['cy', 'ana']);
    expect(names(await board())).toContain('ben');
    expect(names(await board('?country=US'))).toEqual(['ana']);
  });

  it('pages 25 at a time up to rank 100', async () => {
    for (let i = 0; i < 30; i++) await result(await player(`p${i}`), 10 + i, { runtime: 'linux' });
    const first = await board('?runtime=linux');
    const second = await board('?runtime=linux&page=1');
    expect(first.entries).toHaveLength(25);
    expect(second.entries).toHaveLength(5);
    expect(second.entries[0].rank).toBe(26);
    expect((await api('/v1/games/ahsteroids/leaderboards?page=4')).status).toBe(400);
  });

  it('rejects bad filter values', async () => {
    for (const q of ['?runtime=ps5', '?channel=epic', '?country=ph', '?board=nope', '?page=-1']) {
      expect((await api(`/v1/games/ahsteroids/leaderboards${q}`)).status, q).toBe(400);
    }
  });

  it('hides banned players and recomputes bests after suppression', async () => {
    const hide = await api(`/v1/admin/games/ahsteroids/players/${id('ben')}/hide`, {
      body: {},
      headers: ADMIN,
    });
    expect(hide.status).toBe(200);
    expect(names(await board('?country=JP'))).toEqual(['dee']);
    const cheater = await player('zed');
    const run = await result(cheater, 9999, { runtime: 'macos' });
    await result(cheater, 50, { runtime: 'macos' });
    expect((await board('?runtime=macos')).entries[0]).toEqual({
      rank: 1,
      name: 'zed',
      score: 9999,
    });
    const denied = await api(`/v1/admin/games/ahsteroids/runs/${run.run_id}/suppress`, {
      body: {},
    });
    expect(denied.status).toBe(403);
    await api(`/v1/admin/games/ahsteroids/runs/${run.run_id}/suppress`, {
      body: {},
      headers: ADMIN,
    });
    // A fresh filter bypasses the 30 s public cache of the earlier response.
    expect((await board('?runtime=macos&channel=itch_io')).entries[0]).toEqual({
      rank: 1,
      name: 'zed',
      score: 50,
    });
  });
});
