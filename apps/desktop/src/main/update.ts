import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';
import { isNewerVersion } from '@osmaref/domain';
import type { DesktopEvent, UpdateCheckResult } from '@osmaref/contracts';
import type { AppLogger } from './logger';
import type { SettingsStore } from './settings';

/**
 * The NSIS installer ships `resources/app-update.yml`, while the portable zip
 * does not. Its absence is the only reliable way to tell the two builds apart
 * at runtime, and it doubles as the updater feed itself.
 */
export const updatesSupported =
  app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'));

function releaseNotes(info: UpdateInfo): string | null {
  const notes = info.releaseNotes;
  if (typeof notes === 'string') {
    const trimmed = notes.trim();
    return trimmed ? trimmed.slice(0, 4000) : null;
  }
  if (Array.isArray(notes)) {
    const text = notes
      .map((entry) => `${entry.version ? `## ${entry.version}\n` : ''}${entry.note ?? ''}`)
      .join('\n\n')
      .trim();
    return text ? text.slice(0, 4000) : null;
  }
  return null;
}

export class UpdateManager {
  private busy = false;

  constructor(
    private readonly logger: AppLogger,
    private readonly settings: SettingsStore,
    private readonly emit: (event: DesktopEvent) => void,
  ) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = {
      info: (message?: unknown) => this.logger.runtime('info', 'update', String(message ?? '')),
      warn: (message?: unknown) => this.logger.runtime('warn', 'update', String(message ?? '')),
      error: (message?: unknown) => this.logger.runtime('error', 'update', String(message ?? '')),
      debug: (message?: unknown) =>
        this.logger.diagnostic('debug', 'update', String(message ?? '')),
    };

    autoUpdater.on('update-available', (info) => {
      this.logger.runtime('info', 'update', `update ${info.version} is available`);
      this.emit({
        type: 'update_available',
        version: info.version,
        size: info.files?.[0]?.size ?? 0,
        notes: releaseNotes(info),
      });
    });
    autoUpdater.on('download-progress', (progress) => {
      this.emit({
        type: 'update_progress',
        percent: Math.min(100, Math.max(0, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });
    autoUpdater.on('update-downloaded', () => {
      this.logger.runtime('info', 'update', 'update downloaded');
      this.emit({ type: 'update_downloaded' });
    });
    autoUpdater.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.runtime('error', 'update', message);
      this.emit({ type: 'update_error', message });
    });

    this.applyChannel();
  }

  isSupported(): boolean {
    return updatesSupported;
  }

  private applyChannel(): void {
    const channel = this.settings.get().updateChannel;
    autoUpdater.channel = channel === 'preview' ? 'preview' : 'latest';
    autoUpdater.allowPrerelease = channel === 'preview';
  }

  async check(): Promise<UpdateCheckResult> {
    if (!updatesSupported) return { status: 'unsupported' };
    if (this.busy) throw new Error('an update check is already running');
    this.busy = true;
    this.applyChannel();
    try {
      const result = await autoUpdater.checkForUpdates();
      const info = result?.updateInfo;
      if (!info || !isNewerVersion(info.version, app.getVersion())) {
        return { status: 'none', version: app.getVersion() };
      }
      return {
        status: 'available',
        version: info.version,
        size: info.files?.[0]?.size ?? 0,
        notes: releaseNotes(info),
      };
    } finally {
      this.busy = false;
    }
  }

  async download(): Promise<void> {
    if (!updatesSupported) throw new Error('this build cannot download updates');
    this.applyChannel();
    await autoUpdater.downloadUpdate();
  }

  install(): void {
    autoUpdater.quitAndInstall();
  }
}
