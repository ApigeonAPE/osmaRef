import type {
  MatchPlayer,
  PlayerScore,
  TeamSide,
  WinByWinner,
} from '@osmaref/contracts';

export type WinBySlot = [number, number, string[]];
export type WinByMap = [number, string | 0, number];
export type WinByTeams = [number[], number[]];

export interface WinByContext {
  scores: PlayerScore[];
  players: MatchPlayer[];
  teamOneMembers: number[];
  teamTwoMembers: number[];
  teamSize: number;
  beatmapId: number;
  category: string | null;
  sequence: number;
  decide: (slots: WinBySlot[], map: WinByMap, teams: WinByTeams) => unknown;
}

export interface WinByEvaluation {
  winner: TeamSide | null;
  teamValues: { team_one: number | null; team_two: number | null };
  needsReview: boolean;
  reviewReason: string | null;
  slots: WinBySlot[];
  map: WinByMap;
  teams: WinByTeams;
}

/** Places scores in room-slot order; scores without a captured slot fill the gaps. */
export function buildWinBySlots(scores: PlayerScore[], players: MatchPlayer[]): WinBySlot[] {
  const slots: WinBySlot[] = Array.from({ length: 16 }, () => [0, 0, []] as WinBySlot);
  const used = new Set<number>();
  const playerSlots = new Map<number, number>();
  for (const player of players) {
    if (player.slot !== null && player.userId > 0) playerSlots.set(player.userId, player.slot);
  }
  const place = (score: PlayerScore, slot: number): void => {
    slots[slot] = [score.userId, score.score, [...score.mods]];
    used.add(slot);
  };
  for (const score of scores) {
    const captured = playerSlots.get(score.userId);
    if (captured !== undefined && !used.has(captured)) {
      place(score, captured);
      continue;
    }
    const free = slots.findIndex((_slot, index) => !used.has(index));
    if (free >= 0) place(score, free);
  }
  return slots;
}

/** Number of players on a team that have a recorded score. */
function scoredMembers(scores: PlayerScore[], members: number[]): number {
  const memberSet = new Set(members);
  const seen = new Set<number>();
  for (const score of scores) {
    if (memberSet.has(score.userId)) seen.add(score.userId);
  }
  return seen.size;
}

function teamSum(scores: PlayerScore[], members: number[]): number | null {
  const memberSet = new Set(members);
  let total = 0;
  let found = false;
  for (const score of scores) {
    if (!memberSet.has(score.userId)) continue;
    total += score.score;
    found = true;
  }
  return found ? total : null;
}

function winnerSide(value: unknown): WinByWinner {
  if (value === 'red' || value === 'blue' || value === null) return value;
  return null;
}

/**
 * Builds the rule arguments, checks that both rosters reported a score, then
 * asks the rule to decide. Any rule failure becomes a review reason instead of
 * aborting the recording.
 */
export function evaluateWinBy(context: WinByContext): WinByEvaluation {
  const { scores, teamOneMembers, teamTwoMembers, teamSize } = context;
  const teams: WinByTeams = [
    [...new Set(teamOneMembers.filter((id) => id > 0))],
    [...new Set(teamTwoMembers.filter((id) => id > 0))],
  ];
  const slots = buildWinBySlots(scores, context.players);
  const map: WinByMap = [
    context.beatmapId,
    context.category && context.category.length > 0 ? context.category : 0,
    context.sequence,
  ];
  const teamValues = {
    team_one: teamSum(scores, teams[0]),
    team_two: teamSum(scores, teams[1]),
  };
  const fail = (reviewReason: string): WinByEvaluation => ({
    winner: null,
    teamValues,
    needsReview: true,
    reviewReason,
    slots,
    map,
    teams,
  });
  const decide = (result: WinByWinner): WinByEvaluation =>
    result === null
      ? fail('Win-by rule could not determine a winner')
      : {
          winner: result === 'red' ? 'team_one' : 'team_two',
          teamValues,
          needsReview: false,
          reviewReason: null,
          slots,
          map,
          teams,
        };

  if (scores.length === 0) return fail('no scores were recorded for this beatmap');
  if (teams[0].length === 0 || teams[1].length === 0) {
    return fail('one or both teams have no players listed');
  }
  const requiredOne = Math.min(teamSize, teams[0].length);
  const requiredTwo = Math.min(teamSize, teams[1].length);
  if (
    scoredMembers(scores, teams[0]) < requiredOne ||
    scoredMembers(scores, teams[1]) < requiredTwo
  ) {
    return fail('scores are not complete for both teams');
  }
  const known = new Set([...teams[0], ...teams[1]]);
  if (scores.some((score) => !known.has(score.userId))) {
    return fail('some scores could not be matched to a team');
  }

  let result: unknown;
  try {
    result = context.decide(slots, map, teams);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error).replace(/^Error:\s*/, '');
    return fail(`Win-by rule failed: ${message.slice(0, 200)}`);
  }
  const side = winnerSide(result);
  if (side === null) {
    return result === null
      ? fail('Win-by rule could not determine a winner')
      : fail('Win-by rule returned an invalid winner');
  }
  return decide(side);
}
