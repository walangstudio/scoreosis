export type PublishedResult = {
  run_id: string;
  game_id: string;
  board: string;
  ruleset: string;
  player_id: string;
  score: number;
  runtime: string;
  channel: string;
  country: string | null;
  accepted_at: number;
  facts: Record<string, number>;
};

export const PAGE_SIZE = 25;
export const MAX_RANK = 100;

/**
 * Idempotent per run id. A personal best only moves up, so retries and
 * out-of-order delivery never replace a better score with a worse one.
 */
export async function publishResult(db: D1Database, r: PublishedResult): Promise<void> {
  const country = r.country ?? '';
  await db.batch([
    db
      .prepare(
        `INSERT INTO results (run_id, game_id, board, ruleset, player_id, score, runtime, channel, country, accepted_at, facts, suppressed)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
           EXISTS (SELECT 1 FROM suppressed_runs WHERE run_id = ?1)
           OR EXISTS (SELECT 1 FROM disabled_rulesets WHERE game_id = ?2 AND ruleset = ?4))
         ON CONFLICT (run_id) DO NOTHING`,
      )
      .bind(
        r.run_id,
        r.game_id,
        r.board,
        r.ruleset,
        r.player_id,
        r.score,
        r.runtime,
        r.channel,
        country,
        r.accepted_at,
        JSON.stringify(r.facts),
      ),
    db
      .prepare(
        `INSERT INTO bests (game_id, board, player_id, country, runtime, channel, score, run_id, accepted_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM results WHERE run_id = ? AND suppressed = 1)
         ON CONFLICT (game_id, board, player_id, country, runtime, channel) DO UPDATE SET
           score = excluded.score, run_id = excluded.run_id, accepted_at = excluded.accepted_at
         WHERE excluded.score > bests.score`,
      )
      .bind(
        r.game_id,
        r.board,
        r.player_id,
        country,
        r.runtime,
        r.channel,
        r.score,
        r.run_id,
        r.accepted_at,
        r.run_id,
      ),
  ]);
}

export type BoardFilter = {
  game: string;
  board: string;
  country: string | null;
  runtime: string | null;
  channel: string | null;
};

export type BoardEntry = { rank: number; player_id: string; name: string; score: number };

// Each player's best within the filter, earliest accepted on ties; unknown
// country ('') never matches a country filter. Unnamed players are left out.
const BEST = `
  WITH candidates AS (
    SELECT b.player_id, b.score, b.accepted_at, b.run_id,
      row_number() OVER (PARTITION BY b.player_id ORDER BY b.score DESC, b.accepted_at, b.run_id) AS n
    FROM bests b JOIN players p ON p.game_id = b.game_id AND p.player_id = b.player_id
    WHERE b.game_id = ?1 AND b.board = ?2 AND b.score > 0 AND p.hidden = 0 AND p.name_set_at IS NOT NULL
      AND (?3 IS NULL OR b.country = ?3) AND (?4 IS NULL OR b.runtime = ?4) AND (?5 IS NULL OR b.channel = ?5)
  ),
  best AS (SELECT player_id, score, accepted_at, run_id FROM candidates WHERE n = 1)`;

const filterArgs = (f: BoardFilter) => [f.game, f.board, f.country, f.runtime, f.channel];

export async function leaderboardPage(
  db: D1Database,
  f: BoardFilter,
  page: number,
): Promise<BoardEntry[]> {
  const { results } = await db
    .prepare(
      `${BEST}
       SELECT best.player_id, best.score, rank() OVER (ORDER BY best.score DESC) AS rank, p.display_name AS name
       FROM best JOIN players p ON p.game_id = ?1 AND p.player_id = best.player_id
       ORDER BY best.score DESC, best.accepted_at ASC, best.run_id ASC
       LIMIT ?6 OFFSET ?7`,
    )
    .bind(...filterArgs(f), PAGE_SIZE, page * PAGE_SIZE)
    .all<BoardEntry>();
  return results.map((r) => ({
    rank: r.rank,
    player_id: r.player_id,
    name: r.name,
    score: r.score,
  }));
}

export async function playerRank(
  db: D1Database,
  f: BoardFilter,
  player: string,
): Promise<{ rank: number; score: number } | null> {
  return db
    .prepare(
      `${BEST}
       SELECT (SELECT count(*) FROM best other WHERE other.score > me.score) + 1 AS rank, me.score AS score
       FROM best me WHERE me.player_id = ?6`,
    )
    .bind(...filterArgs(f), player)
    .first<{ rank: number; score: number }>();
}

/** Rebuilds personal bests for a game from unsuppressed results (after moderation). */
export async function rebuildBests(db: D1Database, game: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM bests WHERE game_id = ?').bind(game),
    db
      .prepare(
        `INSERT INTO bests (game_id, board, player_id, country, runtime, channel, score, run_id, accepted_at)
         SELECT game_id, board, player_id, country, runtime, channel, score, run_id, accepted_at FROM (
           SELECT *, row_number() OVER (
             PARTITION BY board, player_id, country, runtime, channel ORDER BY score DESC, accepted_at ASC, run_id ASC
           ) AS n FROM results WHERE game_id = ? AND suppressed = 0
         ) WHERE n = 1`,
      )
      .bind(game),
  ]);
}

/** Deletes expired results that no personal best points at. Bounded per call. */
export async function pruneResults(db: D1Database, before: number, limit = 500): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM results WHERE run_id IN (
         SELECT run_id FROM results r WHERE r.accepted_at < ?
           AND NOT EXISTS (SELECT 1 FROM bests b WHERE b.run_id = r.run_id) LIMIT ?)`,
    )
    .bind(before, limit)
    .run();
  return res.meta.changes;
}
