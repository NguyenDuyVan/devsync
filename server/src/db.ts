import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? '/data';
export const BLOB_DIR = join(DATA_DIR, 'blobs');
export const TLS_DIR = join(DATA_DIR, 'tls');
mkdirSync(BLOB_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'devsync.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT OR IGNORE INTO kv (key, value) VALUES ('seq', 0);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pair_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    meta TEXT NOT NULL,
    blob TEXT,
    size INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS entries_seq ON entries (seq);
  CREATE TABLE IF NOT EXISTS history (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    meta TEXT NOT NULL,
    blob TEXT,
    size INTEGER NOT NULL,
    deleted INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, version)
  );
`);

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIR_CODE_TTL_MS = 10 * 60 * 1000;

export function createPairCode(): { code: string; expiresAt: number } {
  const bytes = randomBytes(10);
  const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  const expiresAt = Date.now() + PAIR_CODE_TTL_MS;
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO pair_codes (code_hash, expires_at) VALUES (?, ?)').run(sha256(code), expiresAt);
  return { code, expiresAt };
}

export function consumePairCode(code: string): boolean {
  const result = db
    .prepare('DELETE FROM pair_codes WHERE code_hash = ? AND expires_at >= ?')
    .run(sha256(code.trim().toUpperCase()), Date.now());
  return result.changes === 1;
}

export function createDevice(name: string): { id: string; token: string } {
  const id = randomBytes(8).toString('hex');
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO devices (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    name.slice(0, 64),
    sha256(token),
    Date.now(),
  );
  return { id, token };
}

export function nextSeq(): number {
  const row = db.prepare("UPDATE kv SET value = value + 1 WHERE key = 'seq' RETURNING value").get() as { value: number };
  return row.value;
}
