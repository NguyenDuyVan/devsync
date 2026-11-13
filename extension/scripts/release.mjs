import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.DEVSYNC_SSH_HOST ?? 'HappyFinate';
const releaseDir = '/opt/devsync/data/releases';
const keyPath = process.env.DEVSYNC_RELEASE_KEY ?? join(homedir(), '.devsync', 'release-key.pem');

const args = process.argv.slice(2);
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';
const notesIndex = args.indexOf('--notes');
const notes = notesIndex >= 0 ? args[notesIndex + 1] : undefined;

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const [major, minor, patch] = pkg.version.split('.').map(Number);
const version =
  bump === 'current' ? pkg.version
  : bump === 'major' ? `${major + 1}.0.0`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : bump === 'patch' ? `${major}.${minor}.${patch + 1}`
  : bump;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Phiên bản không hợp lệ: ${version}`);

if (version !== pkg.version) {
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const file = `devsync-${version}.vsix`;
const run = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit' });
run(join(root, 'node_modules/.bin/tsc'), ['-p', '.']);
run(join(root, 'node_modules/.bin/vsce'), ['package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', file]);

const data = readFileSync(join(root, file));
const sha256 = createHash('sha256').update(data).digest('hex');
const signature = sign(null, Buffer.from(`devsync-release:${version}:${sha256}`), createPrivateKey(readFileSync(keyPath))).toString('base64');
const latest = { version, file, sha256, signature, notes, at: Date.now() };
const latestPath = join(root, 'latest.json');
writeFileSync(latestPath, JSON.stringify(latest, null, 2));

run('ssh', [host, `mkdir -p ${releaseDir}`]);
run('scp', ['-q', join(root, file), `${host}:${releaseDir}/${file}`]);
run('scp', ['-q', latestPath, `${host}:${releaseDir}/latest.json.tmp`]);
run('ssh', [host, `cd ${releaseDir} && chown -R 1000:1000 . && mv latest.json.tmp latest.json`]);

console.log(`Đã phát hành DevSync ${version}. Các máy đang mở VS Code sẽ tự cập nhật trong vòng 1 phút.`);
