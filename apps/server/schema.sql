CREATE TABLE IF NOT EXISTS contributors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_ip TEXT,
  banned INTEGER NOT NULL DEFAULT 0,
  -- +1 per approved review of their tiles, -2 per failed review, -1 per revert
  trust INTEGER NOT NULL DEFAULT 0
);

-- Only touched tiles have rows; a missing row means "open, never worked on".
CREATE TABLE IF NOT EXISTS tiles (
  key TEXT PRIMARY KEY,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | leased | done | needs_work
  prev_status TEXT,                         -- status to return to if a lease is abandoned
  lease_kind TEXT,                          -- build | review
  lease_id TEXT,
  lease_holder INTEGER,
  lease_expires INTEGER,
  leased_at INTEGER,
  done_by INTEGER,
  done_at INTEGER,
  building_count INTEGER,
  area_km2 REAL,
  quality REAL,                             -- 0..1 completeness at last finish
  reason TEXT,                              -- why it needs work
  reported INTEGER NOT NULL DEFAULT 0,
  reviews_ok INTEGER NOT NULL DEFAULT 0,
  reviews_failed INTEGER NOT NULL DEFAULT 0,
  last_review_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tiles_xy ON tiles (x, y);
CREATE INDEX IF NOT EXISTS tiles_status ON tiles (status, reported, quality);
CREATE INDEX IF NOT EXISTS tiles_done_by ON tiles (done_by);

-- Append-only change log. Reverting sets status='reverted'; nothing is deleted.
-- seq increases on insert AND on every status change, so replicas see reverts.
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  tile TEXT NOT NULL,
  kind TEXT NOT NULL,                       -- building | rule | asset
  target TEXT,
  payload TEXT NOT NULL,
  author INTEGER NOT NULL,
  client_key TEXT,                          -- idempotency key from the CLI (draft hash)
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'live',      -- live | reverted
  reverted_at INTEGER,
  w REAL NOT NULL, s REAL NOT NULL, e REAL NOT NULL, n REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_tile ON changes (tile, status);
CREATE INDEX IF NOT EXISTS changes_target ON changes (target);
CREATE INDEX IF NOT EXISTS changes_author ON changes (author, created_at);
CREATE INDEX IF NOT EXISTS changes_rules ON changes (kind, status, w, e, s, n);
CREATE INDEX IF NOT EXISTS changes_seq ON changes (seq);
CREATE UNIQUE INDEX IF NOT EXISTS changes_idem ON changes (author, client_key);

CREATE TABLE IF NOT EXISTS assets (
  key TEXT PRIMARY KEY,
  owner INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  triangles INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Problems with a tile: from people in the viewer (source=person), agents (agent), or reviews (review).
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  tile TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  target TEXT,
  message TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'person',
  author INTEGER,
  reporter_ip TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'       -- open | resolved
);
CREATE INDEX IF NOT EXISTS reports_tile ON reports (tile, status);

-- Hand-off notes left when releasing a tile ("no photos of X anywhere", "skipped Y because…").
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  tile TEXT NOT NULL,
  author INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_tile ON notes (tile);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  tile TEXT NOT NULL,
  reviewer INTEGER NOT NULL,
  subject INTEGER,                          -- contributor whose finish was reviewed
  verdict TEXT NOT NULL,                    -- approve | needs_work
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_tile ON reviews (tile);
CREATE INDEX IF NOT EXISTS reviews_reviewer ON reviews (reviewer);

-- Fixed-window rate counters (key = what|who, win = window start).
CREATE TABLE IF NOT EXISTS rate (
  key TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);

-- Completeness gained per finish, for the leaderboard (rewards improving, not rushing).
CREATE TABLE IF NOT EXISTS credits (
  id INTEGER PRIMARY KEY,
  contributor INTEGER NOT NULL,
  tile TEXT NOT NULL,
  delta REAL NOT NULL,
  area_km2 REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS credits_contributor ON credits (contributor);

-- Names visitors suggest for unnamed buildings. Shown as "unverified" until an agent confirms
-- one with a source (by setting spec.name), which marks it accepted.
CREATE TABLE IF NOT EXISTS names (
  id INTEGER PRIMARY KEY,
  tile TEXT NOT NULL,
  target TEXT NOT NULL,
  name TEXT NOT NULL,
  reporter_ip TEXT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'    -- pending | accepted | rejected
);
CREATE INDEX IF NOT EXISTS names_tile ON names (tile, status);
