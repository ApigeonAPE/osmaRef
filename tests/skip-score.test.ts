import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MappoolSlotSchema,
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
  const tournament = createEmptyTournament('Skip Cup');
  const stage = tournament.stages[0]!;
  stage.bestOf = 3;
  stage.slots = [
    MappoolSlotSchema.parse({
      id: 'slot_nm1',
      label: 'NM1',
      category: 'NM',
      beatmapId: 101,
      rulesetId: 0,
    }),
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
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-skip-'));
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
  return { dir, store, manager };
}

function playingSession(tournament: Tournament, matchKind: 'match' | 'lobby' = 'match') {
  return MatchSessionSchema.parse({
    id: 'sess_skip',
    tournamentId: tournament.id,
    matchId: 'match_a',
    tournamentRevision: tournament.revision,
    matchName: 'Skip Cup',
    matchKind,
    teamOneId: String(tournament.teams[0]!.id),
    teamTwoId: String(tournament.teams[1]!.id),
    transport: 'irc',
    status: 'active',
    phase: 'playing',
    bestOf: 3,
    currentSlotLabel: 'NM1',
    currentBeatmapId: 101,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('skipping a beatmap score', () => {
  it('records the winner without player scores', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      store.saveSession(playingSession(tournament));

      const next = await manager.skipScore({
        sessionId: 'sess_skip',
        slotLabel: 'NM1',
        winner: 'team_one',
      });

      expect(next.wins).toEqual({ team_one: 1, team_two: 0 });
      expect(next.currentSlotLabel).toBeNull();
      expect(next.results).toHaveLength(1);
      const result = next.results[0]!;
      expect(result.source).toBe('skip');
      expect(result.scores).toEqual([]);
      expect(result.winner).toBe('team_one');
      expect(result.teamMapScores).toEqual({ team_one: 1, team_two: 0 });
      expect(result.needsReview).toBe(false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finishes the session at the required wins', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      store.saveSession(playingSession(tournament));

      await manager.skipScore({ sessionId: 'sess_skip', slotLabel: 'NM1', winner: 'team_two' });
      const next = await manager.skipScore({
        sessionId: 'sess_skip',
        slotLabel: 'NM1',
        winner: 'team_two',
      });

      expect(next.wins).toEqual({ team_one: 0, team_two: 2 });
      expect(next.status).toBe('finished');
      expect(next.phase).toBe('finished');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('can be undone like a scored result', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      const session = playingSession(tournament);
      store.saveSession(
        MatchSessionSchema.parse({
          ...session,
          actions: [
            {
              id: 'a1',
              kind: 'pick',
              teamId: String(tournament.teams[0]!.id),
              slotLabel: 'NM1',
              beatmapId: 101,
              byUserId: null,
              at: '2026-01-01T00:01:00.000Z',
            },
          ],
          cursor: 1,
        }),
      );

      await manager.skipScore({ sessionId: 'sess_skip', slotLabel: 'NM1', winner: 'team_one' });
      const undone = await manager.undo('sess_skip');

      expect(undone.wins).toEqual({ team_one: 0, team_two: 0 });
      expect(undone.results).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a lobby and an unknown slot', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = fixture();
      store.saveTournament(tournament);
      store.saveSession(playingSession(tournament, 'lobby'));

      await expect(
        manager.skipScore({ sessionId: 'sess_skip', slotLabel: 'NM1', winner: 'team_one' }),
      ).rejects.toThrow('a lobby has no winner to record');

      store.saveSession(playingSession(tournament));
      await expect(
        manager.skipScore({ sessionId: 'sess_skip', slotLabel: 'XX9', winner: 'team_one' }),
      ).rejects.toThrow('unknown mappool slot');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
