import { describe, expect, it } from 'vitest';
import {
  MIGRATION_TEAM_MAP_SCORES,
  migrateSessionRecord,
  runMigrations,
  type MigrationStore,
  type RawSessionRecord,
} from '../apps/desktop/src/main/migrations';

function legacySession(): Record<string, unknown> {
  return {
    id: 's1',
    teamScores: { team_one: 400, team_two: 500 },
    results: [
      {
        id: 'NM1:1',
        slotLabel: 'NM1',
        beatmapId: 1,
        scores: [],
        winner: 'team_one',
        teamValues: { team_one: 400, team_two: 500 },
        source: 'irc',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    wins: { team_one: 1, team_two: 0 },
  };
}

describe('migrateSessionRecord', () => {
  it('renames teamValues and drops the session total', () => {
    const { data, changed } = migrateSessionRecord(legacySession());
    expect(changed).toBe(true);
    const session = data as Record<string, unknown>;
    expect(session['teamScores']).toBeUndefined();
    const results = session['results'] as Record<string, unknown>[];
    expect(results[0]!['teamValues']).toBeUndefined();
    expect(results[0]!['teamMapScores']).toEqual({ team_one: 400, team_two: 500 });
    expect(session['wins']).toEqual({ team_one: 1, team_two: 0 });
  });

  it('keeps an existing teamMapScores value', () => {
    const session = legacySession();
    const result = (session['results'] as Record<string, unknown>[])[0]!;
    result['teamMapScores'] = { team_one: 1, team_two: 0 };
    const { data } = migrateSessionRecord(session);
    const migrated = (data as Record<string, unknown>)['results'] as Record<string, unknown>[];
    expect(migrated[0]!['teamMapScores']).toEqual({ team_one: 1, team_two: 0 });
  });

  it('leaves a migrated session untouched', () => {
    const session = { id: 's2', results: [], wins: { team_one: 0, team_two: 0 } };
    const { data, changed } = migrateSessionRecord(session);
    expect(changed).toBe(false);
    expect(data).toBe(session);
  });

  it('ignores values that are not session objects', () => {
    expect(migrateSessionRecord(null).changed).toBe(false);
    expect(migrateSessionRecord('nope').changed).toBe(false);
    expect(migrateSessionRecord([1, 2]).changed).toBe(false);
  });
});

describe('runMigrations', () => {
  function fakeStore(rows: RawSessionRecord[]): MigrationStore & {
    written: string[];
    marked: string[];
  } {
    const applied = new Set<string>();
    const written: string[] = [];
    const marked: string[] = [];
    return {
      written,
      marked,
      isMigrationApplied: (id) => applied.has(id),
      markMigrationApplied: (id) => {
        applied.add(id);
        marked.push(id);
      },
      rawSessions: () => rows,
      writeRawSession: (id, data) => {
        written.push(id);
        const index = rows.findIndex((row) => row.id === id);
        if (index !== -1) rows[index] = { id, data };
      },
    };
  }

  it('rewrites rows once and records the migration', () => {
    const rows: RawSessionRecord[] = [{ id: 's1', data: legacySession() }];
    const store = fakeStore(rows);
    expect(runMigrations(store)).toEqual([MIGRATION_TEAM_MAP_SCORES]);
    expect(store.written).toEqual(['s1']);
    expect(store.marked).toEqual([MIGRATION_TEAM_MAP_SCORES]);
    expect(runMigrations(store)).toEqual([]);
    expect(store.written).toEqual(['s1']);
  });

  it('does not write rows that are already current', () => {
    const store = fakeStore([{ id: 's3', data: { id: 's3', results: [] } }]);
    runMigrations(store);
    expect(store.written).toEqual([]);
    expect(store.marked).toEqual([MIGRATION_TEAM_MAP_SCORES]);
  });
});
