import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TLS_DIR, createPairCode, db } from './db.ts';

const PORT = Number(process.env.PORT ?? 8743);
const HOST = process.env.PUBLIC_HOST ?? 'localhost';

const [command, arg] = process.argv.slice(2);

function fingerprint() {
  return new X509Certificate(readFileSync(join(TLS_DIR, 'cert.pem'))).fingerprint256;
}

switch (command) {
  case 'invite': {
    const { code, expiresAt } = createPairCode();
    const params = new URLSearchParams({ fp: fingerprint().replaceAll(':', ''), code });
    console.log(`devsync://${HOST}:${PORT}?${params}`);
    console.log(`Hết hạn lúc ${new Date(expiresAt).toLocaleString('vi-VN')}`);
    break;
  }
  case 'devices': {
    console.table(db.prepare(`SELECT id, name, datetime(last_seen / 1000, 'unixepoch') AS last_seen, revoked FROM devices`).all());
    break;
  }
  case 'revoke': {
    if (!arg) throw new Error('Cần id thiết bị');
    db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(arg);
    console.log(`Đã thu hồi ${arg}`);
    break;
  }
  case 'fingerprint':
    console.log(fingerprint());
    break;
  default:
    console.log('Dùng: admin.ts invite | devices | revoke <id> | fingerprint');
}
