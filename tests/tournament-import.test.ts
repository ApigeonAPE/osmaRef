import { describe, expect, it, vi } from 'vitest';
import {
  createEmptyTournament,
  createTournamentId,
  TOURNAMENT_ID_ALPHABET,
  TOURNAMENT_ID_PATTERN,
  type ImportPreview,
  type Tournament,
} from '@osmaref/contracts';
import type { AppStore } from '../apps/desktop/src/main/store';
import type { ServerClient } from '../apps/desktop/src/main/server-client';
import type { AppLogger } from '../apps/desktop/src/main/logger';

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  },
}));

import { TournamentImporter } from '../apps/desktop/src/main/importer';

describe('tournament ids', () => {
  it('creates six-character mixed ids without the letter l', () => {
    for (let index = 0; index < 200; index += 1) {
      const id = createTournamentId();
      expect(id).toHaveLength(6);
      expect(id).toMatch(TOURNAMENT_ID_PATTERN);
      expect(id).not.toContain('l');
      expect(id).toMatch(/\d/);
      expect(id).toMatch(/[a-km-z]/);
      for (const char of id) expect(TOURNAMENT_ID_ALPHABET).toContain(char);
    }
  });

  it('always mixes a digit and a letter even with a deterministic source', () => {
    // A constant source would otherwise produce an all-digit or all-letter id.
    const allDigits = createTournamentId(() => 0);
    expect(allDigits).toMatch(TOURNAMENT_ID_PATTERN);
    expect(allDigits).toMatch(/[a-km-z]/);

    const allLetters = createTournamentId(() => 0.9999);
    expect(allLetters).toMatch(TOURNAMENT_ID_PATTERN);
    expect(allLetters).toMatch(/\d/);
  });

  it('uses the six-character format for new tournaments', () => {
    expect(createEmptyTournament('Test Cup').id).toMatch(TOURNAMENT_ID_PATTERN);
  });
});

describe('tournament imports', () => {
  function makeImporter() {
    const tournaments = new Map<string, Tournament>();
    const store = {
      listTournaments: () => [...tournaments.values()],
      getTournament: (id: string) => tournaments.get(id) ?? null,
      saveTournament: (tournament: Tournament) => {
        const saved: Tournament = {
          ...tournament,
          revision: tournament.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        tournaments.set(saved.id, saved);
        return saved;
      },
    } as unknown as AppStore;
    const logger = { runtime: vi.fn() } as unknown as AppLogger;
    const importer = new TournamentImporter(store, {} as ServerClient, logger);
    return { importer, tournaments };
  }

  function preview(name = 'Imported Cup'): ImportPreview {
    return {
      provider: 'file',
      remoteId: 'bracket.json',
      remoteRevision: null,
      etag: null,
      tournament: createEmptyTournament(name),
      changed: true,
      issues: [],
      notes: [],
    };
  }

  it('creates a new tournament on every import instead of modifying the old one', () => {
    const { importer, tournaments } = makeImporter();

    const first = importer.apply(preview());
    const second = importer.apply(preview());

    expect(first.id).not.toBe(second.id);
    expect(first.id).toMatch(TOURNAMENT_ID_PATTERN);
    expect(second.id).toMatch(TOURNAMENT_ID_PATTERN);
    expect(tournaments.size).toBe(2);
    // The first import is untouched by the second one.
    expect(tournaments.get(first.id)?.revision).toBe(first.revision);
  });

  it('adds a suffix when the same name is imported again', () => {
    const { importer } = makeImporter();
    expect(importer.apply(preview('Cup')).name).toBe('Cup');
    expect(importer.apply(preview('Cup')).name).toBe('Cup (2)');
    expect(importer.apply(preview('Cup')).name).toBe('Cup (3)');
  });

  it('keeps the source metadata of the import', () => {
    const { importer } = makeImporter();
    const saved = importer.apply(preview());
    expect(saved.source).toMatchObject({
      provider: 'file',
      remoteId: 'bracket.json',
    });
  });
});
