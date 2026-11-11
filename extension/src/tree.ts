import * as os from 'os';
import * as vscode from 'vscode';
import type { DeviceInfo } from './api';
import type { Engine } from './engine';
import { itemsFor, type ItemDef } from './items';
import type { Conflict, Mode, ProjectState, Store } from './state';

export type ProjectNode =
  | { kind: 'project'; project: ProjectState }
  | { kind: 'item'; project: ProjectState; item: ItemDef }
  | { kind: 'conflict'; project: ProjectState; conflict: Conflict };

export type DeviceNode = { kind: 'device'; device: DeviceInfo; self: boolean };

export const MODE_LABEL: Record<Mode, string> = { auto: 'Tự động', manual: 'Thủ công', off: 'Tắt' };
const MODE_ICON: Record<Mode, string> = { auto: 'sync', manual: 'debug-pause', off: 'circle-slash' };
const REASON_LABEL: Record<Conflict['reason'], string> = {
  'both-changed': 'cả hai máy cùng sửa',
  'remote-deleted': 'máy khác đã xoá',
  'local-deleted': 'máy này đã xoá',
};

export function relativeTime(at?: number | null) {
  if (!at) return 'chưa bao giờ';
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} giờ trước` : `${Math.round(hours / 24)} ngày trước`;
}

const tildify = (p: string) => p.replace(os.homedir(), '~');

export class ProjectsTree implements vscode.TreeDataProvider<ProjectNode> {
  private readonly emitter = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
  ) {}

  refresh() {
    this.emitter.fire(undefined);
  }

  getChildren(node?: ProjectNode): ProjectNode[] {
    const state = this.store.read();
    if (!node) {
      return Object.values(state.projects)
        .sort((a, b) => Number(!!b.localPath) - Number(!!a.localPath) || Number(!!b.global) - Number(!!a.global) || a.name.localeCompare(b.name))
        .map((project) => ({ kind: 'project', project }));
    }
    if (node.kind !== 'project' || !node.project.localPath) return [];
    const project = state.projects[node.project.id] ?? node.project;
    const conflicts = Object.values(state.conflicts).filter((c) => c.projectId === project.id);
    return [
      ...conflicts.map((conflict): ProjectNode => ({ kind: 'conflict', project, conflict })),
      ...itemsFor(project).map((item): ProjectNode => ({ kind: 'item', project, item })),
    ];
  }

  getTreeItem(node: ProjectNode): vscode.TreeItem {
    if (node.kind === 'project') {
      const { project } = node;
      const linked = !!project.localPath;
      const tree = new vscode.TreeItem(project.name, linked ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
      tree.id = `project:${project.id}`;
      tree.description = linked ? tildify(project.localPath!) : 'chưa liên kết trên máy này';
      tree.tooltip = project.remote ?? project.localPath ?? project.name;
      tree.iconPath = new vscode.ThemeIcon(project.global ? 'settings' : linked ? 'repo' : 'cloud');
      tree.contextValue = linked ? 'project.linked' : 'project.unlinked';
      return tree;
    }
    if (node.kind === 'conflict') {
      const { conflict } = node;
      const tree = new vscode.TreeItem(conflict.path);
      tree.id = `conflict:${conflict.id}`;
      tree.description = `xung đột: ${REASON_LABEL[conflict.reason]}`;
      tree.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      tree.contextValue = 'conflict';
      tree.command = { command: 'devsync.resolveConflict', title: 'Xử lý xung đột', arguments: [node] };
      return tree;
    }
    const { project, item } = node;
    const mode = project.modes[item.id] ?? 'off';
    const pending = this.engine.pending.get(`${project.id}/${item.id}`);
    const counts = pending && mode !== 'off'
      ? [pending.up ? `↑${pending.up}` : '', pending.down ? `↓${pending.down}` : '', pending.conflicts ? `⚠${pending.conflicts}` : '']
          .filter(Boolean)
          .join(' ')
      : '';
    const tree = new vscode.TreeItem(item.label);
    tree.id = `item:${project.id}:${item.id}`;
    tree.description = [MODE_LABEL[mode], counts].filter(Boolean).join(' · ');
    tree.tooltip = new vscode.MarkdownString(`**${item.label}**\n\n${item.detail}\n\nChế độ: ${MODE_LABEL[mode]}`);
    tree.iconPath = new vscode.ThemeIcon(MODE_ICON[mode]);
    tree.contextValue = `item.${item.kind}.${mode}`;
    return tree;
  }
}

export class DevicesTree implements vscode.TreeDataProvider<DeviceNode> {
  private readonly emitter = new vscode.EventEmitter<DeviceNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private devices: DeviceInfo[] = [];

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
  ) {}

  async reload() {
    if (!this.engine.connected) return;
    try {
      this.devices = await this.engine.devices();
    } catch {
      this.devices = [];
    }
    this.emitter.fire(undefined);
  }

  getChildren(node?: DeviceNode): DeviceNode[] {
    if (node) return [];
    const selfId = this.store.read().deviceId;
    return this.devices.map((device) => ({ kind: 'device', device, self: device.id === selfId }));
  }

  getTreeItem(node: DeviceNode): vscode.TreeItem {
    const tree = new vscode.TreeItem(node.device.name);
    tree.description = node.self ? 'máy này' : `hoạt động ${relativeTime(node.device.last_seen)}`;
    tree.iconPath = new vscode.ThemeIcon(node.self ? 'vm-active' : 'device-desktop');
    tree.contextValue = node.self ? 'device.self' : 'device.other';
    return tree;
  }
}
