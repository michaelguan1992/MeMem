CREATE TABLE IF NOT EXISTS memories (
  owner TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  search_text TEXT NOT NULL, occurred_at TEXT, version INTEGER NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS memories_time ON memories(owner, occurred_at);
