import { unionLines } from './files';

export type MergeStrategy = 'union-lines' | 'env';

export interface MergeInput {
  rel: string;
  base?: Buffer;
  local: Buffer;
  remote: Buffer;
  strategy?: MergeStrategy;
  localLabel: string;
  remoteLabel: string;
}

export type MergeResult = { binary: true } | { binary: false; data: Buffer; annotated: boolean; notes: string[] };

export const MARKER = 'DevSync ·';
const MAX_DP_CELLS = 4_000_000;

const isBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

export function mergeContents(input: MergeInput): MergeResult {
  if (isBinary(input.local) || isBinary(input.remote) || (input.base && isBinary(input.base))) return { binary: true };
  const localText = input.local.toString('utf8');
  const remoteText = input.remote.toString('utf8');
  const baseText = input.base?.toString('utf8');
  const eol = localText.includes('\r\n') ? '\r\n' : '\n';
  const split = (text: string) => text.split(/\r?\n/);

  if (input.strategy === 'union-lines' || input.rel.endsWith('.jsonl')) {
    return { binary: false, data: Buffer.from(unionLines(localText, remoteText)), annotated: false, notes: [] };
  }
  if (input.strategy === 'env') {
    const result = mergeEnv(baseText === undefined ? undefined : split(baseText), split(localText), split(remoteText), input);
    return { binary: false, data: Buffer.from(result.lines.join(eol)), annotated: result.conflicts > 0, notes: [] };
  }
  if (input.rel.endsWith('.json')) {
    const json = tryMergeJson(baseText, localText, remoteText, input);
    if (json) return json;
  }
  const lines = mergeLines(baseText === undefined ? undefined : split(baseText), split(localText), split(remoteText), input);
  return { binary: false, data: Buffer.from(lines.lines.join(eol)), annotated: lines.conflicts > 0, notes: [] };
}

function matchMap(base: string[], other: string[]): Int32Array {
  const map = new Int32Array(base.length).fill(-1);
  let start = 0;
  while (start < base.length && start < other.length && base[start] === other[start]) {
    map[start] = start;
    start++;
  }
  let endBase = base.length;
  let endOther = other.length;
  while (endBase > start && endOther > start && base[endBase - 1] === other[endOther - 1]) {
    endBase--;
    endOther--;
    map[endBase] = endOther;
  }
  const n = endBase - start;
  const m = endOther - start;
  if (n === 0 || m === 0 || n * m > MAX_DP_CELLS) return map;

  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        base[start + i] === other[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[start + i] === other[start + j]) {
      map[start + i] = start + j;
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return map;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i]);

function mergeLines(base: string[] | undefined, local: string[], remote: string[], input: MergeInput) {
  const reference = base ?? commonLines(local, remote);
  const toLocal = matchMap(reference, local);
  const toRemote = matchMap(reference, remote);
  const out: string[] = [];
  let conflicts = 0;
  let i = 0;
  let j = 0;
  let k = 0;

  const chunk = (baseEnd: number, localEnd: number, remoteEnd: number) => {
    const b = reference.slice(i, baseEnd);
    const l = local.slice(j, localEnd);
    const r = remote.slice(k, remoteEnd);
    if (sameLines(l, b)) out.push(...r);
    else if (sameLines(r, b) || sameLines(l, r)) out.push(...l);
    else {
      conflicts++;
      out.push(`<<<<<<< ${MARKER} ${input.localLabel}`, ...l, '=======', ...r, `>>>>>>> ${MARKER} ${input.remoteLabel}`);
    }
  };

  for (let s = 0; s < reference.length; s++) {
    const l = toLocal[s];
    const r = toRemote[s];
    if (l < j || r < k) continue;
    chunk(s, l, r);
    out.push(reference[s]);
    i = s + 1;
    j = l + 1;
    k = r + 1;
  }
  chunk(reference.length, local.length, remote.length);
  return { lines: out, conflicts };
}

function commonLines(a: string[], b: string[]): string[] {
  const map = matchMap(a, b);
  return a.filter((_, index) => map[index] >= 0);
}

const ENV_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;

function envMap(lines: string[]) {
  const map = new Map<string, string>();
  for (const line of lines) {
    const key = ENV_KEY.exec(line)?.[1];
    if (key) map.set(key, line);
  }
  return map;
}

function mergeEnv(base: string[] | undefined, local: string[], remote: string[], input: MergeInput) {
  const b = base ? envMap(base) : undefined;
  const l = envMap(local);
  const r = envMap(remote);
  const out: string[] = [];
  const handled = new Set<string>();
  let conflicts = 0;

  for (const line of local) {
    const key = ENV_KEY.exec(line)?.[1];
    if (!key || handled.has(key)) {
      out.push(line);
      continue;
    }
    handled.add(key);
    const localLine = l.get(key)!;
    const remoteLine = r.get(key);
    const baseLine = b?.get(key);
    if (remoteLine === undefined) {
      if (baseLine !== undefined && baseLine === localLine) continue;
      out.push(localLine);
    } else if (remoteLine === localLine || (b && baseLine === remoteLine)) {
      out.push(localLine);
    } else if (b && baseLine === localLine) {
      out.push(remoteLine);
    } else {
      conflicts++;
      out.push(`# ${MARKER} ${key} khác nhau giữa các máy, đang dùng giá trị của ${input.localLabel}`, localLine, `# ${MARKER} ${input.remoteLabel}: ${remoteLine.trim()}`);
    }
  }

  const trailing = out.length && out[out.length - 1] === '' ? out.pop() : undefined;
  for (const [key, line] of r) {
    if (handled.has(key)) continue;
    if (b?.get(key) === line) continue;
    out.push(line);
  }
  if (trailing !== undefined) out.push(trailing);
  return { lines: out, conflicts };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function tryMergeJson(baseText: string | undefined, localText: string, remoteText: string, input: MergeInput): MergeResult | undefined {
  let base: Json | undefined;
  let local: Json;
  let remote: Json;
  try {
    local = JSON.parse(localText);
    remote = JSON.parse(remoteText);
    base = baseText === undefined ? undefined : JSON.parse(baseText);
  } catch {
    return undefined;
  }
  const notes: string[] = [];
  const merged = mergeJson(base, local, remote, '', notes, input);
  const indent = /^\s*[{[]\s*\n(\s+)/.exec(localText)?.[1] ?? '  ';
  const text = JSON.stringify(merged, null, indent) + (localText.endsWith('\n') ? '\n' : '');
  return { binary: false, data: Buffer.from(text), annotated: notes.length > 0, notes };
}

function mergeJson(base: Json | undefined, local: Json, remote: Json, at: string, notes: string[], input: MergeInput): Json {
  if (same(local, remote)) return local;
  if (base !== undefined && same(base, local)) return remote;
  if (base !== undefined && same(base, remote)) return local;
  if (isObject(local) && isObject(remote)) {
    const baseObject = isObject(base) ? base : undefined;
    const result: Record<string, Json> = {};
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const l = local[key];
      const r = remote[key];
      const b = baseObject?.[key];
      if (l === undefined) {
        if (b === undefined || !same(b, r)) result[key] = r;
      } else if (r === undefined) {
        if (b === undefined || !same(b, l)) result[key] = l;
      } else {
        result[key] = mergeJson(b, l, r, at ? `${at}.${key}` : key, notes, input);
      }
    }
    return result;
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    const baseSet = new Set(Array.isArray(base) ? base.map((v) => JSON.stringify(v)) : []);
    const localSet = new Set(local.map((v) => JSON.stringify(v)));
    const remoteSet = new Set(remote.map((v) => JSON.stringify(v)));
    const result = local.filter((v) => {
      const key = JSON.stringify(v);
      return remoteSet.has(key) || !baseSet.has(key);
    });
    for (const v of remote) {
      const key = JSON.stringify(v);
      if (!localSet.has(key) && !baseSet.has(key)) result.push(v);
    }
    return result;
  }
  notes.push(`${at || '(gốc)'}: giữ ${JSON.stringify(local)} của ${input.localLabel}; ${input.remoteLabel} có ${JSON.stringify(remote)}`);
  return local;
}
