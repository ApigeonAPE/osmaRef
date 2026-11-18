import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MatchSessionSchema, type DesktopEvent } from '@osmaref/contracts';
import { ConnectionManager } from '../apps/desktop/src/main/connections';
import { createAppStore } from '../apps/desktop/src/main/store';
import type { SettingsStore } from '../apps/desktop/src/main/settings';
import type { ServerClient } from '../apps/desktop/src/main/server-client';
import type { AppLogger } from '../apps/desktop/src/main/logger';
import { WinByStore } from '../apps/desktop/src/main/winby-store';

/** The lines BanchoBot posts itself while the referee drives an IRC room. */
const BANCHO_LIFECYCLE = [
  'match started',
  'match finished',
  'match aborted',
  'match start countdown: 10s',
  'the room was closed',
];

async function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-lifecycle-chat-'));
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
  return {
    store,
    emitted,
    manager,
    texts: () =>
      emitted.flatMap((event) => (event.type === 'chat_message' ? [event.message.text] : [])),
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function session(transport: 'irc' | 'referee_hub', id: string, roomId: string) {
  return MatchSessionSchema.parse({
    id,
    tournamentId: 'tournament-1',
    matchId: 'match-1',
    tournamentRevision: 1,
    matchName: 'Alpha vs Beta',
    teamOneId: 'team-a',
    teamTwoId: 'team-b',
    transport,
    status: 'active',
    bestOf: 9,
    roomId,
    roomName: 'Room',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('room lifecycle chat', () => {
  it('does not repeat what BanchoBot already announced in the IRC room', async () => {
    const { store, manager, texts, dispose } = await createHarness();
    try {
      store.saveSession(session('irc', 'session-1', '123'));
      store.saveSession(session('irc', 'session-2', '124'));
      const internal = manager as unknown as {
        onTransportEvent: (kind: 'irc' | 'referee_hub', event: unknown) => void;
      };

      for (const event of [
        { type: 'match_started', roomId: '123', playlistItemId: null },
        { type: 'countdown', roomId: '123', seconds: 10, kind: 'match_start' },
        { type: 'match_finished', roomId: '123' },
      ]) {
        internal.onTransportEvent('irc', event);
      }
      for (const event of [
        { type: 'match_started', roomId: '124', playlistItemId: null },
        { type: 'match_aborted', roomId: '124' },
        { type: 'room_closed', roomId: '124' },
      ]) {
        internal.onTransportEvent('irc', event);
      }

      for (const line of BANCHO_LIFECYCLE) {
        expect(texts()).not.toContain(line);
      }
    } finally {
      dispose();
    }
  });

  it('still narrates the same events for the hub, which has no bot', async () => {
    const { store, manager, texts, dispose } = await createHarness();
    try {
      store.saveSession(session('referee_hub', 'session-1', '123'));
      store.saveSession(session('referee_hub', 'session-2', '124'));
      const internal = manager as unknown as {
        onTransportEvent: (kind: 'irc' | 'referee_hub', event: unknown) => void;
      };

      for (const event of [
        { type: 'match_started', roomId: '123', playlistItemId: null },
        { type: 'countdown', roomId: '123', seconds: 10, kind: 'match_start' },
        { type: 'match_finished', roomId: '123' },
      ]) {
        internal.onTransportEvent('referee_hub', event);
      }
      for (const event of [
        { type: 'match_started', roomId: '124', playlistItemId: null },
        { type: 'match_aborted', roomId: '124' },
        { type: 'room_closed', roomId: '124' },
      ]) {
        internal.onTransportEvent('referee_hub', event);
      }

      expect(texts()).toEqual(expect.arrayContaining(BANCHO_LIFECYCLE));
    } finally {
      dispose();
    }
  });
});
