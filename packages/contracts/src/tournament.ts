import { z } from 'zod';

/**
 * Versioned tournament configuration.
 *
 * The configuration is deliberately declarative: no imported script may run.
 * Every rule (scoring, messaging) is data that the domain layer interprets.
 *
 * v4 owns the platform at the tournament root, stores phase-based match flows
 * and stage ban/protect counts, and keeps match IDs independent of their
 * displayed order.
 */

export const TOURNAMENT_SCHEMA_VERSION = 4 as const;

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

/** Platform a tournament is played on; it decides the transport for every room. */
export const PlatformSchema = z.enum(['stable', 'lazer']);
export type Platform = z.infer<typeof PlatformSchema>;

/** Multiplayer team mode (`!mp set` team mode / Hub room type). */
export const MatchTypeSchema = z.enum([
  'head_to_head',
  'tag_coop',
  'team_versus',
  'tag_team_versus',
]);
export type MatchType = z.infer<typeof MatchTypeSchema>;

/** Win conditions a multiplayer room can be configured with. */
export const RoomWinConditionSchema = z.enum([
  'score',
  'score_v2',
  'accuracy',
  'combo',
]);
export type RoomWinCondition = z.infer<typeof RoomWinConditionSchema>;

export const PLATFORM_TEAM_MODES: Record<Platform, MatchType[]> = {
  stable: ['head_to_head', 'tag_coop', 'team_versus', 'tag_team_versus'],
  lazer: ['head_to_head', 'team_versus'],
};

export const PLATFORM_WIN_CONDITIONS: Record<Platform, RoomWinCondition[]> = {
  stable: ['score', 'score_v2', 'accuracy', 'combo'],
  /** lazer has no Score V2 room win condition. */
  lazer: ['score', 'accuracy', 'combo'],
};

export function isTeamModeAllowed(platform: Platform, mode: MatchType): boolean {
  return PLATFORM_TEAM_MODES[platform].includes(mode);
}

export function isWinConditionAllowed(
  platform: Platform,
  condition: RoomWinCondition,
): boolean {
  return PLATFORM_WIN_CONDITIONS[platform].includes(condition);
}

/** Returns the supported value closest to the requested one. */
export function normalizeRoomMode(platform: Platform, mode: MatchType): MatchType {
  if (isTeamModeAllowed(platform, mode)) return mode;
  return platform === 'stable' ? 'team_versus' : 'team_versus';
}

export function normalizeRoomWinCondition(
  platform: Platform,
  condition: RoomWinCondition,
): RoomWinCondition {
  if (isWinConditionAllowed(platform, condition)) return condition;
  return platform === 'lazer' ? 'score' : 'score_v2';
}

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

export const FlowActionSchema = z.enum(['protect', 'ban', 'pick']);
export type FlowAction = z.infer<typeof FlowActionSchema>;

export const FlowPhaseOrderSchema = z.enum(['alternate', 'sequential']);
export type FlowPhaseOrder = z.infer<typeof FlowPhaseOrderSchema>;

/**
 * A flow phase. `countPerTeam` is the number of actions each team gets;
 * `useStageCount` takes ban/protect counts from the stage. Picks are always
 * open-ended (`countPerTeam: null`): the runtime derives them from the stage
 * best-of, so the pick round count is never edited by hand.
 */
export const FlowPhaseSchema = z
  .object({
    id: IdSchema,
    action: FlowActionSchema,
    countPerTeam: z.number().int().min(1).max(10).nullable().default(1),
    useStageCount: z.boolean().default(false),
    phaseOrder: FlowPhaseOrderSchema.default('alternate'),
  })
  .superRefine((phase, ctx) => {
    if (phase.useStageCount && phase.action === 'pick') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'picks cannot use the stage ban/protect count',
        path: ['useStageCount'],
      });
    }
    if (phase.action === 'pick' && phase.countPerTeam !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pick phases are auto-sized from the stage best-of',
        path: ['countPerTeam'],
      });
    }
  });
export type FlowPhase = z.infer<typeof FlowPhaseSchema>;

export const FlowTriggerSchema = z.object({
  id: IdSchema,
  /** Team whose score is watched. */
  subject: z.enum(['team_one', 'team_two']),
  threshold: z.number().int().min(1).max(31),
  /** Repeat the grant every N additional points after the threshold. */
  repeatEvery: z.number().int().min(1).max(31).nullable().default(null),
  /** Which team receives the extra action. */
  grantTo: z.enum(['subject', 'opponent']).default('opponent'),
  action: FlowActionSchema,
  count: z.number().int().min(1).max(10).default(1),
});
export type FlowTrigger = z.infer<typeof FlowTriggerSchema>;

export const MatchFlowSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64),
  phases: z.array(FlowPhaseSchema).default([]),
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
  /** Optional group membership for group-stage fixtures. */
  groupId: IdSchema.nullable().default(null),
  refereeIds: z.array(z.number().int().positive()).default([]),
  /** Required UTC timestamp. New matches are initialized to now. */
  scheduledAt: UtcTimestampSchema,
  /** Lobby retains a zero result for shape consistency but does not use it. */
  result: MatchResultSchema.default({ scoreRed: 0, scoreBlue: 0 }),
  /** Room win condition; platform-specific options are enforced below. */
  winCondition: RoomWinConditionSchema.default('score'),
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
    /** How many bans each team gets; used by phases with `useStageCount`. */
    bans: z.number().int().min(0).max(10).default(0),
    /** How many protects each team gets; used by phases with `useStageCount`. */
    protects: z.number().int().min(0).max(10).default(0),
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

export const AUTOMATION_TRIGGERS = [
  'match_created',
  'beatmap_started',
  'beatmap_completed',
  'match_finished',
  'action_applied',
] as const;
export const AutomationTriggerSchema = z.enum(AUTOMATION_TRIGGERS);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;

/** One automatic chat message; empty strings are kept in the editor but not sent. */
export const AutomationMessageSchema = z.string().max(500);

export const AutomationMessagesSchema = z.object({
  match_created: z.array(AutomationMessageSchema).default([]),
  beatmap_started: z.array(AutomationMessageSchema).default([]),
  beatmap_completed: z.array(AutomationMessageSchema).default([]),
  match_finished: z.array(AutomationMessageSchema).default([]),
  action_applied: z.array(AutomationMessageSchema).default([]),
});
export type AutomationMessages = z.infer<typeof AutomationMessagesSchema>;

export function emptyAutomationMessages(): AutomationMessages {
  return {
    match_created: [],
    beatmap_started: [],
    beatmap_completed: [],
    match_finished: [],
    action_applied: [],
  };
}

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
    platform: PlatformSchema.default('stable'),
    mode: TournamentModeSchema.default('osu'),
    /** Expected players per team in an actual match; roster length is independent. */
    teamSize: z.number().int().min(1).max(16).default(4),
    teams: z.array(TeamSchema).default([]),
    stages: z.array(StageSchema).default([]),
    automation: AutomationMessagesSchema.default({}),
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
  tournament: Pick<Tournament, 'platform' | 'teams' | 'stages'>,
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

    if (stage.flow.phases.length === 0) {
      issues.push({ path: [...stagePath, 'flow', 'phases'], message: 'a match flow needs at least one phase' });
    }
    if (!stage.flow.phases.some((phase) => phase.action === 'pick')) {
      issues.push({ path: [...stagePath, 'flow', 'phases'], message: 'a match flow needs a pick phase' });
    }
    stage.flow.phases.forEach((phase, phaseIndex) => {
      if (phase.useStageCount && phase.action === 'ban' && stage.bans === 0) {
        issues.push({
          path: [...stagePath, 'flow', 'phases', phaseIndex, 'useStageCount'],
          message: 'this ban phase uses the stage count, but the stage allows no bans',
        });
      }
      if (phase.useStageCount && phase.action === 'protect' && stage.protects === 0) {
        issues.push({
          path: [...stagePath, 'flow', 'phases', phaseIndex, 'useStageCount'],
          message: 'this protect phase uses the stage count, but the stage allows no protects',
        });
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
      if (!isTeamModeAllowed(tournament.platform, match.roomMode)) {
        issues.push({
          path: [...matchPath, 'roomMode'],
          message: `team mode "${match.roomMode}" is not available on the ${tournament.platform} platform`,
        });
      }
      if (!isWinConditionAllowed(tournament.platform, match.winCondition)) {
        issues.push({
          path: [...matchPath, 'winCondition'],
          message: `win condition "${match.winCondition}" is not available on the ${tournament.platform} platform`,
        });
      }
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
            message: `match #${matchIndex + 1} references unknown team ${teamId}`,
          });
        }
        if (participantIds.has(teamId)) {
          issues.push({
            path: match.type === 'match' ? matchPath : [...matchPath, 'teamIds', teamIndex],
            message: `team ${teamId} appears more than once in match #${matchIndex + 1}`,
          });
        }
        participantIds.add(teamId);
      });
      if (match.groupId !== null) {
        const group = stage.groups.find((entry) => entry.id === match.groupId);
        if (group && participants.some((teamId) => !group.teamIds.includes(teamId))) {
          issues.push({
            path: [...matchPath, 'groupId'],
            message: `match #${matchIndex + 1} includes a team outside group "${group.name}"`,
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
  const platform: Platform = input.platform === 'lazer' ? 'lazer' : 'stable';
  const stages = Array.isArray(input.stages)
    ? input.stages.map((stage) => {
        if (!isRecord(stage)) return stage;
        const matches = Array.isArray(stage.matches)
          ? stage.matches.map((match) => {
              if (!isRecord(match)) return match;
              return {
                ...match,
                roomMode:
                  typeof match.roomMode === 'string'
                    ? normalizeRoomMode(platform, match.roomMode as MatchType)
                    : match.roomMode,
                winCondition:
                  typeof match.winCondition === 'string'
                    ? normalizeRoomWinCondition(
                        platform,
                        match.winCondition as RoomWinCondition,
                      )
                    : match.winCondition,
              };
            })
          : stage.matches;
        return { ...stage, matches };
      })
    : input.stages;
  return {
    ...input,
    platform,
    stages,
    automation: migrateAutomation(input.automation),
    abbreviation:
      typeof input.abbreviation === 'string'
        ? normalizeAbbreviation(input.abbreviation)
        : input.abbreviation,
  };
}
const LEGACY_TEMPLATE_KEYS: Record<string, string> = {
  team_one: 'team_red',
  team_two: 'team_blue',
  score_one: 'score_red',
  score_two: 'score_blue',
};

function normalizeAutomationMessage(template: string): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key: string) => {
    const mapped = LEGACY_TEMPLATE_KEYS[key] ?? key;
    return `{{${mapped}}}`;
  });
}

function migrateAutomation(input: unknown): AutomationMessages {
  const messages = emptyAutomationMessages();
  if (Array.isArray(input)) {
    for (const rule of input) {
      if (!isRecord(rule) || rule.enabled === false) continue;
      const trigger =
        typeof rule.trigger === 'string' &&
        (AUTOMATION_TRIGGERS as readonly string[]).includes(rule.trigger)
          ? (rule.trigger as AutomationTrigger)
          : null;
      if (!trigger) continue;
      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      for (const action of actions) {
        if (!isRecord(action)) continue;
        if (action.type === 'chat' && typeof action.template === 'string') {
          messages[trigger].push(normalizeAutomationMessage(action.template));
        } else if (action.type === 'notice' && typeof action.message === 'string') {
          messages[trigger].push(normalizeAutomationMessage(action.message));
        }
      }
    }
    return messages;
  }
  if (isRecord(input)) {
    for (const trigger of AUTOMATION_TRIGGERS) {
      const value = input[trigger];
      messages[trigger] = Array.isArray(value)
        ? value
            .filter((entry): entry is string => typeof entry === 'string')
            .map(normalizeAutomationMessage)
        : [];
    }
  }
  return messages;
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
    platform: 'stable',
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
        bans: 1,
        protects: 0,
        slots: [],
        flow: {
          id: 'flow_stage_1',
          name: 'Ban, pick',
          phases: [
            {
              id: 'phase_ban',
              action: 'ban',
              countPerTeam: 1,
              useStageCount: true,
              phaseOrder: 'alternate',
            },
            {
              id: 'phase_pick',
              action: 'pick',
              countPerTeam: null,
              useStageCount: false,
              phaseOrder: 'alternate',
            },
          ],
          triggers: [],
        },
        scoringScheme,
        matches: [],
      },
    ],
    automation: emptyAutomationMessages(),
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
/** Human label for a match row: no stored title, only participants. */
export function matchSessionName(
  tournament: Tournament,
  stage: Stage,
  match: Match,
): string {
  if (match.type === 'lobby') return `${stage.name} Lobby`;
  const red = findTeam(tournament, match.teamRedId)?.name ?? `Team ${match.teamRedId}`;
  const blue = findTeam(tournament, match.teamBlueId)?.name ?? `Team ${match.teamBlueId}`;
  return `${red} vs ${blue}`;
}

/** Room name generated from the tournament, stage and participants. */
export function buildRoomName(
  tournament: Tournament,
  stage: Stage,
  match: Match,
): string {
  if (match.type === 'lobby') {
    return `${tournament.abbreviation} ${stage.name} lobby`.slice(0, 160);
  }
  return `${tournament.abbreviation} ${matchSessionName(tournament, stage, match)}`.slice(0, 160);
}

/** Index of a match inside its stage, used for the displayed #number. */
export function matchIndex(stage: Stage, matchId: string): number {
  return stage.matches.findIndex((match) => match.id === matchId);
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