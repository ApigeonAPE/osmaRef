import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

/**
 * Stores the Mayumi `uuid` cookie.
 *
 * The cookie is a long-lived session credential: it is sealed with the OS
 * credential store when available and otherwise stays in memory for this
 * session only. It is never written to settings or logs.
 */
export class MayumiSession {
  private readonly file: string;
  private uuid: string | null = null;
  private loaded = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'mayumi-session.bin');
  }

  get(): string | null {
    return this.uuid;
  }

  get configured(): boolean {
    return this.uuid !== null;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.load();
  }

  async set(uuid: string | null): Promise<void> {
    this.loaded = true;
    this.uuid = uuid && uuid.trim().length > 0 ? uuid.trim() : null;
    if (this.uuid === null) {
      this.removeFile();
      return;
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      this.removeFile();
      return;
    }
    try {
      writeFileSync(this.file, await safeStorage.encryptStringAsync(this.uuid));
    } catch {
      this.removeFile();
    }
  }

  private async load(): Promise<void> {
    if (!existsSync(this.file)) return;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return;
    try {
      let decrypted = await safeStorage.decryptStringAsync(readFileSync(this.file));
      if (decrypted.shouldReEncrypt) {
        const reencrypted = await safeStorage.encryptStringAsync(decrypted.result);
        writeFileSync(this.file, reencrypted);
        decrypted = await safeStorage.decryptStringAsync(reencrypted);
      }
      const value = decrypted.result.trim();
      if (value.length > 0) this.uuid = value;
    } catch {
      this.removeFile();
      this.uuid = null;
    }
  }

  private removeFile(): void {
    try {
      rmSync(this.file, { force: true });
    } catch {
      // best effort
    }
  }
}
