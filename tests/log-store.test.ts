import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MatchSessionSchema,
  SessionEventSchema,
  toLobbyLogSession,
  type LogEntry,
} from '@osmaref/contracts';
import { createAppStore } from '../apps/desktop/src/main/store';

function runtimeEntry(id: string, at: string): LogEntry {
  return {
    id,
    at,
    level: 'info',
    scope: 'app',
    message: id,
    details: null,
  };
}

function session() {
  return MatchSessionSchema.parse({
    id: 'session-1',
    tournamentId: 'tournament-1',
    matchId: 'match-1',
    tournamentRevision: 1,
    matchName: 'A vs B',
    teamOneId: 'team_a',
    teamTwoId: 'team_b',
    transport: 'referee_hub',
    status: 'closed',
    bestOf: 9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
  });
}

function chatEvent() {
  return SessionEventSchema.parse({
    id: 'chat:session-1:m1',
    sessionId: 'session-1',
    at: '2026-01-01T00:10:00.000Z',
    type: 'chat_message',
    category: 'chat',
    summary: 'Player: hello',
    payload: { text: 'hello' },
  });
}

describe('logging persistence', () => {
  it('keeps runtime logs across a store reopen and honours the limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-log-'));
    const first = await createAppStore(dir);
    try {
      first.appendRuntimeLog(runtimeEntry('log-1', '2026-01-01T00:00:00.000Z'));
      first.appendRuntimeLog(runtimeEntry('log-2', '2026-01-01T00:01:00.000Z'));
      expect(first.listRuntimeLogs().map((entry) => entry.id)).toEqual(['log-1', 'log-2']);
      expect(first.listRuntimeLogs(1).map((entry) => entry.id)).toEqual(['log-2']);
    } finally {
      first.close();
    }

    const reopened = await createAppStore(dir);
    try {
      expect(reopened.listRuntimeLogs().map((entry) => entry.id)).toEqual(['log-1', 'log-2']);
      expect(reopened.listRuntimeLogs().at(-1)?.message).toBe('log-2');
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the room log after the session is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-log-'));
    const store = await createAppStore(dir);
    try {
      const roomSession = session();
      store.saveSession(roomSession);
      store.appendEvent(chatEvent());
      store.upsertLobbyLogSession(toLobbyLogSession(roomSession));

      expect(store.listLobbyLogs()).toHaveLength(1);
      expect(store.listLobbyLogs()[0]).toMatchObject({
        sessionId: 'session-1',
        matchName: 'A vs B',
        entryCount: 1,
      });

      store.deleteSession('session-1');
      expect(store.getSession('session-1')).toBeNull();
      expect(store.listEvents('session-1')).toHaveLength(1);
      expect(store.listLobbyLogs()[0]?.sessionId).toBe('session-1');
    } finally {
      store.close();
    }

    const reopened = await createAppStore(dir);
    try {
      expect(reopened.listEvents('session-1')).toHaveLength(1);
      expect(reopened.listLobbyLogs()[0]?.entryCount).toBe(1);

      reopened.deleteLobbyLog('session-1');
      expect(reopened.listEvents('session-1')).toEqual([]);
      expect(reopened.listLobbyLogs()).toEqual([]);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps IRC chat channels out of room logs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-log-'));
    const store = await createAppStore(dir);
    try {
      const channel = MatchSessionSchema.parse({
        ...session(),
        id: 'channel-session',
        matchName: '#osu',
        roomId: '#osu',
        roomName: '#osu',
        transport: 'irc',
        chatOnly: true,
        status: 'active',
      });
      store.saveSession(channel);
      store.upsertLobbyLogSession(toLobbyLogSession(channel));
      store.appendEvent(
        SessionEventSchema.parse({
          id: 'chat:channel-session:m1',
          sessionId: 'channel-session',
          at: '2026-01-01T00:10:00.000Z',
          type: 'chat_message',
          category: 'chat',
          summary: 'Player: hello',
        }),
      );

      expect(store.listLobbyLogs()).toEqual([]);
      expect(store.listEvents('channel-session')).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('backfills log metadata for sessions created before this feature', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-log-'));
    const store = await createAppStore(dir);
    try {
      store.saveSession(session());
      store.appendEvent(chatEvent());
      expect(store.listLobbyLogs()[0]).toMatchObject({
        sessionId: 'session-1',
        matchName: 'A vs B',
        entryCount: 1,
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
