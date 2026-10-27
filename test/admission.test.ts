import { createScheduledController, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { BUILD, api, guest } from './client.js';
import { RULESET } from './fixtures.js';

const CAP = 3; // MAX_RUNS_PER_ADDRESS in vitest.config.ts
const ADMIN = { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789' };

const used = async () =>
  (await env.DB.prepare('SELECT sum(runs_started) AS n FROM usage').first<{ n: number | null }>())
    ?.n ?? 0;
const attempts = async () =>
  (await env.DB.prepare('SELECT sum(runs) AS n FROM admissions').first<{ n: number | null }>())
    ?.n ?? 0;

async function startFrom(ip: string, token?: string) {
  const player = token ?? (await guest());
  const res = await api('/v1/games/ahsteroids/runs', {
    token: player,
    body: { build_id: BUILD },
    headers: { 'cf-connecting-ip': ip },
  });
  if (res.status === 201) {
    await api(`/v1/games/ahsteroids/runs/${res.body.run_id}/abandon`, { token: player, body: {} });
  }
  return res;
}

describe('per-address admission', () => {
  it('caps the daily runs one address can start, whatever the number of guests', async () => {
    const before = await used();
    const statuses = [];
    for (let i = 0; i < CAP + 2; i++) statuses.push((await startFrom('198.51.100.77')).status);
    expect(statuses).toEqual([201, 201, 201, 429, 429]);
    expect(await used()).toBe(before + CAP);

    const denied = await startFrom('198.51.100.77');
    expect(denied.body.error.code).toBe('address_limit');
    const retry = Number(denied.headers.get('retry-after'));
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    expect(retry).toBeGreaterThan(0);
    expect(Math.abs(retry - (midnight - Date.now()) / 1000)).toBeLessThanOrEqual(5);
    expect((await startFrom('198.51.100.78')).status).toBe(201);
  });

  it('stops writing once an address is over its share', async () => {
    for (let i = 0; i < CAP + 1; i++) await startFrom('198.51.100.90');
    const after = await attempts();
    for (let i = 0; i < 3; i++) expect((await startFrom('198.51.100.90')).status).toBe(429);
    expect(await attempts()).toBe(after);
  });

  it('admits exactly the share under concurrent starts', async () => {
    const before = await used();
    const tokens = await Promise.all(Array.from({ length: CAP + 4 }, () => guest()));
    const results = await Promise.all(tokens.map((t) => startFrom('198.51.100.91', t)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(CAP);
    expect(results.filter((r) => r.status === 429)).toHaveLength(4);
    expect(await used()).toBe(before + CAP);
  });

  it('spends one slot when the same player starts twice at once', async () => {
    const [usedBefore, attemptsBefore] = [await used(), await attempts()];
    const token = await guest();
    const start = () =>
      api('/v1/games/ahsteroids/runs', {
        token,
        body: { build_id: BUILD },
        headers: { 'cf-connecting-ip': '198.51.100.95' },
      });
    const results = await Promise.all([start(), start()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect([await used(), await attempts()]).toEqual([usedBefore + 1, attemptsBefore + 1]);
  });

  it('groups IPv6 by /64 in every spelling, and IPv4-mapped addresses by IPv4', async () => {
    const v6 = [
      '2001:db8:7:7::1',
      '2001:0db8:0007:0007:0:0:0:2',
      '2001:DB8:7:7::3',
      '2001:db8:7:7::4',
    ];
    const statuses = [];
    for (const ip of v6) statuses.push((await startFrom(ip)).status);
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect((await startFrom('2001:db8:7:8::1')).status).toBe(201);
    // 2001:0:0:5::/64 must not merge with 2001::/64.
    for (let i = 0; i < CAP; i++) await startFrom(`2001::${i + 1}`);
    expect((await startFrom('2001::5:6:7:8:9')).status).toBe(201);

    for (let i = 0; i < CAP; i++) await startFrom('198.51.100.92');
    expect((await startFrom('::ffff:198.51.100.92')).status).toBe(429);
  });

  it('spends no counter for a disabled ruleset or a full day', async () => {
    const disable = await api(`/v1/admin/games/ahsteroids/rulesets/${RULESET}/disable`, {
      body: {},
      headers: ADMIN,
    });
    expect(disable.status).toBe(200);
    const [u, a] = [await used(), await attempts()];
    const off = await startFrom('198.51.100.93');
    await env.DB.prepare('DELETE FROM disabled_rulesets').run();
    await env.DB.prepare('UPDATE results SET suppressed = 0').run();
    expect(off.body.error.code).toBe('ruleset_disabled');
    expect([await used(), await attempts()]).toEqual([u, a]);

    const day = new Date().toISOString().slice(0, 10);
    const saved = await used();
    await env.DB.prepare('INSERT OR REPLACE INTO usage (day, runs_started) VALUES (?, 1000)')
      .bind(day)
      .run();
    const a2 = await attempts();
    const full = await startFrom('198.51.100.94');
    await env.DB.prepare('UPDATE usage SET runs_started = ? WHERE day = ?').bind(saved, day).run();
    expect(full.status).toBe(503);
    expect(full.body.error.code).toBe('capacity');
    expect(await attempts()).toBe(a2);
  });

  it('stores only a keyed hash of the address', async () => {
    await startFrom('203.0.113.199');
    const { results } = await env.DB.prepare('SELECT address FROM admissions').all<{
      address: string;
    }>();
    const day = new Date().toISOString().slice(0, 10);
    const plain = await sha256(`${day}:203.0.113.199`);
    expect(results.length).toBeGreaterThan(0);
    for (const row of results) {
      expect(row.address).toMatch(/^[0-9a-f]{64}$/);
      expect(row.address).not.toBe(plain);
    }
  });

  it('prunes days before yesterday in the daily job', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const [old, kept] = ['a'.repeat(64), 'b'.repeat(64)];
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO admissions (day, address, runs) VALUES ('2000-01-01', ?, 1)",
      ).bind(old),
      env.DB.prepare('INSERT INTO admissions (day, address, runs) VALUES (?, ?, 1)').bind(
        yesterday,
        kept,
      ),
    ]);
    await worker.scheduled(createScheduledController(), env);
    const days = await env.DB.prepare(
      'SELECT day FROM admissions WHERE address IN (?, ?) ORDER BY day',
    )
      .bind(old, kept)
      .all<{ day: string }>();
    expect(days.results.map((r) => r.day)).toEqual([yesterday]);
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
