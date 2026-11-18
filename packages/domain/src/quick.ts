import {
  BUILTIN_WIN_BY_RULE_ID,
  TOURNAMENT_SCHEMA_VERSION,
  TournamentSchema,
  emptyAutomationMessages,
  type Match,
  type MatchFlow,
  type Platform,
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
 * beatmap, an auto-sized picks-only flow and score-v2 scoring.
 */
export function buildQuickTournament(options: QuickRoomOptions): Tournament {
  const now = (options.now ?? new Date()).toISOString();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const bestOf = normalizeBestOf(options.bestOf);
  const beatmapId =
    options.beatmapId && options.beatmapId > 0 ? Math.round(options.beatmapId) : null;
  const mode = RULESET_MODES[options.rulesetId] ?? 'osu';
  const platform: Platform = options.transport === 'referee_hub' ? 'lazer' : 'stable';
  const roomWinCondition: 'score' | 'score_v2' =
    platform === 'lazer' ? 'score' : 'score_v2';

  const flow: MatchFlow = {
    id: 'flow_quick',
    name: 'Quick picks',
    phases: [
      {
        id: 'phase_quick_pick',
        action: 'pick',
        countPerTeam: null,
        useStageCount: false,
        phaseOrder: 'alternate',
      },
    ],
    triggers: [],
  };
  const match: Match = {
    id: 'match_quick',
    type: 'match',
    groupId: null,
    teamRedId: 0,
    teamBlueId: 1,
    refereeIds: options.referee ? [options.referee.userId] : [],
    scheduledAt: now,
    result: { scoreRed: 0, scoreBlue: 0 },
    roomMode: options.matchType,
  };
  const stage: Stage = {
    id: 'stage_quick',
    name: 'Quick room',
    order: 0,
    type: 'knockout',
    groups: [],
    bestOf,
    bans: 0,
    protects: 0,
    winCondition: roomWinCondition,
    winByRuleId: BUILTIN_WIN_BY_RULE_ID,
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
          },
        ]
      : [],
    flow,
    matches: [match],
  };

  const tournament: Tournament = {
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    id: `adhoc_${suffix}`,
    name: options.name,
    abbreviation: 'QUICK',
    platform,
    mode,
    teamSize: 4,
    teams: [
      { id: 0, name: 'Team 1', captainUserId: null, members: [], seed: null },
      { id: 1, name: 'Team 2', captainUserId: null, members: [], seed: null },
    ],
    stages: [stage],
    automation: emptyAutomationMessages(),
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
