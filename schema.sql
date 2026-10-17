-- Menu: D1 schema
CREATE TABLE IF NOT EXISTS accounts (
  handle        TEXT PRIMARY KEY,
  school        TEXT NOT NULL,
  club          TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  last_post_at  TEXT,            -- ISO; drives polling tier
  pinned_count  INTEGER DEFAULT 0,
  fail_count    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS buildings (
  id      TEXT PRIMARY KEY,
  school  TEXT NOT NULL,
  name    TEXT NOT NULL,
  lat     REAL, lng REAL,
  approx  INTEGER DEFAULT 0,
  aliases TEXT NOT NULL           -- JSON array, lowercase
);

CREATE TABLE IF NOT EXISTS posts (
  shortcode   TEXT PRIMARY KEY,   -- dedupe key (collab posts appear under several accounts)
  account     TEXT NOT NULL,
  posted_at   TEXT NOT NULL,
  caption     TEXT,
  media_type  TEXT,
  image_keys  TEXT,               -- JSON array of R2 keys
  llm_status  TEXT NOT NULL DEFAULT 'pending', -- pending|done|not_event|error
  llm_raw     TEXT,               -- raw tool output, kept so we can re-parse without re-scraping
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  shortcode    TEXT NOT NULL REFERENCES posts(shortcode),
  school       TEXT NOT NULL,
  account      TEXT NOT NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  date         TEXT NOT NULL,      -- YYYY-MM-DD local
  start_at     TEXT,               -- ISO with offset, null if not posted
  end_at       TEXT,
  building_id  TEXT,
  location_raw TEXT,
  room         TEXT,
  food         TEXT,
  free_food    INTEGER DEFAULT 0,
  price        TEXT,
  category     TEXT,
  flags        TEXT,               -- JSON array
  confidence   REAL,
  status       TEXT NOT NULL DEFAULT 'active' -- active|cancelled|postponed
);
CREATE INDEX IF NOT EXISTS events_date ON events(date);

CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  handles     INTEGER,
  status      TEXT,
  items       INTEGER,
  new_posts   INTEGER,
  events      INTEGER,
  usd         REAL
);
