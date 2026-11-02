CREATE TABLE IF NOT EXISTS media (
  owner TEXT NOT NULL, id TEXT NOT NULL,
  memory_id TEXT,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  taken_at TEXT,
  width INTEGER, height INTEGER,
  caption TEXT,
  created_at TEXT NOT NULL, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS media_memory ON media(owner, memory_id);
CREATE UNIQUE INDEX IF NOT EXISTS media_hash ON media(owner, sha256);

CREATE TABLE IF NOT EXISTS web_sessions (
  token_hash TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  csrf_token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS web_sessions_expiry ON web_sessions(expires_at);
