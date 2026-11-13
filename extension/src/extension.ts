import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatInvite } from './api';
import { Vault, sha256 } from './crypto';
import { Engine, emptyReport, mergeReports, type Action, type Report } from './engine';
import { Matcher, moveToTrash, writeAtomic } from './files';
import { applyWip, currentHead, projectIdForRemote, remoteOf } from './git';
import { GLOBAL_PROJECT_ID, defaultModes, globalProject, itemById, itemsFor, type ItemDef } from './items';
import { Leader, Store, type Mode, type ProjectState, type State } from './state';
import { fetchUpdate } from './updater';
import { DevicesTree, MODE_LABEL, ProjectsTree, relativeTime, type DeviceNode, type ProjectNode } from './tree';

type Direction = 'up' | 'down' | 'both';

class Controller implements vscode.Disposable {
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly output = vscode.window.createOutputChannel('DevSync');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly projectsTree: ProjectsTree;
  private readonly devicesTree: DevicesTree;
  private readonly leader: Leader;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly notifiedConflicts = new Set<string>();
  private stopEvents?: () => void;
  private interval?: NodeJS.Timeout;
  private busy = 0;
  private live = false;

  constructor(private readonly context: vscode.ExtensionContext) {
    const dir = context.globalStorageUri.fsPath;
    this.store = new Store(dir);
    this.engine = new Engine(this.store, context.secrets, {
      maxBytes: () => this.config<number>('maxFileMB', 50) * 1024 * 1024,
      log: (message) => this.log(message),
      trashDir: path.join(dir, 'trash'),
    });
    this.projectsTree = new ProjectsTree(this.store, this.engine);
    this.devicesTree = new DevicesTree(this.store, this.engine);
    this.leader = new Leader(dir, (leading) => (leading ? this.startBackground() : this.stopBackground()));
  }

  async start() {
    this.disposables.push(
      this.output,
      this.status,
      vscode.window.registerTreeDataProvider('devsync.projects', this.projectsTree),
      vscode.window.registerTreeDataProvider('devsync.devices', this.devicesTree),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && this.leader.isLeader && Date.now() - (this.store.read().lastSyncAt ?? 0) > 120_000) this.schedule('focus', 1_000, () => this.runAuto());
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('devsync.intervalMinutes') && this.leader.isLeader) this.resetInterval();
      }),
    );
    this.registerCommands();
    this.status.command = 'devsync.syncNow';
    this.status.show();
    fs.watchFile(this.store.stateFile, { interval: 2_000 }, () => this.refreshViews());
    this.disposables.push({ dispose: () => fs.unwatchFile(this.store.stateFile) });
    const statusTicker = setInterval(() => this.updateStatus(), 30_000);
    this.disposables.push({ dispose: () => clearInterval(statusTicker) });

    const connected = await this.engine.load();
    await vscode.commands.executeCommand('setContext', 'devsync.connected', connected);
    this.updateStatus();
    if (!connected) return;
    this.leader.start();
    void this.devicesTree.reload();
    void this.suggestLinks();
  }

  dispose() {
    this.stopBackground();
    this.leader.stop();
    for (const timer of this.debounce.values()) clearTimeout(timer);
    for (const d of this.disposables) d.dispose();
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('devsync').get<T>(key, fallback);
  }

  private log(message: string) {
    this.output.appendLine(`[${new Date().toLocaleTimeString('vi-VN')}] ${message}`);
  }

  private deviceName() {
    return this.config<string>('deviceName', '').trim() || os.hostname().replace(/\.local$/, '');
  }

  private startBackground() {
    this.log('Cửa sổ này phụ trách đồng bộ nền.');
    this.stopEvents = this.engine.api?.subscribe(
      (event, data) => {
        this.live = true;
        if (event === 'seq' && Number(data) > this.store.read().lastSeq) this.schedule('remote', 3_000, () => this.runAuto());
        if (event === 'release') this.schedule('update', 2_000, () => this.checkUpdate(false));
      },
      (connected) => {
        this.live = connected;
        this.updateStatus();
      },
    );
    this.resetInterval();
    this.schedule('startup', 4_000, () => this.runAuto());
    this.schedule('update', 15_000, () => this.checkUpdate(false));
  }

  private async checkUpdate(interactive: boolean) {
    if (!this.engine.api) return;
    if (!interactive && !this.config<boolean>('autoUpdate', true)) return;
    const current = this.context.extension.packageJSON.version as string;
    try {
      const update = await fetchUpdate(this.engine.api, current, path.join(this.context.globalStorageUri.fsPath, 'updates'));
      if (!update) {
        if (interactive) void vscode.window.showInformationMessage(`DevSync đang ở bản mới nhất (${current}).`);
        return;
      }
      if (!interactive && this.context.globalState.get('devsync.installedUpdate') === update.release.version) return;
      await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(update.vsix));
      await this.context.globalState.update('devsync.installedUpdate', update.release.version);
      this.log(`Đã cài bản ${update.release.version}${update.release.notes ? `: ${update.release.notes}` : ''}`);
      const pick = await vscode.window.showInformationMessage(
        `DevSync đã cập nhật lên ${update.release.version}${update.release.notes ? ` — ${update.release.notes}` : ''}. Tải lại cửa sổ để dùng bản mới.`,
        'Tải lại',
      );
      if (pick) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (error) {
      this.log(`Cập nhật thất bại: ${(error as Error).message}`);
      if (interactive) void vscode.window.showErrorMessage(`DevSync: ${(error as Error).message}`);
    }
  }

  private stopBackground() {
    this.stopEvents?.();
    this.stopEvents = undefined;
    if (this.interval) clearInterval(this.interval);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private resetInterval() {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      void this.runAuto();
      void this.checkUpdate(false);
    }, Math.max(1, this.config<number>('intervalMinutes', 15)) * 60_000);
  }

  private schedule(key: string, delay: number, task: () => Promise<unknown>) {
    clearTimeout(this.debounce.get(key));
    this.debounce.set(
      key,
      setTimeout(() => {
        this.debounce.delete(key);
        void task();
      }, delay),
    );
  }

  private rebuildWatchers(state: State) {
    const wanted = new Map<string, { project: ProjectState; item: ItemDef; dir: string; prefix: string; matcher: Matcher }>();
    for (const project of Object.values(state.projects)) {
      if (!project.localPath) continue;
      for (const item of itemsFor(project)) {
        if (project.modes[item.id] !== 'auto' || item.kind !== 'files') continue;
        const root = item.root?.(project);
        if (!root) continue;
        const matcher = new Matcher(item.include, item.exclude);
        for (const prefix of matcher.prefixes) {
          const dir = path.join(root, prefix);
          if (fs.existsSync(dir)) wanted.set(`${project.id}/${item.id}/${dir}`, { project, item, dir, prefix, matcher });
        }
      }
    }
    for (const [key, watcher] of this.watchers) {
      if (!wanted.has(key)) {
        watcher.close();
        this.watchers.delete(key);
      }
    }
    const delay = Math.max(5, this.config<number>('debounceSeconds', 45)) * 1000;
    for (const [key, target] of wanted) {
      if (this.watchers.has(key)) continue;
      try {
        const watcher = fs.watch(target.dir, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const rel = [target.prefix, filename.toString().split(path.sep).join('/')].filter(Boolean).join('/');
          if (!target.matcher.matches(rel)) return;
          this.schedule(`watch:${target.project.id}/${target.item.id}`, delay, () => this.runItem(target.project.id, target.item.id));
        });
        watcher.on('error', () => this.watchers.delete(key));
        this.watchers.set(key, watcher);
      } catch (error) {
        this.log(`Không theo dõi được ${target.dir}: ${(error as Error).message}`);
      }
    }
  }

  private async withBusy<T>(task: () => Promise<T>): Promise<T> {
    this.busy++;
    this.updateStatus();
    try {
      return await task();
    } finally {
      this.busy--;
      this.refreshViews();
    }
  }

  private async runAuto(): Promise<void> {
    if (!this.engine.connected) return;
    await this.withBusy(async () => {
      try {
        const { report, handoffs } = await this.store.update(async (state) => {
          await this.engine.refreshRemote(state);
          const report = await this.engine.syncAuto(state);
          const handoffs = this.engine.takeNewHandoffs(state);
          this.engine.refreshPending(state);
          state.lastSyncAt = Date.now();
          state.lastError = report.errors[0];
          if (this.leader.isLeader) this.rebuildWatchers(state);
          return { report, handoffs };
        });
        this.handleReport(report, false);
        for (const handoff of handoffs) void this.showHandoff(handoff.project.id, handoff.meta.deviceName, handoff.meta.note, handoff.meta.branch);
      } catch (error) {
        await this.recordError(error);
      }
    });
  }

  private async runItem(projectId: string, itemId: string) {
    const item = itemById(itemId);
    if (!item || !this.engine.connected) return;
    await this.withBusy(async () => {
      try {
        const report = await this.store.update(async (state) => {
          const project = state.projects[projectId];
          if (!project?.localPath || project.modes[itemId] !== 'auto') return emptyReport();
          await this.engine.refreshRemote(state);
          const report = await this.engine.syncItem(state, project, item, 'both');
          state.lastSyncAt = Date.now();
          return report;
        });
        this.handleReport(report, false);
      } catch (error) {
        await this.recordError(error);
      }
    });
  }

  private async recordError(error: unknown) {
    const message = (error as Error).message;
    this.log(`Lỗi: ${message}`);
    await this.store.update((state) => {
      state.lastError = message;
    });
  }

  private handleReport(report: Report, interactive: boolean) {
    for (const line of report.pushed) this.log(`↑ ${line}`);
    for (const line of report.pulled) this.log(`↓ ${line}`);
    for (const line of report.deleted) this.log(`✕ ${line}`);
    for (const line of report.merged) this.log(`⇄ Gộp ${line}`);
    for (const line of report.annotated) this.log(`⇄ Gộp có ghi chú phân biệt máy ${line}`);
    for (const line of report.skipped) this.log(`Bỏ qua ${line}`);
    for (const line of report.errors) this.log(`Lỗi ${line}`);
    if (report.annotated.length) {
      void vscode.window
        .showInformationMessage(
          `DevSync: ${report.annotated.length} file được sửa trên cả hai máy. Đã giữ nội dung của cả hai, chỗ khác nhau có ghi chú tên máy.`,
          'Xem',
        )
        .then((pick) => {
          if (!pick) return;
          const review = Object.values(this.store.read().reviews)[0];
          if (review) void this.openReview(review.id);
        });
    }
    const fresh = report.conflicts.filter((c) => !this.notifiedConflicts.has(c));
    for (const line of report.conflicts) {
      this.log(`⚠ Xung đột ${line}`);
      this.notifiedConflicts.add(line);
    }
    if (fresh.length) {
      void vscode.window.showWarningMessage(`DevSync: ${fresh.length} file bị xung đột giữa các máy.`, 'Xem').then((pick) => {
        if (pick) void vscode.commands.executeCommand('devsync.projects.focus');
      });
    }
    if (interactive) {
      const parts = [
        report.pushed.length ? `đẩy ${report.pushed.length}` : '',
        report.pulled.length ? `kéo ${report.pulled.length}` : '',
        report.deleted.length ? `xoá ${report.deleted.length}` : '',
        report.conflicts.length ? `xung đột ${report.conflicts.length}` : '',
        report.errors.length ? `lỗi ${report.errors.length}` : '',
      ].filter(Boolean);
      const text = parts.length ? `DevSync: ${parts.join(', ')}.` : 'DevSync: mọi thứ đã khớp.';
      const show = report.errors.length ? vscode.window.showErrorMessage : vscode.window.showInformationMessage;
      void show(text, 'Nhật ký').then((pick) => pick && this.output.show());
    }
  }

  private refreshViews() {
    this.projectsTree.refresh();
    this.updateStatus();
  }

  private updateStatus() {
    if (!this.engine.connected) {
      this.status.text = '$(cloud) DevSync: chưa kết nối';
      this.status.command = 'devsync.connect';
      this.status.tooltip = 'Bấm để kết nối máy chủ đồng bộ';
      return;
    }
    this.status.command = 'devsync.syncNow';
    const state = this.store.read();
    const conflicts = Object.keys(state.conflicts).length;
    if (this.busy) this.status.text = '$(sync~spin) DevSync';
    else if (conflicts) this.status.text = `$(warning) DevSync: ${conflicts} xung đột`;
    else if (state.lastError) this.status.text = '$(cloud-offline) DevSync';
    else this.status.text = '$(cloud) DevSync';
    const pending = [...this.engine.pending.values()].reduce((sum, p) => ({ up: sum.up + p.up, down: sum.down + p.down }), { up: 0, down: 0 });
    this.status.tooltip = [
      `Máy chủ: ${state.server?.host}:${state.server?.port}`,
      `Đồng bộ lần cuối: ${relativeTime(state.lastSyncAt)}`,
      this.leader.isLeader ? `Kênh realtime: ${this.live ? 'đang kết nối' : 'mất kết nối'}` : 'Cửa sổ khác đang phụ trách đồng bộ nền',
      `Chờ đẩy: ${pending.up} · chờ kéo: ${pending.down}`,
      state.lastError ? `Lỗi gần nhất: ${state.lastError}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  private register(command: string, handler: (...args: never[]) => unknown) {
    this.disposables.push(
      vscode.commands.registerCommand(command, async (...args: never[]) => {
        try {
          await handler(...args);
        } catch (error) {
          this.log(`Lỗi ${command}: ${(error as Error).message}`);
          void vscode.window.showErrorMessage(`DevSync: ${(error as Error).message}`);
        }
      }),
    );
  }

  private registerCommands() {
    this.register('devsync.connect', () => this.connect());
    this.register('devsync.invite', () => this.invite());
    this.register('devsync.showKey', () => this.copyKey());
    this.register('devsync.addProject', () => this.addProject());
    this.register('devsync.linkProject', (node: ProjectNode) => this.linkProject(node));
    this.register('devsync.unlinkProject', (node: ProjectNode) => this.unlinkProject(node));
    this.register('devsync.syncNow', () => this.syncNow());
    this.register('devsync.syncProject', (node: ProjectNode) => this.syncProject(node));
    this.register('devsync.pushItem', (node: ProjectNode) => this.transferNode(node, 'up'));
    this.register('devsync.pullItem', (node: ProjectNode) => this.transferNode(node, 'down'));
    this.register('devsync.setMode', (node: ProjectNode) => this.setMode(node));
    this.register('devsync.handoff', (node: ProjectNode) => this.handoff(node));
    this.register('devsync.applyWip', (node: ProjectNode) => this.applyWip(node));
    this.register('devsync.history', (node: ProjectNode) => this.history(node));
    this.register('devsync.resolveConflict', (node: ProjectNode) => this.resolveConflict(node));
    this.register('devsync.revokeDevice', (node: DeviceNode) => this.revokeDevice(node));
    this.register('devsync.refresh', () => this.refresh());
    this.register('devsync.showLog', () => this.output.show());
    this.register('devsync.checkUpdate', () => this.checkUpdate(true));
    this.register('devsync.openReview', (node: ProjectNode) => node.kind === 'review' && this.openReview(node.review.id));
    this.register('devsync.dismissReview', (node: ProjectNode) => node.kind === 'review' && this.dismissReview(node.review.id));
  }

  private requireConnected() {
    if (!this.engine.connected) throw new Error('Chưa kết nối máy chủ. Chạy "DevSync: Kết nối máy chủ".');
  }

  private progress<T>(title: string, task: () => Promise<T>) {
    return this.withBusy(() => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `DevSync: ${title}` }, task)));
  }

  private async connect() {
    const inviteText = await vscode.window.showInputBox({
      title: 'Kết nối máy chủ DevSync',
      prompt: 'Dán chuỗi devsync://… (lấy từ "Tạo mã ghép thiết bị" trên máy đã kết nối, hoặc lệnh admin.ts invite trên VPS)',
      ignoreFocusOut: true,
    });
    if (!inviteText) return;
    const deviceName = await vscode.window.showInputBox({ title: 'Tên thiết bị', value: this.deviceName(), ignoreFocusOut: true });
    if (!deviceName) return;
    const paired = await this.progress('đang ghép thiết bị…', () => this.engine.pair(inviteText, deviceName));

    let key = paired.inviteKey;
    if (!key) {
      const hasData = await this.engine.serverHasData(paired.server, paired.token);
      if (hasData) {
        key = await vscode.window.showInputBox({
          title: 'Khoá đồng bộ',
          prompt: 'Máy chủ đã có dữ liệu. Nhập khoá đồng bộ của máy đã kết nối (DevSync: Sao chép khoá đồng bộ).',
          password: true,
          ignoreFocusOut: true,
        });
        if (!key) return;
      } else {
        key = Vault.generateKey();
        await vscode.env.clipboard.writeText(key);
        await vscode.window.showInformationMessage(
          'Đã tạo khoá đồng bộ mới và sao chép vào clipboard. Hãy lưu khoá vào trình quản lý mật khẩu: mất khoá thì không đọc lại được dữ liệu trên máy chủ.',
          { modal: true },
          'Đã lưu',
        );
      }
    }
    await this.engine.finishPairing(paired.server, paired.deviceId, paired.token, deviceName, key);
    await vscode.commands.executeCommand('setContext', 'devsync.connected', true);
    this.log(`Đã kết nối ${paired.server.host}:${paired.server.port} với tên "${deviceName}".`);
    this.leader.stop();
    this.leader.start();
    await this.refresh();
    void this.devicesTree.reload();
    void this.suggestLinks();
    void vscode.window.showInformationMessage('DevSync đã kết nối. Thêm dự án cần đồng bộ ở thanh DevSync bên trái.');
  }

  private async invite() {
    this.requireConnected();
    const code = await this.engine.createInviteCode();
    const key = await this.engine.getKey();
    const state = this.store.read();
    await vscode.env.clipboard.writeText(formatInvite(state.server!, code, key!));
    void vscode.window.showInformationMessage(
      'Đã sao chép chuỗi ghép thiết bị (chứa khoá đồng bộ, hết hạn sau 10 phút). Trên máy mới chạy "DevSync: Kết nối máy chủ" rồi dán vào. Chỉ chuyển chuỗi qua kênh riêng tư.',
    );
  }

  private async copyKey() {
    this.requireConnected();
    const pick = await vscode.window.showWarningMessage('Khoá đồng bộ giải mã được toàn bộ dữ liệu. Sao chép vào clipboard?', { modal: true }, 'Sao chép');
    if (pick) await vscode.env.clipboard.writeText((await this.engine.getKey())!);
  }

  private async suggestLinks() {
    const state = this.store.read();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const remote = await remoteOf(folder.uri.fsPath);
      if (!remote) continue;
      const project = state.projects[projectIdForRemote(remote)];
      if (!project || project.localPath) continue;
      const pick = await vscode.window.showInformationMessage(
        `DevSync: dự án "${project.name}" đang được đồng bộ từ máy khác. Liên kết với thư mục ${folder.name} trên máy này?`,
        'Liên kết',
        'Để sau',
      );
      if (pick === 'Liên kết') await this.link(project.id, folder.uri.fsPath);
    }
  }

  private async addProject() {
    this.requireConnected();
    const state = this.store.read();
    type Pick = vscode.QuickPickItem & { folder?: string; global?: boolean; browse?: boolean };
    const linkedPaths = new Set(Object.values(state.projects).map((p) => p.localPath));
    const picks: Pick[] = [
      ...(vscode.workspace.workspaceFolders ?? [])
        .filter((f) => !linkedPaths.has(f.uri.fsPath))
        .map((f) => ({ label: `$(folder) ${f.name}`, description: f.uri.fsPath, folder: f.uri.fsPath })),
      { label: '$(folder-opened) Chọn thư mục khác…', browse: true },
    ];
    if (!state.projects[GLOBAL_PROJECT_ID]?.localPath) {
      picks.push({ label: '$(settings) Cấu hình Claude chung', description: '~/.claude — skills, commands, settings', global: true });
    }
    const pick = await vscode.window.showQuickPick(picks, { title: 'Thêm dự án cần đồng bộ' });
    if (!pick) return;
    if (pick.global) return this.link(GLOBAL_PROJECT_ID, os.homedir());

    let folder = pick.folder;
    if (pick.browse) {
      const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Chọn dự án' });
      folder = uri?.[0]?.fsPath;
    }
    if (!folder) return;
    const remote = await remoteOf(folder);
    const projectId = remote ? projectIdForRemote(remote) : sha256(`local:${randomUUID()}`).slice(0, 24);
    if (state.projects[projectId]) return this.link(projectId, folder);

    const name = await vscode.window.showInputBox({ title: 'Tên dự án', value: path.basename(folder), ignoreFocusOut: true });
    if (!name) return;
    const modes = await this.pickModes(defaultModes(false), false);
    if (!modes) return;
    const project: ProjectState = { id: projectId, name, remote, localPath: folder, modes, modesAt: Date.now() };
    await this.store.update(async (s) => {
      s.projects[projectId] = project;
      await this.engine.publishProject(s, project);
    });
    if (!remote) {
      void vscode.window.showWarningMessage(
        'Thư mục này không có git remote "origin". Máy khác cần liên kết thủ công bằng nút Liên kết trên dự án.',
      );
    }
    await this.runAuto();
  }

  private async pickModes(current: Record<string, Mode>, global: boolean): Promise<Record<string, Mode> | undefined> {
    const items = itemsFor({ global } as ProjectState);
    const picks = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.label,
        description: MODE_LABEL[current[item.id] === 'off' ? item.defaultMode : current[item.id]],
        detail: item.detail,
        picked: current[item.id] !== 'off',
        item,
      })),
      { title: 'Chọn các mục cần đồng bộ (đổi Tự động/Thủ công sau bằng nút ⚙ trên từng mục)', canPickMany: true, ignoreFocusOut: true },
    );
    if (!picks) return undefined;
    const chosen = new Set(picks.map((p) => p.item.id));
    return Object.fromEntries(items.map((item) => [item.id, chosen.has(item.id) ? (current[item.id] === 'off' ? item.defaultMode : current[item.id]) : 'off']));
  }

  private async link(projectId: string, folder: string) {
    await this.store.update(async (state) => {
      if (projectId === GLOBAL_PROJECT_ID && !state.projects[projectId]) {
        state.projects[projectId] = { ...globalProject(), modesAt: Date.now() };
        await this.engine.publishProject(state, state.projects[projectId]);
      }
      const project = state.projects[projectId];
      project.localPath = projectId === GLOBAL_PROJECT_ID ? globalProject().localPath : folder;
    });
    this.log(`Đã liên kết dự án ${projectId} với ${folder}.`);
    await this.runAuto();
  }

  private async linkProject(node: ProjectNode) {
    this.requireConnected();
    const project = node.project;
    if (project.global) return this.link(project.id, os.homedir());
    const uri = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      openLabel: `Liên kết với ${project.name}`,
    });
    const folder = uri?.[0]?.fsPath;
    if (!folder) return;
    const remote = await remoteOf(folder);
    if (project.remote && remote !== project.remote) {
      const pick = await vscode.window.showWarningMessage(
        `Thư mục này có remote "${remote ?? 'không có'}", khác với dự án "${project.remote}". Vẫn liên kết?`,
        { modal: true },
        'Vẫn liên kết',
      );
      if (!pick) return;
    }
    await this.link(project.id, folder);
  }

  private async unlinkProject(node: ProjectNode) {
    const pick = await vscode.window.showWarningMessage(
      `Ngừng đồng bộ "${node.project.name}" trên máy này? Dữ liệu trên máy chủ và các máy khác giữ nguyên.`,
      { modal: true },
      'Ngừng đồng bộ',
    );
    if (!pick) return;
    await this.store.update((state) => {
      const project = state.projects[node.project.id];
      if (project) project.localPath = undefined;
      for (const key of Object.keys(state.conflicts)) if (state.conflicts[key].projectId === node.project.id) delete state.conflicts[key];
    });
    for (const key of [...this.engine.pending.keys()]) if (key.startsWith(`${node.project.id}/`)) this.engine.pending.delete(key);
  }

  private async syncNow() {
    this.requireConnected();
    await this.runAuto();
    const state = this.store.read();
    if (state.lastError) void vscode.window.showErrorMessage(`DevSync: ${state.lastError}`, 'Nhật ký').then((p) => p && this.output.show());
    else void vscode.window.setStatusBarMessage('$(check) DevSync: đã đồng bộ các mục tự động', 4_000);
  }

  private async refresh() {
    if (!this.engine.connected) return;
    await this.withBusy(() =>
      this.store.update(async (state) => {
        await this.engine.refreshRemote(state);
        this.engine.refreshPending(state);
      }),
    );
    void this.devicesTree.reload();
  }

  private actionLabel(action: Action) {
    const icon = { 'up-write': '$(arrow-up)', 'up-delete': '$(trash)', 'down-write': '$(arrow-down)', 'down-delete': '$(trash)', merge: '$(merge)' }[
      action.kind as 'up-write'
    ];
    const where = action.kind.startsWith('down-') ? 'từ máy khác' : 'lên máy chủ';
    const what = action.kind.endsWith('delete') ? `xoá (${where})` : action.kind === 'merge' ? 'gộp dòng' : where;
    return { label: `${icon ?? ''} ${action.rel}`, description: what };
  }

  private async transfer(projectId: string, itemId: string, direction: Direction, preview: boolean): Promise<Report | undefined> {
    this.requireConnected();
    const item = itemById(itemId)!;
    if (item.kind === 'wip') {
      if (direction === 'down') return undefined;
      return this.progress('đóng gói code dở…', () =>
        this.store.update(async (state) => {
          const report = emptyReport();
          await this.engine.pushWip(state, state.projects[projectId], report);
          return report;
        }),
      );
    }

    const actions = await this.progress('đang so sánh…', () =>
      this.store.update(async (state) => {
        await this.engine.refreshRemote(state);
        return this.engine.plan(state, state.projects[projectId], item);
      }),
    );
    const silent = actions.filter((a) => a.kind === 'in-sync').map((a) => a.id);
    const visible = actions.filter((a) => {
      if (a.kind === 'in-sync' || a.kind === 'conflict') return false;
      if (direction === 'up') return a.kind.startsWith('up-') || a.kind === 'merge';
      if (direction === 'down') return a.kind.startsWith('down-') || a.kind === 'merge';
      return true;
    });
    const conflicts = actions.filter((a) => a.kind === 'conflict').length;
    if (!visible.length) {
      if (preview) {
        void vscode.window.showInformationMessage(
          `DevSync: ${item.label} không có gì để ${direction === 'up' ? 'đẩy lên' : direction === 'down' ? 'kéo về' : 'đồng bộ'}${conflicts ? ` (${conflicts} xung đột cần xử lý riêng)` : ''}.`,
        );
      }
      if (silent.length) await this.store.update((state) => this.engine.syncItem(state, state.projects[projectId], item, direction, new Set(silent)));
      return emptyReport();
    }

    let selected = visible.map((a) => a.id);
    if (preview) {
      const picks = await this.progress('chuẩn bị xem trước…', async () =>
        Promise.all(
          visible.map(async (action) => ({
            ...this.actionLabel(action),
            detail: item.sensitive ? await this.engine.envPreview(action).catch(() => 'không đọc được nội dung') : undefined,
            picked: true,
            id: action.id,
          })),
        ),
      );
      const chosen = await vscode.window.showQuickPick(picks, {
        title: `${item.label}: chọn file cần ${direction === 'up' ? 'đẩy lên' : direction === 'down' ? 'kéo về' : 'đồng bộ'}`,
        canPickMany: true,
        ignoreFocusOut: true,
      });
      if (!chosen) return undefined;
      selected = chosen.map((c) => c.id);
    }
    const only = new Set([...selected, ...silent]);
    return this.progress(`${item.label}…`, () =>
      this.store.update((state) => this.engine.syncItem(state, state.projects[projectId], item, direction, only)),
    );
  }

  private async transferNode(node: ProjectNode, direction: Direction) {
    if (node.kind !== 'item') return;
    const report = await this.transfer(node.project.id, node.item.id, direction, true);
    if (report) this.handleReport(report, true);
  }

  private async syncProject(node: ProjectNode) {
    if (node.kind !== 'project') return;
    const state = this.store.read();
    const project = state.projects[node.project.id];
    const report = emptyReport();
    for (const item of itemsFor(project)) {
      if ((project.modes[item.id] ?? 'off') === 'off') continue;
      const result = await this.transfer(project.id, item.id, 'both', !!item.sensitive);
      if (result) mergeReports(report, result);
    }
    this.handleReport(report, true);
  }

  private async setMode(node: ProjectNode) {
    if (node.kind !== 'item') return;
    const { item } = node;
    const current = node.project.modes[item.id] ?? 'off';
    const options: { label: string; description: string; mode: Mode }[] = [
      {
        label: `$(sync) ${MODE_LABEL.auto}`,
        description: item.kind === 'wip' ? 'Định kỳ đẩy bản sao lưu code dở, không bao giờ tự áp vào máy khác' : 'Tự đẩy khi file đổi, tự kéo khi máy khác cập nhật',
        mode: 'auto',
      },
      { label: `$(debug-pause) ${MODE_LABEL.manual}`, description: 'Chỉ đồng bộ khi bấm nút đẩy/kéo', mode: 'manual' },
      { label: `$(circle-slash) ${MODE_LABEL.off}`, description: 'Không đồng bộ mục này', mode: 'off' },
    ];
    const pick = await vscode.window.showQuickPick(
      options.map((o) => ({ ...o, picked: o.mode === current, label: o.mode === current ? `${o.label} (đang dùng)` : o.label })),
      { title: `${item.label}: chế độ đồng bộ` },
    );
    if (!pick || pick.mode === current) return;
    if (pick.mode === 'auto' && item.sensitive) {
      const confirm = await vscode.window.showWarningMessage(
        'Tự động đồng bộ file env sẽ ghi đè secret giữa các máy mà không xem trước. Vẫn bật?',
        { modal: true },
        'Bật tự động',
      );
      if (!confirm) return;
    }
    await this.store.update(async (state) => {
      const project = state.projects[node.project.id];
      project.modes[item.id] = pick.mode;
      project.modesAt = Date.now();
      await this.engine.publishProject(state, project);
    });
    if (pick.mode === 'auto') await this.runAuto();
    else if (this.leader.isLeader) this.rebuildWatchers(this.store.read());
  }

  private async handoff(node: ProjectNode) {
    if (node.kind !== 'project') return;
    this.requireConnected();
    const project = this.store.read().projects[node.project.id];
    const items = itemsFor(project).filter((item) => (project.modes[item.id] ?? 'off') !== 'off');
    const chosen = await vscode.window.showQuickPick(
      items.map((item) => ({ label: item.label, description: MODE_LABEL[project.modes[item.id]], picked: true, item })),
      { title: `Bàn giao "${project.name}": chọn mục đẩy lên`, canPickMany: true, ignoreFocusOut: true },
    );
    if (!chosen) return;
    const note = await vscode.window.showInputBox({
      title: 'Ghi chú bàn giao',
      prompt: 'Đang làm gì, bước tiếp theo là gì (hiện trên máy kia khi mở VS Code)',
      ignoreFocusOut: true,
    });
    if (note === undefined) return;
    const report = await this.progress('đang bàn giao…', () =>
      this.store.update(async (state) => {
        const current = state.projects[project.id];
        const report = emptyReport();
        await this.engine.refreshRemote(state);
        for (const { item } of chosen) mergeReports(report, await this.engine.syncItem(state, current, item, 'up'));
        const branch = current.global ? undefined : await currentHead(current.localPath!).then((h) => h.branch).catch(() => undefined);
        await this.engine.publishHandoff(state, current, note, branch);
        state.lastSyncAt = Date.now();
        return report;
      }),
    );
    this.handleReport(report, true);
  }

  private async showHandoff(projectId: string, deviceName: string, note: string, branch?: string) {
    const project = this.store.read().projects[projectId];
    if (!project) return;
    const message = `DevSync: ${deviceName} vừa bàn giao "${project.name}"${branch ? ` (nhánh ${branch})` : ''}${note ? `: ${note}` : ''}`;
    const hasWip = this.engine.wipsFrom(this.store.read(), project).length > 0;
    const actions = ['Kéo tất cả', ...(hasWip ? ['Áp code dở'] : [])];
    const pick = await vscode.window.showInformationMessage(message, ...actions);
    if (pick === 'Kéo tất cả') {
      const report = emptyReport();
      for (const item of itemsFor(project)) {
        if ((project.modes[item.id] ?? 'off') === 'off' || item.kind !== 'files') continue;
        const result = await this.transfer(project.id, item.id, 'down', !!item.sensitive);
        if (result) mergeReports(report, result);
      }
      this.handleReport(report, true);
    } else if (pick === 'Áp code dở') {
      await this.applyWip({ kind: 'project', project });
    }
  }

  private async applyWip(node: ProjectNode) {
    this.requireConnected();
    const project = this.store.read().projects[node.project.id];
    if (!project?.localPath) return;
    const entries = await this.store.update(async (state) => {
      await this.engine.refreshRemote(state);
      return this.engine.wipsFrom(state, state.projects[project.id]);
    });
    if (!entries.length) {
      void vscode.window.showInformationMessage('DevSync: chưa có máy nào gửi code dở cho dự án này.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      entries.map((entry) => ({
        label: `$(device-desktop) ${entry.meta.type === 'file' ? entry.meta.deviceName : ''}`,
        description: entry.meta.type === 'file' ? entry.meta.path.split('@')[0] : '',
        detail: `Gửi ${relativeTime(entry.updatedAt)}`,
        entry,
      })),
      { title: 'Chọn bản code dở cần áp' },
    );
    if (!pick) return;
    const pkg = await this.progress('tải patch…', () => this.engine.loadWip(pick.entry));
    const doc = await vscode.workspace.openTextDocument({ content: pkg.patch, language: 'diff' });
    await vscode.window.showTextDocument(doc, { preview: true });
    const head = await currentHead(project.localPath).catch(() => undefined);
    const warnings = [
      head && head.branch !== pkg.branch ? `Máy này đang ở nhánh "${head.branch}", patch tạo trên nhánh "${pkg.branch}".` : '',
      head && head.head !== pkg.head ? `Commit gốc khác nhau (${pkg.head.slice(0, 8)} ≠ ${head.head.slice(0, 8)}): nên git pull trước.` : '',
      pkg.skipped.length ? `Không kèm: ${pkg.skipped.join(', ')}` : '',
    ].filter(Boolean);
    const confirm = await vscode.window.showWarningMessage(
      `Áp patch vào ${project.localPath}?`,
      { modal: true, detail: warnings.join('\n') || 'Cùng nhánh, cùng commit gốc.' },
      'Áp patch',
    );
    if (!confirm) return;
    await applyWip(project.localPath, pkg.patch);
    void vscode.window.showInformationMessage('DevSync: đã áp code dở. Kiểm tra lại trong Source Control.');
  }

  private async history(node: ProjectNode) {
    if (node.kind !== 'item') return;
    this.requireConnected();
    const { item } = node;
    const project = this.store.read().projects[node.project.id];
    const root = item.root?.(project);
    if (!root) return;
    const files = Object.values(this.store.read().remote)
      .filter((e) => e.meta.type === 'file' && e.meta.projectId === project.id && e.meta.item === item.id)
      .sort((a, b) => (a.meta as { path: string }).path.localeCompare((b.meta as { path: string }).path));
    const file = await vscode.window.showQuickPick(
      files.map((entry) => ({
        label: (entry.meta as { path: string }).path,
        description: entry.deleted ? 'đã xoá' : `v${entry.version} · ${relativeTime(entry.updatedAt)}`,
        entry,
      })),
      { title: `${item.label}: chọn file xem lịch sử` },
    );
    if (!file) return;
    const versions = await this.progress('tải lịch sử…', () => this.engine.history(file.entry.id));
    const version = await vscode.window.showQuickPick(
      versions.map((v) => ({
        label: `v${v.version}`,
        description: `${v.meta.type === 'file' ? v.meta.deviceName : ''} · ${new Date(v.updatedAt).toLocaleString('vi-VN')}`,
        detail: v.deleted ? 'bản xoá' : undefined,
        entry: v,
      })),
      { title: `Lịch sử ${file.label}` },
    );
    if (!version || version.entry.deleted) return;
    const data = await this.progress('tải phiên bản…', () => this.engine.download(version.entry));
    const temp = this.tempFile(`v${version.entry.version}-${path.basename(file.label)}`, data);
    const local = path.join(root, ...file.label.split('/'));
    if (fs.existsSync(local)) {
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(temp), vscode.Uri.file(local), `${file.label}: v${version.entry.version} ↔ máy này`);
    } else {
      await vscode.window.showTextDocument(vscode.Uri.file(temp));
    }
    const restore = await vscode.window.showInformationMessage(`Khôi phục ${file.label} về v${version.entry.version}?`, 'Khôi phục');
    if (!restore) return;
    writeAtomic(local, data);
    if (project.modes[item.id] === 'auto') await this.runItem(project.id, item.id);
    else void vscode.window.showInformationMessage('Đã khôi phục trên máy này. Bấm "Đẩy lên" để gửi sang máy khác.');
  }

  private tempFile(name: string, data: Buffer) {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, data, { mode: 0o600 });
    setTimeout(() => fs.rmSync(file, { force: true }), 30 * 60_000);
    return file;
  }

  private async resolveConflict(node: ProjectNode) {
    if (node.kind !== 'conflict') return;
    this.requireConnected();
    const { conflict } = node;
    const item = itemById(conflict.item)!;
    const project = this.store.read().projects[conflict.projectId];
    const abs = path.join(item.root!(project)!, ...conflict.path.split('/'));
    const remote = await this.store.update(async (state) => {
      await this.engine.refreshRemote(state);
      return state.remote[conflict.id];
    });
    if (remote && !remote.deleted) {
      const temp = this.tempFile(`may-khac-${path.basename(conflict.path)}`, await this.engine.download(remote));
      const right = fs.existsSync(abs) ? vscode.Uri.file(abs) : vscode.Uri.parse('untitled:' + abs);
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(temp), right, `${conflict.path}: máy khác ↔ máy này`);
    }
    const remoteLabel = remote?.deleted ? 'Xoá theo máy khác' : 'Lấy bản máy khác';
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(arrow-up) Dùng bản trên máy này', description: 'kể cả khi bạn vừa sửa tay để gộp', choice: 'local' as const },
        { label: `$(arrow-down) ${remoteLabel}`, description: 'bản trên máy này được chuyển vào thùng rác của DevSync', choice: 'remote' as const },
      ],
      { title: `Xử lý xung đột: ${conflict.path}`, ignoreFocusOut: true },
    );
    if (!pick) return;
    await this.store.update(async (state) => {
      const current = state.projects[conflict.projectId];
      const latest = state.remote[conflict.id];
      if (pick.choice === 'local') {
        await this.engine.pushLocal(state, current, item, conflict.path, abs, latest?.version ?? 0);
      } else if (latest) {
        const label = `${current.name}/${item.label}/${conflict.path}`;
        if (fs.existsSync(abs)) moveToTrash(path.join(this.context.globalStorageUri.fsPath, 'trash'), abs, label);
        await this.engine.applyRemote(state, current, item, { id: conflict.id, rel: conflict.path, abs, remote: latest }, label);
      }
      delete state.conflicts[conflict.id];
    });
    this.notifiedConflicts.clear();
    this.log(`Đã xử lý xung đột ${conflict.path}: ${pick.choice === 'local' ? 'giữ bản máy này' : remoteLabel.toLowerCase()}.`);
  }

  private async openReview(id: string) {
    const review = this.store.read().reviews[id];
    if (!review) return;
    if (fs.existsSync(review.abs)) await vscode.window.showTextDocument(vscode.Uri.file(review.abs));
    if (review.notes.length) void vscode.window.showInformationMessage(`DevSync: ${review.notes.join(' | ')}`, { modal: !review.hasMarkers });
  }

  private async dismissReview(id: string) {
    await this.store.update((state) => {
      delete state.reviews[id];
    });
  }

  private async revokeDevice(node: DeviceNode) {
    const pick = await vscode.window.showWarningMessage(
      `Thu hồi thiết bị "${node.device.name}"? Máy đó sẽ không truy cập máy chủ được nữa. Nếu máy bị mất, nên đổi khoá đồng bộ.`,
      { modal: true },
      'Thu hồi',
    );
    if (!pick) return;
    await this.engine.revokeDevice(node.device.id);
    await this.devicesTree.reload();
  }
}

let controller: Controller | undefined;

export async function activate(context: vscode.ExtensionContext) {
  controller = new Controller(context);
  context.subscriptions.push(controller);
  await controller.start();
}

export function deactivate() {
  controller?.dispose();
}
