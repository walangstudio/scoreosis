import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registry } from '../src/games.js';
import { publishResult } from '../src/leaderboard.js';
import { api, guest, useClock } from './client.js';
import { RULESET } from './fixtures.js';

const PROFILE = '/v1/games/ahsteroids/me/profile';
const rename = (token: string, body: unknown) => api(PROFILE, { method: 'PATCH', token, body });
const profile = (token: string) => api(PROFILE, { token });
const playerOf = (token: string) => token.split('.')[0] ?? '';

let runs = 0;
async function verified(token: string, score: number, country: string) {
  await publishResult(env.DB, {
    run_id: crypto.randomUUID(),
    game_id: 'ahsteroids',
    board: 'classic',
    ruleset: RULESET,
    player_id: playerOf(token),
    score,
    runtime: 'web',
    channel: 'itch_io',
    country,
    accepted_at: ++runs,
    facts: { score },
  });
}

afterEach(() => vi.useRealTimers());

describe('player profile', () => {
  it('starts new players unnamed instead of generating a Guest name', async () => {
    const created = await api('/v1/guests', {
      body: { game_id: 'ahsteroids', build_id: 'ahsteroids-web-itch_io-0.1.0' },
    });
    expect(created.status).toBe(201);
    expect(created.body.display_name).toBeNull();
    const res = await profile(created.body.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ display_name: null });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('saves a trimmed, collapsed name with its casing', async () => {
    const token = await guest();
    const saved = await rename(token, { display_name: '  Test-001   A ' });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ display_name: 'Test-001 A' });
    expect((await profile(token)).body).toEqual({ display_name: 'Test-001 A' });
  });

  it('rejects invalid names and keeps the previous one', async () => {
    const token = await guest();
    expect((await rename(token, { display_name: 'test-001' })).status).toBe(200);
    for (const display_name of [
      '',
      '   ',
      'k',
      'a'.repeat(17),
      '<b>test-001</b>',
      'kit\tty',
      'kit\nty',
      'test-001\u0000',
      'test-001​',
      'ñame',
      '-test',
      'test-',
      'test--001',
      'test -001',
      'test- 001',
      'Guest-4F2A10',
      'guest 42',
      42,
      null,
    ]) {
      const res = await rename(token, { display_name });
      expect(res.status, JSON.stringify(display_name)).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
    expect((await rename(token, {})).status).toBe(400);
    expect((await profile(token)).body).toEqual({ display_name: 'test-001' });
  });

  it('rejects ownership fields so a caller cannot pick the row', async () => {
    const victim = await guest();
    const attacker = await guest();
    expect((await rename(victim, { display_name: 'victim' })).status).toBe(200);
    const res = await rename(attacker, { display_name: 'owned', player_id: playerOf(victim) });
    expect(res.status).toBe(400);
    expect((await profile(victim)).body).toEqual({ display_name: 'victim' });
    expect((await profile(attacker)).body).toEqual({ display_name: null });
  });

  it('rejects oversized bodies', async () => {
    const token = await guest();
    const res = await rename(token, { display_name: 'test-001', pad: 'x'.repeat(4096) });
    expect(res.status).toBe(413);
  });

  it('requires a valid credential for this game', async () => {
    const token = await guest();
    expect(
      (await api(PROFILE, { method: 'PATCH', body: { display_name: 'test-001' } })).status,
    ).toBe(401);
    expect((await api(PROFILE)).status).toBe(401);
    const forged = `${playerOf(token)}.${'A'.repeat(43)}`;
    expect((await rename(forged, { display_name: 'test-001' })).status).toBe(401);
    expect((await profile(forged)).status).toBe(401);
    const sneakBuild = registry.get('sneak')?.builds.keys().next().value ?? '';
    const sneak = await guest('sneak', sneakBuild);
    expect((await rename(sneak, { display_name: 'test-001' })).status).toBe(401);
    expect((await profile(token)).body).toEqual({ display_name: null });
  });

  it('lets different players share a name', async () => {
    const a = await guest();
    const b = await guest();
    expect((await rename(a, { display_name: 'test-001' })).status).toBe(200);
    expect((await rename(b, { display_name: 'test-001' })).status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM players WHERE game_id = 'ahsteroids' AND player_id IN (?, ?) AND display_name = 'test-001'",
    )
      .bind(playerOf(a), playerOf(b))
      .first<{ n: number }>();
    expect(rows?.n).toBe(2);
  });

  it('allows one rename per minute, even for concurrent requests', async () => {
    const clock = useClock();
    const token = await guest();
    const first = await Promise.all([
      rename(token, { display_name: 'one' }),
      rename(token, { display_name: 'two' }),
      rename(token, { display_name: 'three' }),
    ]);
    expect(first.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const kept = (await profile(token)).body.display_name;
    expect(first.find((r) => r.status === 200)?.body.display_name).toBe(kept);
    clock.advance(59_000);
    const early = await rename(token, { display_name: 'four' });
    expect(early.status).toBe(429);
    expect(early.body.error.code).toBe('rate_limited');
    clock.advance(2_000);
    expect((await rename(token, { display_name: 'four' })).status).toBe(200);
    expect((await profile(token)).body).toEqual({ display_name: 'four' });
  });

  it('keeps an unnamed player off the board until they choose a name', async () => {
    const unnamed = await guest();
    const named = await guest();
    expect((await rename(named, { display_name: 'test-001' })).status).toBe(200);
    await verified(unnamed, 900, 'NZ');
    await verified(named, 500, 'NZ');

    const before = await api('/v1/games/ahsteroids/leaderboards?country=NZ&me=1', {
      token: unnamed,
    });
    expect(before.body.entries).toEqual([{ rank: 1, name: 'test-001', score: 500 }]);
    expect(before.body.me).toBeNull();
    const best = await api('/v1/games/ahsteroids/leaderboards?country=NZ&runtime=web');
    expect(best.body.entries[0]).toEqual({ rank: 1, name: 'test-001', score: 500 });

    expect((await rename(unnamed, { display_name: 'Late Cat' })).status).toBe(200);
    const after = await api('/v1/games/ahsteroids/leaderboards?country=NZ&me=1', {
      token: unnamed,
    });
    expect(after.body.entries).toEqual([
      { rank: 1, name: 'Late Cat', score: 900 },
      { rank: 2, name: 'test-001', score: 500 },
    ]);
    expect(after.body.me).toEqual({ rank: 1, score: 900 });
  });

  it('frees the rename slot when the database write fails', async () => {
    const token = await guest();
    await env.DB.exec(
      "CREATE TRIGGER players_down BEFORE UPDATE ON players BEGIN SELECT RAISE(ABORT, 'down'); END",
    );
    let failed: Awaited<ReturnType<typeof rename>>;
    try {
      failed = await rename(token, { display_name: 'test-001' });
    } finally {
      await env.DB.exec('DROP TRIGGER players_down');
    }
    expect(failed.status).toBe(500);
    expect((await rename(token, { display_name: 'test-001' })).status).toBe(200);
    expect((await profile(token)).body).toEqual({ display_name: 'test-001' });
  });

  it('shows a verified two-point score immediately after the name is chosen', async () => {
    const token = await guest();
    await verified(token, 2, 'KE');
    const path = '/v1/games/ahsteroids/leaderboards?country=KE&runtime=web';
    expect((await api(path)).body.entries).toEqual([]);
    expect((await rename(token, { display_name: 'test-001' })).status).toBe(200);
    const board = await api(`${path}&me=1`, { token });
    expect(board.status).toBe(200);
    expect(board.body.entries).toEqual([{ rank: 1, name: 'test-001', score: 2 }]);
    expect(board.body.me).toEqual({ rank: 1, score: 2 });
    expect(board.headers.get('cache-control')).toBe('private, no-store');
    expect((await api(`${path}&me=1`)).status).toBe(401);
  });

  it('excludes zero from public boards and personal ranks while keeping positive scores', async () => {
    const zero = await guest();
    await rename(zero, { display_name: 'test-001' });
    await verified(zero, 0, 'FI');
    const path = '/v1/games/ahsteroids/leaderboards?country=FI&runtime=web&me=1';
    const empty = await api(path, { token: zero });
    expect(empty.body.entries).toEqual([]);
    expect(empty.body.me).toBeNull();
    const positive = await guest();
    await rename(positive, { display_name: 'test-002' });
    await verified(positive, 1, 'FI');
    const board = await api(path, { token: positive });
    expect(board.body.entries).toEqual([{ rank: 1, name: 'test-002', score: 1 }]);
    expect(board.body.me).toEqual({ rank: 1, score: 1 });
    expect(
      (await api('/v1/games/ahsteroids/leaderboards?country=FI&runtime=web')).body.entries,
    ).toEqual(board.body.entries);
  });

  it('accepts a retry of the current name without spending the rename slot', async () => {
    const token = await guest();
    expect((await rename(token, { display_name: 'test-001' })).status).toBe(200);
    const retry = await rename(token, { display_name: ' test-001 ' });
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ display_name: 'test-001' });
    expect((await rename(token, { display_name: 'Test-001' })).status).toBe(429);
  });

  it('treats players named before 0.2.0 (generated Guest names) as unnamed', async () => {
    const legacy = 'e'.repeat(32);
    await env.DB.prepare(
      "INSERT INTO players (game_id, player_id, display_name, created_at) VALUES ('ahsteroids', ?, 'Guest-EEEEEE', 0)",
    )
      .bind(legacy)
      .run();
    await verified(`${legacy}.x`, 700, 'IS');
    const board = await api('/v1/games/ahsteroids/leaderboards?country=IS');
    expect(board.body.entries).toEqual([]);
  });
});
