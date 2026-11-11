import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from 'crypto';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

export class Vault {
  private readonly encKey: Buffer;
  private readonly idKey: Buffer;

  private constructor(master: Buffer) {
    this.encKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'devsync/enc', 32));
    this.idKey = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'devsync/id', 32));
  }

  static generateKey(): string {
    return randomBytes(32).toString('base64url');
  }

  static fromKey(text: string): Vault {
    const master = Buffer.from(text.trim(), 'base64url');
    if (master.length !== 32) throw new Error('Khoá đồng bộ không hợp lệ.');
    return new Vault(master);
  }

  encrypt(plain: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(data: Buffer): Buffer {
    if (data[0] !== FORMAT_VERSION) throw new Error('Định dạng dữ liệu mã hoá không hỗ trợ.');
    const iv = data.subarray(1, 1 + IV_BYTES);
    const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]);
  }

  seal(value: unknown): string {
    return this.encrypt(Buffer.from(JSON.stringify(value))).toString('base64');
  }

  open<T>(sealed: string): T {
    return JSON.parse(this.decrypt(Buffer.from(sealed, 'base64')).toString('utf8')) as T;
  }

  entryId(...parts: string[]): string {
    return createHmac('sha256', this.idKey).update(parts.join('\0')).digest('hex').slice(0, 40);
  }
}
