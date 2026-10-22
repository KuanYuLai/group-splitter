import { DatabaseSync } from 'node:sqlite';
export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (version.user_version < 1) db.exec(`
    BEGIN;
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, nickname TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE groups (id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE participants (id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id), name TEXT NOT NULL);
    CREATE TABLE expenses (id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id), description TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), payerId TEXT NOT NULL REFERENCES participants(id));
    CREATE TABLE shares (expenseId TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE, participantId TEXT NOT NULL REFERENCES participants(id), amount INTEGER NOT NULL CHECK(amount >= 0), PRIMARY KEY(expenseId, participantId));
    CREATE TABLE repayments (id TEXT PRIMARY KEY, groupId TEXT NOT NULL REFERENCES groups(id), fromId TEXT NOT NULL REFERENCES participants(id), toId TEXT NOT NULL REFERENCES participants(id), amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL);
    PRAGMA user_version = 1;
    COMMIT;
  `);
  if (version.user_version < 2) db.exec(`
    BEGIN;
    ALTER TABLE participants ADD COLUMN userId TEXT REFERENCES users(id);
    CREATE UNIQUE INDEX participant_user_per_group ON participants(groupId, userId) WHERE userId IS NOT NULL;
    -- Legacy names cannot establish account ownership. Keep their history intact.
    INSERT INTO participants (id, groupId, name, userId)
      SELECT 'owner-' || groups.id, groups.id, users.nickname, users.id
      FROM groups JOIN users ON users.id = groups.ownerId;
    PRAGMA user_version = 2;
    COMMIT;
  `);
  if (version.user_version < 3) db.exec(`
    BEGIN;
    CREATE TABLE idempotency_keys (
      userId TEXT NOT NULL REFERENCES users(id),
      path TEXT NOT NULL,
      key TEXT NOT NULL,
      request TEXT NOT NULL,
      response TEXT NOT NULL,
      PRIMARY KEY(userId, path, key)
    );
    PRAGMA user_version = 3;
    COMMIT;
  `);
  return db;
}
