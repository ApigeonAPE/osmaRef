import { randomUUID } from 'node:crypto';
import type { DesktopEvent, LogEntry, LogLevel } from '@osmaref/contracts';
import type { AppStore } from './store';

const MAX_DIAGNOSTICS = 500;
const MAX_DETAILS = 8000;

/**
 * Central logging service for the main process.
 *
 * Runtime logs are persisted in the store and survive restarts. Connection
 * diagnostics are deliberately memory-only: they describe the current run and
 * are cleared every time osmaRef starts.
 */
export class AppLogger {
  private readonly diagnostics: LogEntry[] = [];
  private emit: (event: DesktopEvent) => void = () => undefined;

  constructor(private readonly store: AppStore) {}

  /** Replaces the renderer sink; events emitted before a window exists are dropped. */
  setEmitter(emit: (event: DesktopEvent) => void): void {
    this.emit = emit;
  }

  runtime(level: LogLevel, scope: string, message: string, details?: string): void {
    const entry = this.makeEntry(level, scope, message, details);
    try {
      this.store.appendRuntimeLog(entry);
    } catch (error) {
      // Logging must never take the application down; the renderer still gets
      // the entry even if persistence failed.
      console.warn('[osmaRef] could not persist the runtime log entry:', error);
    }
    this.emit({ type: 'log', entry });
  }

  diagnostic(level: LogLevel, scope: string, message: string): void {
    const entry = this.makeEntry(level, scope, message);
    this.diagnostics.push(entry);
    if (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTICS);
    }
    this.emit({ type: 'connection_log', entry });
  }

  getRuntimeLogs(limit = 200): LogEntry[] {
    try {
      return this.store.listRuntimeLogs(this.normalizeLimit(limit));
    } catch {
      return [];
    }
  }

  getDiagnostics(limit = 200): LogEntry[] {
    return this.diagnostics.slice(-this.normalizeLimit(limit));
  }

  private normalizeLimit(limit: number): number {
    return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 200;
  }

  private makeEntry(
    level: LogLevel,
    scope: string,
    message: string,
    details?: string,
  ): LogEntry {
    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      level,
      scope: scope.trim() || 'app',
      message: message.trim() || '(no message)',
      details: details ? details.slice(0, MAX_DETAILS) : null,
    };
  }
}
