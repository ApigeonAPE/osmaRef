import { z } from 'zod';
import { BUILTIN_WIN_BY_RULE_ID } from './winby';
import {
  TournamentSchema,
  assignSlotLabels,
  createEmptyTournament,
  createTournamentId,
  emptyAutomationMessages,
  normalizeAbbreviation,
  slugify,
  type FlowPhase,
  type MappoolSlot,
  type Match,
  type MatchFlow,
  type Platform,
  type Stage,
  type RulesetId,
  type Team,
  type Tournament,
  type TournamentMode,
} from './tournament';

/**
 * Import for osu! tournament client brackets (`bracket.json`).
 *
 * The bracket file is a snapshot of a whole tournament tree: many teams, a
 * pool per round and every scheduled match. osmaRef stores the same data as a
 * versioned tournament configuration, so this converter only maps what the
 * internal format can express:
 *
 * - teams and their rosters,
 * - rounds with a mappool and a pick/ban flow derived from `BestOf`/`BanCount`,
 * - matches with their round, teams and scheduled time.
 *
 * Historical match results (scores, pick/ban history, bracket progression and
 * seeding) have no field in the configuration. Scores are kept as a note on
 * the match; the rest is dropped because the client recomputes it while
 * refereeing.
 */

/**
 * osu! tournament client bracket files are loosely typed: unfinished matches
 * have `null` team acronyms/scores, teams may omit a name, and pools can use
 * lower-case mod codes. Every optional field therefore accepts `null` too.
 */
const BracketPlayerSchema = z
  .object({
    id: z.number().int().nullish(),
    Username: z.string().nullish(),
  })
  .passthrough();

const BracketTeamSchema = z
  .object({
    FullName: z.string().nullish(),
    FlagName: z.string().nullish(),
    Acronym: z.string().nullish(),
    Seed: z.union([z.string(), z.number()]).nullish(),
    Players: z.array(BracketPlayerSchema).nullish(),
  })
  .passthrough();

const BracketBeatmapSchema = z
  .object({
    ID: z.number().int().nullish(),
    Mods: z.string().nullish(),
    BeatmapInfo: z
      .object({
        OnlineID: z.number().int().nullish(),
        Ruleset: z
          .object({
            OnlineID: z.number().int().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const BracketRoundSchema = z
  .object({
    Name: z.string().nullish(),
    Description: z.string().nullish(),
    BestOf: z.number().nullish(),
    BanCount: z.number().nullish(),
    Beatmaps: z.array(BracketBeatmapSchema).nullish(),
    StartDate: z.string().nullish(),
    Matches: z.array(z.number().int()).nullish(),
  })
  .passthrough();

const BracketPickBanSchema = z
  .object({
    Team: z.string().nullish(),
    Type: z.string().nullish(),
    BeatmapID: z.number().int().nullish(),
  })
  .passthrough();

const BracketMatchSchema = z
  .object({
    ID: z.number().int(),
    /** `null` while the bracket has not decided who plays this match yet. */
    Team1Acronym: z.string().nullish(),
    Team1Score: z.number().nullish(),
    Team2Acronym: z.string().nullish(),
    Team2Score: z.number().nullish(),
    Completed: z.boolean().nullish(),
    Losers: z.boolean().nullish(),
    Date: z.string().nullish(),
    PointsToWin: z.number().nullish(),
    PicksBans: z.array(BracketPickBanSchema).nullish(),
  })
  .passthrough();

/** The subset of `bracket.json` that the importer reads. */
export const BracketSchema = z
  .object({
    Ruleset: z
      .object({
        ShortName: z.string().nullish(),
        OnlineID: z.number().int().nullish(),
      })
      .passthrough()
      .nullish(),
    Teams: z.array(BracketTeamSchema).nullish(),
    PlayersPerTeam: z.number().int().nullish(),
    Rounds: z.array(BracketRoundSchema),
    Matches: z.array(BracketMatchSchema),
  })
  .passthrough();

export type BracketDocument = z.infer<typeof BracketSchema>;
type BracketRuleset = BracketDocument['Ruleset'];
type BracketBeatmap = z.infer<typeof BracketBeatmapSchema>;
type BracketMatch = z.infer<typeof BracketMatchSchema>;

export interface BracketConversionOptions {
  /** Tournament name; defaults to "Imported bracket". */
  name?: string;
  abbreviation?: string;
}

export interface BracketConversionResult {
  tournament: Tournament;
  /** Non-blocking conversion notes: adjusted values and skipped entries. */
  notes: string[];
}

const RULESET_MODES: Record<string, TournamentMode> = {
  osu: 'osu',
  standard: 'osu',
  taiko: 'taiko',
  catch: 'catch',
  fruits: 'catch',
  mania: 'mania',
};
const RULESET_ID_MODES: TournamentMode[] = ['osu', 'taiko', 'catch', 'mania'];
const MODE_RULESET: Record<Exclude<TournamentMode, 'multi' | 'osu'>, RulesetId> = {
  taiko: 1,
  catch: 2,
  mania: 3,
};

/**
 * Converts an osu! tournament client bracket into an osmaRef tournament.
 *
 * Throws when the input is not a bracket or when the converted document would
 * not satisfy the tournament schema, so a broken import never reaches storage.
 */
export function convertBracketToTournament(
  input: unknown,
  options: BracketConversionOptions = {},
): BracketConversionResult {
  const parsed = BracketSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`bracket.json is not an osu! tournament bracket:\n${formatIssues(parsed.error)}`);
  }
  const bracket = parsed.data;
  const notes: string[] = [];

  const name = (options.name ?? '').trim().slice(0, 120) || 'Imported bracket';
  const tournament = createEmptyTournament(name);
  tournament.id = createTournamentId();
  tournament.abbreviation =
    normalizeAbbreviation(options.abbreviation ?? name) || 'BRK';
  tournament.mode = resolveTournamentMode(bracket.Ruleset, notes);
  tournament.teamSize = normalizeTeamSize(bracket.PlayersPerTeam, notes);
  tournament.revision = 1;
  tournament.source = null;

  const teamLookup = new Map<string, number>();
  const teams: Team[] = [];
  (bracket.Teams ?? []).forEach((raw, index) => {
    const id = index;
    const acronym = (raw.Acronym ?? '').trim() || (raw.FlagName ?? '').trim();
    const displayName = (raw.FullName ?? '').trim() || acronym || `Team ${index + 1}`;
    const members: Team['members'] = [];
    const seenUserIds = new Set<number>();
    for (const player of raw.Players ?? []) {
      const userId = player.id;
      if (userId === undefined || userId === null || userId <= 0) {
        notes.push(`Team "${displayName}" has a player without a valid osu! id; that player was skipped.`);
        continue;
      }
      if (seenUserIds.has(userId)) {
        notes.push(`Team "${displayName}" lists user ${userId} twice; the duplicate was skipped.`);
        continue;
      }
      seenUserIds.add(userId);
      members.push({
        userId,
        username: (player.Username ?? '').slice(0, 64),
      });
    }
    const rawSeed = raw.Seed;
    const parsedSeed =
      rawSeed === null || rawSeed === undefined || rawSeed === '' ? Number.NaN : Number(rawSeed);
    teams.push({
      id,
      name: displayName.slice(0, 64),
      captainUserId: null,
      members,
      seed: Number.isInteger(parsedSeed) && parsedSeed >= 0 ? parsedSeed : null,
    });
    for (const alias of [raw.Acronym, raw.FlagName]) {
      const key = alias?.trim().toUpperCase();
      if (key && !teamLookup.has(key)) teamLookup.set(key, id);
    }
  });

  const usedStageIds = new Set<string>();
  const stages: Stage[] = [];
  const stageByMatchId = new Map<number, Stage>();
  const stageStartTimes = new Map<string, number>();
  (bracket.Rounds ?? []).forEach((raw, index) => {
    const stageName = ((raw.Name ?? '').trim() || `Stage ${index + 1}`).slice(0, 64);
    const id = uniqueId(`stage_${slugify(stageName) || index + 1}`, usedStageIds);
    const bestOf = normalizeBestOf(raw.BestOf ?? undefined, stageName, notes);
    const bans = normalizeBans(raw.BanCount ?? undefined, stageName, notes);
    const stage: Stage = {
      id,
      name: stageName,
      order: index,
      type: 'knockout',
      groups: [],
      bestOf,
      bans,
      protects: 0,
      winCondition: tournament.platform === 'lazer' ? 'score' : 'score_v2',
      winByRuleId: BUILTIN_WIN_BY_RULE_ID,
      slots: buildSlots(raw.Beatmaps ?? [], id, stageName, tournament.mode, tournament.platform, notes),
      flow: buildFlow(id, stageName, bans, notes),
      matches: [],
    };
    stages.push(stage);

    const start = raw.StartDate ? Date.parse(raw.StartDate) : Number.NaN;
    if (Number.isFinite(start)) stageStartTimes.set(id, start);
    for (const matchId of raw.Matches ?? []) {
      if (!stageByMatchId.has(matchId)) stageByMatchId.set(matchId, stage);
    }
  });

  const usedMatchIds = new Set<string>();
  /** Matches whose participants are still TBD (`null` acronyms). */
  const undecided: number[] = [];
  for (const raw of bracket.Matches) {
    const acronymOne = (raw.Team1Acronym ?? '').trim();
    const acronymTwo = (raw.Team2Acronym ?? '').trim();
    if (!acronymOne || !acronymTwo) {
      undecided.push(raw.ID);
      continue;
    }
    const teamOneId = lookupTeam(teamLookup, acronymOne);
    const teamTwoId = lookupTeam(teamLookup, acronymTwo);
    if (teamOneId === undefined || teamTwoId === undefined) {
      notes.push(
        `Bracket match #${raw.ID} references a team that is not in the bracket (${describeTeams(
          acronymOne,
          acronymTwo,
        )}); the match was skipped.`,
      );
      continue;
    }
    if (teamOneId === teamTwoId) {
      notes.push(`Bracket match #${raw.ID} uses the same team on both sides; the match was skipped.`);
      continue;
    }

    const hasValidDate = raw.Date && Number.isFinite(Date.parse(raw.Date));
    const scheduledAt = hasValidDate ? new Date(raw.Date!).toISOString() : new Date().toISOString();
    if (!hasValidDate) {
      notes.push(`Bracket match #${raw.ID} has no readable date; the import time was used.`);
    }

    let stage = stageByMatchId.get(raw.ID);
    if (!stage) {
      stage = stageForDate(scheduledAt, stages, stageStartTimes);
      if (stage) {
        notes.push(
          `Bracket match #${raw.ID} is not listed in a stage; it was assigned to "${stage.name}" by date.`,
        );
      }
    }
    if (!stage) {
      notes.push(`Bracket match #${raw.ID} has no stage to belong to; the match was skipped.`);
      continue;
    }

    const teamRed = teams.find((team) => team.id === teamOneId);
    const teamBlue = teams.find((team) => team.id === teamTwoId);
    if (!teamRed || !teamBlue) continue;

    stage.matches.push({
      id: uniqueId(`match_${raw.ID}`, usedMatchIds),
      type: 'match',
      groupId: null,
      teamRedId: teamOneId,
      teamBlueId: teamTwoId,
      refereeIds: [],
      scheduledAt,
      result: {
        scoreRed: Number.isInteger(raw.Team1Score) ? Math.max(0, raw.Team1Score!) : 0,
        scoreBlue: Number.isInteger(raw.Team2Score) ? Math.max(0, raw.Team2Score!) : 0,
      },
      roomMode: 'team_versus',
      notes: matchNote(raw).slice(0, 1000),
    });
  }

  if (undecided.length > 0) {
    const shown = undecided.slice(0, 12).join(', ');
    notes.push(
      `${undecided.length} bracket match(es) have undecided teams and were skipped: ${shown}${
        undecided.length > 12 ? ', …' : ''
      }.`,
    );
  }

  tournament.teams = teams;
  tournament.stages = stages;
  tournament.automation = emptyAutomationMessages();

  const validated = TournamentSchema.safeParse(tournament);
  if (!validated.success) {
    throw new Error(`converted bracket is not a valid tournament:\n${formatIssues(validated.error)}`);
  }
  return { tournament: validated.data, notes };
}

function resolveTournamentMode(
  ruleset: BracketRuleset,
  notes: string[],
): TournamentMode {
  const online = ruleset?.OnlineID;
  if (typeof online === 'number' && Number.isInteger(online) && online >= 0 && online <= 3) {
    return RULESET_ID_MODES[online]!;
  }
  const shortName = ruleset?.ShortName?.trim().toLowerCase();
  const byName = shortName ? RULESET_MODES[shortName] : undefined;
  if (byName !== undefined) return byName;
  notes.push('The bracket has no known ruleset; osu!standard was assumed.');
  return 'osu';
}

function normalizeTeamSize(value: number | null | undefined, notes: string[]): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return 4;
  const size = Math.min(16, Math.round(value));
  if (size !== value) {
    notes.push(`PlayersPerTeam ${value} was clamped to ${size}.`);
  }
  return size;
}

function normalizeBestOf(value: number | undefined, stageName: string, notes: string[]): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 9;
  let bestOf = Math.min(31, Math.max(1, raw));
  if (bestOf !== raw) {
    notes.push(
      `Stage "${stageName}" has best-of ${raw}; ${bestOf} is used because the format allows 1–31.`,
    );
  }
  if (bestOf % 2 === 0) {
    const adjusted = bestOf >= 31 ? 31 : bestOf + 1;
    notes.push(
      `Stage "${stageName}" has best-of ${bestOf}; ${adjusted} is used because a best-of must be odd.`,
    );
    bestOf = adjusted;
  }
  return bestOf;
}

function buildSlots(
  beatmaps: BracketBeatmap[],
  stageId: string,
  stageName: string,
  mode: TournamentMode,
  platform: Platform,
  notes: string[],
): MappoolSlot[] {
  const slots: MappoolSlot[] = [];
  const usedBeatmaps = new Set<number>();

  for (const raw of beatmaps) {
    const beatmapId = raw.BeatmapInfo?.OnlineID ?? raw.ID;
    if (beatmapId === undefined || beatmapId === null || beatmapId <= 0) {
      notes.push(`Stage "${stageName}" contains a beatmap without a valid id; it was skipped.`);
      continue;
    }
    if (usedBeatmaps.has(beatmapId)) {
      notes.push(`Stage "${stageName}" lists beatmap ${beatmapId} twice; the duplicate was skipped.`);
      continue;
    }

    const rawCode = (raw.Mods ?? '').trim().toUpperCase();
    const category = sanitizeCategory(rawCode);
    if (rawCode && category !== rawCode) {
      notes.push(
        `Stage "${stageName}" uses mod code "${rawCode}"; it was normalised to "${category}".`,
      );
    }
    usedBeatmaps.add(beatmapId);

    const slotRuleset = raw.BeatmapInfo?.Ruleset?.OnlineID;
    slots.push({
      id: '',
      label: '',
      category,
      beatmapId,
      beatmap: null,
      rulesetId:
        typeof slotRuleset === 'number' && slotRuleset >= 0 && slotRuleset <= 3
          ? (slotRuleset as RulesetId)
          : mode === 'multi' || mode === 'osu'
            ? null
            : MODE_RULESET[mode],
      ...modsForCategory(category, platform),
    });
  }

  // Labels come from categories: 1..n per category, a lone beatmap keeps the
  // bare category (`TB`, not `TB1`). Ids follow the final label.
  assignSlotLabels(slots);
  const usedIds = new Set<string>();
  for (const slot of slots) {
    slot.id = uniqueId(`${stageId}_${slot.label.toLowerCase()}`, usedIds);
  }
  return slots;
}

function normalizeBans(banCount: number | undefined, stageName: string, notes: string[]): number {
  const requested = Math.round(banCount ?? 0);
  const bans = Math.min(10, Math.max(0, requested));
  if (bans !== requested) {
    notes.push(
      `Stage "${stageName}" has ${requested} bans per team; the stage count is capped to ${bans}.`,
    );
  }
  return bans;
}

function buildFlow(
  stageId: string,
  stageName: string,
  bans: number,
  notes: string[],
): MatchFlow {
  const phases: FlowPhase[] = [];
  if (bans > 0) {
    phases.push({
      id: `phase_ban_${stageId}`,
      action: 'ban',
      countPerTeam: 1,
      useStageCount: true,
      phaseOrder: 'alternate',
    });
  }
  phases.push({
    id: `phase_pick_${stageId}`,
    action: 'pick',
    countPerTeam: null,
    useStageCount: false,
    phaseOrder: 'alternate',
  });
  return { id: `flow_${stageId}`, name: `${stageName} flow`.slice(0, 64), phases, triggers: [] };
}

function stageForDate(
  scheduledAt: string,
  stages: Stage[],
  startTimes: Map<string, number>,
): Stage | undefined {
  const at = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  if (!Number.isFinite(at)) return stages[0];
  let chosen: Stage | undefined;
  let chosenStart = Number.NEGATIVE_INFINITY;
  for (const stage of stages) {
    const start = startTimes.get(stage.id);
    if (start === undefined || start > at) continue;
    if (!chosen || start >= chosenStart) {
      chosen = stage;
      chosenStart = start;
    }
  }
  return chosen ?? stages[0];
}

function matchNote(match: BracketMatch): string {
  const parts = [`osu! bracket match #${match.ID}`];
  const one = match.Team1Score;
  const two = match.Team2Score;
  if (typeof one === 'number' && typeof two === 'number' && (one > 0 || two > 0)) {
    parts.push(`score ${one}-${two}`);
  }
  if (match.Completed) parts.push('completed');
  parts.push(match.Losers ? 'losers bracket' : 'winners bracket');
  return parts.join(', ');
}

function describeTeams(teamOne: string | null | undefined, teamTwo: string | null | undefined): string {
  return [teamOne, teamTwo]
    .map((value) => (value ?? '').trim() || '(empty)')
    .join(' vs ');
}

function lookupTeam(
  lookup: Map<string, number>,
  acronym: string | null | undefined,
): number | undefined {
  const key = acronym?.trim().toUpperCase();
  return key ? lookup.get(key) : undefined;
}

function modsForCategory(category: string, platform: Platform): {
  requiredMods: string[];
  allowedMods: string[];
  freestyle: boolean;
  freemod: boolean;
} {
  switch (category) {
    case 'HD':
      return { requiredMods: ['HD'], allowedMods: [], freestyle: false, freemod: false };
    case 'HR':
      return { requiredMods: ['HR'], allowedMods: [], freestyle: false, freemod: false };
    case 'DT':
      return { requiredMods: ['DT'], allowedMods: [], freestyle: false, freemod: false };
    case 'FM':
      return platform === 'stable'
        ? { requiredMods: [], allowedMods: [], freestyle: false, freemod: true }
        : { requiredMods: [], allowedMods: [], freestyle: true, freemod: false };
    default:
      return { requiredMods: [], allowedMods: [], freestyle: false, freemod: false };
  }
}

/**
 * Short pool code that can prefix a slot label.
 *
 * Key-count codes such as `4K`/`7K` are preserved: stripping the digit would
 * merge different key modes into one `K` pool.
 */
function sanitizeCategory(raw: string): string {
  const cleaned = raw.replace(/[^A-Z0-9]/g, '').slice(0, 4);
  return /[A-Z]/.test(cleaned) ? cleaned : 'NM';
}

function uniqueId(base: string, used: Set<string>): string {
  const safe = (base || 'item').slice(0, 120);
  let candidate = safe;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${safe}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
