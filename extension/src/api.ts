import * as https from 'https';
import * as tls from 'tls';
import type { IncomingMessage } from 'http';

export interface ServerInfo {
  host: string;
  port: number;
  fingerprint: string;
  certPem: string;
}

export interface Invite {
  host: string;
  port: number;
  fingerprint: string;
  code: string;
  key?: string;
}

export interface RawEntry {
  id: string;
  version: number;
  seq: number;
  meta: string;
  blob: string | null;
  size: number;
  deleted: boolean;
  deviceId: string;
  updatedAt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  created_at: number;
  last_seen: number | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(`HTTP ${status}: ${String(body.error ?? 'lỗi không xác định')}`);
  }
}

const normalizeFingerprint = (value: string) => value.replace(/:/g, '').toUpperCase();

export function parseInvite(text: string): Invite {
  const url = new URL(text.trim());
  if (url.protocol !== 'devsync:') throw new Error('Chuỗi kết nối phải bắt đầu bằng devsync://');
  const fingerprint = url.searchParams.get('fp');
  const code = url.searchParams.get('code');
  if (!fingerprint || !code) throw new Error('Chuỗi kết nối thiếu fp hoặc code.');
  const key = new URLSearchParams(url.hash.slice(1)).get('key') ?? undefined;
  return { host: url.hostname, port: Number(url.port || 8743), fingerprint: normalizeFingerprint(fingerprint), code, key };
}

export function formatInvite(server: ServerInfo, code: string, key: string): string {
  const query = new URLSearchParams({ fp: server.fingerprint, code });
  return `devsync://${server.host}:${server.port}?${query}#key=${key}`;
}

export function fetchPinnedCert(host: string, port: number, fingerprint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (normalizeFingerprint(cert.fingerprint256 ?? '') !== fingerprint) {
        reject(new Error('Vân tay chứng chỉ máy chủ không khớp. Dừng kết nối.'));
        return;
      }
      const body = cert.raw.toString('base64').match(/.{1,64}/g)!.join('\n');
      resolve(`-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`);
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error('Hết thời gian kết nối máy chủ.')));
    socket.on('error', reject);
  });
}

export class ApiClient {
  constructor(
    private readonly server: ServerInfo,
    private readonly token?: string,
  ) {}

  private options(method: string, path: string, headers: Record<string, string | number> = {}): https.RequestOptions {
    return {
      host: this.server.host,
      port: this.server.port,
      method,
      path,
      ca: this.server.certPem,
      checkServerIdentity: (_host, cert) =>
        normalizeFingerprint(cert.fingerprint256) === this.server.fingerprint ? undefined : new Error('Sai vân tay chứng chỉ'),
      headers: { ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...headers },
      timeout: 120_000,
    };
  }

  private request(method: string, path: string, body?: Buffer, contentType = 'application/json'): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = body ? { 'content-type': contentType, 'content-length': body.length } : {};
      const req = https.request(this.options(method, path, headers), (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('Hết thời gian chờ máy chủ.')));
      req.on('error', reject);
      req.end(body);
    });
  }

  async json<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const res = await this.request(method, path, payload === undefined ? undefined : Buffer.from(JSON.stringify(payload)));
    const parsed = res.body.length ? (JSON.parse(res.body.toString('utf8')) as Record<string, unknown>) : {};
    if (res.status >= 400) throw new ApiError(res.status, parsed);
    return parsed as T;
  }

  async putBlob(hash: string, data: Buffer): Promise<void> {
    const res = await this.request('PUT', `/blobs/${hash}`, data, 'application/octet-stream');
    if (res.status >= 400) throw new ApiError(res.status, JSON.parse(res.body.toString('utf8') || '{}'));
  }

  async getBlob(hash: string): Promise<Buffer> {
    return this.getFile(`/blobs/${hash}`);
  }

  async getFile(filePath: string): Promise<Buffer> {
    const res = await this.request('GET', filePath);
    if (res.status >= 400) throw new ApiError(res.status, JSON.parse(res.body.toString('utf8') || '{}'));
    return res.body;
  }

  subscribe(onEvent: (event: string, data: string) => void, onState: (connected: boolean) => void): () => void {
    let stopped = false;
    let current: IncomingMessage | undefined;
    let retry = 1_000;
    let timer: NodeJS.Timeout | undefined;

    const connect = () => {
      if (stopped) return;
      const req = https.request(this.options('GET', '/events', { accept: 'text/event-stream' }), (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return scheduleRetry();
        }
        current = res;
        retry = 1_000;
        onState(true);
        let buffer = '';
        let watchdog = setTimeout(() => res.destroy(), 70_000);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          clearTimeout(watchdog);
          watchdog = setTimeout(() => res.destroy(), 70_000);
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const lines = block.split('\n');
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7) ?? 'message';
            const data = lines.find((line) => line.startsWith('data: '));
            if (data) onEvent(event, data.slice(6));
          }
        });
        res.on('close', () => {
          clearTimeout(watchdog);
          onState(false);
          scheduleRetry();
        });
      });
      req.setTimeout(0);
      req.on('error', () => scheduleRetry());
      req.end();
    };

    const scheduleRetry = () => {
      if (stopped || timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        connect();
      }, retry);
      retry = Math.min(retry * 2, 60_000);
    };

    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      current?.destroy();
    };
  }
}
