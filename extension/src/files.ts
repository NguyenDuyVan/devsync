import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from './crypto';

const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.turbo', 'coverage', '.pnpm-store', '.cache', '.venv', '__pycache__']);
const MAX_DEPTH = 10;

export interface LocalFile {
  rel: string;
  abs: string;
  size: number;
  hash: string;
}

export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

export class Matcher {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];
  readonly prefixes: string[];
  readonly maxDepth: number;

  constructor(include: string[], exclude: string[] = []) {
    this.include = include.map(globToRegExp);
    this.exclude = exclude.map(globToRegExp);
    this.prefixes = Matcher.walkPrefixes(include);
    this.maxDepth = include.some((glob) => glob.includes('**'))
      ? MAX_DEPTH
      : Math.max(0, ...include.map((glob) => glob.split('/').length - 1));
  }

  matches(rel: string) {
    return this.include.some((re) => re.test(rel)) && !this.exclude.some((re) => re.test(rel));
  }

  private static walkPrefixes(include: string[]): string[] {
    const prefixes = include.map((glob) => {
      const segments = glob.split('/');
      const literal: string[] = [];
      for (const segment of segments.slice(0, -1)) {
        if (/[*?]/.test(segment)) break;
        literal.push(segment);
      }
      return literal.join('/');
    });
    if (prefixes.includes('')) return [''];
    return [...new Set(prefixes)].filter((p) => !prefixes.some((other) => other !== p && p.startsWith(`${other}/`)));
  }
}

const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string }>();

export function hashFile(abs: string, stat: fs.Stats): string {
  const cached = hashCache.get(abs);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
  const hash = sha256(fs.readFileSync(abs));
  hashCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

export function localHash(abs: string): string | undefined {
  try {
    const stat = fs.statSync(abs);
    return stat.isFile() ? hashFile(abs, stat) : undefined;
  } catch {
    return undefined;
  }
}

export function scan(root: string, matcher: Matcher, maxBytes: number, onSkip: (rel: string, size: number) => void): Map<string, LocalFile> {
  const result = new Map<string, LocalFile>();
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < matcher.maxDepth) visit(abs, depth + 1);
        continue;
      }
      if (!entry.isFile() || !matcher.matches(rel) || entry.name.endsWith('.devsync-tmp')) continue;
      const stat = fs.statSync(abs);
      if (stat.size > maxBytes) {
        onSkip(rel, stat.size);
        continue;
      }
      result.set(rel, { rel, abs, size: stat.size, hash: hashFile(abs, stat) });
    }
  };
  for (const prefix of matcher.prefixes) {
    const start = path.join(root, prefix);
    if (prefix === '') visit(root, 0);
    else if (fs.existsSync(start)) visit(start, prefix.split('/').length);
  }
  return result;
}

export function writeAtomic(abs: string, data: Buffer) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temp = `${abs}.${process.pid}.devsync-tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, abs);
  const stat = fs.statSync(abs);
  hashCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, hash: sha256(data) });
}

export function moveToTrash(trashRoot: string, abs: string, label: string) {
  const target = path.join(trashRoot, new Date().toISOString().replace(/[:.]/g, '-'), label);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(abs, target);
  hashCache.delete(abs);
}

export function unionLines(local: string, remote: string): string {
  const lines = local.split('\n');
  const seen = new Set(lines.map((line) => line.trimEnd()));
  const trailingNewline = local.endsWith('\n');
  if (trailingNewline) lines.pop();
  for (const line of remote.split('\n')) {
    if (line.trim() && !seen.has(line.trimEnd())) {
      lines.push(line);
      seen.add(line.trimEnd());
    }
  }
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

export function envKeyDiff(before: string | undefined, after: string | undefined): string {
  const parse = (text?: string) => {
    const map = new Map<string, string>();
    for (const line of (text ?? '').split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
      if (match) map.set(match[1], match[2].trim());
    }
    return map;
  };
  const a = parse(before);
  const b = parse(after);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const parts = [
    added.length ? `+${added.join(', +')}` : '',
    changed.length ? `~${changed.join(', ~')}` : '',
    removed.length ? `-${removed.join(', -')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('  ') : 'không đổi key nào';
}
