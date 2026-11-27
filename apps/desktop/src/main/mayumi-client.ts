import { z } from 'zod';
import {
  MayumiDrawSchema,
  MayumiPlayersResponseSchema,
  MayumiPoolStageSchema,
  MayumiRoundInfoSchema,
  MayumiScheduleStageSchema,
  MayumiTournamentInfoSchema,
  MayumiTournamentSummarySchema,
  mayumiOpenState,
  type MayumiSnapshot,
  type MayumiTournamentSummary,
} from '@osmaref/contracts';

export type MayumiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'network'
  | 'protocol';

export class MayumiError extends Error {
  constructor(
    readonly kind: MayumiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'MayumiError';
  }
}

export interface MayumiClientOptions {
  timeoutMs?: number;
}

const MAYUMI_BASE_URL = 'https://mayumi.xyz';
const REQUEST_TIMEOUT = 20_000;

/**
 * Read-only client for mayumi.xyz.
 *
 * Only public endpoints are used: the import never needs a session cookie.
 */
export class MayumiClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: MayumiClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT;
  }

  /** Tournaments whose published date range contains `now`. */
  /** Every tournament on the instance; `open` marks the ones running today. */
  async list(now: Date = new Date()): Promise<MayumiTournamentSummary[]> {
    const payload = await this.request('/api/tournament-summaries');
    const parsed = z.array(MayumiTournamentSummarySchema).safeParse(payload);
    if (!parsed.success) {
      throw new MayumiError('protocol', 'Mayumi returned an unexpected tournament list.');
    }
    return parsed.data
      .map((entry) => ({
        name: entry.name,
        abbreviation: entry.abbreviation,
        status: entry.status ?? '',
        startDate: entry.start_date ?? '',
        endDate: entry.end_date ?? '',
        open: mayumiOpenState(entry.start_date, entry.end_date, now) !== 'closed',
      }))
      .sort((left, right) => right.startDate.localeCompare(left.startDate));
  }

  /**
   * Fetches everything the converter needs. The tournament info and the roster
   * are required; the schedule, the pools and the draw degrade to `null` so a
   * partially published tournament can still be imported.
   */
  async fetchSnapshot(abbreviation: string): Promise<MayumiSnapshot> {
    const query = `tournament_name=${encodeURIComponent(abbreviation)}`;
    const [infoPayload, playersPayload] = await Promise.all([
      this.request(`/api/tournament-info?${query}`),
      this.request(`/api/players?${query}`),
    ]);

    const info = MayumiTournamentInfoSchema.safeParse(infoPayload);
    if (!info.success) {
      throw new MayumiError('protocol', 'Mayumi returned an unexpected tournament description.');
    }
    const players = MayumiPlayersResponseSchema.safeParse(playersPayload);
    if (!players.success) {
      throw new MayumiError('protocol', 'Mayumi returned an unexpected player list.');
    }

    const optional = async <T>(path: string, schema: z.ZodType<T>): Promise<T | null> => {
      try {
        const payload = await this.request(path);
        const parsed = schema.safeParse(payload);
        return parsed.success ? parsed.data : null;
      } catch (cause) {
        if (cause instanceof MayumiError && cause.kind === 'unauthorized') return null;
        if (cause instanceof MayumiError && cause.kind === 'not-found') return null;
        if (cause instanceof MayumiError && cause.kind === 'forbidden') return null;
        if (cause instanceof MayumiError && cause.kind === 'protocol') return null;
        return null;
      }
    };

    const [schedule, mapPools, roundInfo, draw] = await Promise.all([
      optional(`/api/schedule?${query}`, z.array(MayumiScheduleStageSchema)),
      optional(`/api/map_pools?${query}`, z.array(MayumiPoolStageSchema)),
      optional(`/api/tournament-round-info?${query}`, z.array(MayumiRoundInfoSchema)),
      optional(
        `/api/tournament-draw/${encodeURIComponent(abbreviation)}/public`,
        MayumiDrawSchema,
      ),
    ]);
    return {
      info: info.data,
      players: players.data,
      schedule,
      mapPools,
      roundInfo,
      draw: draw?.state ?? null,
    };
  }

  private async request(path: string): Promise<unknown> {
    const base = MAYUMI_BASE_URL;

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new MayumiError('network', `Cannot reach Mayumi at ${base}.`);
    }

    if (response.status === 401) {
      throw new MayumiError('unauthorized', 'Mayumi session expired.');
    }
    if (response.status === 403) {
      throw new MayumiError('forbidden', 'This account cannot read the tournament in Mayumi.');
    }
    if (response.status === 404) {
      throw new MayumiError('not-found', 'Tournament not found on Mayumi.');
    }
    if (!response.ok) {
      throw new MayumiError('protocol', `Mayumi answered ${response.status}.`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new MayumiError('protocol', 'Mayumi did not answer with JSON.');
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new MayumiError('protocol', 'Mayumi returned an unreadable response.');
    }
  }
}
