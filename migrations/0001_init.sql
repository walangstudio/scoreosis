-- Public projection of verified results. The player's Durable Object is the
-- source of truth; rows arrive through its publication outbox.

CREATE TABLE players (
  game_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (game_id, player_id)
);

-- Accepted runs. Retained 90 days unless a personal best still points at one.
CREATE TABLE results (
  run_id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  board TEXT NOT NULL,
  ruleset TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  runtime TEXT NOT NULL,
  channel TEXT NOT NULL,
  country TEXT NOT NULL, -- '' when unknown
  accepted_at INTEGER NOT NULL,
  facts TEXT NOT NULL,
  suppressed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX results_accepted ON results (accepted_at);
CREATE INDEX results_tuple ON results (game_id, board, player_id, country, runtime, channel, score);

-- One personal best per (game, board, player, country, runtime, channel).
CREATE TABLE bests (
  game_id TEXT NOT NULL,
  board TEXT NOT NULL,
  player_id TEXT NOT NULL,
  country TEXT NOT NULL,
  runtime TEXT NOT NULL,
  channel TEXT NOT NULL,
  score INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, board, player_id, country, runtime, channel)
);
CREATE INDEX bests_rank ON bests (game_id, board, score DESC);

CREATE TABLE disabled_rulesets (
  game_id TEXT NOT NULL,
  ruleset TEXT NOT NULL,
  disabled_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, ruleset)
);

-- Daily ranked admissions, the capacity guard for the free plan.
CREATE TABLE usage (
  day TEXT PRIMARY KEY,
  runs_started INTEGER NOT NULL
);
