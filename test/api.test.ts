import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { rulesets } from '../games/rulesets.generated.js';
import { type GameConfig, buildRegistry } from '../src/games.js';
import { BASE, Player, api } from './client.js';
import { BUILD, RULESET } from './fixtures.js';

const ADMIN = { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789' };

describe('public API', () => {
  it('reports health and game metadata', async () => {
    expect((await api('/v1/health')).body).toEqual({
      ok: true,
      games: ['ahsteroids', 'ebakuw8', 'sneak'],
    });
    const game = await api('/v1/games/ahsteroids');
    expect(game.body).toMatchObject({ id: 'ahsteroids', boards: ['classic'], modes: [] });
    const ebakuw8 = await api('/v1/games/ebakuw8');
    expect(ebakuw8.body.modes).toHaveLength(12);
    expect(ebakuw8.body.modes.slice(0, 2)).toEqual(['train', 'diner']);
    expect(game.body.achievements).toHaveLength(12);
    const sneak = await api('/v1/games/sneak');
    expect(sneak.body).toMatchObject({ id: 'sneak', boards: ['classic'] });
    expect(sneak.body.achievements).toHaveLength(12);
    expect((await api('/v1/games/nope')).status).toBe(404);
  });

  it('returns stable error envelopes', async () => {
    const res = await api('/v1/nowhere');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'no such route' } });
    const bad = await SELF.fetch(`${BASE}/v1/guests`, { method: 'POST', body: '{' });
    expect(bad.status).toBe(400);
  });

  it('registers itch releases for both games and every shipped runtime', async () => {
    for (const [game, version] of [
      ['sneak', '0.2.0'],
      ['ahsteroids', '0.1.0'],
    ]) {
      for (const runtime of ['web', 'windows', 'android']) {
        const registered = await api('/v1/guests', {
          body: { game_id: game, build_id: `${game}-${runtime}-itch_io-${version}` },
          headers: {
            'cf-connecting-ip': `198.51.100.${runtime === 'web' ? 21 : runtime === 'windows' ? 22 : 23}`,
          },
        });
        expect(registered.status, `${game}/${runtime}`).toBe(201);
      }
    }
  });

  it('allows CORS only for configured origins', async () => {
    for (const origin of ['http://127.0.0.1:8774', 'http://localhost:8775']) {
      const board = await SELF.fetch(`${BASE}/v1/games/sneak/leaderboards?runtime=web`, {
        headers: { origin },
      });
      expect(board.status).toBe(200);
      expect(board.headers.get('access-control-allow-origin')).toBe(origin);
      const preflight = await SELF.fetch(`${BASE}/v1/guests`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    }
    const res = await SELF.fetch(`${BASE}/v1/health`, {
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('throttles guest creation per address', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await api('/v1/guests', {
        body: { game_id: 'ahsteroids', build_id: BUILD },
        headers: { 'cf-connecting-ip': '198.51.100.7' },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses).toContain(429);
  });

  it('stops new ranked runs at the daily capacity', async () => {
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('INSERT OR REPLACE INTO usage (day, runs_started) VALUES (?, 1000)')
      .bind(day)
      .run();
    const player = await Player.create();
    const res = await player.start();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('capacity');
    expect(res.headers.get('retry-after')).toBe('60');
    await env.DB.prepare('DELETE FROM usage').run();
  });

  it('blocks new runs on a disabled ruleset', async () => {
    const player = await Player.create();
    const denied = await api(`/v1/admin/games/ahsteroids/rulesets/${RULESET}/disable`, {
      body: {},
    });
    expect(denied.status).toBe(403);
    const ok = await api(`/v1/admin/games/ahsteroids/rulesets/${RULESET}/disable`, {
      body: {},
      headers: ADMIN,
    });
    expect(ok.status).toBe(200);
    const res = await player.start();
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ruleset_disabled');
    await env.DB.prepare('DELETE FROM disabled_rulesets').run();
  });
});

describe('game registry', () => {
  const [ebakuw8] = rulesets.filter((r) => r.game === 'ebakuw8');
  const config = (builds: GameConfig['builds'], boards: GameConfig['boards']): GameConfig => ({
    id: 'ebakuw8',
    name: 'ebakuw8',
    entry: ebakuw8?.entry ?? '',
    boards,
    builds,
  });

  it('requires build ids to name their runtime and channel', () => {
    const ruleset = ebakuw8?.ruleset ?? '';
    const build = (id: string) => [{ id, ruleset, runtime: 'windows', channel: 'steam' }];
    const boards = { stages: [ruleset] };
    expect(() =>
      buildRegistry([config(build('ebakuw8-windows-steam-1.0'), boards)], rulesets),
    ).not.toThrow();
    for (const id of [
      'ebakuw8-beta-steam-1.0',
      'ebakuw8-web-steam-1.0',
      'other-windows-steam-1.0',
    ]) {
      expect(() => buildRegistry([config(build(id), boards)], rulesets)).toThrow(/id must be/);
    }
  });

  it('keeps the modes of older registered rulesets readable', () => {
    if (!ebakuw8) throw new Error('ebakuw8 ruleset missing');
    const older = { ...ebakuw8, ruleset: 'older', modes: ['retired', 'train'] };
    const game = buildRegistry(
      [
        config(
          [
            { id: 'ebakuw8-web-direct-0.1.0', ruleset: 'older', runtime: 'web', channel: 'direct' },
            {
              id: 'ebakuw8-web-direct-0.3.0',
              ruleset: ebakuw8.ruleset,
              runtime: 'web',
              channel: 'direct',
            },
          ],
          { old: ['older'], stages: [ebakuw8.ruleset] },
        ),
      ],
      [...rulesets, older],
    ).get('ebakuw8');
    expect(game?.modes[0]).toBe(ebakuw8.modes?.[0]);
    expect(game?.modes).toContain('retired');
  });
});
