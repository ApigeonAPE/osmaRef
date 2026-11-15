import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyTournament } from '@osmaref/contracts';
import { createAppStore } from '../apps/desktop/src/main/store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'osmaref-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('store data upgrade', () => {
  it('clears old tournaments and sessions but keeps runtime logs', async () => {
    const dir = tempDir();
    const first = await createAppStore(dir);
    const tournament = createEmptyTournament('Before upgrade');
    first.saveTournament(tournament);
    first.appendRuntimeLog({
      id: 'log_1',
      at: '2026-01-01T00:00:00.000Z',
      level: 'info',
      scope: 'app',
      message: 'kept across the upgrade',
      details: null,
    });
    first.close();

    const db = new DatabaseSync(join(dir, 'osmaRef.db'));
    db.exec('PRAGMA user_version = 2;');
    db.close();

    const second = await createAppStore(dir);
    expect(second.listTournaments()).toEqual([]);
    expect(second.listSessions()).toEqual([]);
    expect(second.listRuntimeLogs().map((entry) => entry.message)).toEqual([
      'kept across the upgrade',
    ]);
    second.close();

    const check = new DatabaseSync(join(dir, 'osmaRef.db'));
    expect(Number(check.prepare('PRAGMA user_version').get()?.['user_version'])).toBe(4);
    check.close();
  });

  it('does not clear current data on a normal reopen', async () => {
    const dir = tempDir();
    const first = await createAppStore(dir);
    first.saveTournament(createEmptyTournament('Survives'));
    first.close();

    const second = await createAppStore(dir);
    expect(second.listTournaments().map((entry) => entry.name)).toEqual(['Survives']);
    second.close();
  });
});
