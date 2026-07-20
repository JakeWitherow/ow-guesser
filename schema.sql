-- OW Guessr gameplay stats — D1 schema
-- One row per COMPLETED puzzle attempt that counts toward stats (i.e. the
-- exact same "isReplay" check the front-end already uses locally: replays
-- of a day you've already finished before are not sent here at all).

CREATE TABLE IF NOT EXISTS plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  day          INTEGER NOT NULL,          -- puzzle day number
  difficulty   TEXT,                      -- Bronze / Silver / Gold / ... (nullable)
  is_archive   INTEGER NOT NULL DEFAULT 0,-- 1 if played from the archive, 0 if on release day
  win          INTEGER NOT NULL DEFAULT 0,-- 1 = solved, 0 = lost / gave up
  gave_up      INTEGER NOT NULL DEFAULT 0,-- 1 = ended via "reveal answer"
  guess_count  INTEGER,                   -- 1-6 guesses used (NULL if gave up on guess 1 with 0 guesses made — rare)
  streak       INTEGER,                   -- the player's streak value *after* this result (release-day wins only; NULL otherwise)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_plays_day ON plays(day);
CREATE INDEX IF NOT EXISTS idx_plays_created_at ON plays(created_at);

-- Simple per-IP rate limiter for /api/guess (and reusable elsewhere), so
-- that scripting a field-by-field brute-force of a day's answer isn't
-- practical. Not a security boundary on its own — paired with the
-- answers no longer being shipped to the client at all.
CREATE TABLE IF NOT EXISTS rate_limit (
  ip           TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

