import {
  memoryAchievementStore,
  memoryEventStore,
  memoryScoreStore,
  memoryStreakStore,
} from '@walangstudio/badgetrip-core';
import { describe, expect, it } from 'vitest';
import { achievementEngine, recordVerifiedRun } from '../src/achievements.js';
import { registry } from '../src/games.js';

const specs = registry.get('ahsteroids')?.achievements ?? [];

function engine() {
  return achievementEngine(
    {
      events: memoryEventStore(),
      scores: memoryScoreStore(),
      achievements: memoryAchievementStore(),
      streaks: memoryStreakStore(),
    },
    specs,
    () => 0,
  );
}

describe('achievement catalog', () => {
  it('ships the 12 Ah!Steroids achievements', () => {
    expect(specs.map((s) => s.id)).toEqual([
      'survive_60',
      'survive_120',
      'score_5000',
      'score_20000',
      'kills_1',
      'kills_100',
      'kills_1000',
      'large_kill',
      'steroid',
      'mastery_3',
      'close_saves_10',
      'fleet_60',
    ]);
  });

  for (const spec of specs) {
    it(`${spec.id} unlocks exactly at ${spec.fact} >= ${spec.gte} (${spec.mode})`, async () => {
      const e = engine();
      if (spec.mode === 'run') {
        expect(
          await recordVerifiedRun(e, specs, 'p', 'a', 1, { [spec.fact]: spec.gte - 1 }),
        ).not.toContain(spec.id);
        expect(
          await recordVerifiedRun(e, specs, 'p', 'b', 2, { [spec.fact]: spec.gte - 1 }),
        ).not.toContain(spec.id);
        expect(await recordVerifiedRun(e, specs, 'p', 'c', 3, { [spec.fact]: spec.gte })).toContain(
          spec.id,
        );
      } else {
        const half = Math.floor(spec.gte / 2);
        expect(await recordVerifiedRun(e, specs, 'p', 'a', 1, { [spec.fact]: half })).not.toContain(
          spec.id,
        );
        expect(
          await recordVerifiedRun(e, specs, 'p', 'b', 2, { [spec.fact]: spec.gte - half - 1 }),
        ).not.toContain(spec.id);
        expect(await recordVerifiedRun(e, specs, 'p', 'c', 3, { [spec.fact]: 1 })).toContain(
          spec.id,
        );
      }
    });
  }

  it('counts a replayed run event once', async () => {
    const e = engine();
    await recordVerifiedRun(e, specs, 'p', 'same', 1, { kills: 60 });
    await recordVerifiedRun(e, specs, 'p', 'same', 1, { kills: 60 });
    expect(await e.score('p', 'total_kills')).toBe(60);
  });

  it('reports best-run progress toward single-run achievements', async () => {
    const e = engine();
    await recordVerifiedRun(e, specs, 'p', 'a', 1, { score: 12000 });
    await recordVerifiedRun(e, specs, 'p', 'b', 2, { score: 3000 });
    expect(await e.progress('p', 'score_20000')).toEqual({
      current: 12000,
      target: 20000,
      percent: 60,
    });
  });
});
