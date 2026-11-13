import { createPublicKey, verify } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ApiError, type ApiClient } from './api';
import { sha256 } from './crypto';

const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAgkgBoElX1Oaikt5egVizCJwhlOKny8Aprh7RBhQExuk=
-----END PUBLIC KEY-----`;

export interface Release {
  version: string;
  file: string;
  sha256: string;
  signature: string;
  notes?: string;
  at: number;
}

export const releaseMessage = (version: string, hash: string) => `devsync-release:${version}:${hash}`;

export function isNewer(candidate: string, current: string) {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export async function fetchUpdate(api: ApiClient, currentVersion: string, downloadDir: string): Promise<{ release: Release; vsix: string } | undefined> {
  let release: Release;
  try {
    release = await api.json<Release>('GET', '/release/latest');
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
  if (!isNewer(release.version, currentVersion)) return undefined;
  if (!/^devsync-\d+\.\d+\.\d+\.vsix$/.test(release.file)) throw new Error('Tên file bản phát hành không hợp lệ.');

  const signed = verify(null, Buffer.from(releaseMessage(release.version, release.sha256)), createPublicKey(RELEASE_PUBLIC_KEY), Buffer.from(release.signature, 'base64'));
  if (!signed) throw new Error(`Chữ ký bản ${release.version} không hợp lệ, bỏ qua cập nhật.`);

  const data = await api.getFile(`/release/file/${release.file}`);
  if (sha256(data) !== release.sha256) throw new Error(`File bản ${release.version} sai checksum, bỏ qua cập nhật.`);

  fs.mkdirSync(downloadDir, { recursive: true });
  const vsix = path.join(downloadDir, release.file);
  fs.writeFileSync(vsix, data);
  return { release, vsix };
}
