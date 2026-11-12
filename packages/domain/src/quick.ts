import {
  TournamentSchema,
  type Match,
  type MatchFlow,
  type ScoringScheme,
  type Stage,
  type Tournament,
  type TournamentMode,
  type TransportKind,
} from '@osmaref/contracts';

export interface QuickRoomOptions {
  name: string;
  /** Optional for Bancho IRC; the Referee Hub requires one. */
  beatmapId?: number | null;
  rulesetId: number;
  matchType: 'head_to_head' | 'team_versus';
  transport: TransportKind;
  bestOf: number;
  referee?: { userId: number; username: string } | null;
  now?: Date;
}

const RULESET_MODES: TournamentMode[] = ['osu', 'taiko', 'catch', 'mania'];

/**
 * Builds the throw-away configuration behind a "quick room".
 *
 * The room has no stored tournament, so the session keeps this snapshot. It
 * deliberately contains only what a referee needs before players arrive: one
 * beatmap, a picks-only flow and score-v2 scoring. Everything else can be
 * changed later through normal room commands.
 */
export function buildQuickTournament(options: QuickRoomOptions): Tournament {
  const now = (options.now ?? new Date()).toISOString();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const bestOf = normalizeBestOf(options.bestOf);
  const matchType = options.matchType;
  const beatmapId =
    options.beatmapId && options.beatmapId > 0 ? Math.round(options.beatmapId) : null;
  const mode = RULESET_MODES[options.rulesetId] ?? 'osu';

  const flow: MatchFlow = {
    id: 'flow_quick',
    name: 'Quick picks',
    steps: [{ id: 'step_quick_pick', kind: 'pick', count: 10 }],
    triggers: [],
  };
  const scoring: ScoringScheme = {
    id: 'score_quick',
    name: 'Score V2',
    winCondition: 'score_v2',
    aggregation: 'sum',
    modMultipliers: {},
  };
  const match: Match = {
    id: 'match_quick',
    type: 'match',
    name: options.name,
    groupId: null,
    teamRedId: 0,
    teamBlueId: 1,
    refereeIds: options.referee ? [options.referee.userId] : [],
    transport: options.transport,
    scheduledAt: now,
    result: { scoreRed: 0, scoreBlue: 0 },
    roomMode: matchType,
    roomNameTemplate: '{tournament}',
    initialBeatmapId: beatmapId,
  };
  const stage: Stage = {
    id: 'stage_quick',
    name: 'Quick room',
    order: 0,
    type: 'knockout',
    groups: [],
    bestOf,
    slots: beatmapId
      ? [
          {
            id: 'slot_quick_nm1',
            label: 'NM1',
            category: 'NM',
            beatmapId,
            rulesetId:
              options.rulesetId >= 0 && options.rulesetId <= 3 ? options.rulesetId : null,
            requiredMods: [],
            allowedMods: [],
            freestyle: false,
            winCondition: null,
            winConditionWinner: null,
          },
        ]
      : [],
    flow,
    scoringScheme: scoring,
    matches: [match],
  };

  const tournament: Tournament = {
    schemaVersion: 3,
    id: `adhoc_${suffix}`,
    name: options.name,
    abbreviation: 'QUICK',
    mode,
    teamSize: 4,
    teams: [
      { id: 0, name: 'Team 1', captainUserId: null, members: [], seed: null },
      { id: 1, name: 'Team 2', captainUserId: null, members: [], seed: null },
    ],
    stages: [stage],
    automation: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    source: null,
  };

  return TournamentSchema.parse(tournament);
}

export function normalizeBestOf(value: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : 1;
  const clamped = Math.min(31, Math.max(1, rounded));
  return clamped % 2 === 0 ? Math.min(31, clamped + 1) : clamped;
}
