import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MatchSessionSchema,
  RoomSnapshotSchema,
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
  const tournament = createEmptyTournament('Relink Cup');
  const stage = tournament.stages[0]!;
  stage.bestOf = 3;
  stage.slots = [
    {
      id: 'slot_nm1',
      label: 'NM1',
      category: 'NM',
      beatmapId: 1111,
      rulesetId: 0,
      requiredMods: [],
      allowedMods: [],
      freestyle: false,
      freemod: false,
      beatmap: null,
    },
  ];
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
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-relink-'));
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
  const manager = new ConnectionManager({
    store,
    settings,
    winby: new WinByStore(dir),
    server: { osu: {} } as unknown as ServerClient,
    logger,
    emit: (event) => emitted.push(event),
  });
  let rooms = 0;
  const transport = {
    createRoom: vi.fn(async (options: { name: string }) =>
      RoomSnapshotSchema.parse({
        roomId: String(120 + ++rooms),
        name: options.name,
        updatedAt: new Date().toISOString(),
      }),
    ),
    closeRoom: vi.fn(async () => {}),
  };
  (manager as unknown as { irc: unknown }).irc = transport;
  return { dir, store, manager, emitted, transport };
}

describe('room relinking', () => {
  it('reopens the same session when the room was closed mid-match', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const first = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      await manager.skipScore({ sessionId: first.id, slotLabel: 'NM1', winner: 'team_one' });
      await manager.closeSession(first.id);

      const reopened = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      expect(reopened.id).toBe(first.id);
      expect(reopened.status).toBe('active');
      expect(reopened.wins.team_one).toBe(1);
      expect(reopened.results).toHaveLength(1);
      const result = reopened.configSnapshot!.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([121, 122]);
      expect(result.activeRoomId).toBe(122);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to open a second room for an active match', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      await expect(
        manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' }),
      ).rejects.toThrow(/already has an open room/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a finished session finished when the room is closed', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const first = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      await manager.skipScore({ sessionId: first.id, slotLabel: 'NM1', winner: 'team_one' });
      await manager.skipScore({ sessionId: first.id, slotLabel: 'NM1', winner: 'team_one' });

      await manager.closeSession(first.id);
      expect(store.getSession(first.id)!.status).toBe('finished');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the room from the session snapshot when reopening', async () => {
    const { dir, store, manager, transport } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const first = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      await manager.closeSession(first.id);

      const renamed = store.getTournament(tournament.id)!;
      renamed.name = 'Renamed Cup';
      renamed.abbreviation = 'RENAMED';
      store.saveTournament(renamed);

      await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      const reopenedCall = transport.createRoom.mock.calls[1]?.[0] as { name: string };
      expect(reopenedCall.name).toContain('RELINK CUP');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a fresh session when the match already has a recorded room', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const match = tournament.stages[0]!.matches[0]!;
      match.result = {
        scoreRed: 3,
        scoreBlue: 0,
        roomIds: [88],
        activeRoomId: 88,
        beatmaps: [],
      };
      store.saveTournament(tournament);

      const opened = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      expect(opened.wins).toEqual({ team_one: 0, team_two: 0 });
      const result = opened.configSnapshot!.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([]);
      expect(result.activeRoomId).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a fresh session when the previous one is finished', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const finished = tournament.stages[0]!.matches[0]!;
      finished.result = {
        scoreRed: 2,
        scoreBlue: 0,
        roomIds: [77],
        activeRoomId: 77,
        beatmaps: [],
      };
      store.saveTournament(tournament);
      store.saveSession(
        MatchSessionSchema.parse({
          id: 'sess_finished',
          tournamentId: tournament.id,
          matchId: 'match_a',
          tournamentRevision: tournament.revision,
          matchName: 'Relink Cup / match_a',
          matchKind: 'match',
          teamOneId: String(tournament.teams[0]!.id),
          teamTwoId: String(tournament.teams[1]!.id),
          transport: 'irc',
          status: 'finished',
          bestOf: 3,
          roomId: '77',
          roomName: 'previous room',
          configSnapshot: tournament,
          wins: { team_one: 2, team_two: 0 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          committedAt: '2026-01-01T00:00:00.000Z',
        }),
      );

      const reopened = await manager.openRoom({ tournamentId: tournament.id, matchId: 'match_a' });
      expect(reopened.id).not.toBe('sess_finished');
      expect(reopened.status).toBe('active');
      expect(reopened.wins).toEqual({ team_one: 0, team_two: 0 });
      const result = reopened.configSnapshot!.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([]);
      expect(result.activeRoomId).toBeNull();
      expect(result.scoreRed).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
