import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  userId: number;
  username: string;
}

/**
 * Stores the osu! OAuth token set delivered by the companion server.
 *
 * The set is sealed with the OS credential store when available; otherwise it
 * stays in memory only. The desktop never stores the OAuth client secret.
 */
export class TokenVault {
  private readonly file: string;
  private tokens: OAuthTokenSet | null = null;
  private loaded = false;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, 'osu-tokens.bin');
    // Remove the pre-token-set file from older builds; it is no longer valid.
    try {
      rmSync(join(dataDir, 'session-token.bin'), { force: true });
    } catch {
      // best effort
    }
  }

  get(): OAuthTokenSet | null {
    return this.tokens;
  }

  /** Loads the sealed token file once the app is ready. */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await this.load();
  }

  async set(tokens: OAuthTokenSet | null): Promise<void> {
    this.loaded = true;
    this.tokens = tokens;
    if (!tokens) {
      this.removeFile();
      return;
    }
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      // Never persist bearer/refresh tokens unencrypted.
      this.removeFile();
      return;
    }
    try {
      writeFileSync(this.file, await safeStorage.encryptStringAsync(JSON.stringify(tokens)));
    } catch {
      this.removeFile();
    }
  }

  clear(): void {
    this.tokens = null;
    this.removeFile();
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
      const parsed = JSON.parse(decrypted.result) as OAuthTokenSet;
      if (
        typeof parsed.accessToken === 'string' &&
        typeof parsed.refreshToken === 'string' &&
        typeof parsed.expiresAt === 'number'
      ) {
        this.tokens = parsed;
      }
    } catch {
      this.removeFile();
      this.tokens = null;
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