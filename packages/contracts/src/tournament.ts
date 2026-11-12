import { z } from 'zod';

/**
 * Versioned tournament configuration.
 *
 * The configuration is deliberately declarative: no imported script may run.
 * Every rule (scoring, messaging) is data that the domain layer interprets.
 *
 * v3 stores teams and tournament mode at the root, with stages owning groups,
 * mappools, scoring, flows, and their lobby/match fixtures.
 */

export const TOURNAMENT_SCHEMA_VERSION = 3 as const;

/**
 * Tournament ids are six random characters: digits plus lower-case letters
 * except `l`, which is easy to confuse with `1`. At least one digit and one
 * letter are guaranteed so the id is always "mixed".
 */
export const TOURNAMENT_ID_ALPHABET = '0123456789abcdefghijkmnopqrstuvwxyz';
const TOURNAMENT_ID_DIGITS = '0123456789';
const TOURNAMENT_ID_LETTERS = 'abcdefghijkmnopqrstuvwxyz';
export const TOURNAMENT_ID_PATTERN = /^(?=.*\d)(?=.*[a-km-z])[0-9a-km-z]{6}$/;

export function createTournamentId(random: () => number = Math.random): string {
  const pick = (alphabet: string): string =>
    alphabet[Math.min(alphabet.length - 1, Math.floor(random() * alphabet.length))]!;
  const chars: string[] = [];
  for (let index = 0; index < 6; index += 1) chars.push(pick(TOURNAMENT_ID_ALPHABET));
  if (!chars.some((char) => TOURNAMENT_ID_DIGITS.includes(char))) chars[0] = pick(TOURNAMENT_ID_DIGITS);
  if (!chars.some((char) => TOURNAMENT_ID_LETTERS.includes(char))) chars[1] = pick(TOURNAMENT_ID_LETTERS);
  return chars.join('');
}

/** osu!, osu!taiko, osu!catch, osu!mania — mirrors osu! ruleset ids. */
export const RulesetIdSchema = z.number().int().min(0).max(3);
export type RulesetId = z.infer<typeof RulesetIdSchema>;

export const MatchTypeSchema = z.enum(['head_to_head', 'team_versus']);
export type MatchType = z.infer<typeof MatchTypeSchema>;

export const TransportKindSchema = z.enum(['irc', 'referee_hub']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

/** Win conditions supported by the internal score engine. */
export const WinConditionSchema = z.enum([
  'score',
  'score_v2',
  'accuracy',
  'combo',
  'misses',
]);
export type WinCondition = z.infer<typeof WinConditionSchema>;

/** Which side of the comparison wins a beatmap. */
export const WinConditionWinnerSchema = z.enum(['highest', 'lowest']);
export type WinConditionWinner = z.infer<typeof WinConditionWinnerSchema>;

/**
 * Mod/category code of a slot. osu!'s tournament client uses arbitrary short
 * codes (RC, LN, SV, HB, NM, HD, ...), so this is not a fixed enum.
 */
export const MappoolCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(8)
  .regex(/^[A-Za-z0-9]+$/, 'category must be a short alphanumeric code');
export type MappoolCategory = z.infer<typeof MappoolCategorySchema>;

const TimestampSchema = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'must be a parseable date-time string',
  });
const UtcTimestampSchema = TimestampSchema.refine((value) => value.endsWith('Z'), {
  message: 'must be a UTC timestamp ending in Z',
});

const IdSchema = z.string().min(1).max(128);

export const TeamIdSchema = z.number().int().nonnegative();
export type TeamId = z.infer<typeof TeamIdSchema>;

/** Ruleset mode of a tournament. `osu` means each beatmap's native mode. */
export const TOURNAMENT_MODES = ['osu', 'taiko', 'catch', 'mania', 'multi'] as const;
export const TournamentModeSchema = z.enum(TOURNAMENT_MODES);
export type TournamentMode = z.infer<typeof TournamentModeSchema>;

/** Explicit map conversion mode; null means retain the beatmap's native mode. */
export const RulesetOverrideSchema = RulesetIdSchema.nullable().default(null);
export type RulesetOverride = z.infer<typeof RulesetOverrideSchema>;

export const TeamMemberSchema = z.object({
  userId: z.number().int().positive(),
  /** Filled from the osu! API after entering the id; never required by hand. */
  username: z.string().max(64).default(''),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** Team colours are assigned to teamRed/teamBlue per match, not stored here. */
export const TeamSchema = z.object({
  /** Stable zero-based id allocated when the team is created. */
  id: TeamIdSchema,
  name: z.string().min(1).max(64),
  captainUserId: z.number().int().positive().nullable().default(null),
  members: z.array(TeamMemberSchema).default([]),
  seed: z.number().int().nonnegative().nullable().default(null),
});
export type Team = z.infer<typeof TeamSchema>;

export const StageTypeSchema = z.enum(['group', 'knockout']);
export type StageType = z.infer<typeof StageTypeSchema>;

export const StageGroupSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  teamIds: z.array(TeamIdSchema).default([]),
});
export type StageGroup = z.infer<typeof StageGroupSchema>;

export const MatchResultSchema = z.object({
  scoreRed: z.number().int().nonnegative().default(0),
  scoreBlue: z.number().int().nonnegative().default(0),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const TournamentMatchTypeSchema = z.enum(['lobby', 'match']);
export type TournamentMatchType = z.infer<typeof TournamentMatchTypeSchema>;

export const RefereeSchema = z.object({
  userId: z.number().int().positive(),
  username: z.string().max(64).default(''),
});
export type Referee = z.infer<typeof RefereeSchema>;

export const MappoolSlotSchema = z.object({
  id: IdSchema,
  /**
   * Human readable slot label such as `NM1`, `DT3`, `TB` or a mania key-count
   * pool such as `4K1`. Labels are alphanumeric and must contain a letter.
   */
  label: z
    .string()
    .min(1)
    .max(12)
    .regex(
      /^(?=.*[A-Za-z])[A-Za-z0-9]{1,12}$/,
      'slot label must be 1–12 letters/digits and contain a letter, e.g. NM1, 4K1 or TB',
    ),
  category: MappoolCategorySchema,
  beatmapId: z.number().int().positive(),
  /** null selects the beatmap's native ruleset; otherwise this may request conversion. */
  rulesetId: RulesetOverrideSchema,
  requiredMods: z.array(z.string().min(1).max(16)).default([]),
  allowedMods: z.array(z.string().min(1).max(16)).default([]),
  freestyle: z.boolean().default(false),
  winCondition: WinConditionSchema.nullable().default(null),
  /** null means derive from the condition (misses => lowest, otherwise highest). */
  winConditionWinner: WinConditionWinnerSchema.nullable().default(null),
  note: z.string().max(500).optional(),
});
export type MappoolSlot = z.infer<typeof MappoolSlotSchema>;

export const FlowStepKindSchema = z.enum(['protect', 'ban', 'pick']);
export type FlowStepKind = z.infer<typeof FlowStepKindSchema>;

export const FlowStepSchema = z.object({
  id: IdSchema,
  kind: FlowStepKindSchema,
  /**
   * Actions per team. Every step alternates the two teams, so `count: 1`
   * means "one action each" ("one ban each", "one protect each", ...).
   * Older files may still carry a `side` field; it is dropped on parse.
   */
  count: z.number().int().min(1).max(10),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowTriggerSchema = z.object({
  id: IdSchema,
  team: z.enum(['team_one', 'team_two']),
  threshold: z.number().int().min(1).max(31),
  action: z.enum(['ban', 'protect', 'pick']),
  count: z.number().int().min(1).max(10).default(1),
  /** Repeat the grant every N additional points after the threshold. */
  repeatEvery: z.number().int().min(1).max(31).nullable().default(null),
});
export type FlowTrigger = z.infer<typeof FlowTriggerSchema>;

export const MatchFlowSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  steps: z.array(FlowStepSchema).default([]),
  triggers: z.array(FlowTriggerSchema).default([]),
});
export type MatchFlow = z.infer<typeof MatchFlowSchema>;

export const ScoringSchemeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  winCondition: WinConditionSchema.default('score'),
  aggregation: z.enum(['sum', 'average', 'max']).default('sum'),
  /** Multipliers applied to a player's raw value, keyed by mod acronym. */
  modMultipliers: z.record(z.number().positive()).default({}),
  /** Free-form note shown in the UI; never executed. */
  note: z.string().max(500).optional(),
});
export type ScoringScheme = z.infer<typeof ScoringSchemeSchema>;

const MatchBaseSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(128),
  /** Optional group membership for group-stage fixtures. */
  groupId: IdSchema.nullable().default(null),
  refereeIds: z.array(z.number().int().positive()).default([]),
  transport: TransportKindSchema.default('irc'),
  /** Required UTC timestamp. New matches are initialized to now. */
  scheduledAt: UtcTimestampSchema,
  /** Lobby retains a zero result for shape consistency but does not use it. */
  result: MatchResultSchema.default({ scoreRed: 0, scoreBlue: 0 }),
  roomNameTemplate: z
    .string()
    .min(1)
    .max(160)
    .default('{tournament}: ({team_one}) vs ({team_two})'),
  initialBeatmapId: z.number().int().positive().nullable().default(null),
  notes: z.string().max(1000).optional(),
});

export const MatchSchema = z.discriminatedUnion('type', [
  MatchBaseSchema.extend({
    type: z.literal('lobby'),
    teamIds: z.array(TeamIdSchema).min(3),
    roomMode: MatchTypeSchema.default('head_to_head'),
  }),
  MatchBaseSchema.extend({
    type: z.literal('match'),
    teamRedId: TeamIdSchema,
    teamBlueId: TeamIdSchema,
    roomMode: MatchTypeSchema.default('team_versus'),
  }),
]);
export type Match = z.infer<typeof MatchSchema>;

export const StageSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(64),
    order: z.number().int().min(0),
    type: StageTypeSchema,
    groups: z.array(StageGroupSchema).default([]),
    bestOf: z.number().int().min(1).max(31),
    slots: z.array(MappoolSlotSchema).default([]),
    flow: MatchFlowSchema,
    scoringScheme: ScoringSchemeSchema,
    matches: z.array(MatchSchema).default([]),
  })
  .refine((stage) => stage.bestOf % 2 === 1, {
    message: 'bestOf must be an odd number so a match cannot end in a tie',
    path: ['bestOf'],
  });
export type Stage = z.infer<typeof StageSchema>;

export const AutomationTriggerSchema = z.enum([
  'match_created',
  'beatmap_started',
  'beatmap_completed',
  'match_finished',
  'action_applied',
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

export const AutomationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat'),
    template: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('notice'),
    message: z.string().min(1).max(500),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationRuleSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  trigger: AutomationTriggerSchema,
  /** Optional exact slot filter, e.g. only fire on `TB`. */
  slotLabel: z.string().min(1).max(12).nullable().default(null),
  actions: z.array(AutomationActionSchema).default([]),
  enabled: z.boolean().default(true),
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

export const TournamentSourceSchema = z.object({
  provider: z.enum(['file', 'http']),
  remoteId: z.string().min(1),
  remoteRevision: z.string().nullable().default(null),
  etag: z.string().nullable().default(null),
  importedAt: TimestampSchema,
});
export type TournamentSource = z.infer<typeof TournamentSourceSchema>;

export const ABBREVIATION_MAX_LENGTH = 10;

/** Uppercases and truncates an abbreviation to the stored limit. */
export function normalizeAbbreviation(value: string): string {
  return value.trim().toUpperCase().slice(0, ABBREVIATION_MAX_LENGTH);
}

export const TournamentSchema = z
  .object({
    schemaVersion: z.literal(TOURNAMENT_SCHEMA_VERSION),
    id: IdSchema,
    name: z.string().min(1).max(120),
    abbreviation: z
      .string()
      .trim()
      .min(1)
      .max(ABBREVIATION_MAX_LENGTH)
      .transform((value) => value.toUpperCase())
      .refine((value) => value.length <= ABBREVIATION_MAX_LENGTH, {
        message: `abbreviation must be at most ${ABBREVIATION_MAX_LENGTH} characters`,
      }),
    mode: TournamentModeSchema.default('osu'),
    /** Expected players per team in an actual match; roster length is independent. */
    teamSize: z.number().int().min(1).max(16).default(4),
    teams: z.array(TeamSchema).default([]),
    stages: z.array(StageSchema).default([]),
    automation: z.array(AutomationRuleSchema).default([]),
    revision: z.number().int().min(1).default(1),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    source: TournamentSourceSchema.nullable().default(null),
  })
  .superRefine((tournament, ctx) => {
    for (const issue of validateTournamentReferences(tournament)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: issue.message,
        path: issue.path,
      });
    }
  });
export type Tournament = z.infer<typeof TournamentSchema>;

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Cross-field validation that Zod cannot express locally.
 * Kept exported so the UI can show a checklist instead of only failing on save.
 */
export function validateTournamentReferences(
  tournament: Pick<Tournament, 'teams' | 'stages'>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const teamIds = new Set<TeamId>();
  tournament.teams.forEach((team, index) => {
    if (teamIds.has(team.id)) {
      issues.push({ path: ['teams', index, 'id'], message: `duplicate team id "${team.id}"` });
    }
    teamIds.add(team.id);
    const memberIds = new Set<number>();
    team.members.forEach((member, memberIndex) => {
      if (memberIds.has(member.userId)) {
        issues.push({
          path: ['teams', index, 'members', memberIndex, 'userId'],
          message: `user ${member.userId} appears twice in team "${team.name}"`,
        });
      }
      memberIds.add(member.userId);
    });
    if (team.captainUserId !== null && !memberIds.has(team.captainUserId)) {
      issues.push({
        path: ['teams', index, 'captainUserId'],
        message: `captain ${team.captainUserId} is not a member of team "${team.name}"`,
      });
    }
  });

  const stageIds = new Set<string>();
  const matchIds = new Set<string>();
  tournament.stages.forEach((stage, stageIndex) => {
    const stagePath = ['stages', stageIndex] as (string | number)[];
    if (stageIds.has(stage.id)) {
      issues.push({ path: [...stagePath, 'id'], message: `duplicate stage id "${stage.id}"` });
    }
    stageIds.add(stage.id);

    const groupIds = new Set<string>();
    const assignedTeams = new Set<TeamId>();
    stage.groups.forEach((group, groupIndex) => {
      const groupPath = [...stagePath, 'groups', groupIndex];
      if (groupIds.has(group.id)) {
        issues.push({ path: [...groupPath, 'id'], message: `duplicate group id "${group.id}"` });
      }
      groupIds.add(group.id);
      const localTeamIds = new Set<TeamId>();
      group.teamIds.forEach((teamId, teamIndex) => {
        if (!teamIds.has(teamId)) {
          issues.push({
            path: [...groupPath, 'teamIds', teamIndex],
            message: `group "${group.name}" references unknown team ${teamId}`,
          });
        }
        if (localTeamIds.has(teamId)) {
          issues.push({
            path: [...groupPath, 'teamIds', teamIndex],
            message: `team ${teamId} appears twice in group "${group.name}"`,
          });
        }
        if (assignedTeams.has(teamId)) {
          issues.push({
            path: [...groupPath, 'teamIds', teamIndex],
            message: `team ${teamId} is assigned to multiple groups in stage "${stage.name}"`,
          });
        }
        localTeamIds.add(teamId);
        assignedTeams.add(teamId);
      });
    });

    const labels = new Set<string>();
    const beatmaps = new Set<number>();
    stage.slots.forEach((slot, slotIndex) => {
      const slotPath = [...stagePath, 'slots', slotIndex];
      const label = normalizeSlotLabel(slot.label);
      if (labels.has(label)) {
        issues.push({
          path: [...slotPath, 'label'],
          message: `duplicate slot label "${slot.label}" in stage "${stage.name}"`,
        });
      }
      labels.add(label);
      if (beatmaps.has(slot.beatmapId)) {
        issues.push({
          path: [...slotPath, 'beatmapId'],
          message: `beatmap ${slot.beatmapId} appears twice in stage "${stage.name}"`,
        });
      }
      beatmaps.add(slot.beatmapId);
      if (slot.freestyle && slot.allowedMods.length > 0) {
        issues.push({
          path: [...slotPath, 'allowedMods'],
          message: 'freestyle slots cannot also declare allowed mods',
        });
      }
      if (slot.category === 'TB' && label !== 'TB') {
        issues.push({
          path: [...slotPath, 'label'],
          message: 'tiebreaker slots must use the TB label',
        });
      }
      const required = new Set(slot.requiredMods.map((mod) => mod.toUpperCase()));
      const expectedMods: Record<string, string[]> = {
        HD: ['HD'],
        HR: ['HR'],
        DT: ['DT', 'NC'],
      };
      const alternatives = expectedMods[slot.category];
      if (alternatives && !alternatives.some((mod) => required.has(mod))) {
        issues.push({
          path: [...slotPath, 'requiredMods'],
          message: `category ${slot.category} requires one of ${alternatives.join('/')} in required mods`,
        });
      }
      if (slot.category === 'NM' && required.size > 0) {
        issues.push({
          path: [...slotPath, 'requiredMods'],
          message: 'NM slots cannot declare required mods',
        });
      }
      if (slot.category === 'FM' && !slot.freestyle && slot.allowedMods.length === 0) {
        issues.push({ path: slotPath, message: 'FM slots must be freestyle or declare allowed mods' });
      }
    });

    stage.flow.triggers.forEach((trigger, triggerIndex) => {
      if (trigger.threshold > stage.bestOf) {
        issues.push({
          path: [...stagePath, 'flow', 'triggers', triggerIndex, 'threshold'],
          message: 'trigger threshold cannot exceed the stage best-of',
        });
      }
    });
    for (const [mod, multiplier] of Object.entries(stage.scoringScheme.modMultipliers)) {
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        issues.push({
          path: [...stagePath, 'scoringScheme', 'modMultipliers', mod],
          message: 'multiplier must be a positive finite number',
        });
      }
    }

    stage.matches.forEach((match, matchIndex) => {
      const matchPath = [...stagePath, 'matches', matchIndex];
      if (matchIds.has(match.id)) {
        issues.push({ path: [...matchPath, 'id'], message: `duplicate match id "${match.id}"` });
      }
      matchIds.add(match.id);
      if (match.groupId !== null && !groupIds.has(match.groupId)) {
        issues.push({
          path: [...matchPath, 'groupId'],
          message: `unknown group "${match.groupId}" in stage "${stage.name}"`,
        });
      }
      const participants = match.type === 'match'
        ? [match.teamRedId, match.teamBlueId]
        : match.teamIds;
      const participantIds = new Set<TeamId>();
      participants.forEach((teamId, teamIndex) => {
        if (!teamIds.has(teamId)) {
          issues.push({
            path: match.type === 'match'
              ? [...matchPath, teamIndex === 0 ? 'teamRedId' : 'teamBlueId']
              : [...matchPath, 'teamIds', teamIndex],
            message: `match "${match.name}" references unknown team ${teamId}`,
          });
        }
        if (participantIds.has(teamId)) {
          issues.push({
            path: match.type === 'match' ? matchPath : [...matchPath, 'teamIds', teamIndex],
            message: `team ${teamId} appears more than once in match "${match.name}"`,
          });
        }
        participantIds.add(teamId);
      });
      if (match.groupId !== null) {
        const group = stage.groups.find((entry) => entry.id === match.groupId);
        if (group && participants.some((teamId) => !group.teamIds.includes(teamId))) {
          issues.push({
            path: [...matchPath, 'groupId'],
            message: `match "${match.name}" includes a team outside group "${group.name}"`,
          });
        }
      }
    });
  });

  return issues;
}
export function normalizeSlotLabel(label: string): string {
  return label.trim().toUpperCase();
}

export const SLOT_LABEL_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9]{1,12}$/;

export const DEFAULT_FREEMOD_POOL = [
  'HD',
  'HR',
  'EZ',
  'DT',
  'FL',
  'HT',
  'SO',
  'NF',
] as const;

export const KNOWN_MODS = [
  'NM',
  'HD',
  'HR',
  'EZ',
  'DT',
  'NC',
  'HT',
  'FL',
  'SO',
  'FI',
  'SD',
  'PF',
  'NF',
  'AT',
  'MR',
  'CL',
  'DA',
  'RX',
  'AP',
  'V2',
  'FREEMOD',
  'NONE',
] as const;

/**
 * Parses v2 and migrates v1 documents (stages + mappools + flows) on the fly.
 * Migration keeps the stage id as the round id so matches remain resolvable.
 */
export function parseTournament(input: unknown) {
  return TournamentSchema.safeParse(migrateTournament(input));
}

export function migrateTournament(input: unknown): unknown {
  if (!isRecord(input)) return input;
  if (input.schemaVersion !== TOURNAMENT_SCHEMA_VERSION) return input;
  return {
    ...input,
    abbreviation:
      typeof input.abbreviation === 'string'
        ? normalizeAbbreviation(input.abbreviation)
        : input.abbreviation,
  };
}
export function createEmptyTournament(name: string, now = new Date()): Tournament {
  const timestamp = now.toISOString();
  const scoringScheme: ScoringScheme = {
    id: 'score_default',
    name: 'Score V2',
    winCondition: 'score_v2',
    aggregation: 'sum',
    modMultipliers: {},
  };
  return {
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    id: createTournamentId(),
    name,
    abbreviation: normalizeAbbreviation(name) || 'TOURNAMENT',
    mode: 'osu',
    teamSize: 4,
    teams: [
      { id: 0, name: 'Team 1', captainUserId: null, members: [], seed: null },
      { id: 1, name: 'Team 2', captainUserId: null, members: [], seed: null },
    ],
    stages: [
      {
        id: 'stage_1',
        name: 'Stage 1',
        order: 0,
        type: 'knockout',
        groups: [],
        bestOf: 9,
        slots: [],
        flow: {
          id: 'flow_stage_1',
          name: 'Protect, ban, pick',
          steps: [
            { id: 'step_protect', kind: 'protect', count: 1 },
            { id: 'step_ban', kind: 'ban', count: 1 },
            { id: 'step_pick', kind: 'pick', count: 10 },
          ],
          triggers: [],
        },
        scoringScheme,
        matches: [],
      },
    ],
    automation: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    source: null,
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Source alias retained while downstream modules move from rounds to stages. */
export type Round = Stage;

export function findStage(tournament: Tournament, stageId: string): Stage | undefined {
  return tournament.stages.find((stage) => stage.id === stageId);
}

/** @deprecated Use findStage. */
export const findRound = findStage;

export function findScoring(tournament: Tournament, stageId: string): ScoringScheme | undefined {
  return findStage(tournament, stageId)?.scoringScheme;
}

export function findMatch(tournament: Tournament, matchId: string): Match | undefined {
  return tournament.stages.flatMap((stage) => stage.matches).find((match) => match.id === matchId);
}

export function findStageForMatch(tournament: Tournament, matchId: string): Stage | undefined {
  return tournament.stages.find((stage) => stage.matches.some((match) => match.id === matchId));
}

export function matchTeamIds(match: Match): TeamId[] {
  return match.type === 'match' ? [match.teamRedId, match.teamBlueId] : match.teamIds;
}

export function findTeam(tournament: Tournament, teamId: TeamId | string): Team | undefined {
  const id = typeof teamId === 'string' ? Number(teamId) : teamId;
  if (!Number.isInteger(id)) return undefined;
  return tournament.teams.find((team) => team.id === id);
}

export function findSlotByLabel(
  stage: { slots: MappoolSlot[] },
  label: string,
): MappoolSlot | undefined {
  const normalized = normalizeSlotLabel(label);
  return stage.slots.find((slot) => normalizeSlotLabel(slot.label) === normalized);
}

export function allParticipants(tournament: Tournament): TeamMember[] {
  return tournament.teams.flatMap((team) => team.members);
}

export function renderRoomName(
  template: string,
  context: {
    tournament: string;
    stage: string;
    team_one: string;
    team_two: string;
  },
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = (context as Record<string, string>)[key];
    return value ?? match;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}