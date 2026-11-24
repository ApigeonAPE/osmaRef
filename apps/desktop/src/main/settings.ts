import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage, app } from 'electron';
import { DEFAULT_SETTINGS, type Settings } from '@osmaref/contracts';

/**
 * Settings and credentials.
 *
 * The IRC password is sealed with Electron's OS-backed `safeStorage`. If the
 * OS facility is not available it stays in memory for this session only; it is
 * never written to disk in plain text.
 */
export class SettingsStore {
  private readonly settingsFile: string;
  private readonly credentialsFile: string;
  private settings: Settings;
  private ircPassword: string | null = null;
  private lastWarning: string | null = null;

  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.settingsFile = join(dataDir, 'settings.json');
    this.credentialsFile = join(dataDir, 'irc-credential.bin');
    this.settings = this.loadSettings();
  }

  /** Loads the sealed IRC password once the app is ready. */
  async init(): Promise<void> {
    await this.loadPassword();
  }

  get(): Settings {
    return { ...this.settings };
  }

  getWarning(): string | null {
    return this.lastWarning;
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.settings, ...patch } as Settings;
    next.serverBaseUrl = next.serverBaseUrl.trim().replace(/\/$/, '');
    next.ircHost = next.ircHost.trim();
    next.hubBaseUrl = next.hubBaseUrl.trim().replace(/\/$/, '');
    next.ircDefaultChannels = (next.ircDefaultChannels ?? []).map((channel) =>
      channel.startsWith('#') ? channel : `#${channel}`,
    );
    this.settings = next;
    this.persist();
    return this.get();
  }

  async setIrcPassword(password: string): Promise<void> {
    this.ircPassword = password.length > 0 ? password : null;
    this.lastWarning = null;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      this.lastWarning =
        'The operating system credential store is unavailable, so the IRC password stays in memory for this session only.';
      this.removeStoredPassword();
      return;
    }
    if (!this.ircPassword) {
      this.removeStoredPassword();
      return;
    }
    const encrypted = await safeStorage.encryptStringAsync(this.ircPassword);
    writeFileSync(this.credentialsFile, encrypted);
  }

  getIrcPassword(): string | null {
    return this.ircPassword;
  }

  hasIrcPassword(): boolean {
    return this.ircPassword !== null;
  }

  clearIrcPassword(): void {
    this.ircPassword = null;
    this.removeStoredPassword();
  }

  private loadSettings(): Settings {
    const defaults = this.defaultSettings();
    if (!existsSync(this.settingsFile)) {
      this.settings = defaults;
      this.persist();
      return defaults;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Partial<Settings>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  private defaultSettings(): Settings {
    const previewBuild = app.getVersion().includes('-');
    return previewBuild
      ? { ...DEFAULT_SETTINGS, updateChannel: 'preview' }
      : { ...DEFAULT_SETTINGS };
  }

  private async loadPassword(): Promise<void> {
    if (!existsSync(this.credentialsFile)) return;
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      this.lastWarning =
        'Stored IRC credentials could not be decrypted on this system; enter the password again.';
      return;
    }
    try {
      let decrypted = await safeStorage.decryptStringAsync(readFileSync(this.credentialsFile));
      if (decrypted.shouldReEncrypt) {
        const reencrypted = await safeStorage.encryptStringAsync(decrypted.result);
        writeFileSync(this.credentialsFile, reencrypted);
        decrypted = await safeStorage.decryptStringAsync(reencrypted);
      }
      this.ircPassword = decrypted.result;
    } catch {
      this.lastWarning = 'Stored IRC credentials were unreadable and have been discarded.';
      this.removeStoredPassword();
    }
  }

  private removeStoredPassword(): void {
    try {
      rmSync(this.credentialsFile, { force: true });
    } catch {
      // best effort
    }
  }

  private persist(): void {
    const temporary = `${this.settingsFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.settings, null, 2), 'utf8');
    renameSync(temporary, this.settingsFile);
  }
}