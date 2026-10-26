ALTER TABLE results ADD COLUMN entry_name TEXT;

UPDATE results SET entry_name = (
  SELECT display_name FROM players p
  WHERE p.game_id = results.game_id AND p.player_id = results.player_id AND p.name_set_at IS NOT NULL
)
WHERE EXISTS (SELECT 1 FROM bests b WHERE b.run_id = results.run_id);

CREATE TRIGGER immutable_entry_name BEFORE UPDATE OF entry_name ON results
WHEN OLD.entry_name IS NOT NULL AND NEW.entry_name IS NOT OLD.entry_name
BEGIN SELECT RAISE(ABORT, 'score entry names are immutable'); END;

CREATE INDEX results_arcade_rank ON results (game_id, board, runtime, score DESC, accepted_at, run_id)
WHERE suppressed = 0 AND score > 0 AND entry_name IS NOT NULL;
CREATE INDEX results_arcade_retention ON results (game_id, board, country, runtime, channel, score DESC, accepted_at, run_id)
WHERE suppressed = 0 AND score > 0 AND entry_name IS NOT NULL;
