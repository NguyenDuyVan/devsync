import { createServer, type ServerOptions } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BLOB_DIR, DATA_DIR, TLS_DIR, consumePairCode, createDevice, createPairCode, db, nextSeq, sha256 } from './db.ts';

const PORT = Number(process.env.PORT ?? 8743);
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_MB ?? 100) * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const HISTORY_KEEP_VERSIONS = 20;
const HISTORY_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const RELEASE_DIR = join(DATA_DIR, 'releases');
const RELEASE_FILE = /^devsync-\d+\.\d+\.\d+\.vsix$/;

const HEX64 = /^[a-f0-9]{64}$/;
const ENTRY_ID = /^[a-f0-9]{16,64}$/;

interface Device {
  id: string;
  name: string;
}

class HttpError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const failures = new Map<string, { count: number; resetAt: number }>();
const FAILURE_LIMIT = 20;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function assertNotBlocked(ip: string) {
  const record = failures.get(ip);
  if (record && record.resetAt > Date.now() && record.count >= FAILURE_LIMIT) {
    throw new HttpError(429, 'too many failed attempts');
  }
}

function recordFailure(ip: string) {
  const now = Date.now();
  const record = failures.get(ip);
  if (!record || record.resetAt < now) failures.set(ip, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
  else record.count++;
}

function authenticate(req: IncomingMessage): Device {
  const ip = clientIp(req);
  assertNotBlocked(ip);
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const device = token
    ? (db.prepare('SELECT id, name FROM devices WHERE token_hash = ? AND revoked = 0').get(sha256(token)) as Device | undefined)
    : undefined;
  if (!device) {
    recordFailure(ip);
    throw new HttpError(401, 'unauthorized');
  }
  db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), device.id);
  return device;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = await readBody(req, MAX_JSON_BYTES);
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  res.end(payload);
}

function blobPath(hash: string) {
  return join(BLOB_DIR, hash.slice(0, 2), hash);
}

async function storeBlob(req: IncomingMessage, hash: string) {
  const target = blobPath(hash);
  if (existsSync(target)) {
    req.resume();
    return;
  }
  mkdirSync(join(BLOB_DIR, hash.slice(0, 2)), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const digest = createHash('sha256');
  const out = createWriteStream(temp);
  let size = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BLOB_BYTES) {
          reject(new HttpError(413, 'blob too large'));
          req.destroy();
          return;
        }
        digest.update(chunk);
        out.write(chunk);
      });
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
    });
    if (digest.digest('hex') !== hash) throw new HttpError(400, 'hash mismatch');
    renameSync(temp, target);
  } finally {
    out.destroy();
    rmSync(temp, { force: true });
  }
}

const streams = new Set<ServerResponse>();

function broadcast(seq: number, event = 'seq') {
  for (const res of streams) res.write(`event: ${event}\ndata: ${seq}\n\n`);
}

function latestRelease(): { version: string; file: string } | undefined {
  try {
    return JSON.parse(readFileSync(join(RELEASE_DIR, 'latest.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

let releaseMtime = 0;
function watchReleases() {
  try {
    const mtime = statSync(join(RELEASE_DIR, 'latest.json')).mtimeMs;
    if (releaseMtime && mtime !== releaseMtime) broadcast(0, 'release');
    releaseMtime = mtime;
  } catch {
    releaseMtime = releaseMtime || -1;
  }
}

interface EntryRow {
  id: string;
  version: number;
  seq: number;
  meta: string;
  blob: string | null;
  size: number;
  deleted: number;
  device_id: string;
  updated_at: number;
}

function toEntry(row: EntryRow) {
  return {
    id: row.id,
    version: row.version,
    seq: row.seq,
    meta: row.meta,
    blob: row.blob,
    size: row.size,
    deleted: row.deleted === 1,
    deviceId: row.device_id,
    updatedAt: row.updated_at,
  };
}

interface CommitBody {
  id: string;
  baseVersion: number;
  meta: string;
  blob: string | null;
  size: number;
  deleted: boolean;
}

function commit(device: Device, body: CommitBody) {
  if (!ENTRY_ID.test(body.id ?? '')) throw new HttpError(400, 'invalid id');
  if (typeof body.meta !== 'string' || body.meta.length > 64 * 1024) throw new HttpError(400, 'invalid meta');
  if (body.blob !== null && !HEX64.test(body.blob ?? '')) throw new HttpError(400, 'invalid blob');
  if (body.blob && !existsSync(blobPath(body.blob))) throw new HttpError(400, 'blob not uploaded');

  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT * FROM entries WHERE id = ?').get(body.id) as EntryRow | undefined;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== body.baseVersion) {
      db.exec('ROLLBACK');
      throw new HttpError(409, 'version conflict', { current: current ? toEntry(current) : null });
    }
    const row: EntryRow = {
      id: body.id,
      version: currentVersion + 1,
      seq: nextSeq(),
      meta: body.meta,
      blob: body.deleted ? null : body.blob,
      size: body.deleted ? 0 : Number(body.size) || 0,
      deleted: body.deleted ? 1 : 0,
      device_id: device.id,
      updated_at: Date.now(),
    };
    db.prepare(
      `INSERT INTO entries (id, version, seq, meta, blob, size, deleted, device_id, updated_at)
       VALUES (:id, :version, :seq, :meta, :blob, :size, :deleted, :device_id, :updated_at)
       ON CONFLICT (id) DO UPDATE SET version = :version, seq = :seq, meta = :meta, blob = :blob,
         size = :size, deleted = :deleted, device_id = :device_id, updated_at = :updated_at`,
    ).run({ ...row });
    db.prepare(
      `INSERT INTO history (id, version, meta, blob, size, deleted, device_id, updated_at)
       VALUES (:id, :version, :meta, :blob, :size, :deleted, :device_id, :updated_at)`,
    ).run({
      id: row.id,
      version: row.version,
      meta: row.meta,
      blob: row.blob,
      size: row.size,
      deleted: row.deleted,
      device_id: row.device_id,
      updated_at: row.updated_at,
    });
    db.exec('COMMIT');
    broadcast(row.seq);
    return toEntry(row);
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

function openEventStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const seq = (db.prepare("SELECT value FROM kv WHERE key = 'seq'").get() as { value: number }).value;
  res.write(`event: seq\ndata: ${seq}\n\n`);
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(res);
  });
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'https://local');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true });

  if (method === 'POST' && url.pathname === '/pair') {
    const ip = clientIp(req);
    assertNotBlocked(ip);
    const body = await readJson<{ code?: string; name?: string }>(req);
    if (!body.code || !consumePairCode(body.code)) {
      recordFailure(ip);
      throw new HttpError(401, 'invalid or expired pair code');
    }
    const device = createDevice(body.name?.trim() || 'device');
    return sendJson(res, 200, { deviceId: device.id, token: device.token });
  }

  const device = authenticate(req);

  if (method === 'GET' && url.pathname === '/me') return sendJson(res, 200, device);

  if (method === 'GET' && url.pathname === '/events') return openEventStream(req, res);

  if (method === 'POST' && url.pathname === '/pair-codes') return sendJson(res, 200, createPairCode());

  if (method === 'GET' && url.pathname === '/changes') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 500), 1000);
    const rows = db.prepare('SELECT * FROM entries WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit) as unknown as EntryRow[];
    return sendJson(res, 200, { entries: rows.map(toEntry) });
  }

  if (method === 'POST' && url.pathname === '/commit') {
    return sendJson(res, 200, commit(device, await readJson<CommitBody>(req)));
  }

  if (parts[0] === 'blobs' && parts.length === 2 && HEX64.test(parts[1])) {
    const hash = parts[1];
    if (method === 'PUT') {
      await storeBlob(req, hash);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET') {
      const path = blobPath(hash);
      if (!existsSync(path)) throw new HttpError(404, 'blob not found');
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(path).size });
      createReadStream(path).pipe(res);
      return;
    }
  }

  if (method === 'GET' && parts[0] === 'history' && parts.length === 2 && ENTRY_ID.test(parts[1])) {
    const rows = db
      .prepare('SELECT * FROM history WHERE id = ? ORDER BY version DESC')
      .all(parts[1]) as unknown as Omit<EntryRow, 'seq'>[];
    return sendJson(res, 200, { versions: rows.map((row) => toEntry({ ...row, seq: 0 })) });
  }

  if (method === 'GET' && url.pathname === '/release/latest') {
    const release = latestRelease();
    if (!release) throw new HttpError(404, 'no release');
    return sendJson(res, 200, release);
  }

  if (method === 'GET' && parts[0] === 'release' && parts[1] === 'file' && parts.length === 3 && RELEASE_FILE.test(parts[2])) {
    const path = join(RELEASE_DIR, parts[2]);
    if (!existsSync(path)) throw new HttpError(404, 'release file not found');
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(path).size });
    createReadStream(path).pipe(res);
    return;
  }

  if (method === 'GET' && url.pathname === '/devices') {
    const rows = db.prepare('SELECT id, name, created_at, last_seen FROM devices WHERE revoked = 0 ORDER BY created_at').all();
    return sendJson(res, 200, { devices: rows });
  }

  if (method === 'DELETE' && parts[0] === 'devices' && parts.length === 2) {
    db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(parts[1]);
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'not found');
}

function cleanup() {
  const cutoff = Date.now() - HISTORY_KEEP_DAYS * DAY_MS;
  db.prepare(
    `DELETE FROM history WHERE updated_at < ?
       AND version <= (SELECT version FROM entries WHERE entries.id = history.id) - ?`,
  ).run(cutoff, HISTORY_KEEP_VERSIONS);
  db.prepare('DELETE FROM history WHERE id IN (SELECT id FROM entries WHERE deleted = 1 AND updated_at < ?)').run(cutoff);
  db.prepare('DELETE FROM entries WHERE deleted = 1 AND updated_at < ?').run(cutoff);
  db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(Date.now());

  const referenced = new Set(
    (db.prepare('SELECT blob FROM entries WHERE blob IS NOT NULL UNION SELECT blob FROM history WHERE blob IS NOT NULL').all() as {
      blob: string;
    }[]).map((row) => row.blob),
  );
  let removed = 0;
  for (const shard of readdirSync(BLOB_DIR)) {
    for (const file of readdirSync(join(BLOB_DIR, shard))) {
      const path = join(BLOB_DIR, shard, file);
      const stale = file.endsWith('.tmp') && statSync(path).mtimeMs < Date.now() - DAY_MS;
      if (stale || (!file.endsWith('.tmp') && !referenced.has(file))) {
        rmSync(path, { force: true });
        removed++;
      }
    }
  }
  console.log(`[cleanup] removed ${removed} blobs`);
}

const tls: ServerOptions = {
  key: readFileSync(join(TLS_DIR, 'key.pem')),
  cert: readFileSync(join(TLS_DIR, 'cert.pem')),
};

createServer(tls, (req, res) => {
  route(req, res).catch((error: unknown) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message, ...(error.body as object) });
    console.error(error);
    sendJson(res, 500, { error: 'internal error' });
  });
}).listen(PORT, () => console.log(`devsync listening on ${PORT}`));

cleanup();
setInterval(cleanup, DAY_MS);
watchReleases();
setInterval(watchReleases, 30_000);
