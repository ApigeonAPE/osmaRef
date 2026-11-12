import type {
  BeatmapResult,
  PlayerScore,
  ScoringScheme,
  TeamSide,
  WinCondition,
} from '@osmaref/contracts';

export interface EvaluateInput {
  slotLabel: string;
  beatmapId: number;
  scores: PlayerScore[];
  teamOneId: string;
  teamTwoId: string;
  memberTeam: Map<number, string>;
  scheme: ScoringScheme;
  /** Per-beatmap override; falls back to the scheme's condition. */
  winCondition?: WinCondition | null;
  /** Per-beatmap override; defaults to lowest for misses, highest otherwise. */
  winner?: 'highest' | 'lowest' | null;
  recordedAt: string;
  source: BeatmapResult['source'];
}

export interface Evaluation {
  result: BeatmapResult;
  /** True when the reducer must mark this beatmap for human review. */
  needsReview: boolean;
  reviewReason: string | null;
}

export function playerValue(
  score: PlayerScore,
  scheme: ScoringScheme,
  condition: WinCondition = scheme.winCondition,
): number {
  const base = baseValue(score, condition);
  if (condition !== 'score' && condition !== 'score_v2') {
    return base;
  }
  return base * modMultiplier(score.mods, scheme.modMultipliers);
}

function baseValue(score: PlayerScore, condition: WinCondition): number {
  switch (condition) {
    case 'score':
    case 'score_v2':
      return score.score;
    case 'accuracy':
      return score.accuracy;
    case 'combo':
      return score.maxCombo;
    case 'misses':
      return score.misses;
    default:
      return score.score;
  }
}

export function modMultiplier(mods: string[], multipliers: Record<string, number>): number {
  let result = 1;
  for (const mod of mods) {
    const key = mod.toUpperCase();
    const value = multipliers[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      result *= value;
    }
  }
  return result;
}

export function aggregate(values: number[], aggregation: ScoringScheme['aggregation']): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  switch (aggregation) {
    case 'sum':
      return sum;
    case 'average':
      return sum / values.length;
    case 'max':
      return Math.max(...values);
    default:
      return sum;
  }
}

/**
 * Evaluates one beatmap into a persisted result.
 *
 * It never guesses: unknown team membership, empty teams and ties are returned
 * with `needsReview`, and the winner stays null so no point is silently awarded.
 */
export function evaluateBeatmap(input: EvaluateInput): Evaluation {
  const condition: WinCondition = input.winCondition ?? input.scheme.winCondition;
  const lowerWins =
    (input.winner ?? (condition === 'misses' ? 'lowest' : 'highest')) === 'lowest';
  const teamValues: Record<string, number[]> = { [input.teamOneId]: [], [input.teamTwoId]: [] };
  let unknownTeam = false;

  for (const score of input.scores) {
    const teamId = input.memberTeam.get(score.userId);
    if (!teamId || !(teamId in teamValues)) {
      unknownTeam = true;
      continue;
    }
    teamValues[teamId]!.push(playerValue(score, input.scheme, condition));
  }

  const teamOneValues = teamValues[input.teamOneId] ?? [];
  const teamTwoValues = teamValues[input.teamTwoId] ?? [];
  const valueOne = aggregate(teamOneValues, input.scheme.aggregation);
  const valueTwo = aggregate(teamTwoValues, input.scheme.aggregation);

  const result: BeatmapResult = {
    id: `${input.slotLabel}:${input.recordedAt}`,
    slotLabel: input.slotLabel,
    beatmapId: input.beatmapId,
    scores: input.scores,
    winner: null,
    teamValues: { team_one: valueOne, team_two: valueTwo },
    source: input.source,
    recordedAt: input.recordedAt,
    needsReview: false,
  };

  let reviewReason: string | null = null;
  if (unknownTeam) {
    reviewReason = 'some scores could not be matched to a team';
  } else if (valueOne === null || valueTwo === null) {
    reviewReason = 'one or both teams have no scores for this beatmap';
  } else if (valueOne === valueTwo) {
    reviewReason = 'both teams produced the same value';
  }

  if (reviewReason === null && valueOne !== null && valueTwo !== null) {
    const teamOneWins = lowerWins ? valueOne < valueTwo : valueOne > valueTwo;
    result.winner = teamOneWins ? 'team_one' : 'team_two';
  }

  if (reviewReason !== null) {
    result.needsReview = true;
  }

  return { result, needsReview: reviewReason !== null, reviewReason };
}

export function sideForTeamId(
  teamId: string,
  teamOneId: string,
  teamTwoId: string,
): TeamSide | null {
  if (teamId === teamOneId) return 'team_one';
  if (teamId === teamTwoId) return 'team_two';
  return null;
}