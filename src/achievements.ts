import {
  type AchievementView,
  type Definitions,
  type Stores,
  createEngine,
} from '@walangstudio/badgetrip-core';
import type { AchievementSpec } from './games.js';

export const RUN_EVENT = 'run.verified';

const bestScore = (fact: string) => `best_${fact}`;
const totalScore = (fact: string) => `total_${fact}`;
const gainPath = (fact: string) => `best_gain_${fact}`;

/**
 * Translates a game's declared achievements into BadgeTrip definitions. One
 * `run.verified` event per finished run carries the authoritative facts:
 * "run" achievements track a best-ever score (raised by non-negative gains),
 * "total" achievements accumulate the fact across runs.
 */
export function definitionsFor(specs: AchievementSpec[]): Definitions {
  const runFacts = new Set(specs.filter((s) => s.mode === 'run').map((s) => s.fact));
  const totalFacts = new Set(specs.filter((s) => s.mode === 'total').map((s) => s.fact));
  return {
    scores: [...[...runFacts].map(bestScore), ...[...totalFacts].map(totalScore)],
    points: [
      ...[...runFacts].map((f) => ({
        on: RUN_EVENT,
        score: bestScore(f),
        delta: { path: `payload.${gainPath(f)}` },
      })),
      ...[...totalFacts].map((f) => ({
        on: RUN_EVENT,
        score: totalScore(f),
        delta: { path: `payload.${f}` },
      })),
    ],
    achievements: specs.map((s) => ({
      code: s.id,
      name: s.name,
      description: s.description,
      rarity: 1,
      rule: {
        kind: 'score',
        score: s.mode === 'run' ? bestScore(s.fact) : totalScore(s.fact),
        gte: s.gte,
      },
    })),
  };
}

export function achievementEngine(stores: Stores, specs: AchievementSpec[], now: () => number) {
  return createEngine({ ...stores, clock: { now }, definitions: definitionsFor(specs) });
}

/** Applies one verified run. Idempotent per run id; returns newly unlocked achievement ids. */
export async function recordVerifiedRun(
  engine: ReturnType<typeof achievementEngine>,
  specs: AchievementSpec[],
  actor: string,
  runId: string,
  ts: number,
  facts: Record<string, number>,
): Promise<string[]> {
  const payload: Record<string, number> = { ...facts };
  for (const fact of new Set(specs.filter((s) => s.mode === 'run').map((s) => s.fact))) {
    const best = await engine.score(actor, bestScore(fact));
    payload[gainPath(fact)] = Math.max(0, (facts[fact] ?? 0) - best);
  }
  const result = await engine.emit({ id: `run:${runId}`, actor, type: RUN_EVENT, ts, payload });
  return result.unlocked;
}

export type VerifiedAchievement = Pick<
  AchievementView,
  'code' | 'name' | 'description' | 'unlocked' | 'unlockedAt' | 'progress'
>;
