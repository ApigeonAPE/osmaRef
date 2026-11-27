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
  const tournament = createEmptyTournament('Snapshot Cup');
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

function sessionFor(tournament: Tournament) {
  return MatchSessionSchema.parse({
    id: 'sess_snapshot',
    tournamentId: tournament.id,
    matchId: 'match_a',
    tournamentRevision: tournament.revision,
    matchName: 'Snapshot Cup / match_a',
    matchKind: 'match',
    teamOneId: String(tournament.teams[0]!.id),
    teamTwoId: String(tournament.teams[1]!.id),
    transport: 'irc',
    status: 'active',
    bestOf: 3,
    roomId: '900',
    roomName: 'osu! room',
    configSnapshot: tournament,
    actions: [
      {
        id: 'a1',
        kind: 'pick',
        teamId: String(tournament.teams[0]!.id),
        slotLabel: 'NM1',
        beatmapId: 1111,
        byUserId: 1000,
        at: '2026-01-01T00:00:00.000Z',
      },
    ],
    queue: [
      { id: 'q1', stepId: 'step_1', kind: 'pick', side: 'team_one', index: 1, count: 1 },
      { id: 'q2', stepId: 'step_2', kind: 'pick', side: 'team_two', index: 1, count: 1 },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-snapshot-'));
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
  return { dir, store, manager, emitted };
}

describe('room snapshots', () => {
  it('records a map in the snapshot without touching the tournament', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      store.saveSession(sessionFor(tournament));

      const after = await manager.skipScore({
        sessionId: 'sess_snapshot',
        slotLabel: 'NM1',
        winner: 'team_one',
      });

      const snapshotResult = after.configSnapshot!.stages[0]!.matches[0]!.result;
      expect(snapshotResult.scoreRed).toBe(1);
      expect(snapshotResult.activeRoomId).toBe(900);
      expect(snapshotResult.roomIds).toEqual([900]);
      expect(after.committedAt).toBeNull();

      const stored = store.getTournament(tournament.id)!;
      expect(stored.stages[0]!.matches[0]!.result.scoreRed).toBe(0);
      expect(stored.stages[0]!.matches[0]!.result.roomIds).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the tournament alone until the result is synced', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      store.saveSession(sessionFor(tournament));

      await manager.skipScore({ sessionId: 'sess_snapshot', slotLabel: 'NM1', winner: 'team_one' });
      const finished = await manager.skipScore({
        sessionId: 'sess_snapshot',
        slotLabel: 'NM1',
        winner: 'team_one',
      });

      expect(finished.status).toBe('finished');
      expect(finished.committedAt).toBeNull();
      expect(store.getTournament(tournament.id)!.stages[0]!.matches[0]!.result.scoreRed).toBe(0);

      const synced = await manager.syncMatch('sess_snapshot');
      expect(synced.committedAt).not.toBeNull();
      const result = store.getTournament(tournament.id)!.stages[0]!.matches[0]!.result;
      expect(result.scoreRed).toBe(2);
      expect(result.scoreBlue).toBe(0);
      expect(result.activeRoomId).toBe(900);
      expect(result.beatmaps).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-commits the tournament after an undo of a synced result', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      store.saveSession(sessionFor(tournament));

      await manager.skipScore({ sessionId: 'sess_snapshot', slotLabel: 'NM1', winner: 'team_one' });
      await manager.skipScore({ sessionId: 'sess_snapshot', slotLabel: 'NM1', winner: 'team_one' });
      await manager.syncMatch('sess_snapshot');
      expect(store.getTournament(tournament.id)!.stages[0]!.matches[0]!.result.scoreRed).toBe(2);

      const undone = await manager.undo('sess_snapshot');
      expect(undone.wins.team_one).toBe(1);
      const result = store.getTournament(tournament.id)!.stages[0]!.matches[0]!.result;
      expect(result.scoreRed).toBe(1);
      expect(result.beatmaps).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the session object alone when nothing changed', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      store.saveSession(sessionFor(tournament));
      const session = store.getSession('sess_snapshot')!;
      const project = (
        manager as unknown as { updateSnapshotResult(value: typeof session): typeof session }
      ).updateSnapshotResult.bind(manager);
      const projected = project(session);
      expect(project(projected)).toBe(projected);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
