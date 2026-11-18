import { z } from 'zod';
import { WinByRuleSnapshotSchema } from './winby';
import {
  FlowTriggerSchema,
  MatchTypeSchema,
  type MatchType,
  RulesetIdSchema,
  TournamentSchema,
  TransportKindSchema,
  migrateTournament,
  type Tournament,
} from './tournament';

export const TeamSideSchema = z.enum(['team_one', 'team_two']);
export type TeamSide = z.infer<typeof TeamSideSchema>;

export const SessionStatusSchema = z.enum(['active', 'finished', 'aborted', 'closed']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const MatchPhaseSchema = z.enum([
  'lobby',
  'roll',
  'protect',
  'ban',
  'pick',
  'playing',
  'finished',
  'aborted',
]);
export type MatchPhase = z.infer<typeof MatchPhaseSchema>;

export const ActionKindSchema = z.enum(['protect', 'ban', 'pick', 'roll', 'manual']);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const PendingActionSchema = z.object({
  id: z.string().min(1),
  stepId: z.string().min(1),
  kind: z.enum(['protect', 'ban', 'pick']),
  side: TeamSideSchema,
  index: z.number().int().min(1),
  count: z.number().int().min(1),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

export const PlayerScoreSchema = z.object({
  userId: z.number().int().positive(),
  username: z.string().min(1).optional(),
  score: z.number().nonnegative().default(0),
  accuracy: z.number().min(0).max(1).default(0),
  maxCombo: z.number().int().nonnegative().default(0),
  misses: z.number().int().nonnegative().default(0),
  mods: z.array(z.string()).default([]),
  passed: z.boolean().default(true),
});
export type PlayerScore = z.infer<typeof PlayerScoreSchema>;

/** Room slot/team snapshot captured when a map starts. */
export const MatchPlayerSchema = z.object({
  userId: z.number().int().nonnegative(),
  username: z.string().max(64).optional(),
  slot: z.number().int().min(0).max(15).nullable().default(null),
  team: z.enum(['red', 'blue']).nullable().default(null),
});
export type MatchPlayer = z.infer<typeof MatchPlayerSchema>;

export const ResultSourceSchema = z.enum(['irc', 'referee_hub', 'manual']);

export const BeatmapResultSchema = z.object({
  id: z.string().min(1),
  slotLabel: z.string().min(1),
  beatmapId: z.number().int().positive(),
  scores: z.array(PlayerScoreSchema).default([]),
  winner: TeamSideSchema.nullable().default(null),
  teamValues: z
    .object({
      team_one: z.number().nullable().default(null),
      team_two: z.number().nullable().default(null),
    })
    .default({ team_one: null, team_two: null }),
  source: ResultSourceSchema.default('manual'),
  recordedAt: z.string().min(1),
  /** Win-by rule that decided this beatmap, kept for auditability. */
  winByRuleId: z.string().min(1).max(128).nullable().default(null),
  needsReview: z.boolean().default(false),
});
export type BeatmapResult = z.infer<typeof BeatmapResultSchema>;

export const MatchActionSchema = z.object({
  id: z.string().min(1),
  kind: ActionKindSchema,
  teamId: z.string().min(1).nullable().default(null),
  slotLabel: z.string().min(1).nullable().default(null),
  beatmapId: z.number().int().positive().nullable().default(null),
  byUserId: z.number().int().positive().nullable().default(null),
  at: z.string().min(1),
  note: z.string().max(500).optional(),
});
export type MatchAction = z.infer<typeof MatchActionSchema>;

export const MatchSessionSchema = z.object({
  id: z.string().min(1),
  tournamentId: z.string().min(1),
  matchId: z.string().min(1),
  tournamentRevision: z.number().int().min(1),
  matchName: z.string().min(1),
  /** Tournament fixture type: a two-team match or a multi-team lobby. */
  matchKind: z.enum(['lobby', 'match']).default('match'),
  /**
   * All participating team IDs as strings. Match sessions use the first two;
   * lobby sessions keep every participant but do not compute a winner.
   */
  participantIds: z.array(z.string().min(1)).default([]),
  teamOneId: z.string().min(1),
  teamTwoId: z.string().min(1),
  /**
   * Set for ad-hoc rooms that have no stored tournament, and available to any
   * session that wants a frozen copy of its configuration.
   */
  configSnapshot: z
    .preprocess(
      (value) => (value == null ? null : migrateTournament(value)),
      TournamentSchema.nullable(),
    )
    .nullable()
    .default(null),
  /** Frozen Win-by rule used by this session. */
  winBy: WinByRuleSnapshotSchema.nullable().default(null),
  rulesetId: RulesetIdSchema.default(0),
  matchType: MatchTypeSchema.default('team_versus'),
  transport: TransportKindSchema.default('irc'),
  status: SessionStatusSchema.default('active'),
  phase: MatchPhaseSchema.default('lobby'),
  bestOf: z.number().int().min(1).max(31).default(9),
  queue: z.array(PendingActionSchema).default([]),
  /** Score-triggered actions copied from the flow at session creation. */
  flowTriggers: z.array(FlowTriggerSchema).default([]),
  /** How many times each trigger has fired, keyed by trigger id. */
  triggerCounts: z.record(z.number().int().nonnegative()).default({}),
  cursor: z.number().int().min(0).default(0),
  wins: z.object({ team_one: z.number().int().nonnegative(), team_two: z.number().int().nonnegative() }).default({ team_one: 0, team_two: 0 }),
  /** False until the referee assigns the first team for every flow step. */
  firstTeamsSet: z.boolean().default(false),
  teamScores: z
    .object({ team_one: z.number().nonnegative(), team_two: z.number().nonnegative() })
    .default({ team_one: 0, team_two: 0 }),
  actions: z.array(MatchActionSchema).default([]),
  results: z.array(BeatmapResultSchema).default([]),
  /** Slots/teams captured at the last map start, used to resolve team sides. */
  matchPlayers: z.array(MatchPlayerSchema).default([]),
  currentSlotLabel: z.string().min(1).nullable().default(null),
  currentBeatmapId: z.number().int().positive().nullable().default(null),
  roomId: z.string().min(1).nullable().default(null),
  roomName: z.string().min(1).nullable().default(null),
  /** True for an IRC channel/PM session that has no multiplayer match. */
  chatOnly: z.boolean().default(false),
  needsReview: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MatchSession = z.infer<typeof MatchSessionSchema>;

export const SessionEventCategorySchema = z.enum(['operation', 'chat', 'game']);
export type SessionEventCategory = z.infer<typeof SessionEventCategorySchema>;

export const SessionEventTypeSchema = z.enum([
  'session_created',
  'room_linked',
  'room_joined',
  'room_left',
  'action_applied',
  'action_rejected',
  'result_recorded',
  'result_needs_review',
  'manual_adjustment',
  'match_started',
  'match_finished',
  'match_completed',
  'match_aborted',
  'beatmap_changed',
  'player_joined',
  'player_left',
  'player_finished',
  'countdown',
  'room_settings_changed',
  'chat_message',
  'transport_event',
  'command_received',
  'command_rejected',
]);
export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;

const GAME_EVENT_TYPES = new Set<SessionEventType>([
  'match_started',
  'match_finished',
  'match_completed',
  'match_aborted',
  'beatmap_changed',
  'player_joined',
  'player_left',
  'player_finished',
  'countdown',
]);

/** Category shown in the lobby log and used by the export formatter. */
export function sessionEventCategory(type: SessionEventType): SessionEventCategory {
  if (type === 'chat_message') return 'chat';
  if (GAME_EVENT_TYPES.has(type)) return 'game';
  return 'operation';
}

export const SessionEventSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.string().min(1),
  type: SessionEventTypeSchema,
  category: SessionEventCategorySchema.default('operation'),
  actorUserId: z.number().int().positive().nullable().default(null),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
});
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/**
 * Metadata for one room's lobby log.
 *
 * It deliberately lives outside `sessions`: removing a finished room from the
 * room list must keep its log readable and exportable until the user deletes
 * the log explicitly.
 */
export const LobbyLogSessionSchema = z.object({
  sessionId: z.string().min(1),
  matchName: z.string().min(1).max(128),
  roomId: z.string().min(1).nullable(),
  transport: TransportKindSchema,
  bestOf: z.number().int().min(1).max(31),
  status: SessionStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type LobbyLogSession = z.infer<typeof LobbyLogSessionSchema>;

export const LobbyLogSummarySchema = LobbyLogSessionSchema.extend({
  entryCount: z.number().int().nonnegative(),
  lastEntryAt: z.string().min(1),
});
export type LobbyLogSummary = z.infer<typeof LobbyLogSummarySchema>;

export function toLobbyLogSession(session: MatchSession): LobbyLogSession {
  return {
    sessionId: session.id,
    matchName: session.matchName,
    roomId: session.roomId,
    transport: session.transport,
    bestOf: session.bestOf,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export interface CreateSessionInput {
  id: string;
  tournamentId: string;
  matchId: string;
  matchName: string;
  matchKind?: 'lobby' | 'match';
  participantIds?: string[];
  teamOneId: string;
  teamTwoId: string;
  tournamentRevision: number;
  /** Stage ban/protect counts used by `useStageCount` phases. */
  bans?: number;
  protects?: number;
  rulesetId: number;
  matchType: MatchType;
  transport: 'irc' | 'referee_hub';
  bestOf: number;
  /** Embedded configuration for rooms created without a stored tournament. */
  configSnapshot?: Tournament | null;
  /** Frozen Win-by rule; null falls back to the built-in rule. */
  winBy?: z.infer<typeof WinByRuleSnapshotSchema> | null;
  /** Quick rooms have no meaningful first-team setup. */
  firstTeamsSet?: boolean;
  now: string;
}

export function requiredWins(bestOf: number): number {
  return Math.floor(bestOf / 2) + 1;
}

export function currentPendingAction(session: MatchSession): PendingAction | null {
  return session.queue[session.cursor] ?? null;
}

export function isSessionEditable(session: MatchSession): boolean {
  return session.status === 'active';
}