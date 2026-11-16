import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hasCompleteTeamScores,
  mergeScores,
  mplinkGames,
  scoresDiffer,
  selectLatestGame,
} from '@osmaref/adapters';
import type { OsuMatch } from '@osmaref/adapters';
import type { PlayerScore } from '@osmaref/contracts';

const match = JSON.parse(
  readFileSync(new URL('./fixtures/mplink-122026887.json', import.meta.url), 'utf8'),
) as OsuMatch;

const games = mplinkGames(match);

function ircScore(score: PlayerScore, value: number): PlayerScore {
  return { ...score, score: value, accuracy: 0, maxCombo: 0, misses: 0, mods: [] };
}

describe('mplink score mapping', () => {
  it('normalises a real match payload and fills usernames', () => {
    expect(games).toHaveLength(3);
    const first = games[0]!;
    expect(first.beatmapId).toBe(4954309);
    expect(first.scores).toHaveLength(4);
    expect(first.scores[0]?.userId).toBeGreaterThan(0);
    expect(first.scores[0]?.username).toBeTruthy();
    expect(first.scores[0]?.score).toBeGreaterThan(0);
  });

  it('selects the game that ended near the result time', () => {
    expect(selectLatestGame(games, 4368305, '2026-10-17T13:52:00Z')?.id).toBe(643095804);
    expect(selectLatestGame(games, 4368305, '2026-10-17T13:47:30Z')).toBeNull();
    expect(selectLatestGame(games, 4954309, '2026-10-17T14:10:00Z')).toBeNull();
  });

  it('prefers mplink scores and keeps IRC-only players', () => {
    const first = games[0]!;
    const irc = [
      ircScore(first.scores[0]!, 1),
      { ...first.scores[0]!, userId: 999, username: 'IRC only', score: 42 },
    ];
    const merged = mergeScores(irc, first.scores);
    expect(merged).toHaveLength(5);
    expect(merged.find((score) => score.userId === first.scores[0]!.userId)?.score).toBe(
      first.scores[0]!.score,
    );
    expect(merged.find((score) => score.userId === 999)?.score).toBe(42);
  });
});

describe('IRC completeness', () => {
  const teamByUser = new Map<number, string>([
    [30174043, 'one'],
    [34215813, 'one'],
    [12031289, 'two'],
    [38271402, 'two'],
  ]);

  it('requires both teams to reach the roster size', () => {
    const scores = games[0]!.scores;
    expect(hasCompleteTeamScores(scores, teamByUser, 2, 'one', 'two')).toBe(true);
    expect(hasCompleteTeamScores(scores.slice(0, 3), teamByUser, 2, 'one', 'two')).toBe(false);
  });

  it('detects score changes for the correction pass', () => {
    const scores = games[0]!.scores;
    expect(scoresDiffer(scores, scores)).toBe(false);
    expect(scoresDiffer(scores, [ircScore(scores[0]!, 1), ...scores.slice(1)])).toBe(true);
  });
});
