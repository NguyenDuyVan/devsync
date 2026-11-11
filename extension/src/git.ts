import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from './crypto';

const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;

function git(cwd: string, args: string[], allowExit1 = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 200 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error || (allowExit1 && (error as NodeJS.ErrnoException & { code?: number }).code === 1)) resolve(stdout);
      else reject(new Error(stderr.trim() || error.message));
    });
  });
}

export function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d+\/)/, '/')
    .replace(/:\d+\//, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export async function remoteOf(cwd: string): Promise<string | undefined> {
  try {
    const url = (await git(cwd, ['remote', 'get-url', 'origin'])).trim();
    return url ? normalizeRemote(url) : undefined;
  } catch {
    return undefined;
  }
}

export const projectIdForRemote = (remote: string) => sha256(`remote:${remote}`).slice(0, 24);

export interface WipPackage {
  branch: string;
  head: string;
  patch: string;
  skipped: string[];
  createdAt: number;
}

export async function createWip(cwd: string, excluded: (rel: string) => boolean): Promise<WipPackage> {
  const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  let patch = await git(cwd, ['diff', '--binary', 'HEAD']);
  const skipped: string[] = [];
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of untracked) {
    if (excluded(file)) {
      skipped.push(`${file} (env, đồng bộ qua mục riêng)`);
      continue;
    }
    const size = fs.statSync(path.join(cwd, file)).size;
    if (size > MAX_UNTRACKED_BYTES) {
      skipped.push(`${file} (file mới > 5MB)`);
      continue;
    }
    patch += await git(cwd, ['diff', '--binary', '--no-index', '--', '/dev/null', file], true);
  }
  return { branch, head, patch, skipped, createdAt: Date.now() };
}

export async function currentHead(cwd: string): Promise<{ branch: string; head: string }> {
  return {
    branch: (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(),
    head: (await git(cwd, ['rev-parse', 'HEAD'])).trim(),
  };
}

export async function applyWip(cwd: string, patch: string): Promise<void> {
  const file = path.join(os.tmpdir(), `devsync-${Date.now()}.patch`);
  fs.writeFileSync(file, patch);
  try {
    try {
      await git(cwd, ['apply', '--whitespace=nowarn', file]);
    } catch {
      await git(cwd, ['apply', '--3way', '--whitespace=nowarn', file]);
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}
