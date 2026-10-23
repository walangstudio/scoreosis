-- Players choose their public name. NULL = never named: their verified
-- results are kept but stay off every board until they choose one.
-- Players created before this migration had generated Guest names and start unnamed.
ALTER TABLE players ADD COLUMN name_set_at INTEGER;
