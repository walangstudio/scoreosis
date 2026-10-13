import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { BASE, Player, api } from './client.js';
import { BUILD, RULESET } from './fixtures.js';

const ADMIN = { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789' };

describe('public API', () => {
  it('reports health and game metadata', async () => {
    expect((await api('/v1/health')).body).toEqual({ ok: true, games: ['ahsteroids'] });
    const game = await api('/v1/games/ahsteroids');
    expect(game.body).toMatchObject({ id: 'ahsteroids', boards: ['classic'] });
    expect(game.body.achievements).toHaveLength(12);
    expect((await api('/v1/games/nope')).status).toBe(404);
  });

  it('returns stable error envelopes', async () => {
    const res = await api('/v1/nowhere');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'not_found', message: 'no such route' } });
    const bad = await SELF.fetch(`${BASE}/v1/guests`, { method: 'POST', body: '{' });
    expect(bad.status).toBe(400);
  });

  it('allows CORS only for configured origins', async () => {
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
