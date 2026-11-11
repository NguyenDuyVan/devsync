import * as fs from 'fs';
import * as path from 'path';
import { ApiClient, ApiError, fetchPinnedCert, parseInvite, type DeviceInfo, type RawEntry, type ServerInfo } from './api';
import { Vault, sha256 } from './crypto';
import { Matcher, envKeyDiff, localHash, moveToTrash, scan, unionLines, writeAtomic, type LocalFile } from './files';
import { createWip, type WipPackage } from './git';
import { itemById, itemsFor, type ItemDef } from './items';
import type { EntryMeta, FileMeta, HandoffMeta, ProjectMeta, ProjectState, RemoteEntry, State, Store } from './state';

export type ActionKind = 'in-sync' | 'down-write' | 'down-delete' | 'up-write' | 'up-delete' | 'merge' | 'conflict';

export interface Action {
  id: string;
  kind: ActionKind;
  rel: string;
  abs: string;
  local?: LocalFile;
  remote?: RemoteEntry;
}

export interface Report {
  pushed: string[];
  pulled: string[];
  deleted: string[];
  conflicts: string[];
  skipped: string[];
  errors: string[];
}

export const emptyReport = (): Report => ({ pushed: [], pulled: [], deleted: [], conflicts: [], skipped: [], errors: [] });

export function mergeReports(target: Report, source: Report) {
  for (const key of Object.keys(target) as (keyof Report)[]) target[key].push(...source[key]);
  return target;
}

export interface Pending {
  up: number;
  down: number;
  conflicts: number;
}

class VersionConflict extends Error {}

const SECRET_TOKEN = 'devsync.token';
const SECRET_KEY = 'devsync.key';
const PAGE_SIZE = 500;

interface Secrets {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
}

export interface EngineOptions {
  maxBytes(): number;
  log(message: string): void;
  trashDir: string;
}

export class Engine {
  api?: ApiClient;
  vault?: Vault;
  readonly pending = new Map<string, Pending>();

  constructor(
    readonly store: Store,
    private readonly secrets: Secrets,
    private readonly options: EngineOptions,
  ) {}

  get connected() {
    return !!this.api && !!this.vault;
  }

  async load(): Promise<boolean> {
    const state = this.store.read();
    const token = await this.secrets.get(SECRET_TOKEN);
    const key = await this.secrets.get(SECRET_KEY);
    if (!state.server || !token || !key) return false;
    this.api = new ApiClient(state.server, token);
    this.vault = Vault.fromKey(key);
    return true;
  }

  async getKey() {
    return this.secrets.get(SECRET_KEY);
  }

  async pair(inviteText: string, deviceName: string) {
    const invite = parseInvite(inviteText);
    const certPem = await fetchPinnedCert(invite.host, invite.port, invite.fingerprint);
    const server: ServerInfo = { host: invite.host, port: invite.port, fingerprint: invite.fingerprint, certPem };
    const result = await new ApiClient(server).json<{ deviceId: string; token: string }>('POST', '/pair', { code: invite.code, name: deviceName });
    return { server, ...result, inviteKey: invite.key };
  }

  async serverHasData(server: ServerInfo, token: string) {
    const { entries } = await new ApiClient(server, token).json<{ entries: RawEntry[] }>('GET', '/changes?since=0&limit=1');
    return entries.length > 0;
  }

  async finishPairing(server: ServerInfo, deviceId: string, token: string, deviceName: string, key: string) {
    const vault = Vault.fromKey(key);
    const api = new ApiClient(server, token);
    const { entries } = await api.json<{ entries: RawEntry[] }>('GET', '/changes?since=0&limit=20');
    for (const entry of entries) {
      try {
        vault.open(entry.meta);
      } catch {
        throw new Error('Khoá đồng bộ không khớp với dữ liệu trên máy chủ.');
      }
    }
    await this.secrets.store(SECRET_TOKEN, token);
    await this.secrets.store(SECRET_KEY, key);
    await this.store.update((state) => {
      state.server = server;
      state.deviceId = deviceId;
      state.deviceName = deviceName;
      state.lastSeq = 0;
      state.remote = {};
      state.base = {};
      state.conflicts = {};
      state.seenHandoff = {};
    });
    this.api = api;
    this.vault = vault;
  }

  private requireReady() {
    if (!this.api || !this.vault) throw new Error('Chưa kết nối máy chủ DevSync.');
    return { api: this.api, vault: this.vault };
  }

  private decode(raw: RawEntry): RemoteEntry | undefined {
    try {
      return { ...raw, meta: this.vault!.open<EntryMeta>(raw.meta) };
    } catch {
      this.options.log(`Bỏ qua bản ghi ${raw.id}: không giải mã được (khác khoá?)`);
      return undefined;
    }
  }

  async refreshRemote(state: State): Promise<RemoteEntry[]> {
    const { api } = this.requireReady();
    const initial = state.lastSeq === 0;
    const fresh: RemoteEntry[] = [];
    for (;;) {
      const { entries } = await api.json<{ entries: RawEntry[] }>('GET', `/changes?since=${state.lastSeq}&limit=${PAGE_SIZE}`);
      for (const raw of entries) {
        state.lastSeq = Math.max(state.lastSeq, raw.seq);
        const entry = this.decode(raw);
        if (!entry) continue;
        state.remote[entry.id] = entry;
        fresh.push(entry);
        if (entry.meta.type === 'project' && !entry.deleted) this.adoptProject(state, entry.meta);
        if (initial && entry.meta.type === 'handoff') state.seenHandoff[entry.id] = entry.updatedAt;
      }
      if (entries.length < PAGE_SIZE) break;
    }
    return fresh;
  }

  private adoptProject(state: State, meta: ProjectMeta) {
    const existing = state.projects[meta.projectId];
    if (!existing) {
      state.projects[meta.projectId] = {
        id: meta.projectId,
        name: meta.name,
        remote: meta.remote,
        global: meta.global,
        modes: meta.modes,
        modesAt: meta.modesAt,
      };
    } else if (meta.modesAt > existing.modesAt) {
      existing.modes = { ...existing.modes, ...meta.modes };
      existing.modesAt = meta.modesAt;
      existing.name = meta.name;
    }
  }

  private async commit(state: State, id: string, baseVersion: number, meta: EntryMeta, blob: string | null, size: number, deleted: boolean) {
    const { api, vault } = this.requireReady();
    try {
      const raw = await api.json<RawEntry>('POST', '/commit', { id, baseVersion, meta: vault.seal(meta), blob, size, deleted });
      const entry: RemoteEntry = { ...raw, meta };
      state.remote[id] = entry;
      return entry;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const current = error.body.current as RawEntry | null;
        const decoded = current ? this.decode(current) : undefined;
        if (decoded) state.remote[id] = decoded;
        throw new VersionConflict('Máy khác vừa cập nhật bản ghi này.');
      }
      throw error;
    }
  }

  async publishProject(state: State, project: ProjectState) {
    const id = this.vault!.entryId(project.id, '_project');
    const meta: ProjectMeta = {
      type: 'project',
      projectId: project.id,
      name: project.name,
      remote: project.remote,
      global: project.global,
      modes: project.modes,
      modesAt: project.modesAt,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.commit(state, id, state.remote[id]?.version ?? 0, meta, null, 0, false);
        return;
      } catch (error) {
        if (!(error instanceof VersionConflict) || attempt === 1) throw error;
      }
    }
  }

  private context(project: ProjectState, item: ItemDef) {
    const root = item.root?.(project);
    return root ? { root, matcher: new Matcher(item.include, item.exclude) } : undefined;
  }

  entryIdFor(project: ProjectState, item: ItemDef, rel: string) {
    return this.vault!.entryId(project.id, item.id, rel);
  }

  plan(state: State, project: ProjectState, item: ItemDef, report: Report = emptyReport()): Action[] {
    const ctx = this.context(project, item);
    if (!ctx || item.kind !== 'files') return [];
    const local = scan(ctx.root, ctx.matcher, this.options.maxBytes(), (rel, size) =>
      report.skipped.push(`${rel} (${(size / 1024 / 1024).toFixed(1)}MB)`),
    );
    const ids = new Map<string, string>();
    for (const rel of local.keys()) ids.set(this.entryIdFor(project, item, rel), rel);
    for (const [id, base] of Object.entries(state.base)) if (base.projectId === project.id && base.item === item.id) ids.set(id, base.path);
    for (const entry of Object.values(state.remote)) {
      if (entry.meta.type === 'file' && entry.meta.projectId === project.id && entry.meta.item === item.id) ids.set(entry.id, entry.meta.path);
    }

    const actions: Action[] = [];
    for (const [id, rel] of ids) {
      const file = local.get(rel);
      const base = state.base[id];
      const remote = state.remote[id];
      const remoteFile = remote?.meta.type === 'file' ? remote : undefined;
      const abs = path.join(ctx.root, ...rel.split('/'));
      const action = (kind: ActionKind): Action => ({ id, kind, rel, abs, local: file, remote: remoteFile });

      if (remoteFile && !remoteFile.deleted && file?.hash === (remoteFile.meta as FileMeta).hash) {
        if (!base || base.version !== remoteFile.version || state.conflicts[id]) actions.push(action('in-sync'));
        continue;
      }
      if (remoteFile?.deleted && !file) {
        if (base || state.conflicts[id]) actions.push(action('in-sync'));
        continue;
      }
      const remoteChanged = !!remoteFile && (!base || remoteFile.version !== base.version);
      const localChanged = base ? file?.hash !== base.hash : !!file;
      if (!remoteChanged && !localChanged) continue;
      if (remoteChanged && !localChanged) actions.push(action(remoteFile!.deleted ? 'down-delete' : 'down-write'));
      else if (!remoteChanged && localChanged) actions.push(action(file ? 'up-write' : 'up-delete'));
      else if (file && !remoteFile!.deleted && item.mergeStrategy?.(rel) === 'union-lines') actions.push(action('merge'));
      else actions.push(action('conflict'));
    }
    this.pending.set(`${project.id}/${item.id}`, {
      up: actions.filter((a) => a.kind.startsWith('up-')).length,
      down: actions.filter((a) => a.kind.startsWith('down-')).length,
      conflicts: actions.filter((a) => a.kind === 'conflict').length,
    });
    return actions;
  }

  async execute(state: State, project: ProjectState, item: ItemDef, actions: Action[], report: Report) {
    for (const action of actions) {
      const label = `${project.name} › ${item.label} › ${action.rel}`;
      try {
        switch (action.kind) {
          case 'in-sync':
            if (action.remote?.deleted) delete state.base[action.id];
            else this.setBase(state, project, item, action.rel, action.remote!);
            delete state.conflicts[action.id];
            break;
          case 'down-write':
            await this.applyRemote(state, project, item, action, label);
            report.pulled.push(label);
            break;
          case 'down-delete':
            await this.applyRemote(state, project, item, action, label);
            report.deleted.push(label);
            break;
          case 'up-write':
          case 'up-delete':
            await this.pushLocal(state, project, item, action.rel, action.abs, action.remote?.version ?? 0);
            report.pushed.push(action.kind === 'up-delete' ? `${label} (xoá)` : label);
            break;
          case 'merge': {
            const remoteText = (await this.download(action.remote!)).toString('utf8');
            const merged = unionLines(fs.readFileSync(action.abs, 'utf8'), remoteText);
            writeAtomic(action.abs, Buffer.from(merged));
            this.setBase(state, project, item, action.rel, action.remote!);
            await this.pushLocal(state, project, item, action.rel, action.abs, action.remote!.version);
            report.pulled.push(`${label} (đã gộp)`);
            break;
          }
          case 'conflict':
            this.markConflict(state, project, item, action);
            report.conflicts.push(label);
            break;
        }
      } catch (error) {
        if (error instanceof VersionConflict) {
          this.markConflict(state, project, item, { ...action, remote: state.remote[action.id] });
          report.conflicts.push(label);
        } else {
          report.errors.push(`${label}: ${(error as Error).message}`);
        }
      }
    }
  }

  private setBase(state: State, project: ProjectState, item: ItemDef, rel: string, remote: RemoteEntry) {
    state.base[remote.id] = {
      version: remote.version,
      hash: remote.meta.type === 'file' ? remote.meta.hash : '',
      projectId: project.id,
      item: item.id,
      path: rel,
    };
  }

  private markConflict(state: State, project: ProjectState, item: ItemDef, action: Action) {
    const remote = action.remote ?? state.remote[action.id];
    state.conflicts[action.id] = {
      id: action.id,
      projectId: project.id,
      item: item.id,
      path: action.rel,
      remoteVersion: remote?.version ?? 0,
      reason: remote?.deleted ? 'remote-deleted' : action.local || fs.existsSync(action.abs) ? 'both-changed' : 'local-deleted',
      at: Date.now(),
    };
  }

  async download(remote: RemoteEntry): Promise<Buffer> {
    const { api, vault } = this.requireReady();
    if (!remote.blob) throw new Error('Bản ghi không có nội dung.');
    const data = vault.decrypt(await api.getBlob(remote.blob));
    if (remote.meta.type === 'file' && sha256(data) !== remote.meta.hash) throw new Error('Nội dung tải về sai hash.');
    return data;
  }

  async applyRemote(state: State, project: ProjectState, item: ItemDef, action: Pick<Action, 'id' | 'rel' | 'abs' | 'remote'>, label: string) {
    const remote = action.remote!;
    if (remote.deleted) {
      if (fs.existsSync(action.abs)) moveToTrash(this.options.trashDir, action.abs, label.replace(/ › /g, '/'));
      delete state.base[action.id];
    } else {
      writeAtomic(action.abs, await this.download(remote));
      this.setBase(state, project, item, action.rel, remote);
    }
    delete state.conflicts[action.id];
  }

  async pushLocal(state: State, project: ProjectState, item: ItemDef, rel: string, abs: string, baseVersion: number) {
    const { api, vault } = this.requireReady();
    const id = this.entryIdFor(project, item, rel);
    const meta: FileMeta = { type: 'file', projectId: project.id, item: item.id, path: rel, hash: '', deviceName: state.deviceName ?? '' };
    let entry: RemoteEntry;
    if (fs.existsSync(abs)) {
      const content = fs.readFileSync(abs);
      meta.hash = sha256(content);
      const encrypted = vault.encrypt(content);
      const blob = sha256(encrypted);
      await api.putBlob(blob, encrypted);
      entry = await this.commit(state, id, baseVersion, meta, blob, encrypted.length, false);
      this.setBase(state, project, item, rel, entry);
    } else {
      await this.commit(state, id, baseVersion, meta, null, 0, true);
      delete state.base[id];
    }
    delete state.conflicts[id];
  }

  async syncItem(state: State, project: ProjectState, item: ItemDef, direction: 'both' | 'up' | 'down', only?: Set<string>): Promise<Report> {
    const report = emptyReport();
    if (item.kind === 'wip') {
      if (direction !== 'down') await this.pushWip(state, project, report);
      return report;
    }
    const actions = this.plan(state, project, item, report).filter((action) => {
      if (only && !only.has(action.id)) return false;
      if (direction === 'up') return !action.kind.startsWith('down-');
      if (direction === 'down') return !action.kind.startsWith('up-');
      return true;
    });
    await this.execute(state, project, item, actions, report);
    this.plan(state, project, item);
    return report;
  }

  async syncAuto(state: State): Promise<Report> {
    const report = emptyReport();
    for (const project of Object.values(state.projects)) {
      if (!project.localPath) continue;
      for (const item of itemsFor(project)) {
        if (project.modes[item.id] !== 'auto') continue;
        mergeReports(report, await this.syncItem(state, project, item, 'both'));
      }
    }
    return report;
  }

  async syncProject(state: State, project: ProjectState): Promise<Report> {
    const report = emptyReport();
    for (const item of itemsFor(project)) {
      if ((project.modes[item.id] ?? 'off') === 'off') continue;
      mergeReports(report, await this.syncItem(state, project, item, 'both'));
    }
    return report;
  }

  refreshPending(state: State) {
    for (const project of Object.values(state.projects)) {
      if (!project.localPath) continue;
      for (const item of itemsFor(project)) {
        if (item.kind === 'files' && project.modes[item.id] !== 'off') this.plan(state, project, item);
      }
    }
  }

  envPreview(action: Action): Promise<string> {
    const read = async () => (action.remote && !action.remote.deleted && action.remote.blob ? (await this.download(action.remote)).toString('utf8') : undefined);
    const local = fs.existsSync(action.abs) ? fs.readFileSync(action.abs, 'utf8') : undefined;
    return read().then((remote) => (action.kind.startsWith('up-') ? envKeyDiff(remote, local) : envKeyDiff(local, remote)));
  }

  async pushWip(state: State, project: ProjectState, report: Report) {
    if (!project.localPath) return;
    const env = itemById('env')!;
    const envMatcher = new Matcher(env.include, env.exclude);
    const pkg = await createWip(project.localPath, (rel) => envMatcher.matches(rel));
    const content = Buffer.from(JSON.stringify(pkg));
    const id = this.vault!.entryId(project.id, 'wip', state.deviceId ?? '');
    const remote = state.remote[id];
    const empty = pkg.patch.trim() === '';
    const meta: FileMeta = {
      type: 'file',
      projectId: project.id,
      item: 'wip',
      path: `${pkg.branch}@${sha256(pkg.patch).slice(0, 12)}`,
      hash: sha256(content),
      deviceName: state.deviceName ?? '',
    };
    if (empty && (!remote || remote.deleted)) return;
    if (remote?.meta.type === 'file' && remote.meta.path === meta.path && remote.deleted === empty) return;
    const { api, vault } = this.requireReady();
    const encrypted = vault.encrypt(content);
    const blob = sha256(encrypted);
    if (!empty) await api.putBlob(blob, encrypted);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.commit(state, id, state.remote[id]?.version ?? 0, meta, empty ? null : blob, empty ? 0 : encrypted.length, empty);
        break;
      } catch (error) {
        if (!(error instanceof VersionConflict) || attempt === 1) throw error;
      }
    }
    report.pushed.push(`${project.name} › Code dở (${empty ? 'không có thay đổi' : `${pkg.branch}, ${content.length} byte`})`);
    if (pkg.skipped.length) report.skipped.push(...pkg.skipped);
  }

  wipsFrom(state: State, project: ProjectState): RemoteEntry[] {
    return Object.values(state.remote).filter(
      (e) => e.meta.type === 'file' && e.meta.item === 'wip' && e.meta.projectId === project.id && !e.deleted && e.deviceId !== state.deviceId,
    );
  }

  async loadWip(entry: RemoteEntry): Promise<WipPackage> {
    return JSON.parse((await this.download(entry)).toString('utf8')) as WipPackage;
  }

  async publishHandoff(state: State, project: ProjectState, note: string, branch?: string) {
    const id = this.vault!.entryId(project.id, '_handoff', state.deviceId ?? '');
    const meta: HandoffMeta = { type: 'handoff', projectId: project.id, note, branch, deviceName: state.deviceName ?? '', at: Date.now() };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.commit(state, id, state.remote[id]?.version ?? 0, meta, null, 0, false);
        return;
      } catch (error) {
        if (!(error instanceof VersionConflict) || attempt === 1) throw error;
      }
    }
  }

  takeNewHandoffs(state: State): { entry: RemoteEntry; meta: HandoffMeta; project: ProjectState }[] {
    const result = [];
    for (const entry of Object.values(state.remote)) {
      if (entry.meta.type !== 'handoff' || entry.deviceId === state.deviceId) continue;
      const project = state.projects[entry.meta.projectId];
      if (!project?.localPath || (state.seenHandoff[entry.id] ?? 0) >= entry.updatedAt) continue;
      state.seenHandoff[entry.id] = entry.updatedAt;
      result.push({ entry, meta: entry.meta, project });
    }
    return result;
  }

  async history(id: string): Promise<RemoteEntry[]> {
    const { api } = this.requireReady();
    const { versions } = await api.json<{ versions: RawEntry[] }>('GET', `/history/${id}`);
    return versions.map((raw) => this.decode(raw)).filter((entry): entry is RemoteEntry => !!entry);
  }

  async devices(): Promise<DeviceInfo[]> {
    const { api } = this.requireReady();
    return (await api.json<{ devices: DeviceInfo[] }>('GET', '/devices')).devices;
  }

  async revokeDevice(id: string) {
    await this.requireReady().api.json('DELETE', `/devices/${id}`);
  }

  async createInviteCode(): Promise<string> {
    return (await this.requireReady().api.json<{ code: string }>('POST', '/pair-codes')).code;
  }

  localHashOf(abs: string) {
    return localHash(abs);
  }
}
