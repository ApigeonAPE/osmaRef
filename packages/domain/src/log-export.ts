import type { LobbyLogSummary, LogEntry, SessionEvent } from '@osmaref/contracts';
import { sessionEventCategory } from '@osmaref/contracts';

export interface RuntimeLogExportMeta {
  exportedAt: string;
  appVersion: string;
  platform: string;
  arch: string;
}

export type LobbyLogExportMeta = LobbyLogSummary & { exportedAt: string };

const SEPARATOR = '-'.repeat(78);

/** Plain-text runtime log used by the settings-page export. */
export function formatRuntimeLog(entries: LogEntry[], meta: RuntimeLogExportMeta): string {
  const lines = [
    'osmaRef runtime log',
    `exported: ${meta.exportedAt}`,
    `app: ${meta.appVersion} (${meta.platform} ${meta.arch})`,
    `entries: ${entries.length}`,
    SEPARATOR,
  ];
  for (const entry of entries) {
    lines.push(
      `${entry.at}  ${levelLabel(entry.level).padEnd(5)}  ${entry.scope
        .toUpperCase()
        .padEnd(10)}  ${entry.message}`,
    );
    if (entry.details) lines.push(indent(entry.details));
  }
  return `${lines.join('\n')}\n`;
}

/** Plain-text room log used by the lobby-logs page export. */
export function formatLobbyLog(entries: SessionEvent[], meta: LobbyLogExportMeta): string {
  const ordered = [...entries].sort(
    (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
  );
  const lines = [
    'osmaRef lobby log',
    `exported: ${meta.exportedAt}`,
    `session: ${meta.sessionId}`,
    `match: ${meta.matchName}`,
    `room: ${meta.roomId ?? '-'}`,
    `transport: ${meta.transport}`,
    `best of: ${meta.bestOf}`,
    `status: ${meta.status}`,
    `entries: ${ordered.length}`,
    SEPARATOR,
  ];
  for (const entry of ordered) {
    const category = sessionEventCategory(entry.type).toUpperCase();
    lines.push(
      `${entry.at}  ${category.padEnd(9)}  ${entry.type.padEnd(20)}  ${entry.summary}`,
    );
    if (entry.type !== 'chat_message' && entry.payload !== undefined) {
      const payload = compactJson(entry.payload);
      if (payload) lines.push(`    payload: ${payload}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function levelLabel(level: LogEntry['level']): string {
  switch (level) {
    case 'debug':
      return 'DEBUG';
    case 'warn':
      return 'WARN';
    case 'error':
      return 'ERROR';
    default:
      return 'INFO';
  }
}

function indent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `    ${line}`)
    .join('\n');
}

function compactJson(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    if (!text) return null;
    return text.length > 2000 ? `${text.slice(0, 2000)}...` : text;
  } catch {
    return null;
  }
}
