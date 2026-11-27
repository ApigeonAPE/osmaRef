import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MatchSessionSchema,
  createEmptyTournament,
  type DesktopEvent,
  type Tournament,
} from '@osmaref/contracts';
import { ConnectionManager } from '../apps/desktop/src/main/connections';
import { createAppStore } from '../apps/desktop/src/main/store';
import type { SettingsStore } from '../apps/desktop/src/main/settings';
import type { ServerClient } from '../apps/desktop/src/main/server-client';
import type { AppLogger } from '../apps/desktop/src/main/logger';
import { WinByStore } from '../apps/desktop/src/main/winby-store';

function fixture(): Tournament {
  const tournament = createEmptyTournament('Bind Cup');
  const stage = tournament.stages[0]!;
  stage.bestOf = 3;
  stage.matches = [
    {
      type: 'match',
      id: 'match_a',
      groupId: null,
      refereeIds: [],
      scheduledAt: '2026-01-02T12:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0, roomIds: [], activeRoomId: null, beatmaps: [] },
      teamRedId: tournament.teams[0]!.id,
      teamBlueId: tournament.teams[1]!.id,
      roomMode: 'team_versus',
    },
  ];
  return tournament;
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-bind-'));
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
  return { dir, store, manager, emitted };
}

function quickSession(roomId: string) {
  return MatchSessionSchema.parse({
    id: 'sess_quick',
    tournamentId: 'quick_none',
    matchId: 'quick_match',
    tournamentRevision: 1,
    matchName: 'Quick room',
    teamOneId: '0',
    teamTwoId: '1',
    transport: 'irc',
    status: 'active',
    bestOf: 3,
    roomId,
    roomName: 'osu! room',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('binding a room to a stored match', () => {
  it('rewrites the session and stores the MP link on the match', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      store.saveSession(quickSession('990001'));

      const bound = await manager.bindSessionRoom({
        sessionId: 'sess_quick',
        tournamentId: tournament.id,
        matchId: 'match_a',
      });

      expect(bound.id).toBe('sess_quick');
      expect(bound.tournamentId).toBe(tournament.id);
      expect(bound.matchId).toBe('match_a');
      expect(bound.roomId).toBe('990001');
      expect(bound.transport).toBe('irc');

      const saved = store.getTournament(tournament.id)!;
      const match = saved.stages[0]!.matches[0]!;
      expect(match.result.roomIds).toEqual([990001]);
      expect(match.result.activeRoomId).toBe(990001);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adds its room to a match that already has an MP link', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      tournament.stages[0]!.matches[0]!.result.roomIds = [123456];
      tournament.stages[0]!.matches[0]!.result.activeRoomId = 123456;
      store.saveTournament(tournament);
      store.saveSession(quickSession('990002'));

      await manager.bindSessionRoom({
        sessionId: 'sess_quick',
        tournamentId: tournament.id,
        matchId: 'match_a',
      });
      const saved = store.getTournament(tournament.id)!;
      const result = saved.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([123456, 990002]);
      expect(result.activeRoomId).toBe(990002);
      expect(result.scoreRed).toBe(0);
      expect(result.beatmaps).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to rebind a room that is already bound', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      store.saveSession(quickSession('990003'));

      const bound = await manager.bindSessionRoom({
        sessionId: 'sess_quick',
        tournamentId: tournament.id,
        matchId: 'match_a',
      });
      store.saveSession(bound);

      await expect(
        manager.bindSessionRoom({
          sessionId: bound.id,
          tournamentId: tournament.id,
          matchId: 'match_a',
        }),
      ).rejects.toThrow('already bound');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
