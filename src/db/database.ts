import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

/**
 * Ordered, append-only schema migrations. The index + 1 is stored in
 * SQLite's `user_version` pragma, so each migration runs exactly once.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    id               TEXT PRIMARY KEY,
    source           TEXT    NOT NULL,
    external_id      TEXT    NOT NULL,
    type             TEXT    NOT NULL,
    payload          TEXT    NOT NULL,
    payload_hash     TEXT    NOT NULL,
    status           TEXT    NOT NULL
                     CHECK (status IN ('pending', 'processing', 'retrying', 'succeeded', 'dead_lettered')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  INTEGER,
    lease_expires_at INTEGER,
    last_error       TEXT,
    response_status  INTEGER NOT NULL,
    response_body    TEXT    NOT NULL,
    received_at      INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    completed_at     INTEGER,
    UNIQUE (source, external_id)
  );

  CREATE INDEX events_due_idx      ON events (status, next_attempt_at);
  CREATE INDEX events_received_idx ON events (received_at DESC);

  CREATE TABLE delivery_attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id       TEXT    NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    attempt_number INTEGER NOT NULL,
    outcome        TEXT    NOT NULL CHECK (outcome IN ('success', 'failure')),
    error          TEXT,
    status_code    INTEGER,
    started_at     INTEGER NOT NULL,
    finished_at    INTEGER NOT NULL
  );

  CREATE INDEX delivery_attempts_event_idx ON delivery_attempts (event_id, id);
  `,
];

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) break;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
