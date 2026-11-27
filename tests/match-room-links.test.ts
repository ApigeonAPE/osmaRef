import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
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
  const tournament = createEmptyTournament('Link Cup');
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
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-links-'));
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

describe('match MP links', () => {
  it('appends a link and makes it active', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      const updated = await manager.addRoomLink({
        tournamentId: tournament.id,
        matchId: 'match_a',
        roomId: 111,
      });
      const result = updated.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([111]);
      expect(result.activeRoomId).toBe(111);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('only activates an existing link instead of duplicating it', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 111 });
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 222 });
      const updated = await manager.addRoomLink({
        tournamentId: tournament.id,
        matchId: 'match_a',
        roomId: 111,
      });
      const result = updated.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([111, 222]);
      expect(result.activeRoomId).toBe(111);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the last remaining link when the active one is removed', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 111 });
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 222 });
      const updated = await manager.removeRoomLink({
        tournamentId: tournament.id,
        matchId: 'match_a',
        roomId: 222,
      });
      const result = updated.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([111]);
      expect(result.activeRoomId).toBe(111);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears the active link when the last one is removed', async () => {
    const { dir, store, manager } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 111 });
      const updated = await manager.removeRoomLink({
        tournamentId: tournament.id,
        matchId: 'match_a',
        roomId: 111,
      });
      const result = updated.stages[0]!.matches[0]!.result;
      expect(result.roomIds).toEqual([]);
      expect(result.activeRoomId).toBeNull();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits a tournaments_changed event', async () => {
    const { dir, store, manager, emitted } = await setup();
    try {
      const tournament = store.saveTournament(fixture());
      await manager.addRoomLink({ tournamentId: tournament.id, matchId: 'match_a', roomId: 111 });
      expect(emitted.some((event) => event.type === 'tournaments_changed')).toBe(true);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
