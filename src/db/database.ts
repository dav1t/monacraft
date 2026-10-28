import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  code        TEXT NOT NULL,
  successes   INTEGER NOT NULL DEFAULT 0,
  failures    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS revelations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS goals (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id  INTEGER,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'todo',
  position   INTEGER NOT NULL DEFAULT 0,
  attempts   INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  template   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS goals_parent ON goals (parent_id, position);
CREATE TABLE IF NOT EXISTS plan_templates (
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  subgoals_json TEXT NOT NULL,
  uses          INTEGER NOT NULL DEFAULT 0,
  successes     INTEGER NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  flagged       INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, name)
);
CREATE TABLE IF NOT EXISTS days (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL DEFAULT (datetime('now')),
  journal       TEXT NOT NULL,
  history_until INTEGER NOT NULL DEFAULT 0,
  skills_review TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS structures (
  name       TEXT PRIMARY KEY,
  shape      TEXT NOT NULL,
  block      TEXT NOT NULL,
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  z          INTEGER NOT NULL,
  facing     TEXT NOT NULL,
  width      INTEGER NOT NULL,
  depth      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  placed     INTEGER NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS containers (
  x          INTEGER NOT NULL,
  y          INTEGER NOT NULL,
  z          INTEGER NOT NULL,
  block      TEXT NOT NULL,
  items      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (x, y, z)
);
CREATE TABLE IF NOT EXISTS llm_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session       INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost          REAL,
  duration_ms   INTEGER NOT NULL,
  error         TEXT,
  tool_error    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS llm_calls_session ON llm_calls (session);
CREATE TABLE IF NOT EXISTS identity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  self       TEXT NOT NULL,
  wants      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  seeds      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS scars (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cause      TEXT NOT NULL,
  place      TEXT NOT NULL,
  lost       TEXT NOT NULL,
  meaning    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  content    TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'sleep',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Changes for databases created before a column or table existed. Each step is idempotent. */
function migrate(db: DatabaseSync): void {
  const memoryColumns = db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]
  if (!memoryColumns.some((c) => c.name === 'pinned')) db.exec('ALTER TABLE memory ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')

  // The goal used to be the memory fact "goal".
  const old = db.prepare(`SELECT value FROM memory WHERE key = 'goal'`).get() as { value: string } | undefined
  if (old) {
    const hasGoal = db.prepare(`SELECT 1 FROM goals WHERE kind = 'goal' AND status = 'active'`).get()
    if (!hasGoal) db.prepare(`INSERT INTO goals (kind, title, status) VALUES ('goal', ?, 'active')`).run(old.value)
    db.exec(`DELETE FROM memory WHERE key = 'goal'`)
  }
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  migrate(db)
  return db
}
