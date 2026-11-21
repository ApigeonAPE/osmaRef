import { writeFileSync } from 'node:fs';
import { app, dialog } from 'electron';
import { formatLobbyLog, formatRuntimeLog } from '@osmaref/domain';
import type { AppStore } from './store';

const LOG_FILTERS = [
  { name: 'Log file', extensions: ['log'] },
  { name: 'Text file', extensions: ['txt'] },
];

export async function exportRuntimeLog(store: AppStore): Promise<string | null> {
  const entries = store.listRuntimeLogs();
  const result = await dialog.showSaveDialog({
    title: 'Export runtime logs',
    defaultPath: `osmaRef-runtime-${fileStamp()}.log`,
    filters: LOG_FILTERS,
  });
  if (result.canceled || !result.filePath) return null;
  const text = formatRuntimeLog(entries, {
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  });
  writeFileSync(result.filePath, text, 'utf8');
  return result.filePath;
}

export async function exportSessionLog(
  store: AppStore,
  sessionId: string,
): Promise<string | null> {
  const summary = store.listLobbyLogs().find((entry) => entry.sessionId === sessionId);
  if (!summary) throw new Error('room log not found');
  const entries = store.listEvents(sessionId);
  const stem = safeFileStem(summary.matchName) || safeFileStem(summary.sessionId) || 'room';
  const result = await dialog.showSaveDialog({
    title: 'Export room log',
    defaultPath: `osmaRef-room-${stem}-${fileStamp()}.log`,
    filters: LOG_FILTERS,
  });
  if (result.canceled || !result.filePath) return null;
  const text = formatLobbyLog(entries, {
    ...summary,
    exportedAt: new Date().toISOString(),
  });
  writeFileSync(result.filePath, text, 'utf8');
  return result.filePath;
}

function fileStamp(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\..*$/, '');
}

function safeFileStem(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
