import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from 'cloudflare:test';
import type { Stores } from '@walangstudio/badgetrip-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { achievementEngine, recordVerifiedRun } from '../src/achievements.js';
import { sqliteStores } from '../src/badgetrip-sqlite.js';
import { registry } from '../src/games.js';
import { type PublishedResult, publishResult } from '../src/leaderboard.js';
import { Player, api, stubFor, useClock } from './client.js';

afterEach(() => {
  vi.useRealTimers();
});

const specs = registry.get('ahsteroids')?.achievements ?? [];

describe('recovery', () => {
  it('restores the verifier from a checkpoint after eviction with an identical result', async () => {
    const clock = useClock();
    const a = await Player.create(12345);
    await a.start();
    const reference = await a.playToEnd(clock);

    const b = await Player.create(12345);
    await b.start();
    // Same seed inputs but a different server seed: compare against b's own client instead.
    let evictions = 0;
    while (!b.finished) {
      clock.advance(1000);
      expect((await b.send(b.play())).status).toBe(200);
      if (b.seq % 7 === 0) {
        await evictDurableObject(stubFor(b.token));
        evictions++;
      }
    }
    let res = await b.finish();
    for (let i = 0; i < 30 && res.body.status === 'verifying'; i++) {
      clock.advance(1000);
      res = await b.finish();
    }
    expect(evictions).toBeGreaterThan(1);
    expect(reference.body.status).toBe('finished');
    expect(res.body.status).toBe('finished');
    const clientFacts = Object.fromEntries(
      b.vm
        .call('sv_facts')
        .split('\n')
        .map((l) => l.split('='))
        .map(([k, v]) => [k, Number(v)]),
    );
    expect(res.body.facts).toEqual(clientFacts);
  });

  it('finalizes once under concurrent finish requests', async () => {
    const clock = useClock();
    const player = await Player.create(6);
    await player.start();
    while (!player.finished) {
      clock.advance(1000);
      await player.send(player.play());
    }
    const results = await Promise.all([player.finish(), player.finish(), player.finish()]);
    for (const r of results) expect(r.body.status).toBe('finished');
    const events = await runInDurableObject(stubFor(player.token), (_, state) =>
      state.storage.sql.exec('SELECT count(*) AS n FROM bt_events').one(),
    );
    expect(events.n).toBe(1);
  });

  it('rolls back every BadgeTrip write when finalization fails at any stage', async () => {
    const player = await Player.create();
    const stub = stubFor(player.token);
    const facts = {
      score: 25000,
      kills: 150,
      survival_ticks: 8000,
      fleet_ticks: 4000,
      large_kills: 2,
      steroids: 1,
      mastery: 3,
      close_saves: 12,
    };
    const counts = (sql: SqlStorage) =>
      ['bt_events', 'bt_scores', 'bt_score_deltas', 'bt_achievements', 'outbox'].map(
        (t) => sql.exec(`SELECT count(*) AS n FROM ${t}`).one().n,
      );
    for (let failAt = 1; failAt < 40; failAt++) {
      const outcome = await runInDurableObject(stub, async (_, state) => {
        const sql = state.storage.sql;
        const real = sqliteStores(sql);
        const before = counts(sql);
        let calls = 0;
        const stores = failingStores(real, () => ++calls === failAt);
        let failed = false;
        try {
          await state.storage.transaction(async () => {
            const engine = achievementEngine(stores, specs, () => 1);
            await recordVerifiedRun(engine, specs, 'p', `r${failAt}`, 1, facts);
            sql.exec(
              "INSERT INTO outbox (run_id, payload, attempts, next_attempt_at) VALUES (?, '{}', 0, 0)",
              `r${failAt}`,
            );
            if (calls < failAt) throw new Error('fail after the last store call');
          });
        } catch {
          failed = true;
        }
        return { failed, before, after: counts(sql), calls };
      });
      expect(outcome.failed).toBe(true);
      expect(outcome.after).toEqual(outcome.before);
      if (outcome.calls < failAt) break;
    }
  });

  it('keeps the result pending while D1 is down and publishes it from the outbox', async () => {
    const clock = useClock();
    const player = await Player.create(2);
    await player.start();
    await env.DB.exec('ALTER TABLE bests RENAME TO bests_offline');
    let first: Awaited<ReturnType<Player['finish']>>;
    try {
      while (!player.finished) {
        clock.advance(1000);
        await player.send(player.play());
      }
      first = await player.finish();
    } finally {
      await env.DB.exec('ALTER TABLE bests_offline RENAME TO bests');
    }
    expect(first.body).toMatchObject({ status: 'finished', published: false });
    clock.advance(10_000);
    expect(await runDurableObjectAlarm(stubFor(player.token))).toBe(true);
    const again = await player.finish();
    expect(again.body.published).toBe(true);
    const board = await api('/v1/games/ahsteroids/leaderboards?me=1', { token: player.token });
    expect(board.body.me).toEqual({ rank: expect.any(Number), score: first.body.score });
  });

  it('never lets a late or duplicate publication lower a personal best', async () => {
    const base: PublishedResult = {
      run_id: '',
      game_id: 'ahsteroids',
      board: 'classic',
      ruleset: '45629a5a0139f70a',
      player_id: 'f'.repeat(32),
      score: 0,
      runtime: 'web',
      channel: 'direct',
      country: 'PH',
      accepted_at: 1,
      facts: {},
    };
    await env.DB.prepare(
      "INSERT INTO players (game_id, player_id, display_name, created_at) VALUES ('ahsteroids', ?, 'X', 0)",
    )
      .bind(base.player_id)
      .run();
    await publishResult(env.DB, { ...base, run_id: 'better', score: 900, accepted_at: 2 });
    await publishResult(env.DB, { ...base, run_id: 'worse', score: 400, accepted_at: 1 });
    await publishResult(env.DB, { ...base, run_id: 'better', score: 900, accepted_at: 2 });
    const best = await env.DB.prepare('SELECT score, run_id FROM bests WHERE player_id = ?')
      .bind(base.player_id)
      .all();
    expect(best.results).toEqual([{ score: 900, run_id: 'better' }]);
    const results = await env.DB.prepare('SELECT count(*) AS n FROM results WHERE player_id = ?')
      .bind(base.player_id)
      .first();
    expect(results?.n).toBe(2);
  });
});

/** Wraps every store method so the call for which `shouldFail()` is true throws. */
function failingStores(stores: Stores, shouldFail: () => boolean): Stores {
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (shouldFail()) throw new Error(`injected failure in ${String(key)}`);
          return value.apply(obj, args);
        };
      },
    });
  return {
    events: wrap(stores.events),
    scores: wrap(stores.scores),
    achievements: wrap(stores.achievements),
    streaks: wrap(stores.streaks),
  };
}
