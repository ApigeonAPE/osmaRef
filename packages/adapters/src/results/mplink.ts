import type { PlayerScore } from '@osmaref/contracts';
import type { OsuMatch } from '../osu/api';
import { mapScore } from './provider';

/** One played game inside a legacy osu! multiplayer match. */
export interface MplinkGame {
  id: number;
  beatmapId: number;
  endTime: string | null;
  scores: PlayerScore[];
}

/** Normalises the API payload so the main process never handles raw scores. */
export function mplinkGames(match: OsuMatch): MplinkGame[] {
  const names = new Map((match.users ?? []).map((user) => [user.id, user.username]));
  const games: MplinkGame[] = [];
  for (const event of match.events ?? []) {
    const game = event.game;
    if (!game || !game.beatmap_id) continue;
    const scores = (game.scores ?? [])
      .map((raw) => mapScore(raw))
      .filter((score) => score.userId > 0)
      .map((score) => ({
        ...score,
        username: score.username ?? names.get(score.userId),
      }));
    games.push({
      id: game.id,
      beatmapId: game.beatmap_id,
      endTime: game.end_time ?? null,
      scores,
    });
  }
  return games;
}

/**
 * Picks the game that belongs to the result being recorded.
 *
 * A match can contain warmups, aborted attempts and rematches on the same
 * beatmap. The game must have ended near `at`, so a later rematch never
 * rewrites an older result.
 */
export function selectLatestGame(
  games: readonly MplinkGame[],
  beatmapId: number,
  at: string,
  windowMs = 15 * 60 * 1000,
): MplinkGame | null {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return null;

  let best: MplinkGame | null = null;
  let bestEnd = Number.NEGATIVE_INFINITY;
  for (const game of games) {
    if (game.beatmapId !== beatmapId || !game.endTime || game.scores.length === 0) continue;
    const end = Date.parse(game.endTime);
    if (!Number.isFinite(end)) continue;
    if (end > atMs + 60_000 || end < atMs - windowMs) continue;
    if (end > bestEnd) {
      best = game;
      bestEnd = end;
    }
  }
  return best;
}

/**
 * IRC is the primary source; mplink replaces a player's score when it has one.
 * Players missing from mplink keep the IRC report.
 */
export function mergeScores(
  irc: readonly PlayerScore[],
  mplink: readonly PlayerScore[],
): PlayerScore[] {
  const merged = new Map<number, PlayerScore>();
  for (const score of irc) {
    if (score.userId > 0) merged.set(score.userId, score);
  }
  for (const score of mplink) {
    if (score.userId > 0) merged.set(score.userId, score);
  }
  return [...merged.values()];
}

/** True when both teams have at least `teamSize` distinct players with a score. */
export function hasCompleteTeamScores(
  scores: readonly PlayerScore[],
  teamByUser: ReadonlyMap<number, string>,
  teamSize: number,
  teamOneId: string,
  teamTwoId: string,
): boolean {
  const one = new Set<number>();
  const two = new Set<number>();
  for (const score of scores) {
    const team = teamByUser.get(score.userId);
    if (team === teamOneId) one.add(score.userId);
    else if (team === teamTwoId) two.add(score.userId);
  }
  return one.size >= teamSize && two.size >= teamSize;
}

/** Compares the scores that matter for a recorded result. */
export function scoresDiffer(
  left: readonly PlayerScore[],
  right: readonly PlayerScore[],
): boolean {
  if (left.length !== right.length) return true;
  const byId = new Map(right.map((score) => [score.userId, score]));
  for (const score of left) {
    const other = byId.get(score.userId);
    if (!other || other.score !== score.score || other.passed !== score.passed) return true;
  }
  return false;
}
