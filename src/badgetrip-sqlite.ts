import type {
  AchievementStore,
  Event,
  EventStore,
  ScoreStore,
  Stores,
  StreakStore,
} from '@walangstudio/badgetrip-core';
import { matchFilter } from '@walangstudio/badgetrip-core';

export const BADGETRIP_SCHEMA = `
CREATE TABLE IF NOT EXISTS bt_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  ts REAL NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bt_events_actor_type ON bt_events (actor, type, ts, seq);
CREATE TABLE IF NOT EXISTS bt_scores (
  actor TEXT NOT NULL,
  score TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (actor, score)
);
CREATE TABLE IF NOT EXISTS bt_score_deltas (
  actor TEXT NOT NULL,
  score TEXT NOT NULL,
  delta REAL NOT NULL,
  ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS bt_score_deltas_score_ts ON bt_score_deltas (score, ts);
CREATE TABLE IF NOT EXISTS bt_achievements (
  actor TEXT NOT NULL,
  code TEXT NOT NULL,
  at REAL NOT NULL,
  PRIMARY KEY (actor, code)
);
CREATE TABLE IF NOT EXISTS bt_streaks (
  actor TEXT NOT NULL,
  code TEXT NOT NULL,
  key TEXT NOT NULL,
  current INTEGER NOT NULL,
  best INTEGER NOT NULL,
  last_tick REAL NOT NULL,
  PRIMARY KEY (actor, code, key)
);
`;

// Streak keys: '' means "no key"; real keys get a prefix so '' stays distinct.
const keyOf = (key: string | undefined) => (key === undefined ? '' : `k:${key}`);

type EventRow = { id: string; actor: string; type: string; ts: number; payload: string };

/**
 * BadgeTrip stores over Durable Object SQLite. Every method is a synchronous SQL
 * statement, so each is atomic and the whole set joins an enclosing
 * `ctx.storage.transaction`.
 */
export function sqliteStores(sql: SqlStorage): Stores {
  sql.exec(BADGETRIP_SCHEMA);

  const events: EventStore = {
    async append(e: Event) {
      const inserted = sql.exec(
        'INSERT INTO bt_events (id, actor, type, ts, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING seq',
        e.id,
        e.actor,
        e.type,
        e.ts,
        JSON.stringify(e.payload ?? {}),
      );
      return inserted.toArray().length > 0;
    },
    async *read(opts) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (opts.actor !== undefined) {
        where.push('actor = ?');
        args.push(opts.actor);
      }
      if (opts.type !== undefined) {
        where.push('type = ?');
        args.push(opts.type);
      }
      if (opts.since !== undefined) {
        where.push('ts >= ?');
        args.push(opts.since);
      }
      const limit = opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : '';
      const rows = sql
        .exec<EventRow>(
          `SELECT id, actor, type, ts, payload FROM bt_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ts, seq${limit}`,
          ...args,
        )
        .toArray();
      for (const r of rows) {
        yield { id: r.id, actor: r.actor, type: r.type, ts: r.ts, payload: JSON.parse(r.payload) };
      }
    },
    async count(opts) {
      if (!opts.where) {
        const row = sql
          .exec<{ n: number }>(
            'SELECT count(*) AS n FROM bt_events WHERE actor = ? AND type = ?',
            opts.actor,
            opts.type,
          )
          .one();
        return row.n;
      }
      let n = 0;
      for await (const e of events.read({ actor: opts.actor, type: opts.type })) {
        if (matchFilter(e, opts.where)) n++;
      }
      return n;
    },
  };

  const scores: ScoreStore = {
    async get(actor, score) {
      const rows = sql
        .exec<{ value: number }>(
          'SELECT value FROM bt_scores WHERE actor = ? AND score = ?',
          actor,
          score,
        )
        .toArray();
      return rows[0]?.value ?? 0;
    },
    async apply(d) {
      sql.exec(
        'INSERT INTO bt_score_deltas (actor, score, delta, ts) VALUES (?, ?, ?, ?)',
        d.actor,
        d.score,
        d.delta,
        d.ts,
      );
      return sql
        .exec<{ value: number }>(
          'INSERT INTO bt_scores (actor, score, value) VALUES (?, ?, ?) ON CONFLICT (actor, score) DO UPDATE SET value = value + excluded.value RETURNING value',
          d.actor,
          d.score,
          d.delta,
        )
        .one().value;
    },
    async top(score, limit, window) {
      const rows = window
        ? sql.exec<{ actor: string; value: number }>(
            'SELECT actor, sum(delta) AS value FROM bt_score_deltas WHERE score = ? AND ts >= ? GROUP BY actor ORDER BY value DESC, actor ASC LIMIT ?',
            score,
            window.since,
            limit,
          )
        : sql.exec<{ actor: string; value: number }>(
            'SELECT actor, value FROM bt_scores WHERE score = ? ORDER BY value DESC, actor ASC LIMIT ?',
            score,
            limit,
          );
      return rows.toArray().map((r) => ({ actor: r.actor, value: r.value }));
    },
  };

  const achievements: AchievementStore = {
    async award(actor, code, at) {
      return (
        sql
          .exec(
            'INSERT INTO bt_achievements (actor, code, at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING code',
            actor,
            code,
            at,
          )
          .toArray().length > 0
      );
    },
    async list(actor) {
      return sql
        .exec<{ code: string; at: number }>(
          'SELECT code, at FROM bt_achievements WHERE actor = ?',
          actor,
        )
        .toArray()
        .map((r) => ({ code: r.code, at: r.at }));
    },
    async has(actor, code) {
      return (
        sql
          .exec('SELECT 1 FROM bt_achievements WHERE actor = ? AND code = ?', actor, code)
          .toArray().length > 0
      );
    },
  };

  const streaks: StreakStore = {
    async get(actor, code, key) {
      const row = sql
        .exec<{ current: number; best: number; last_tick: number }>(
          'SELECT current, best, last_tick FROM bt_streaks WHERE actor = ? AND code = ? AND key = ?',
          actor,
          code,
          keyOf(key),
        )
        .toArray()[0];
      return row
        ? { current: row.current, best: row.best, lastTick: row.last_tick }
        : { current: 0, best: 0, lastTick: 0 };
    },
    async tick(actor, code, key, at) {
      const row = sql
        .exec<{ current: number; best: number }>(
          `INSERT INTO bt_streaks (actor, code, key, current, best, last_tick) VALUES (?, ?, ?, 1, 1, ?)
           ON CONFLICT (actor, code, key) DO UPDATE SET current = current + 1, best = max(best, current + 1), last_tick = excluded.last_tick
           RETURNING current, best`,
          actor,
          code,
          keyOf(key),
          at,
        )
        .one();
      return { current: row.current, best: row.best };
    },
    async reset(actor, code, key, at) {
      const before = sql
        .exec<{ current: number }>(
          'SELECT current FROM bt_streaks WHERE actor = ? AND code = ? AND key = ?',
          actor,
          code,
          keyOf(key),
        )
        .toArray()[0];
      sql.exec(
        `INSERT INTO bt_streaks (actor, code, key, current, best, last_tick) VALUES (?, ?, ?, 0, 0, ?)
         ON CONFLICT (actor, code, key) DO UPDATE SET current = 0, last_tick = excluded.last_tick`,
        actor,
        code,
        keyOf(key),
        at,
      );
      return before?.current ?? 0;
    },
  };

  return { events, scores, achievements, streaks };
}
