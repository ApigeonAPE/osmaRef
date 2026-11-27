import { z } from 'zod';
import { BUILTIN_WIN_BY_RULE_ID } from './winby';
import {
  assignSlotLabels,
  createEmptyTournament,
  normalizeAbbreviation,
  slugify,
  type Match,
  type MatchFlow,
  type MappoolSlot,
  type Platform,
  type RulesetId,
  type Stage,
  type Team,
  type Tournament,
  type TournamentMode,
} from './tournament';

/**
 * Import for Mayumi tournaments.
 *
 * Mayumi is a tournament management site: the public API serves the roster,
 * the schedule, the published mappools and the public draw without a session.
 * `convertMayumiToTournament` is a pure function over a snapshot of those
 * responses, so it can be tested without network access.
 *
 * Only what osmaRef can express is mapped: teams, knockout stages with a pool
 * and a pick/ban flow, and matches with their teams, scores and time. Bracket
 * structure, seeding, warmups and statistics are dropped.
 */

const UidSchema = z.number().int();

const SimpleInfoSchema = z
  .object({
    id: z.string().nullish(),
    uid: z.array(UidSchema).nullish(),
    name: z.string().nullish(),
    avatar_url: z.string().nullish(),
  })
  .passthrough();

export const MayumiPlayerSchema = z
  .object({
    uid: UidSchema,
    name: z.string(),
    /** False for staff who are stored in the same list. */
    player: z.boolean().nullish(),
  })
  .passthrough();
export type MayumiPlayer = z.infer<typeof MayumiPlayerSchema>;

export const MayumiGroupSchema = z
  .object({
    name: z.string(),
    members: z.array(UidSchema).nullish(),
    captains: z.array(UidSchema).nullish(),
  })
  .passthrough();
export type MayumiGroup = z.infer<typeof MayumiGroupSchema>;

export const MayumiTournamentInfoSchema = z
  .object({
    name: z.string(),
    abbreviation: z.string().nullish(),
    mode: z.string().nullish(),
    is_group: z.boolean().nullish(),
    status: z.string().nullish(),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
  })
  .passthrough();
export type MayumiTournamentInfo = z.infer<typeof MayumiTournamentInfoSchema>;

export const MayumiMatchInfoSchema = z
  .object({
    match_id: z.string(),
    datetime: z.string().nullish(),
    team1: SimpleInfoSchema.nullish(),
    team2: SimpleInfoSchema.nullish(),
    team1_score: z.number().nullish(),
    team2_score: z.number().nullish(),
    is_winner_bracket: z.boolean().nullish(),
  })
  .passthrough();

export const MayumiLobbyInfoSchema = z
  .object({
    lobby_name: z.string().nullish(),
    match_id: z.string(),
    datetime: z.string().nullish(),
    match_url: z.array(z.string().nullable()).nullish(),
    participants: z.array(SimpleInfoSchema).nullish(),
  })
  .passthrough();

export const MayumiScheduleStageSchema = z
  .object({
    stage_name: z.string(),
    is_lobby: z.boolean().nullish(),
    lobby_info: z.array(MayumiLobbyInfoSchema).nullish(),
    match_info: z.array(MayumiMatchInfoSchema).nullish(),
  })
  .passthrough();
export type MayumiScheduleStage = z.infer<typeof MayumiScheduleStageSchema>;

export const MayumiRoundInfoSchema = z
  .object({
    stage_name: z.string(),
    is_lobby: z.boolean().nullish(),
    is_solo_qualifier: z.boolean().nullish(),
    start_time: z.string().nullish(),
    end_time: z.string().nullish(),
  })
  .passthrough();
export type MayumiRoundInfo = z.infer<typeof MayumiRoundInfoSchema>;

export const MayumiMapSchema = z
  .object({
    map_id: z.number().int(),
    map_name: z.string().nullish(),
    mapper: z.string().nullish(),
    diff_name: z.string().nullish(),
    mode: z.string().nullish(),
    /** Free-form pool code: NM, HD, TB, RC, O!M4K, ... */
    mod: z.string().nullish(),
    number: z.number().nullish(),
    metadata_pending: z.boolean().nullish(),
  })
  .passthrough();

export const MayumiPoolStageSchema = z
  .object({
    stage_name: z.string(),
    mod_bracket: z.array(
      z
        .object({
          mod: z.string().nullish(),
          maps: z.array(MayumiMapSchema).nullish(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export type MayumiPoolStage = z.infer<typeof MayumiPoolStageSchema>;

export const MayumiDrawMatchSchema = z
  .object({
    id: z.string(),
    round_id: z.string(),
    teams: z.array(z.string().nullable()).nullish(),
    scores: z.array(z.number()).nullish(),
    status: z.string().nullish(),
    datetime: z.string().nullish(),
  })
  .passthrough();

export const MayumiDrawSchema = z
  .object({
    state: z
      .object({
        format: z.string().nullish(),
        entrants: z.array(SimpleInfoSchema).nullish(),
        rounds: z
          .array(
            z
              .object({
                id: z.string(),
                name: z.string().nullish(),
                bracket: z.string().nullish(),
                best_of: z.number().nullish(),
                stage_name: z.string().nullish(),
              })
              .passthrough(),
          )
          .nullish(),
        matches: z.array(MayumiDrawMatchSchema).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type MayumiDraw = z.infer<typeof MayumiDrawSchema>;

export const MayumiBracketConfigSchema = z
  .object({
    revision: z.number().nullish(),
    settings: z
      .object({
        rounds: z
          .record(
            z
              .object({
                bestOf: z.number().nullish(),
                banCount: z.number().nullish(),
              })
              .passthrough(),
          )
          .nullish(),
        acronyms: z.record(z.string()).nullish(),
        flagNames: z.record(z.string()).nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();
export type MayumiBracketConfig = z.infer<typeof MayumiBracketConfigSchema>;

export const MayumiPlayersResponseSchema = z
  .object({
    groups: z.array(MayumiGroupSchema).nullish(),
    players: z.array(MayumiPlayerSchema).nullish(),
  })
  .passthrough();

export interface MayumiSnapshot {
  info: MayumiTournamentInfo;
  players: z.infer<typeof MayumiPlayersResponseSchema> | null;
  schedule: MayumiScheduleStage[] | null;
  mapPools: MayumiPoolStage[] | null;
  roundInfo: MayumiRoundInfo[] | null;
  draw: MayumiDraw['state'] | null;
  bracket: MayumiBracketConfig | null;
}

export interface MayumiConversionOptions {
  platform: Platform;
  /** Used for matches without a readable date. */
  now?: Date;
}

export interface MayumiConversionResult {
  tournament: Tournament;
  notes: string[];
}

const MODE_RULESET: Record<Exclude<TournamentMode, 'multi' | 'osu'>, RulesetId> = {
  taiko: 1,
  catch: 2,
  mania: 3,
};

/** Mayumi modes are osu!/taiko/fruits/mania/all. */
export function mayumiMode(mode: string | null | undefined): TournamentMode {
  switch ((mode ?? '').trim().toLowerCase()) {
    case 'taiko':
      return 'taiko';
    case 'fruits':
    case 'catch':
      return 'catch';
    case 'mania':
      return 'mania';
    case 'all':
    case 'multi':
      return 'multi';
    default:
      return 'osu';
  }
}

/** Pool code Mayumi uses to the short category osmaRef stores. */
function poolCategory(mod: string | null | undefined): string {
  const raw = (mod ?? '').trim().toUpperCase();
  if (!raw) return 'NM';
  const cleaned = raw.replace(/[^A-Z0-9]/g, '').slice(0, 5);
  return /[A-Z]/.test(cleaned) ? cleaned : 'NM';
}

function slotMods(
  category: string,
  platform: Platform,
): Pick<MappoolSlot, 'requiredMods' | 'allowedMods' | 'freestyle' | 'freemod'> {
  switch (category) {
    case 'HD':
      return { requiredMods: ['HD'], allowedMods: [], freestyle: false, freemod: false };
    case 'HR':
      return { requiredMods: ['HR'], allowedMods: [], freestyle: false, freemod: false };
    case 'DT':
    case 'NC':
      return { requiredMods: [category], allowedMods: [], freestyle: false, freemod: false };
    case 'FM':
      return platform === 'stable'
        ? { requiredMods: [], allowedMods: [], freestyle: false, freemod: true }
        : { requiredMods: [], allowedMods: [], freestyle: true, freemod: false };
    default:
      return { requiredMods: [], allowedMods: [], freestyle: false, freemod: false };
  }
}

/** Key-count and mode pools carry their own ruleset; otherwise the tournament mode decides. */
function slotRuleset(category: string, mode: TournamentMode): RulesetId | null {
  if (category.startsWith('OM') || category === '4K' || category === '7K') return 3;
  if (category.startsWith('CTB') || category === 'CATCH') return 2;
  if (category.startsWith('TAIKO')) return 1;
  if (category === 'STD' || category === 'OSU') return 0;
  if (mode === 'multi' || mode === 'osu') return null;
  return MODE_RULESET[mode];
}

function buildFlow(stageId: string, stageName: string, bans: number): MatchFlow {
  const phases: MatchFlow['phases'] = [];
  if (bans > 0) {
    phases.push({
      id: `phase_ban_${stageId}`.slice(0, 128),
      action: 'ban',
      countPerTeam: 1,
      useStageCount: true,
      phaseOrder: 'alternate',
    });
  }
  phases.push({
    id: `phase_pick_${stageId}`.slice(0, 128),
    action: 'pick',
    countPerTeam: null,
    useStageCount: false,
    phaseOrder: 'alternate',
  });
  return {
    id: `flow_${stageId}`.slice(0, 128),
    name: `${stageName} flow`.slice(0, 64),
    phases,
    triggers: [],
  };
}

function normalizeBestOf(value: number | null | undefined, stageName: string, notes: string[]): number {
  const requested = Math.round(value ?? 9);
  let bestOf = Number.isFinite(requested) ? Math.min(31, Math.max(1, requested)) : 9;
  if (bestOf % 2 === 0) bestOf += 1;
  if (bestOf !== requested) {
    notes.push(`Stage "${stageName}" best-of ${requested} was adjusted to ${bestOf}.`.slice(0, 500));
  }
  return bestOf;
}

function normalizeBans(value: number | null | undefined): number {
  const requested = Math.round(value ?? 0);
  return Number.isFinite(requested) ? Math.min(10, Math.max(0, requested)) : 0;
}

function uniqueId(base: string, used: Set<string>): string {
  const safe = (slugify(base) || 'item').slice(0, 120);
  let candidate = safe;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${safe}_${suffix}`.slice(0, 128);
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function key(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function validUid(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Converts a Mayumi snapshot into a tournament configuration.
 *
 * `platform` cannot be inferred: it decides whether `FM` is stable Freemod or
 * lazer Freestyle, and the room win condition.
 */
export function convertMayumiToTournament(
  snapshot: MayumiSnapshot,
  options: MayumiConversionOptions,
): MayumiConversionResult {
  const notes: string[] = [];
  const now = options.now ?? new Date();
  const info = snapshot.info;
  const name = (info.name ?? '').trim().slice(0, 120) || 'Mayumi tournament';

  const tournament = createEmptyTournament(name, now);
  tournament.name = name;
  tournament.abbreviation =
    normalizeAbbreviation(info.abbreviation ?? '') || normalizeAbbreviation(name) || 'MYM';
  tournament.platform = options.platform;
  tournament.mode = mayumiMode(info.mode);
  tournament.revision = 1;
  tournament.source = null;
  tournament.teams = [];
  tournament.stages = [];
  tournament.webhooks = [];

  const players = snapshot.players?.players ?? [];
  const groups = snapshot.players?.groups ?? [];
  const playerNames = new Map<number, string>();
  for (const player of players) {
    const uid = validUid(player.uid);
    if (uid === null) continue;
    playerNames.set(uid, (player.name ?? '').trim().slice(0, 64));
  }

  /** Team index by uid: every roster uid maps to its team. */
  const teamByUid = new Map<number, number>();
  const teamByName = new Map<string, number>();
  const teamByAcronym = new Map<string, number>();
  const teams: Team[] = [];

  const merge = (group: MayumiGroup): number[] => {
    const seen = new Set<number>();
    const merged: number[] = [];
    for (const raw of [...(group.captains ?? []), ...(group.members ?? [])]) {
      const uid = validUid(raw);
      if (uid === null || seen.has(uid)) continue;
      seen.add(uid);
      merged.push(uid);
    }
    return merged;
  };

  const hasTeamConfig = groups.some((group) => merge(group).length > 0);

  const addTeam = (team: Team): void => {
    teams.push(team);
    teamByName.set(key(team.name), team.id);
    for (const member of team.members) teamByUid.set(member.userId, team.id);
  };

  if (hasTeamConfig) {
    for (const group of groups) {
      const uids = merge(group);
      if (uids.length === 0) continue;
      const id = teams.length;
      addTeam({
        id,
        name: (group.name ?? '').trim().slice(0, 64) || `Team ${id + 1}`,
        captainUserId: validUid(group.captains?.[0]) ?? uids[0] ?? null,
        members: uids.map((uid) => ({ userId: uid, username: playerNames.get(uid) ?? '' })),
        seed: null,
      });
    }
  } else {
    // Solo tournament: every player becomes a one-person team.
    const candidates = players.filter((player) => player.player === true);
    const pool = candidates.length > 0 ? candidates : players;
    const seen = new Set<number>();
    for (const player of pool) {
      const uid = validUid(player.uid);
      if (uid === null || seen.has(uid)) continue;
      seen.add(uid);
      const id = teams.length;
      addTeam({
        id,
        name: (player.name ?? '').trim().slice(0, 64) || `Player ${uid}`,
        captainUserId: uid,
        members: [{ userId: uid, username: (player.name ?? '').trim().slice(0, 64) }],
        seed: null,
      });
    }
  }

  // Entrant order is the seed order; the id is `team:<name>` or `player:<uid>`.
  const entrants = snapshot.draw?.entrants ?? [];
  entrants.forEach((entrant, index) => {
    const id = (entrant.id ?? '').trim();
    const seed = index + 1;
    const teamIndex = id.startsWith('team:') ? teamByName.get(key(id.slice(5))) : undefined;
    if (teamIndex !== undefined) {
      const team = teams.find((entry) => entry.id === teamIndex);
      if (team && team.seed === null) team.seed = seed;
    }
  });

  // Bracket configuration acronyms allow matching teams whose name changed.
  const acronyms = snapshot.bracket?.settings?.acronyms ?? {};
  for (const [left, right] of Object.entries(acronyms)) {
    const byName = teamByName.get(key(left));
    if (byName !== undefined) teamByAcronym.set(key(right), byName);
    const byValue = teamByName.get(key(right));
    if (byValue !== undefined) teamByAcronym.set(key(left), byValue);
  }

  const bracketRounds = snapshot.bracket?.settings?.rounds ?? {};
  const drawRounds = snapshot.draw?.rounds ?? [];
  const drawBestOf = new Map<string, number>();
  for (const round of drawRounds) {
    const stageName = (round.stage_name ?? '').trim();
    if (!stageName || typeof round.best_of !== 'number') continue;
    drawBestOf.set(stageName, Math.max(drawBestOf.get(stageName) ?? 0, round.best_of));
  }

  const roundInfo = snapshot.roundInfo ?? [];
  const schedule = snapshot.schedule ?? [];
  const pools = snapshot.mapPools ?? [];

  const roundByStage = new Map<string, MayumiRoundInfo>();
  for (const entry of roundInfo) roundByStage.set(entry.stage_name.trim(), entry);

  // Stage order: the published schedule first, then round-info, then pools.
  const stageNames: string[] = [];
  const pushStage = (stageName: string): void => {
    const trimmed = stageName.trim();
    if (trimmed && !stageNames.includes(trimmed)) stageNames.push(trimmed);
  };
  for (const stage of schedule) pushStage(stage.stage_name);
  for (const round of drawRounds) pushStage(round.stage_name ?? '');
  for (const entry of roundInfo) pushStage(entry.stage_name);
  for (const stage of pools) pushStage(stage.stage_name);

  const isLobbyStage = (stageName: string): boolean => {
    const info2 = roundByStage.get(stageName);
    if (info2?.is_lobby === true) return true;
    const scheduled = schedule.find((stage) => stage.stage_name.trim() === stageName);
    if (!scheduled) return false;
    const matches = scheduled.match_info ?? [];
    const lobbies = scheduled.lobby_info ?? [];
    return lobbies.length > 0 && matches.length === 0;
  };

  const droppedStages: string[] = [];
  const keptStageNames = stageNames.filter((stageName) => {
    const soloQualifier =
      roundByStage.get(stageName)?.is_solo_qualifier === true || isLobbyStage(stageName);
    if (hasTeamConfig && soloQualifier) {
      droppedStages.push(stageName);
      return false;
    }
    return true;
  });
  if (droppedStages.length > 0) {
    notes.push(
      `Dropped qualifier stage(s) because the tournament already has team rosters: ${droppedStages.join(
        ', ',
      )}.`.slice(0, 500),
    );
  }

  const usedStageIds = new Set<string>();
  const usedMatchIds = new Set<string>();
  const stages: Stage[] = [];

  const resolveTeam = (info2: { uid?: number[] | null; name?: string | null } | null | undefined): number | undefined => {
    if (!info2) return undefined;
    for (const raw of info2.uid ?? []) {
      const uid = validUid(raw);
      if (uid === null) continue;
      const byCaptain = teams.find((team) => team.captainUserId === uid);
      if (byCaptain) return byCaptain.id;
      const byMember = teamByUid.get(uid);
      if (byMember !== undefined) return byMember;
    }
    const byName = teamByName.get(key(info2.name));
    if (byName !== undefined) return byName;
    return teamByAcronym.get(key(info2.name));
  };

  const ensureSoloTeam = (info2: { uid?: number[] | null; name?: string | null } | null | undefined): number | undefined => {
    const uid = validUid(info2?.uid?.[0]);
    if (uid === null) return undefined;
    const existing = teamByUid.get(uid);
    if (existing !== undefined) return existing;
    const id = teams.length;
    const displayName =
      (info2?.name ?? '').trim().slice(0, 64) || playerNames.get(uid) || `Player ${uid}`;
    addTeam({
      id,
      name: displayName,
      captainUserId: uid,
      members: [{ userId: uid, username: playerNames.get(uid) ?? displayName }],
      seed: null,
    });
    return id;
  };

  const scheduledAtOf = (raw: string | null | undefined, label: string): string => {
    const parsed = raw ? Date.parse(raw) : Number.NaN;
    if (!Number.isFinite(parsed)) {
      notes.push(`${label} has no readable date; the import time was used.`.slice(0, 500));
      return now.toISOString();
    }
    return new Date(parsed).toISOString();
  };

  keptStageNames.forEach((stageName, order) => {
    const id = uniqueId(`stage_${stageName}`, usedStageIds);
    const lobbyStage = isLobbyStage(stageName) && !hasTeamConfig;
    const bracketRound = bracketRounds[stageName];
    const bestOf = lobbyStage
      ? 1
      : normalizeBestOf(bracketRound?.bestOf ?? drawBestOf.get(stageName), stageName, notes);
    const bans = lobbyStage ? 0 : normalizeBans(bracketRound?.banCount);

    // Pool.
    const poolStage = pools.find((entry) => entry.stage_name.trim() === stageName);
    const slots: MappoolSlot[] = [];
    const usedBeatmaps = new Set<number>();
    for (const bracket of poolStage?.mod_bracket ?? []) {
      const category = poolCategory(bracket.mod);
      if ((bracket.mod ?? '').trim().toUpperCase() !== category) {
        notes.push(
          `Stage "${stageName}" uses pool code "${bracket.mod}"; it was normalised to "${category}".`.slice(0, 500),
        );
      }
      for (const map of bracket.maps ?? []) {
        const beatmapId = typeof map.map_id === 'number' ? map.map_id : Number.NaN;
        if (!Number.isInteger(beatmapId) || beatmapId <= 0) {
          notes.push(`Stage "${stageName}" contains a map without a valid id; it was skipped.`.slice(0, 500));
          continue;
        }
        if (usedBeatmaps.has(beatmapId)) {
          notes.push(`Stage "${stageName}" lists beatmap ${beatmapId} twice; the duplicate was skipped.`.slice(0, 500));
          continue;
        }
        usedBeatmaps.add(beatmapId);
        slots.push({
          id: '',
          label: '',
          category,
          beatmapId,
          beatmap: {
            id: beatmapId,
            title: (map.map_name ?? '').slice(0, 200),
            artist: '',
            mapper: (map.mapper ?? '').slice(0, 100),
            difficultyName: (map.diff_name ?? '').slice(0, 100),
            beatmapsetId: null,
            beatmapUrl: '',
            coverUrl: '',
          },
          rulesetId: slotRuleset(category, tournament.mode),
          ...slotMods(category, options.platform),
        });
      }
    }
    assignSlotLabels(slots);
    const usedSlotIds = new Set<string>();
    for (const slot of slots) {
      slot.id = uniqueId(`${id}_${slot.label}`, usedSlotIds);
    }

    const stage: Stage = {
      id,
      name: stageName.slice(0, 64),
      order,
      type: 'knockout',
      groups: [],
      bestOf,
      bans,
      protects: 0,
      winCondition: options.platform === 'lazer' ? 'score' : 'score_v2',
      winByRuleId: BUILTIN_WIN_BY_RULE_ID,
      slots,
      flow: buildFlow(id, stageName, bans),
      matches: [],
    };
    stages.push(stage);

    const scheduled = schedule.find((entry) => entry.stage_name.trim() === stageName);

    for (const raw of scheduled?.match_info ?? []) {
      const label = `Match "${raw.match_id}" in stage "${stageName}"`;
      const one = hasTeamConfig ? resolveTeam(raw.team1) : ensureSoloTeam(raw.team1);
      const two = hasTeamConfig ? resolveTeam(raw.team2) : ensureSoloTeam(raw.team2);
      if (one === undefined || two === undefined) {
        const missing = [raw.team1?.name, raw.team2?.name].filter((value) => !value);
        notes.push(
          `${label} has no decided teams${
            (raw.team1?.name ?? raw.team2?.name) ? ` (${raw.team1?.name ?? '?'} vs ${raw.team2?.name ?? '?'})` : ''
          }; it was skipped.${missing.length ? '' : ''}`.slice(0, 500),
        );
        continue;
      }
      if (one === two) {
        notes.push(`${label} uses the same team on both sides; it was skipped.`.slice(0, 500));
        continue;
      }
      let scoreRed = Math.round(raw.team1_score ?? 0);
      let scoreBlue = Math.round(raw.team2_score ?? 0);
      if (scoreRed < 0 || scoreBlue < 0) {
        notes.push(`${label} records a forfeit (${scoreRed}:${scoreBlue}); it was stored as 0:0.`.slice(0, 500));
        scoreRed = Math.max(0, scoreRed);
        scoreBlue = Math.max(0, scoreBlue);
      }
      const notes2 = [`Mayumi match ${raw.match_id}`];
      if (raw.is_winner_bracket === false) notes2.push('losers bracket');
      const match: Match = {
        type: 'match',
        id: uniqueId(`m_${stageName}_${raw.match_id}`, usedMatchIds),
        groupId: null,
        refereeIds: [],
        scheduledAt: scheduledAtOf(raw.datetime, label),
        result: {
          scoreRed: Math.max(0, scoreRed),
          scoreBlue: Math.max(0, scoreBlue),
          roomId: null,
          beatmaps: [],
        },
        teamRedId: one,
        teamBlueId: two,
        roomMode: 'team_versus',
        notes: notes2.join(', ').slice(0, 1000),
      };
      stage.matches.push(match);
    }

    for (const raw of scheduled?.lobby_info ?? []) {
      if (!lobbyStage) continue;
      const label = `Lobby "${raw.lobby_name ?? raw.match_id}" in stage "${stageName}"`;
      const teamIds: number[] = [];
      for (const participant of raw.participants ?? []) {
        const teamId = ensureSoloTeam(participant);
        if (teamId !== undefined && !teamIds.includes(teamId)) teamIds.push(teamId);
      }
      if (teamIds.length === 0) {
        notes.push(`${label} has no participants yet; it was skipped.`.slice(0, 500));
        continue;
      }
      const match: Match = {
        type: 'lobby',
        id: uniqueId(`l_${stageName}_${raw.match_id}`, usedMatchIds),
        groupId: null,
        refereeIds: [],
        scheduledAt: scheduledAtOf(raw.datetime, label),
        result: { scoreRed: 0, scoreBlue: 0, roomId: null, beatmaps: [] },
        teamIds,
        roomMode: 'head_to_head',
        notes: `Mayumi lobby ${raw.lobby_name ?? raw.match_id}`.slice(0, 1000),
      };
      stage.matches.push(match);
    }
  });

  tournament.stages = stages;
  tournament.teams = teams;
  tournament.teamSize =
    teams.length === 0
      ? 1
      : hasTeamConfig
        ? Math.min(16, Math.max(1, ...teams.map((team) => team.members.length)))
        : 1;

  const matchCount = stages.reduce((total, stage) => total + stage.matches.length, 0);
  if (matchCount === 0) {
    notes.push('The schedule contains no matches that could be converted.');
  }
  if (snapshot.mapPools === null) {
    notes.push('Mayumi returned no published mappool; stages were created without beatmaps.');
  }
  if (snapshot.draw === null) {
    notes.push('The public draw is not published; best-of values fall back to the defaults.');
  }

  return { tournament, notes };
}

/** One entry of `/api/tournament-summaries`. */
export const MayumiTournamentSummarySchema = z
  .object({
    name: z.string(),
    abbreviation: z.string(),
    status: z.string().nullish(),
    description: z.string().nullish(),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    mode: z.string().nullish(),
  })
  .passthrough();
export type MayumiTournamentSummaryPayload = z.infer<typeof MayumiTournamentSummarySchema>;

export type MayumiOpenState = 'open' | 'closed' | 'unknown';

/**
 * Whether `now` falls inside the published date range.
 *
 * Mayumi stores `start_date` either as `YYYY-MM-DD` or as an ISO timestamp and
 * `end_date` as `YYYY-MM-DD`; both are treated as UTC. A missing or unreadable
 * date cannot be judged, which callers must not treat as "closed" when
 * deciding whether an import is allowed.
 */
export function mayumiOpenState(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  now: Date = new Date(),
): MayumiOpenState {
  const start = parseBound(startDate, 'start');
  const end = parseBound(endDate, 'end');
  if (start === null || end === null) return 'unknown';
  const at = now.getTime();
  return at >= start && at <= end ? 'open' : 'closed';
}

function parseBound(value: string | null | undefined, edge: 'start' | 'end'): number | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const plainDate = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = Date.parse(plainDate ? `${raw}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z` : raw);
  return Number.isFinite(parsed) ? parsed : null;
}
