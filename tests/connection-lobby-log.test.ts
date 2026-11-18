import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MatchSessionSchema,
  RoomSnapshotSchema,
  type DesktopEvent,
  type RoomSnapshot,
} from '@osmaref/contracts';
import type { ChatEnvelope } from '@osmaref/adapters';
import { ConnectionManager } from '../apps/desktop/src/main/connections';
import { createAppStore } from '../apps/desktop/src/main/store';
import type { SettingsStore } from '../apps/desktop/src/main/settings';
import type { ServerClient } from '../apps/desktop/src/main/server-client';
import type { AppLogger } from '../apps/desktop/src/main/logger';
import { WinByStore } from '../apps/desktop/src/main/winby-store';

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    roomId: '123',
    name: 'Room',
    chatChannelId: '#mp_123',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('ConnectionManager lobby log integration', () => {
  it('records room changes, chat and match events and keeps them after removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-conn-log-'));
    const store = await createAppStore(dir);
    const emitted: DesktopEvent[] = [];
    const logger = {
      runtime: vi.fn(),
      diagnostic: vi.fn(),
      setEmitter: vi.fn(),
      getRuntimeLogs: vi.fn(() => []),
      getDiagnostics: vi.fn(() => []),
    } as unknown as AppLogger;
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS }),
      getIrcPassword: () => null,
    } as unknown as SettingsStore;
    const server = { osu: {} } as unknown as ServerClient;
    const manager = new ConnectionManager({
      store,
      settings,
      winby: new WinByStore(dir),
      server,
      logger,
      emit: (event) => emitted.push(event),
    });
    const internal = manager as unknown as {
      onTransportEvent: (kind: 'irc' | 'referee_hub', event: unknown) => void;
      onChat: (envelope: ChatEnvelope, source: 'irc' | 'referee_hub') => void;
    };

    try {
      store.saveSession(
        MatchSessionSchema.parse({
          id: 'session-1',
          tournamentId: 'tournament-1',
          matchId: 'match-1',
          tournamentRevision: 1,
          matchName: 'Alpha vs Beta',
          teamOneId: 'team-a',
          teamTwoId: 'team-b',
          transport: 'irc',
          status: 'active',
          bestOf: 9,
          roomId: '123',
          roomName: 'Room',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      );

      internal.onTransportEvent('irc', { type: 'room_joined', snapshot: snapshot() });
      internal.onTransportEvent('irc', {
        type: 'room_updated',
        snapshot: snapshot({
          currentBeatmapId: 200,
          maxParticipants: 8,
          players: [
            { userId: 1, username: 'Alpha', team: 'red', slot: 0, status: 'idle', mods: [] },
            { userId: 2, username: 'Beta', team: 'blue', slot: 1, status: 'ready', mods: [] },
          ],
        }),
      });
      internal.onChat(
        {
          id: 'chat-1',
          channelId: '#mp_123',
          userId: 2,
          username: 'Beta',
          text: 'hello',
          at: '2026-01-01T00:02:00.000Z',
          self: false,
          system: false,
        },
        'irc',
      );
      internal.onTransportEvent('irc', {
        type: 'match_started',
        roomId: '123',
        playlistItemId: null,
      });
      internal.onTransportEvent('irc', { type: 'room_closed', roomId: '123' });

      const events = store.listEvents('session-1');
      const types = events.map((event) => event.type);
      expect(types).toContain('player_joined');
      expect(types).toContain('beatmap_changed');
      expect(types).toContain('room_settings_changed');
      expect(types).toContain('chat_message');
      expect(types).toContain('match_started');
      expect(types).toContain('room_left');

      const chat = events.find((event) => event.type === 'chat_message');
      expect(chat?.category).toBe('chat');
      expect(chat?.summary).toBe('Beta: hello');
      expect(chat?.payload).toMatchObject({ text: 'hello' });

      const summary = store.listLobbyLogs()[0];
      expect(summary).toMatchObject({
        sessionId: 'session-1',
        matchName: 'Alpha vs Beta',
        roomId: '123',
        entryCount: events.length,
      });

      store.deleteSession('session-1');
      expect(store.getSession('session-1')).toBeNull();
      expect(store.listEvents('session-1')).toHaveLength(events.length);
      expect(store.listLobbyLogs()[0]?.sessionId).toBe('session-1');

      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
