import { z } from 'zod';
import {
  MayumiBracketConfigSchema,
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
  /** Read on every request so a settings change applies immediately. */
  baseUrl: () => string;
  /** The stored `uuid` cookie, if any. */
  session: () => string | null;
  timeoutMs?: number;
}

const REQUEST_TIMEOUT = 20_000;

/**
 * Read-only client for a Mayumi instance.
 *
 * Only public endpoints are used for the import; the optional session cookie
 * unlocks the bracket configuration (`bestOf`/`banCount`) and the private draw.
 */
export class MayumiClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: MayumiClientOptions) {
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
      .sort((left, right) => left.startDate.localeCompare(right.startDate));
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

    const optional = async <T>(
      path: string,
      schema: z.ZodType<T>,
      withSession = false,
    ): Promise<T | null> => {
      try {
        const payload = await this.request(path, withSession);
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

    const [schedule, mapPools, roundInfo, drawPublic, drawPrivate, bracket] = await Promise.all([
      optional(`/api/schedule?${query}`, z.array(MayumiScheduleStageSchema)),
      optional(`/api/map_pools?${query}`, z.array(MayumiPoolStageSchema)),
      optional(`/api/tournament-round-info?${query}`, z.array(MayumiRoundInfoSchema)),
      optional(
        `/api/tournament-draw/${encodeURIComponent(abbreviation)}/public`,
        MayumiDrawSchema,
      ),
      this.options.session()
        ? optional(`/api/tournament-draw/${encodeURIComponent(abbreviation)}`, MayumiDrawSchema, true)
        : Promise.resolve(null),
      this.options.session()
        ? optional(
            `/api/tournament-bracket/${encodeURIComponent(abbreviation)}`,
            MayumiBracketConfigSchema,
            true,
          )
        : Promise.resolve(null),
    ]);

    const draw = drawPrivate?.state ?? drawPublic?.state ?? null;
    return {
      info: info.data,
      players: players.data,
      schedule,
      mapPools,
      roundInfo,
      draw,
      bracket,
    };
  }

  private async request(path: string, withSession = false): Promise<unknown> {
    const base = this.options.baseUrl().trim().replace(/\/$/, '');
    if (!/^https?:\/\//i.test(base)) {
      throw new MayumiError('network', `Cannot reach Mayumi at ${base}.`);
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    const session = withSession ? this.options.session() : null;
    if (session) headers['Cookie'] = `uuid=${session}`;

    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers,
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
