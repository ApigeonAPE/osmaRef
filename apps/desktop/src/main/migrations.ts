/**
 * One-shot data migrations.
 *
 * Each migration is recorded in the store once it finishes, so an installation
 * runs it a single time no matter how many times the app starts afterwards.
 * Migrations must not import contracts: they work on the raw rows, before zod
 * gets a chance to strip fields the new schema no longer declares.
 */

export const MIGRATION_TEAM_MAP_SCORES = '2026-11-27-team-map-scores';

export interface RawSessionRecord {
  id: string;
  data: unknown;
}

export interface MigrationStore {
  isMigrationApplied(id: string): boolean;
  markMigrationApplied(id: string): void;
  rawSessions(): RawSessionRecord[];
  writeRawSession(id: string, data: unknown): void;
}

/**
 * `BeatmapResult.teamValues` became `teamMapScores` in 0.2.0-preview, and the
 * session-level `teamScores` counter was dropped. Rewrites a stored session
 * without touching anything else.
 */
export function migrateSessionRecord(raw: unknown): { data: unknown; changed: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: raw, changed: false };
  const session = structuredClone(raw) as Record<string, unknown>;
  let changed = false;
  if ('teamScores' in session) {
    delete session['teamScores'];
    changed = true;
  }
  const results = session['results'];
  if (Array.isArray(results)) {
    for (const entry of results) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const result = entry as Record<string, unknown>;
      if (result['teamValues'] === undefined) continue;
      if (result['teamMapScores'] === undefined) result['teamMapScores'] = result['teamValues'];
      delete result['teamValues'];
      changed = true;
    }
  }
  return { data: changed ? session : raw, changed };
}

/** Applies every pending migration and returns the ids that ran. */
export function runMigrations(store: MigrationStore): string[] {
  const applied: string[] = [];
  if (store.isMigrationApplied(MIGRATION_TEAM_MAP_SCORES)) return applied;
  for (const record of store.rawSessions()) {
    const { data, changed } = migrateSessionRecord(record.data);
    if (changed) store.writeRawSession(record.id, data);
  }
  store.markMigrationApplied(MIGRATION_TEAM_MAP_SCORES);
  applied.push(MIGRATION_TEAM_MAP_SCORES);
  return applied;
}
