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
import { RULESET } from './fixtures.js';

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
  }, 60_000);

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
      ruleset: RULESET,
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

/** Shrinks one player's verifier budget so input piles up unverified. */
async function starve(token: string, instructions: number) {
  await runInDurableObject(stubFor(token), (instance) => {
    Object.assign(instance, { env: { ...env, VERIFY_INSTRUCTIONS: String(instructions) } });
  });
}

// The starved-budget tests drain a large backlog one request at a time; a
// timeout would leave their loops advancing the shared fake clock for later tests.
describe('review regressions', () => {
  it('rejects input after the end even when it was queued behind the verifier', async () => {
    const clock = useClock();
    const player = await Player.create(3);
    await player.start();
    await starve(player.token, 20_000);
    while (!player.finished) {
      clock.advance(1000);
      expect((await player.send(player.play())).status).toBe(200);
    }
    clock.advance(1000);
    const extra = await player.send({ seq: player.seq, from_tick: player.tick, inputs: '60:0' });
    expect(extra.status).toBe(200);
    player.tick += 60;
    let res = await player.finish();
    for (let i = 0; i < 400 && res.body.status === 'verifying'; i++) {
      clock.advance(1000);
      await runDurableObjectAlarm(stubFor(player.token));
      res = await player.finish();
    }
    expect(res.body).toEqual({ status: 'rejected', reason: 'input_after_end' });
  }, 60_000);

  it('keeps verifying an older run while a new one plays', async () => {
    const clock = useClock();
    const player = await Player.create(5);
    await player.start();
    await starve(player.token, 150_000);
    while (!player.finished) {
      clock.advance(1000);
      await player.send(player.play());
    }
    expect((await player.finish()).body.status).toBe('verifying');
    const first = player.run.run_id;
    const firstTick = player.tick;
    await player.start();
    for (let s = 0; s < 20; s++) {
      clock.advance(1000);
      await player.send(player.play());
      await runDurableObjectAlarm(stubFor(player.token));
    }
    let res: Awaited<ReturnType<typeof api>> | undefined;
    for (let i = 0; i < 400; i++) {
      res = await api(`/v1/games/ahsteroids/runs/${first}/finish`, {
        token: player.token,
        body: { tick: firstTick },
      });
      if (res.body.status !== 'verifying') break;
      clock.advance(1000);
      await runDurableObjectAlarm(stubFor(player.token));
    }
    expect(res?.body.status).toBe('finished');
  }, 60_000);

  it('rejects a run whose checkpoint is corrupt instead of failing every request', async () => {
    const clock = useClock();
    const player = await Player.create(9);
    await player.start();
    for (let s = 0; s < 12; s++) {
      clock.advance(1000);
      await player.send(player.play());
    }
    const stub = stubFor(player.token);
    await runInDurableObject(stub, (_, state) => {
      state.storage.sql.exec("UPDATE checkpoints SET data = '{garbage'");
    });
    await evictDurableObject(stub);
    clock.advance(1000);
    const res = await player.send(player.play());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'rejected', reason: 'verifier_error' });
  });

  it('suppresses results of a ruleset disabled while the run was in flight', async () => {
    const clock = useClock();
    const player = await Player.create(4);
    await player.start();
    await api(`/v1/admin/games/ahsteroids/rulesets/${RULESET}/disable`, {
      body: {},
      headers: { authorization: 'Bearer test-admin-token-0123456789abcdef0123456789' },
    });
    try {
      const res = await player.playToEnd(clock);
      expect(res.body.status).toBe('finished');
      const row = await env.DB.prepare('SELECT suppressed FROM results WHERE run_id = ?')
        .bind(player.run.run_id)
        .first();
      expect(row?.suppressed).toBe(1);
      const best = await env.DB.prepare('SELECT 1 FROM bests WHERE run_id = ?')
        .bind(player.run.run_id)
        .first();
      expect(best).toBeNull();
    } finally {
      await env.DB.prepare('DELETE FROM disabled_rulesets').run();
    }
  });
});
