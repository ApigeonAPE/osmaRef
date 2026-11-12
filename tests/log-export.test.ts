import { describe, expect, it } from 'vitest';
import type { LobbyLogSummary, LogEntry, SessionEvent } from '@osmaref/contracts';
import { formatLobbyLog, formatRuntimeLog } from '@osmaref/domain';

const runtimeEntries: LogEntry[] = [
  {
    id: 'log-1',
    at: '2026-01-01T00:00:00.000Z',
    level: 'info',
    scope: 'room',
    message: 'opened room 123',
    details: null,
  },
  {
    id: 'log-2',
    at: '2026-01-01T00:01:00.000Z',
    level: 'error',
    scope: 'ipc',
    message: 'sessions:open: failed',
    details: 'Error: failed\n  at test.ts:1',
  },
];

const lobbyMeta: LobbyLogSummary & { exportedAt: string } = {
  sessionId: 'session-1',
  matchName: 'Alpha vs Beta',
  roomId: '123',
  transport: 'irc',
  bestOf: 9,
  status: 'closed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T01:00:00.000Z',
  entryCount: 3,
  lastEntryAt: '2026-01-01T00:02:00.000Z',
  exportedAt: '2026-01-02T00:00:00.000Z',
};

const lobbyEntries: SessionEvent[] = [
  {
    id: 'e1',
    sessionId: 'session-1',
    at: '2026-01-01T00:00:00.000Z',
    type: 'session_created',
    category: 'operation',
    actorUserId: null,
    summary: 'opened room 123',
  },
  {
    id: 'e2',
    sessionId: 'session-1',
    at: '2026-01-01T00:01:00.000Z',
    type: 'match_started',
    category: 'game',
    actorUserId: null,
    summary: 'match started (slot NM1, beatmap 100)',
    payload: { slotLabel: 'NM1', beatmapId: 100 },
  },
  {
    id: 'e3',
    sessionId: 'session-1',
    at: '2026-01-01T00:02:00.000Z',
    type: 'chat_message',
    category: 'chat',
    actorUserId: 7,
    summary: 'Player: hello',
    payload: { text: 'hello' },
  },
];

describe('log export formatting', () => {
  it('formats runtime logs with header, ordering and details', () => {
    const text = formatRuntimeLog(runtimeEntries, {
      exportedAt: '2026-01-02T00:00:00.000Z',
      appVersion: '0.1.0',
      platform: 'win32',
      arch: 'x64',
    });
    expect(text).toContain('osmaRef runtime log');
    expect(text).toContain('app: 0.1.0 (win32 x64)');
    expect(text).toContain('entries: 2');
    expect(text.indexOf('opened room 123')).toBeLessThan(
      text.indexOf('sessions:open: failed'),
    );
    expect(text).toMatch(/ERROR\s+IPC\s+sessions:open: failed/);
    expect(text).toContain('    Error: failed\n      at test.ts:1');
  });

  it('formats lobby logs with categories and operation/game payloads', () => {
    const text = formatLobbyLog(lobbyEntries, lobbyMeta);
    expect(text).toContain('osmaRef lobby log');
    expect(text).toContain('match: Alpha vs Beta');
    expect(text).toMatch(/OPERATION\s+session_created/);
    expect(text).toMatch(/GAME\s+match_started/);
    expect(text).toMatch(/CHAT\s+chat_message/);
    expect(text).toContain('"beatmapId":100');
    expect(text).not.toContain('"text":"hello"');
  });
});
