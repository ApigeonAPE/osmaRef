import type { PlayerScore } from '@osmaref/contracts';
import type { PlaylistScores, ResultProvider } from '../types';
import type { OsuApiClient } from '../osu/api';

export interface HttpResultProviderOptions {
  /** Local osu! API client; scores are fetched directly from osu!web. */
  client: OsuApiClient;
}

/**
 * Fetches played multiplayer scores directly from osu!web.
 *
 * The referee hub only reports which playlist item completed; retrieving the
 * actual scores needs a separate API call, so failures are explicit and the
 * caller can ask the referee to confirm the result manually.
 */
export class HttpResultProvider implements ResultProvider {
  private readonly options: HttpResultProviderOptions;

  constructor(options: HttpResultProviderOptions) {
    this.options = options;
  }

  async fetchScores(roomId: string, playlistItemId: string): Promise<PlaylistScores> {
    const page = await this.options.client.playlistScores(roomId, playlistItemId);
    return {
      roomId,
      playlistItemId,
      scores: page.scores.map((entry) => mapScore(entry as Record<string, unknown>)),
      fetchedAt: new Date().toISOString(),
      complete: page.complete,
    };
  }
}

export function mapScore(raw: Record<string, unknown>): PlayerScore {
  const statistics = isRecord(raw.statistics) ? raw.statistics : {};
  const user = isRecord(raw.user) ? raw.user : {};
  const mods = Array.isArray(raw.mods)
    ? raw.mods.map((mod) => {
        if (typeof mod === 'string') return mod;
        if (isRecord(mod) && typeof mod.acronym === 'string') return mod.acronym;
        return '';
      }).filter(Boolean)
    : [];
  const accuracy = typeof raw.accuracy === 'number' ? raw.accuracy : 0;
  return {
    userId: numberOr(raw.user_id, numberOr(user.id, 0)),
    username: typeof user.username === 'string' ? user.username : undefined,
    // Realtime multiplayer scores are lazer scores, so API v20220705+ always
    // reports the standardised score as `total_score`.
    score: numberOr(raw.total_score, 0),
    accuracy: accuracy > 1 ? accuracy / 100 : accuracy,
    maxCombo: numberOr(raw.max_combo, 0),
    misses: numberOr(statistics.miss ?? statistics.count_miss, 0),
    mods,
    passed: raw.passed !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}