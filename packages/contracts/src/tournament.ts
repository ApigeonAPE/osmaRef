import { z } from 'zod';
import { BUILTIN_WIN_BY_RULE_ID } from './winby';

/**
 * Versioned tournament configuration.
 *
 * Apart from explicitly imported Win-by rules, the configuration is
 * declarative: every other rule (messaging, flows) is data that the domain
 * layer interprets.
 *
 * v5 moves the room win condition to the stage and replaces the internal
 * scoring scheme with a Win-by rule id. v4 owned the platform at the
 * tournament root, stored phase-based match flows and stage ban/protect
 * counts, and kept match IDs independent of their displayed order.
 */

export const TOURNAMENT_SCHEMA_VERSION = 6 as const;

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
  /** lazer has no room win condition; the stage value is ignored. */
  lazer: [],
};

export function isTeamModeAllowed(platform: Platform, mode: MatchType): boolean {
  return PLATFORM_TEAM_MODES[platform].includes(mode);
}

export function normalizeRoomMode(platform: Platform, mode: MatchType): MatchType {
  if (isTeamModeAllowed(platform, mode)) return mode;
  return platform === 'stable' ? 'team_versus' : 'team_versus';
}

export const TransportKindSchema = z.enum(['irc', 'referee_hub']);
export type TransportKind = z.infer<typeof TransportKindSchema>;

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

export const MappoolBeatmapInfoSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().default(''),
  artist: z.string().default(''),
  mapper: z.string().default(''),
  difficultyName: z.string().default(''),
  beatmapsetId: z.number().int().positive().nullable().default(null),
  beatmapUrl: z.string().max(500).default(''),
  coverUrl: z.string().max(500).default(''),
});
export type MappoolBeatmapInfo = z.infer<typeof MappoolBeatmapInfoSchema>;

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
  /** Snapshot of the beatmap metadata resolved when the id was edited. */
  beatmap: MappoolBeatmapInfoSchema.nullable().default(null),
  /** null selects the beatmap's native ruleset; otherwise this may request conversion. */
  rulesetId: RulesetOverrideSchema,
  requiredMods: z.array(z.string().min(1).max(16)).default([]),
  allowedMods: z.array(z.string().min(1).max(16)).default([]),
  /** Lazer-only: players may pick any mod and adjust difficulty. */
  freestyle: z.boolean().default(false),
  /** Stable-only: `!mp mods Freemod`; Bancho filters out conflicting mods. */
  freemod: z.boolean().default(false),
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

const MatchBaseSchema = z.object({
  id: IdSchema,
  /** Optional group membership for group-stage fixtures. */
  groupId: IdSchema.nullable().default(null),
  refereeIds: z.array(z.number().int().positive()).default([]),
  /** Required UTC timestamp. New matches are initialized to now. */
  scheduledAt: UtcTimestampSchema,
  /** Lobby retains a zero result for shape consistency but does not use it. */
  result: MatchResultSchema.default({ scoreRed: 0, scoreBlue: 0 }),
  notes: z.string().max(1000).optional(),
});

export const MatchSchema = z.discriminatedUnion('type', [
  MatchBaseSchema.extend({
    type: z.literal('lobby'),
    teamIds: z.array(TeamIdSchema).min(1),
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
    /** Room win condition applied when this stage creates a stable room. */
    winCondition: RoomWinConditionSchema.default('score'),
    /** Global Win-by rule used to decide each beatmap. */
    winByRuleId: z.string().min(1).max(128).default(BUILTIN_WIN_BY_RULE_ID),
    slots: z.array(MappoolSlotSchema).default([]),
    flow: MatchFlowSchema,
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

/**
 * One action a trigger runs. Chat is the only kind for now; additional kinds
 * (webhook, ...) extend this union without changing the trigger map.
 */
export const AutomationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chat'),
    template: AutomationMessageSchema,
  }),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;

export const AutomationMessagesSchema = z.object({
  match_created: z.array(AutomationActionSchema).default([]),
  beatmap_started: z.array(AutomationActionSchema).default([]),
  beatmap_completed: z.array(AutomationActionSchema).default([]),
  match_finished: z.array(AutomationActionSchema).default([]),
  action_applied: z.array(AutomationActionSchema).default([]),
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

/**
 * One webhook target. Discord is the only kind for now; other kinds (generic
 * HTTP, Slack, ...) extend this union without touching tournaments.
 */
export const WebhookSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('discord'),
    name: z.string().min(1).max(100),
    url: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((value) => value.startsWith('https://'), {
        message: 'discord webhook urls must use https',
      }),
    triggers: z.array(AutomationTriggerSchema).default([]),
  }),
]);
export type Webhook = z.infer<typeof WebhookSchema>;

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
    webhooks: z.array(WebhookSchema).default([]),
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
      if (label) {
        if (labels.has(label)) {
          issues.push({
            path: [...slotPath, 'label'],
            message: `duplicate slot label "${slot.label}" in stage "${stage.name}"`,
          });
        }
        labels.add(label);
      } else {
        issues.push({ path: [...slotPath, 'label'], message: 'slot label is empty' });
      }
      if (!slot.category.trim()) {
        issues.push({ path: [...slotPath, 'category'], message: 'slot category is empty' });
      }
      if (Number.isInteger(slot.beatmapId) && slot.beatmapId > 0) {
        if (beatmaps.has(slot.beatmapId)) {
          issues.push({
            path: [...slotPath, 'beatmapId'],
            message: `beatmap ${slot.beatmapId} appears twice in stage "${stage.name}"`,
          });
        }
        beatmaps.add(slot.beatmapId);
      } else {
        issues.push({
          path: [...slotPath, 'beatmapId'],
          message: 'beatmap id must be a positive number',
        });
      }
      if (slot.freestyle && slot.allowedMods.length > 0) {
        issues.push({
          path: [...slotPath, 'allowedMods'],
          message: 'freestyle slots cannot also declare allowed mods',
        });
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

/** Trailing digits of a slot label, i.e. the sequence in `HB2`; `TB` yields an empty string. */
export function slotLabelSequence(label: string): string {
  return label.match(/(\d+)$/)?.[1] ?? '';
}

/** Build a slot label from its category and sequence number. */
export function composeSlotLabel(category: string, sequence: string): string {
  return `${category}${sequence}`;
}

/**
 * Rebuilds every label from its category in list order: `1..n` per category,
 * except a category that holds a single beatmap, which drops the number so
 * `TB` stays `TB` instead of becoming `TB1`. Referees only type the category.
 */
export function assignSlotLabels(slots: MappoolSlot[]): void {
  const totals = new Map<string, number>();
  for (const slot of slots) {
    const category = slot.category.trim().toUpperCase();
    totals.set(category, (totals.get(category) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const slot of slots) {
    const category = slot.category.trim().toUpperCase();
    const index = (seen.get(category) ?? 0) + 1;
    seen.set(category, index);
    if (!category) {
      slot.label = '';
      continue;
    }
    slot.label = totals.get(category) === 1 ? category : `${category}${index}`;
  }
}


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
  if (input.schemaVersion !== 4 && input.schemaVersion !== TOURNAMENT_SCHEMA_VERSION) {
    return input;
  }
  const version = input.schemaVersion;
  const platform: Platform = input.platform === 'lazer' ? 'lazer' : 'stable';
  const stages = Array.isArray(input.stages)
    ? input.stages.map((stage) => {
        if (!isRecord(stage)) return stage;
        const legacyMatches = Array.isArray(stage.matches) ? stage.matches : [];
        const firstMatch = legacyMatches.find(isRecord);
        const legacyCondition =
          version === 4 && firstMatch && typeof firstMatch.winCondition === 'string'
            ? (firstMatch.winCondition as RoomWinCondition)
            : null;
        const rawCondition =
          typeof stage.winCondition === 'string'
            ? stage.winCondition
            : legacyCondition;
        const parsedCondition = RoomWinConditionSchema.safeParse(rawCondition);
        const winCondition = parsedCondition.success ? parsedCondition.data : 'score';
        const nextStage: Record<string, unknown> = { ...stage };
        delete nextStage.scoringScheme;
        nextStage.winCondition = winCondition;
        nextStage.winByRuleId =
          typeof stage.winByRuleId === 'string' && stage.winByRuleId.length > 0
            ? stage.winByRuleId
            : BUILTIN_WIN_BY_RULE_ID;
        nextStage.slots = Array.isArray(stage.slots)
          ? stage.slots.map((slot) => {
              if (!isRecord(slot)) return slot;
              const nextSlot = { ...slot };
              delete nextSlot.winCondition;
              delete nextSlot.winConditionWinner;
              if (platform === 'stable' && nextSlot.freestyle === true && nextSlot.freemod === undefined) {
                nextSlot.freemod = true;
                nextSlot.freestyle = false;
              }
              return nextSlot;
            })
          : stage.slots;
        nextStage.matches = Array.isArray(stage.matches)
          ? stage.matches.map((match) => {
              if (!isRecord(match)) return match;
              const nextMatch = { ...match };
              delete nextMatch.winCondition;
              return {
                ...nextMatch,
                roomMode:
                  typeof match.roomMode === 'string'
                    ? normalizeRoomMode(platform, match.roomMode as MatchType)
                    : match.roomMode,
              };
            })
          : stage.matches;
        return nextStage;
      })
    : input.stages;
  return {
    ...input,
    schemaVersion: TOURNAMENT_SCHEMA_VERSION,
    platform,
    stages,
    automation: input.automation,
    abbreviation:
      typeof input.abbreviation === 'string'
        ? normalizeAbbreviation(input.abbreviation)
        : input.abbreviation,
  };
}
export function createEmptyTournament(name: string, now = new Date()): Tournament {
  const timestamp = now.toISOString();
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
        winCondition: 'score_v2',
        winByRuleId: BUILTIN_WIN_BY_RULE_ID,
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
        matches: [],
      },
    ],
    automation: emptyAutomationMessages(),
    webhooks: [],
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

export function findStage(tournament: Tournament, stageId: string): Stage | undefined {
  return tournament.stages.find((stage) => stage.id === stageId);
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
    const index = stage.matches.indexOf(match) + 1;
    return `${tournament.abbreviation}: (Lobby) vs (#${Math.max(1, index)})`.slice(0, 160);
  }
  const red = findTeam(tournament, match.teamRedId)?.name ?? `Team ${match.teamRedId}`;
  const blue = findTeam(tournament, match.teamBlueId)?.name ?? `Team ${match.teamBlueId}`;
  return `${tournament.abbreviation}: (${red}) vs (${blue})`.slice(0, 160);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}