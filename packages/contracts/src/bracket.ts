import { z } from 'zod';
import {
  TournamentSchema,
  createEmptyTournament,
  createTournamentId,
  normalizeAbbreviation,
  slugify,
  type FlowStep,
  type MappoolSlot,
  type Match,
  type MatchFlow,
  type Round,
  type RulesetId,
  type Team,
  type Tournament,
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

const RULESET_NAMES: Record<string, RulesetId> = {
  osu: 0,
  standard: 0,
  taiko: 1,
  catch: 2,
  fruits: 2,
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
  tournament.rulesetId = resolveRulesetId(bracket.Ruleset, notes);
  tournament.defaultMatchType = 'team_versus';
  tournament.revision = 1;
  tournament.source = null;

  const teamLookup = new Map<string, string>();
  const usedTeamIds = new Set<string>();
  const teams: Team[] = [];
  (bracket.Teams ?? []).forEach((raw, index) => {
    const acronym = (raw.Acronym ?? '').trim() || (raw.FlagName ?? '').trim();
    const displayName = (raw.FullName ?? '').trim() || acronym || `Team ${index + 1}`;
    const acronymSlug = slugify(acronym);
    const baseId = acronymSlug ? `team_${acronymSlug}` : `team_${index + 1}`;
    const id = uniqueId(baseId, usedTeamIds);
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
        captain: false,
      });
    }
    teams.push({ id, name: displayName.slice(0, 64), members });
    for (const alias of [raw.Acronym, raw.FlagName]) {
      const key = alias?.trim().toUpperCase();
      if (key && !teamLookup.has(key)) teamLookup.set(key, id);
    }
  });

  const usedRoundIds = new Set<string>();
  const rounds: Round[] = [];
  const roundByMatchId = new Map<number, Round>();
  const roundStartTimes = new Map<string, number>();
  (bracket.Rounds ?? []).forEach((raw, index) => {
    const roundName = ((raw.Name ?? '').trim() || `Round ${index + 1}`).slice(0, 64);
    const id = uniqueId(`round_${slugify(roundName) || index + 1}`, usedRoundIds);
    const bestOf = normalizeBestOf(raw.BestOf ?? undefined, roundName, notes);
    const round: Round = {
      id,
      name: roundName,
      order: index,
      bestOf,
      slots: buildSlots(raw.Beatmaps ?? [], id, roundName, tournament.rulesetId, notes),
      flow: buildFlow(id, roundName, bestOf, raw.BanCount ?? undefined, notes),
    };
    rounds.push(round);

    const start = raw.StartDate ? Date.parse(raw.StartDate) : Number.NaN;
    if (Number.isFinite(start)) roundStartTimes.set(id, start);
    for (const matchId of raw.Matches ?? []) {
      if (!roundByMatchId.has(matchId)) roundByMatchId.set(matchId, round);
    }
  });

  const usedMatchIds = new Set<string>();
  const matches: Match[] = [];
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
    if (!teamOneId || !teamTwoId) {
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

    const scheduledAt =
      raw.Date && Number.isFinite(Date.parse(raw.Date))
        ? new Date(raw.Date).toISOString()
        : null;
    if (raw.Date && scheduledAt === null) {
      notes.push(`Bracket match #${raw.ID} has an unreadable date; its schedule was cleared.`);
    }

    let round = roundByMatchId.get(raw.ID);
    if (!round) {
      round = roundForDate(scheduledAt, rounds, roundStartTimes);
      if (round) {
        notes.push(
          `Bracket match #${raw.ID} is not listed in a round; it was assigned to "${round.name}" by date.`,
        );
      }
    }
    if (!round) {
      notes.push(`Bracket match #${raw.ID} has no round to belong to; the match was skipped.`);
      continue;
    }

    const teamOne = teams.find((team) => team.id === teamOneId);
    const teamTwo = teams.find((team) => team.id === teamTwoId);
    if (!teamOne || !teamTwo) continue;

    const initialBeatmapId = firstPickedBeatmap(raw, round);
    matches.push({
      id: uniqueId(`match_${raw.ID}`, usedMatchIds),
      name: `${teamOne.name} vs ${teamTwo.name}`.slice(0, 128),
      roundId: round.id,
      teamOneId,
      teamTwoId,
      refereeIds: [],
      transport: 'irc',
      scoringId: 'score_default',
      roomNameTemplate: '{tournament}: ({team_one}) vs ({team_two})',
      initialBeatmapId,
      scheduledAt,
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
  tournament.rounds = rounds;
  tournament.scoringSchemes = [
    {
      id: 'score_default',
      name: 'Score V2',
      winCondition: 'score_v2',
      aggregation: 'sum',
      modMultipliers: {},
    },
  ];
  tournament.matches = matches;
  tournament.automation = [];

  const validated = TournamentSchema.safeParse(tournament);
  if (!validated.success) {
    throw new Error(`converted bracket is not a valid tournament:\n${formatIssues(validated.error)}`);
  }
  return { tournament: validated.data, notes };
}

function resolveRulesetId(
  ruleset: BracketRuleset,
  notes: string[],
): RulesetId {
  const online = ruleset?.OnlineID;
  if (typeof online === 'number' && Number.isInteger(online) && online >= 0 && online <= 3) {
    return online as RulesetId;
  }
  const shortName = ruleset?.ShortName?.trim().toLowerCase();
  const byName = shortName ? RULESET_NAMES[shortName] : undefined;
  if (byName !== undefined) return byName;
  notes.push('The bracket has no known ruleset; osu!standard was assumed.');
  return 0;
}

function normalizeBestOf(value: number | undefined, roundName: string, notes: string[]): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 9;
  let bestOf = Math.min(31, Math.max(1, raw));
  if (bestOf !== raw) {
    notes.push(
      `Round "${roundName}" has best-of ${raw}; ${bestOf} is used because the format allows 1–31.`,
    );
  }
  if (bestOf % 2 === 0) {
    const adjusted = bestOf >= 31 ? 31 : bestOf + 1;
    notes.push(
      `Round "${roundName}" has best-of ${bestOf}; ${adjusted} is used because a best-of must be odd.`,
    );
    bestOf = adjusted;
  }
  return bestOf;
}

function buildSlots(
  beatmaps: BracketBeatmap[],
  roundId: string,
  roundName: string,
  rulesetId: RulesetId,
  notes: string[],
): MappoolSlot[] {
  const slots: MappoolSlot[] = [];
  const usedLabels = new Set<string>();
  const usedBeatmaps = new Set<number>();
  const labelCounts = new Map<string, number>();

  for (const raw of beatmaps) {
    const beatmapId = raw.BeatmapInfo?.OnlineID ?? raw.ID;
    if (beatmapId === undefined || beatmapId === null || beatmapId <= 0) {
      notes.push(`Round "${roundName}" contains a beatmap without a valid id; it was skipped.`);
      continue;
    }
    if (usedBeatmaps.has(beatmapId)) {
      notes.push(`Round "${roundName}" lists beatmap ${beatmapId} twice; the duplicate was skipped.`);
      continue;
    }

    const rawCode = (raw.Mods ?? '').trim().toUpperCase();
    const code = rawCode === 'TB' ? 'TB' : sanitizeCategory(rawCode);
    if (rawCode && rawCode !== 'TB' && code !== rawCode) {
      notes.push(
        `Round "${roundName}" uses mod code "${rawCode}"; it was normalised to "${code}".`,
      );
    }
    let label: string;
    let category: string;

    if (code === 'TB') {
      label = 'TB';
      category = 'TB';
    } else {
      const next = (labelCounts.get(code) ?? 0) + 1;
      const limit = 99;
      if (next > limit) {
        notes.push(
          `Round "${roundName}" has more than ${limit} "${code}" beatmaps; the extras were skipped.`,
        );
        continue;
      }
      labelCounts.set(code, next);
      label = `${code}${next}`;
      category = code;
    }

    const normalizedLabel = label.toUpperCase();
    if (usedLabels.has(normalizedLabel)) {
      notes.push(
        `Round "${roundName}" would have produced the duplicate slot label "${label}"; the beatmap was skipped.`,
      );
      continue;
    }
    usedLabels.add(normalizedLabel);
    usedBeatmaps.add(beatmapId);

    const slotRuleset = raw.BeatmapInfo?.Ruleset?.OnlineID;
    slots.push({
      id: `${roundId}_${label.toLowerCase()}`,
      label,
      category,
      beatmapId,
      rulesetId:
        typeof slotRuleset === 'number' && slotRuleset >= 0 && slotRuleset <= 3
          ? (slotRuleset as RulesetId)
          : rulesetId,
      ...modsForCategory(category),
      winCondition: null,
      winConditionWinner: null,
    });
  }
  return slots;
}

function buildFlow(
  roundId: string,
  roundName: string,
  bestOf: number,
  banCount: number | undefined,
  notes: string[],
): MatchFlow {
  const steps: FlowStep[] = [];
  const requestedBans = Math.round(banCount ?? 0);
  const bans = Math.min(10, Math.max(0, requestedBans));
  if (bans !== requestedBans) {
    notes.push(
      `Round "${roundName}" has ${requestedBans} bans per team; the flow step is capped to ${bans}.`,
    );
  }
  if (bans > 0) {
    steps.push({ id: `step_ban_${roundId}`, kind: 'ban', count: bans, side: 'both' });
  }
  const picksNeeded = Math.ceil(bestOf / 2);
  const picks = Math.min(10, Math.max(1, picksNeeded));
  if (picks !== picksNeeded) {
    notes.push(
      `Round "${roundName}" needs ${picksNeeded} picks per team; the flow step is capped at 10.`,
    );
  }
  steps.push({ id: `step_pick_${roundId}`, kind: 'pick', count: picks, side: 'both' });
  return { id: `flow_${roundId}`, name: `${roundName} flow`.slice(0, 64), steps, triggers: [] };
}

function roundForDate(
  scheduledAt: string | null,
  rounds: Round[],
  startTimes: Map<string, number>,
): Round | undefined {
  const at = scheduledAt ? Date.parse(scheduledAt) : Number.NaN;
  if (!Number.isFinite(at)) return rounds[0];
  let chosen: Round | undefined;
  let chosenStart = Number.NEGATIVE_INFINITY;
  for (const round of rounds) {
    const start = startTimes.get(round.id);
    if (start === undefined || start > at) continue;
    if (!chosen || start >= chosenStart) {
      chosen = round;
      chosenStart = start;
    }
  }
  return chosen ?? rounds[0];
}

function firstPickedBeatmap(match: BracketMatch, round: Round): number | null {
  const pool = new Set(round.slots.map((slot) => slot.beatmapId));
  for (const entry of match.PicksBans ?? []) {
    if ((entry.Type ?? '').toLowerCase() !== 'pick') continue;
    if (typeof entry.BeatmapID === 'number' && pool.has(entry.BeatmapID)) {
      return entry.BeatmapID;
    }
  }
  return round.slots[0]?.beatmapId ?? null;
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
  return parts.join(' · ');
}

function describeTeams(teamOne: string | null | undefined, teamTwo: string | null | undefined): string {
  return [teamOne, teamTwo]
    .map((value) => (value ?? '').trim() || '(empty)')
    .join(' vs ');
}

function lookupTeam(lookup: Map<string, string>, acronym: string | null | undefined): string | undefined {
  const key = acronym?.trim().toUpperCase();
  return key ? lookup.get(key) : undefined;
}

function modsForCategory(category: string): {
  requiredMods: string[];
  allowedMods: string[];
  freestyle: boolean;
} {
  switch (category) {
    case 'HD':
      return { requiredMods: ['HD'], allowedMods: [], freestyle: false };
    case 'HR':
      return { requiredMods: ['HR'], allowedMods: [], freestyle: false };
    case 'DT':
      return { requiredMods: ['DT'], allowedMods: [], freestyle: false };
    case 'FM':
      return { requiredMods: [], allowedMods: [], freestyle: true };
    default:
      return { requiredMods: [], allowedMods: [], freestyle: false };
  }
}

/** Short letter-only pool code that can prefix a slot label such as `HB2`. */
function sanitizeCategory(raw: string): string {
  const cleaned = raw.replace(/[^A-Z]/g, '').slice(0, 4);
  return cleaned || 'NM';
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
