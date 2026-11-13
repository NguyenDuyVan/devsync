import * as fs from 'fs';
import * as path from 'path';
import type { ServerInfo } from './api';

export type Mode = 'auto' | 'manual' | 'off';

export interface ProjectState {
  id: string;
  name: string;
  remote?: string;
  global?: boolean;
  localPath?: string;
  modes: Record<string, Mode>;
  modesAt: number;
}

export interface FileMeta {
  type: 'file';
  projectId: string;
  item: string;
  path: string;
  hash: string;
  deviceName: string;
}

export interface ProjectMeta {
  type: 'project';
  projectId: string;
  name: string;
  remote?: string;
  global?: boolean;
  modes: Record<string, Mode>;
  modesAt: number;
}

export interface HandoffMeta {
  type: 'handoff';
  projectId: string;
  note: string;
  branch?: string;
  deviceName: string;
  at: number;
}

export type EntryMeta = FileMeta | ProjectMeta | HandoffMeta;

export interface RemoteEntry {
  id: string;
  version: number;
  seq: number;
  blob: string | null;
  size: number;
  deleted: boolean;
  deviceId: string;
  updatedAt: number;
  meta: EntryMeta;
}

export interface BaseEntry {
  version: number;
  hash: string;
  projectId: string;
  item: string;
  path: string;
}

export interface Conflict {
  id: string;
  projectId: string;
  item: string;
  path: string;
  remoteVersion: number;
  reason: 'both-changed' | 'remote-deleted' | 'local-deleted';
  at: number;
}

export interface Review {
  id: string;
  projectId: string;
  item: string;
  path: string;
  abs: string;
  notes: string[];
  hasMarkers: boolean;
  at: number;
}

export interface State {
  server?: ServerInfo;
  deviceId?: string;
  deviceName?: string;
  lastSeq: number;
  lastSyncAt?: number;
  lastError?: string;
  projects: Record<string, ProjectState>;
  base: Record<string, BaseEntry>;
  remote: Record<string, RemoteEntry>;
  conflicts: Record<string, Conflict>;
  reviews: Record<string, Review>;
  seenHandoff: Record<string, number>;
}

const emptyState = (): State => ({ lastSeq: 0, projects: {}, base: {}, remote: {}, conflicts: {}, reviews: {}, seenHandoff: {} });

const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_MS = 90_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Store {
  private readonly file: string;
  private readonly lockDir: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'state.json');
    this.lockDir = path.join(dir, 'state.lock');
  }

  get stateFile() {
    return this.file;
  }

  read(): State {
    try {
      return { ...emptyState(), ...(JSON.parse(fs.readFileSync(this.file, 'utf8')) as State) };
    } catch {
      return emptyState();
    }
  }

  private write(state: State) {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state));
    fs.renameSync(temp, this.file);
  }

  update<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => this.withFileLock(async () => {
      const state = this.read();
      try {
        return await fn(state);
      } finally {
        this.write(state);
      }
    }));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    for (;;) {
      try {
        fs.mkdirSync(this.lockDir);
        break;
      } catch {
        try {
          if (Date.now() - fs.statSync(this.lockDir).mtimeMs > LOCK_STALE_MS) fs.rmSync(this.lockDir, { recursive: true, force: true });
        } catch {
          continue;
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error('Cửa sổ VS Code khác đang đồng bộ, thử lại sau.');
        await sleep(150);
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(this.lockDir, now, now, () => undefined);
    }, 30_000);
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    }
  }
}

const LEADER_STALE_MS = 45_000;

export class Leader {
  private readonly file: string;
  private readonly token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  private timer?: NodeJS.Timeout;
  private leading = false;

  constructor(dir: string, private readonly onChange: (leading: boolean) => void) {
    this.file = path.join(dir, 'leader.json');
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.leading && this.readOwner()?.token === this.token) fs.rmSync(this.file, { force: true });
    if (this.leading) {
      this.leading = false;
      this.onChange(false);
    }
  }

  get isLeader() {
    return this.leading;
  }

  private readOwner(): { token: string; pid: number; at: number } | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private alive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private tick() {
    const owner = this.readOwner();
    const free = !owner || owner.token === this.token || Date.now() - owner.at > LEADER_STALE_MS || !this.alive(owner.pid);
    if (free) fs.writeFileSync(this.file, JSON.stringify({ token: this.token, pid: process.pid, at: Date.now() }));
    const leading = this.readOwner()?.token === this.token;
    if (leading !== this.leading) {
      this.leading = leading;
      this.onChange(leading);
    }
  }
}
