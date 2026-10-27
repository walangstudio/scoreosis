-- Ranked runs started per day from one network address, so one address cannot
-- spend the whole daily allowance. `address` is SHA-256 of "<day>:<address key>",
-- never the raw address; rows older than yesterday are pruned daily.
CREATE TABLE admissions (
  day TEXT NOT NULL,
  address TEXT NOT NULL,
  runs INTEGER NOT NULL,
  PRIMARY KEY (day, address)
);
