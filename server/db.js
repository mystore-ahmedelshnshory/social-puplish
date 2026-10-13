import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// AMPLIFY_DB lets the test suite run against an isolated (or in-memory) database.
export const db = new Database(process.env.AMPLIFY_DB || path.join(DATA_DIR, 'amplify.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT NOT NULL,
  handle        TEXT NOT NULL,
  display_name  TEXT,
  kind          TEXT DEFAULT 'profile',
  tokens        TEXT,
  status        TEXT DEFAULT 'connected',
  created_at    TEXT DEFAULT (datetime('now')),
  UNIQUE (platform, handle)
);

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  text          TEXT DEFAULT '',
  scene         TEXT,
  media         TEXT DEFAULT '[]',
  scheduled_at  TEXT,
  status        TEXT DEFAULT 'draft',
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS post_targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status     TEXT DEFAULT 'pending',
  result     TEXT,
  external_id TEXT,
  UNIQUE (post_id, account_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_id    INTEGER REFERENCES post_targets(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  state        TEXT DEFAULT 'queued',
  attempts     INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  not_before   TEXT DEFAULT (datetime('now')),
  last_error   TEXT,
  external_id  TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  updated_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stats (
  target_id  INTEGER PRIMARY KEY REFERENCES post_targets(id) ON DELETE CASCADE,
  metrics    TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  filename   TEXT NOT NULL,
  stored_as  TEXT NOT NULL,
  mime       TEXT,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state      TEXT PRIMARY KEY,
  platform   TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
DELETE FROM oauth_states WHERE created_at < datetime('now', '-10 minutes');

CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs (state, not_before);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts (status, scheduled_at);
`);

export const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** ISO string -> SQLite datetime string (UTC). Returns null for empty/invalid input. */
export const toDbTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
};
