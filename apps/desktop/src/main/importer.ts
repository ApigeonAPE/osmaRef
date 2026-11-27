import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dialog } from 'electron';
import {
  parseTournament as parseTournamentInput,
  convertBracketToTournament,
  convertMayumiToTournament,
  createEmptyTournament,
  createTournamentId,
  validateTournamentReferences,
  type ImportPreview,
  type Platform,
  type Tournament,
} from '@osmaref/contracts';
import type { AppStore } from './store';
import type { AppLogger } from './logger';
import type { MayumiClient } from './mayumi-client';

export class TournamentImporter {
  constructor(
    private readonly store: AppStore,
    private readonly logger: AppLogger,
    private readonly mayumi: MayumiClient | null = null,
  ) {}

  async exportToFile(tournamentId: string): Promise<string | null> {
    const tournament = this.store.getTournament(tournamentId);
    if (!tournament) throw new Error('tournament not found');
    const result = await dialog.showSaveDialog({
      title: 'Export tournament configuration',
      defaultPath: `${tournament.id}.json`,
      filters: [{ name: 'osmaRef tournament', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return null;
    writeFileSync(
      result.filePath,
      JSON.stringify(stripLocalCovers(tournament), null, 2),
      'utf8',
    );
    this.logger.runtime('info', 'tournament', `exported "${tournament.name}" to ${result.filePath}`);
    return result.filePath;
  }

  async importFromFile(): Promise<ImportPreview | null> {
    const result = await dialog.showOpenDialog({
      title: 'Import tournament configuration',
      properties: ['openFile'],
      filters: [{ name: 'osmaRef tournament', extensions: ['json'] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const tournament = parseTournament(raw);
    this.logger.runtime('info', 'tournament', `imported "${tournament.name}" from ${file}`);
    return this.buildPreview('file', basename(file, '.json'), null, null, tournament);
  }

  /**
   * Imports an osu! tournament client bracket. The bracket is converted to the
   * internal tournament format first; the preview then shows the converted
   * tournament together with any conversion notes.
   */
  async importBracketFromFile(): Promise<ImportPreview | null> {
    const result = await dialog.showOpenDialog({
      title: 'Import osu! tournament bracket (bracket.json)',
      properties: ['openFile'],
      filters: [{ name: 'osu! tournament bracket', extensions: ['json'] }],
    });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    const { tournament, notes } = convertBracketToTournament(raw, {
      name: basename(file, '.json'),
    });
    const remoteId = `bracket:${basename(file)}`.slice(0, 200);
    const matchCount = tournament.stages.reduce((total, stage) => total + stage.matches.length, 0);
    this.logger.runtime(
      'info',
      'tournament',
      `converted bracket ${basename(file)} (${tournament.teams.length} teams, ` +
        `${tournament.stages.length} stages, ${matchCount} matches, ` +
        `${notes.length} notes)`,
    );
    return this.buildPreview('file', remoteId, null, null, tournament, notes);
  }

  /**
   * Reads a tournament from Mayumi and converts it.
   *
   * The session is optional: without it the bracket configuration is skipped
   * and best-of/bans fall back to the public draw or the defaults.
   */
  async importFromMayumi(abbreviation: string, platform: Platform): Promise<ImportPreview> {
    if (!this.mayumi) throw new Error('the Mayumi client is not available');
    const snapshot = await this.mayumi.fetchSnapshot(abbreviation);
    const { tournament, notes } = convertMayumiToTournament(snapshot, { platform });
    const matchCount = tournament.stages.reduce((total, stage) => total + stage.matches.length, 0);
    this.logger.runtime(
      'info',
      'tournament',
      `converted Mayumi ${abbreviation} (${tournament.teams.length} teams, ` +
        `${tournament.stages.length} stages, ${matchCount} matches, ${notes.length} notes)`,
    );
    return this.buildPreview(
      'mayumi',
      `mayumi:${abbreviation}`.slice(0, 200),
      null,
      null,
      tournament,
      notes,
    );
  }

  /**
   * Applies a preview as a brand-new tournament.
   *
   * Imports never modify an existing local tournament: the id is regenerated
   * for every import, so importing the same file twice creates two entries
   * with independent revisions.
   */
  apply(preview: ImportPreview): Tournament {
    const name = uniqueTournamentName(
      preview.tournament.name,
      new Set(this.store.listTournaments().map((tournament) => tournament.name)),
    );
    const next: Tournament = {
      ...preview.tournament,
      id: createTournamentId(),
      name,
      source: {
        provider: preview.provider,
        remoteId: preview.remoteId,
        remoteRevision: preview.remoteRevision,
        etag: preview.etag,
        importedAt: new Date().toISOString(),
      },
      updatedAt: new Date().toISOString(),
    };
    const saved = this.store.saveTournament(next);
    this.logger.runtime(
      'info',
      'tournament',
      `imported "${saved.name}" as new tournament ${saved.id} (${preview.provider}:${preview.remoteId})`,
    );
    return saved;
  }

  createBlank(name: string): Tournament {
    const created = this.store.saveTournament(createEmptyTournament(name));
    this.logger.runtime('info', 'tournament', `created blank tournament "${created.name}"`);
    return created;
  }

  private buildPreview(
    provider: ImportPreview['provider'],
    remoteId: string,
    remoteRevision: string | null,
    etag: string | null,
    tournament: Tournament,
    notes: string[] = [],
  ): ImportPreview {
    const existing = this.store.getTournament(tournament.id);
    const changed = !existing || existing.source?.remoteRevision !== remoteRevision;
    const issues = validateTournamentReferences(tournament).map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
    return {
      provider,
      remoteId,
      remoteRevision,
      etag,
      tournament,
      changed,
      issues,
      notes,
    };
  }
}

function parseTournament(raw: unknown): Tournament {
  const parsed = parseTournamentInput(raw);
  if (!parsed.success) {
    if (looksLikeBracket(raw)) {
      throw new Error(
        'this is an osu! tournament bracket; use "Import bracket.json" so it can be converted first',
      );
    }
    const details = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`tournament configuration is invalid:\n${details}`);
  }
  return stripLocalCovers(parsed.data);
}

/**
 * Cover thumbnails live in a per-tournament folder on this machine. A saved
 * tournament may point at those files, but an exported or imported copy cannot:
 * clear the path so the receiving machine looks the cover up again.
 */
function stripLocalCovers(tournament: Tournament): Tournament {
  let changed = false;
  const stages = tournament.stages.map((stage) => {
    let stageChanged = false;
    const slots = stage.slots.map((slot) => {
      if (!slot.beatmap || !slot.beatmap.coverUrl.startsWith('osmaref-cover:')) return slot;
      stageChanged = true;
      return { ...slot, beatmap: { ...slot.beatmap, coverUrl: '' } };
    });
    if (!stageChanged) return stage;
    changed = true;
    return { ...stage, slots };
  });
  return changed ? { ...tournament, stages } : tournament;
}

function looksLikeBracket(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    !('schemaVersion' in record) &&
    Array.isArray(record['Rounds']) &&
    Array.isArray(record['Matches'])
  );
}

/** Appends a numeric suffix so repeated imports stay distinguishable. */
function uniqueTournamentName(desired: string, taken: Set<string>): string {
  if (!taken.has(desired)) return desired;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${desired} (${index})`.slice(0, 120);
    if (!taken.has(candidate)) return candidate;
  }
  return `${desired} (${Date.now().toString(36)})`.slice(0, 120);
}