import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MergeStrategy } from './merge';
import type { Mode, ProjectState } from './state';

export type ItemKind = 'files' | 'wip';

export interface ItemDef {
  id: string;
  label: string;
  detail: string;
  scope: 'project' | 'global';
  kind: ItemKind;
  defaultMode: Mode;
  allowAuto: boolean;
  sensitive?: boolean;
  include: string[];
  exclude?: string[];
  root?(project: ProjectState): string | undefined;
  mergeStrategy?(relPath: string): MergeStrategy | undefined;
}

export const GLOBAL_PROJECT_ID = 'global';

const claudeHome = () => path.join(os.homedir(), '.claude');

function encodeClaudeDir(projectPath: string) {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function claudeProjectDir(projectPath: string): string {
  const base = path.join(claudeHome(), 'projects');
  const candidates = [projectPath.normalize('NFC'), projectPath.normalize('NFD')].map((p) => path.join(base, encodeClaudeDir(p)));
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

export const ITEMS: ItemDef[] = [
  {
    id: 'claude-memory',
    label: 'Bộ nhớ Claude',
    detail: '~/.claude/projects/<dự án>/memory',
    scope: 'project',
    kind: 'files',
    defaultMode: 'auto',
    allowAuto: true,
    include: ['**/*'],
    root: (p) => (p.localPath ? path.join(claudeProjectDir(p.localPath), 'memory') : undefined),
    mergeStrategy: (rel) => (rel === 'MEMORY.md' ? 'union-lines' : undefined),
  },
  {
    id: 'claude-local',
    label: 'Cấu hình Claude của dự án',
    detail: '.claude/settings.local.json',
    scope: 'project',
    kind: 'files',
    defaultMode: 'auto',
    allowAuto: true,
    include: ['.claude/settings.local.json'],
    root: (p) => p.localPath,
  },
  {
    id: 'claude-sessions',
    label: 'Phiên chat Claude',
    detail: '*.jsonl — mở lại bằng claude --resume',
    scope: 'project',
    kind: 'files',
    defaultMode: 'manual',
    allowAuto: true,
    include: ['*.jsonl'],
    root: (p) => (p.localPath ? claudeProjectDir(p.localPath) : undefined),
  },
  {
    id: 'env',
    label: 'File env / secret',
    detail: '.env, .env.*, *.env',
    scope: 'project',
    kind: 'files',
    defaultMode: 'manual',
    allowAuto: true,
    sensitive: true,
    include: ['**/.env', '**/.env.*', '**/*.env'],
    exclude: ['**/*.example', '**/*.sample', '**/*.template', '**/env.example/**'],
    root: (p) => p.localPath,
    mergeStrategy: () => 'env',
  },
  {
    id: 'wip',
    label: 'Code đang làm dở',
    detail: 'Thay đổi chưa commit, đóng gói thành patch',
    scope: 'project',
    kind: 'wip',
    defaultMode: 'manual',
    allowAuto: true,
    include: [],
  },
  {
    id: 'claude-user',
    label: 'Skills, commands, CLAUDE.md',
    detail: '~/.claude/{skills,commands,agents,CLAUDE.md}',
    scope: 'global',
    kind: 'files',
    defaultMode: 'auto',
    allowAuto: true,
    include: ['CLAUDE.md', 'skills/**', 'commands/**', 'agents/**', 'output-styles/**'],
    root: () => claudeHome(),
  },
  {
    id: 'claude-user-settings',
    label: 'settings.json của Claude',
    detail: '~/.claude/settings.json, keybindings.json',
    scope: 'global',
    kind: 'files',
    defaultMode: 'manual',
    allowAuto: true,
    include: ['settings.json', 'keybindings.json'],
    root: () => claudeHome(),
  },
];

export const itemById = (id: string) => ITEMS.find((item) => item.id === id);

export const itemsFor = (project: ProjectState) => ITEMS.filter((item) => item.scope === (project.global ? 'global' : 'project'));

export function defaultModes(global: boolean): Record<string, Mode> {
  return Object.fromEntries(ITEMS.filter((i) => i.scope === (global ? 'global' : 'project')).map((i) => [i.id, i.defaultMode]));
}

export function globalProject(): ProjectState {
  return {
    id: GLOBAL_PROJECT_ID,
    name: 'Cấu hình Claude chung',
    global: true,
    localPath: claudeHome(),
    modes: defaultModes(true),
    modesAt: 0,
  };
}
