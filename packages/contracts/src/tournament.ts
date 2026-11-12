import { z } from 'zod';

/**
 * Versioned tournament configuration.
 *
 * The configuration is deliberately declarative: no imported script may run.
 * Every rule (scoring, messaging) is data that the domain layer interprets.
 *
 * v2 folds stages, mappools and flows into self-contained rounds, because a
 * tournament round owns its own best-of, mappool and pick/ban procedure.
 */

export const TOURNAMENT_SCHEMA_VERSION = 2 as const;

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

const IdSchema = z.string().min(1).max(128);

export const TeamMemberSchema = z.object({
  userId: z.number().int().positive(),
  /** Filled from the osu! API after entering the id; never required by hand. */
  username: z.string().max(64).default(''),
  captain: z.boolean().default(false),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** Team colours are decided per match, not stored on the team. */
export const TeamSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  members: z.array(TeamMemberSchema).default([]),
});
export type Team = z.infer<typeof TeamSchema>;

export const RefereeSchema = z.object({
  userId: z.number().int().positive(),
  username: z.string().max(64).default(''),
});
export type Referee = z.infer<typeof RefereeSchema>;

export const MappoolSlotSchema = z.object({
  id: IdSchema,
  /** Human readable slot label such as `NM1`, `DT3`, `TB`. */
  label: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Za-z]{1,4}\d{0,2}$/, 'slot label must look like NM1, DT3 or TB'),
  category: MappoolCategorySchema,
  beatmapId: z.number().int().positive(),
  rulesetId: RulesetIdSchema.default(0),
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

export const FlowSideSchema = z.enum(['team_one', 'team_two', 'both']);
export type FlowSide = z.infer<typeof FlowSideSchema>;

export const FlowStepSchema = z.object({
  id: IdSchema,
  kind: FlowStepKindSchema,
  count: z.number().int().min(1).max(10),
  side: FlowSideSchema,
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

export const RoundSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(64),
    order: z.number().int().min(0),
    bestOf: z.number().int().min(1).max(31),
    slots: z.array(MappoolSlotSchema).default([]),
    flow: MatchFlowSchema,
  })
  .refine((round) => round.bestOf % 2 === 1, {
    message: 'bestOf must be an odd number so a match cannot end in a tie',
    path: ['bestOf'],
  });
export type Round = z.infer<typeof RoundSchema>;

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

export const MatchSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(128),
  roundId: IdSchema,
  teamOneId: IdSchema,
  teamTwoId: IdSchema,
  refereeIds: z.array(z.number().int().positive()).default([]),
  transport: TransportKindSchema.default('irc'),
  scoringId: IdSchema,
  roomNameTemplate: z
    .string()
    .min(1)
    .max(160)
    .default('{tournament}: ({team_one}) vs ({team_two})'),
  initialBeatmapId: z.number().int().positive().nullable().default(null),
  scheduledAt: TimestampSchema.nullable().default(null),
  notes: z.string().max(1000).optional(),
});
export type Match = z.infer<typeof MatchSchema>;

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
    rulesetId: RulesetIdSchema.default(0),
    defaultMatchType: MatchTypeSchema.default('team_versus'),
    teams: z.array(TeamSchema).default([]),
    referees: z.array(RefereeSchema).default([]),
    rounds: z.array(RoundSchema).default([]),
    scoringSchemes: z.array(ScoringSchemeSchema).default([]),
    matches: z.array(MatchSchema).default([]),
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
  tournament: Pick<
    Tournament,
    'teams' | 'rounds' | 'scoringSchemes' | 'matches' | 'referees'
  >,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const teamIds = new Set<string>();
  tournament.teams.forEach((team, index) => {
    if (teamIds.has(team.id)) {
      issues.push({
        path: ['teams', index, 'id'],
        message: `duplicate team id "${team.id}"`,
      });
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
  });

  // A tournament may hold more than two teams (imported brackets do), because
  // every match names its own two sides; a single match still only uses two.

  const roundIds = new Set<string>();
  const scoringIds = new Set(tournament.scoringSchemes.map((scheme) => scheme.id));

  tournament.rounds.forEach((round, roundIndex) => {
    if (roundIds.has(round.id)) {
      issues.push({
        path: ['rounds', roundIndex, 'id'],
        message: `duplicate round id "${round.id}"`,
      });
    }
    roundIds.add(round.id);

    const labels = new Set<string>();
    const beatmaps = new Set<number>();
    round.slots.forEach((slot, slotIndex) => {
      const label = normalizeSlotLabel(slot.label);
      if (labels.has(label)) {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex, 'label'],
          message: `duplicate slot label "${slot.label}" in round "${round.name}"`,
        });
      }
      labels.add(label);
      if (beatmaps.has(slot.beatmapId)) {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex, 'beatmapId'],
          message: `beatmap ${slot.beatmapId} appears twice in round "${round.name}"`,
        });
      }
      beatmaps.add(slot.beatmapId);
      if (slot.freestyle && slot.allowedMods.length > 0) {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex, 'allowedMods'],
          message: 'freestyle slots cannot also declare allowed mods',
        });
      }
      if (slot.category === 'TB' && label !== 'TB') {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex, 'label'],
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
          path: ['rounds', roundIndex, 'slots', slotIndex, 'requiredMods'],
          message: `category ${slot.category} requires one of ${alternatives.join('/')} in required mods`,
        });
      }
      if (slot.category === 'NM' && required.size > 0) {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex, 'requiredMods'],
          message: 'NM slots cannot declare required mods',
        });
      }
      if (slot.category === 'FM' && !slot.freestyle && slot.allowedMods.length === 0) {
        issues.push({
          path: ['rounds', roundIndex, 'slots', slotIndex],
          message: 'FM slots must be freestyle or declare allowed mods',
        });
      }
    });

    round.flow.triggers.forEach((trigger, triggerIndex) => {
      if (trigger.threshold > round.bestOf) {
        issues.push({
          path: ['rounds', roundIndex, 'flow', 'triggers', triggerIndex, 'threshold'],
          message: 'trigger threshold cannot exceed the round best-of',
        });
      }
    });
  });

  tournament.scoringSchemes.forEach((scheme, index) => {
    for (const [mod, multiplier] of Object.entries(scheme.modMultipliers)) {
      if (!Number.isFinite(multiplier) || multiplier <= 0) {
        issues.push({
          path: ['scoringSchemes', index, 'modMultipliers', mod],
          message: 'multiplier must be a positive finite number',
        });
      }
    }
  });

  tournament.matches.forEach((match, index) => {
    if (!roundIds.has(match.roundId)) {
      issues.push({
        path: ['matches', index, 'roundId'],
        message: `unknown round "${match.roundId}"`,
      });
    }
    if (!teamIds.has(match.teamOneId) || !teamIds.has(match.teamTwoId)) {
      issues.push({
        path: ['matches', index],
        message: 'match references an unknown team',
      });
    }
    if (match.teamOneId === match.teamTwoId) {
      issues.push({
        path: ['matches', index],
        message: 'a match cannot use the same team on both sides',
      });
    }
    if (!scoringIds.has(match.scoringId)) {
      issues.push({
        path: ['matches', index, 'scoringId'],
        message: `unknown scoring scheme "${match.scoringId}"`,
      });
    }
  });

  return issues;
}

export function normalizeSlotLabel(label: string): string {
  return label.trim().toUpperCase();
}

export const SLOT_LABEL_PATTERN = /^[A-Z]{2,4}\d{0,2}$/;

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
  // Older versions allowed longer, mixed-case abbreviations; normalise before
  // validation so stored tournaments keep loading instead of being dropped.
  const source =
    typeof input.abbreviation === 'string'
      ? { ...input, abbreviation: normalizeAbbreviation(input.abbreviation) }
      : input;
  if (source.schemaVersion === TOURNAMENT_SCHEMA_VERSION || Array.isArray(source.rounds)) {
    return source;
  }

  const stages = Array.isArray(source.stages) ? source.stages : [];
  const mappools = Array.isArray(source.mappools) ? source.mappools : [];
  const flows = Array.isArray(source.flows) ? source.flows : [];
  const matches = Array.isArray(source.matches) ? source.matches : [];

  const rounds = stages.map((rawStage, index) => {
    const stage = isRecord(rawStage) ? rawStage : {};
    const stageId = typeof stage.id === 'string' ? stage.id : `round_${index + 1}`;
    const pool = mappools.find(
      (candidate) => isRecord(candidate) && candidate.id === stage.mappoolId,
    );
    const matchForStage = matches.find(
      (candidate) => isRecord(candidate) && candidate.stageId === stageId,
    );
    const flow =
      flows.find(
        (candidate) =>
          isRecord(candidate) &&
          isRecord(matchForStage) &&
          candidate.id === matchForStage.flowId,
      ) ??
      flows[0] ??
      defaultFlow(stageId);
    return {
      id: stageId,
      name: typeof stage.name === 'string' ? stage.name : `Round ${index + 1}`,
      order: typeof stage.order === 'number' ? stage.order : index,
      bestOf: typeof stage.bestOf === 'number' ? stage.bestOf : 9,
      slots: isRecord(pool) && Array.isArray(pool.slots) ? pool.slots : [],
      flow,
    };
  });

  const teams = (Array.isArray(source.teams) ? source.teams : []).map((rawTeam) => {
    if (!isRecord(rawTeam)) return rawTeam;
    const { color: _color, ...team } = rawTeam;
    return team;
  });

  const migratedMatches = matches.map((rawMatch) => {
    if (!isRecord(rawMatch)) return rawMatch;
    const { stageId, mappoolId: _mappoolId, flowId: _flowId, ...rest } = rawMatch;
    return { ...rest, roundId: rest.roundId ?? stageId };
  });

  return {
    ...source,
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    teams,
    rounds,
    matches: migratedMatches,
  };
}

function defaultFlow(roundId: string): MatchFlow {
  return {
    id: `flow_${roundId}`,
    name: 'Default flow',
    steps: [
      { id: `step_ban_${roundId}`, kind: 'ban', count: 1, side: 'both' },
      { id: `step_pick_${roundId}`, kind: 'pick', count: 10, side: 'both' },
    ],
    triggers: [],
  };
}

export function createEmptyTournament(name: string, now = new Date()): Tournament {
  const timestamp = now.toISOString();
  return {
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    id: createTournamentId(),
    name,
    abbreviation: normalizeAbbreviation(name) || 'TOURNAMENT',
    rulesetId: 0,
    defaultMatchType: 'team_versus',
    teams: [
      { id: 'team_one', name: 'Team 1', members: [] },
      { id: 'team_two', name: 'Team 2', members: [] },
    ],
    referees: [],
    rounds: [
      {
        id: 'round_1',
        name: 'Round 1',
        order: 0,
        bestOf: 9,
        slots: [],
        flow: {
          id: 'flow_round_1',
          name: 'Protect, ban, pick',
          steps: [
            { id: 'step_protect', kind: 'protect', count: 1, side: 'both' },
            { id: 'step_ban', kind: 'ban', count: 1, side: 'both' },
            { id: 'step_pick', kind: 'pick', count: 10, side: 'both' },
          ],
          triggers: [],
        },
      },
    ],
    scoringSchemes: [
      {
        id: 'score_default',
        name: 'Score V2',
        winCondition: 'score_v2',
        aggregation: 'sum',
        modMultipliers: {},
      },
    ],
    matches: [],
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

export function findRound(tournament: Tournament, roundId: string): Round | undefined {
  return tournament.rounds.find((round) => round.id === roundId);
}

export function findScoring(
  tournament: Tournament,
  scoringId: string,
): ScoringScheme | undefined {
  return tournament.scoringSchemes.find((scheme) => scheme.id === scoringId);
}

export function findMatch(tournament: Tournament, matchId: string): Match | undefined {
  return tournament.matches.find((match) => match.id === matchId);
}

export function findTeam(tournament: Tournament, teamId: string): Team | undefined {
  return tournament.teams.find((team) => team.id === teamId);
}

export function findSlotByLabel(
  round: { slots: MappoolSlot[] },
  label: string,
): MappoolSlot | undefined {
  const normalized = normalizeSlotLabel(label);
  return round.slots.find((slot) => normalizeSlotLabel(slot.label) === normalized);
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