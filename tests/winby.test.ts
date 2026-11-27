import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_WIN_BY_RULE,
  BUILTIN_WIN_BY_RULE_ID,
  parseWinByDirectives,
  type MatchPlayer,
  type PlayerScore,
} from '@osmaref/contracts';
import { buildWinBySlots, evaluateWinBy } from '@osmaref/domain';
import { compileWinBySource, runWinBy } from '../apps/desktop/src/main/winby';
import { WinByStore } from '../apps/desktop/src/main/winby-store';

function score(userId: number, value: number, accuracy = 0.95): PlayerScore {
  return {
    userId,
    username: `player-${userId}`,
    score: value,
    accuracy,
    maxCombo: 100,
    misses: 1,
    mods: [],
    passed: true,
  };
}

function players(): MatchPlayer[] {
  return [
    { userId: 1, username: 'red-1', slot: 0, team: 'red' },
    { userId: 2, username: 'red-2', slot: 1, team: 'red' },
    { userId: 3, username: 'blue-1', slot: 2, team: 'blue' },
    { userId: 4, username: 'blue-2', slot: 3, team: 'blue' },
  ];
}

function evaluate(
  scores: PlayerScore[],
  options: { source?: string; teamSize?: number; members?: [number[], number[]] } = {},
) {
  return evaluateWinBy({
    scores,
    players: players(),
    teamOneMembers: options.members?.[0] ?? [1, 2],
    teamTwoMembers: options.members?.[1] ?? [3, 4],
    teamSize: options.teamSize ?? 2,
    beatmapId: 42,
    category: 'NM',
    sequence: 3,
    decide: (slots, map, teams) =>
      runWinBy(options.source ?? BUILTIN_WIN_BY_RULE.source, slots, map, teams),
  });
}

describe('Win-by rules', () => {
  it('sums team scores with the built-in rule', () => {
    const result = evaluate([score(1, 100), score(2, 200), score(3, 50), score(4, 40)]);
    expect(result.winner).toBe('team_one');
    expect(result.teamMapScores).toEqual({ team_one: 300, team_two: 90 });
    expect(result.needsReview).toBe(false);
  });

  it('passes the scoreboard shape to the rule', () => {
    const source = [
      '// @name Slot reader',
      '// @scoreboard enable',
      'export default function (slots, map, teams) {',
      '  const total = (team) => slots.filter((slot) => team.includes(slot[0])).reduce((sum, slot) => sum + slot[1], 0);',
      '  if (map[1] !== "NM" || map[2] !== 3) return null;',
      '  return total(teams[1]) > total(teams[0]) ? "blue" : "red";',
      '}',
    ].join('\n');
    const result = evaluate([score(1, 100), score(2, 100), score(3, 500), score(4, 0)], {
      source,
    });
    expect(result.winner).toBe('team_two');
    expect(result.slots[3]).toEqual([4, 0, []]);
  });

  it('places captured slots and fills gaps in room order', () => {
    const slots = buildWinBySlots(
      [score(1, 10), score(2, 20), score(3, 30)],
      [
        { userId: 1, slot: 5, team: 'red' },
        { userId: 2, slot: 2, team: 'blue' },
        { userId: 3, slot: null, team: 'blue' },
      ],
    );
    expect(slots[5]).toEqual([1, 10, []]);
    expect(slots[2]).toEqual([2, 20, []]);
    expect(slots[0]).toEqual([3, 30, []]);
    expect(slots.filter((slot) => slot[0] !== 0)).toHaveLength(3);
  });

  it('flags incomplete scores for review', () => {
    const result = evaluate([score(1, 100), score(3, 50)]);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toBe('scores are not complete for both teams');
    expect(result.winner).toBeNull();
  });

  it('flags empty team rosters for review', () => {
    const result = evaluate([score(1, 100), score(3, 50)], { members: [[], [3, 4]] });
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toBe('one or both teams have no players listed');
  });

  it('flags unknown players for review', () => {
    const result = evaluate([score(1, 1), score(2, 1), score(3, 1), score(4, 1), score(9, 1)]);
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toBe('some scores could not be matched to a team');
  });

  it('flags a tie and invalid returns as review reasons', () => {
    const tie = evaluate([score(1, 10), score(2, 10), score(3, 10), score(4, 10)]);
    expect(tie.needsReview).toBe(true);
    expect(tie.reviewReason).toBe('Win-by rule could not determine a winner');

    const invalid = evaluate([score(1, 10), score(2, 10), score(3, 10), score(4, 10)], {
      source: 'export default function () { return "green"; }',
    });
    expect(invalid.needsReview).toBe(true);
    expect(invalid.reviewReason).toBe('Win-by rule returned an invalid winner');
  });

  it('turns a rule exception into a review reason', () => {
    const result = evaluate([score(1, 1), score(2, 1), score(3, 1), score(4, 1)], {
      source: 'export default function () { throw new Error("boom"); }',
    });
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toBe('Win-by rule failed: boom');
  });

  it('rejects imports, require and missing default exports', () => {
    expect(() => compileWinBySource("import fs from 'node:fs';\nexport default () => null;")).toThrow(
      'cannot use import',
    );
    expect(() =>
      compileWinBySource("const fs = require('node:fs');\nexport default () => null;"),
    ).toThrow('cannot use require');
    expect(() => compileWinBySource('function helper() { return null; }')).toThrow(
      'needs a default export',
    );
    expect(() => compileWinBySource('export const helper = 1;')).toThrow('needs a default export');
  });

  it('rejects async rules and runs helpers from the same file', () => {
    expect(() =>
      runWinBy('export default async function () { return null; }', [], [0, 0, 1], [[], []]),
    ).toThrow('synchronously');

    const source = [
      'function total(team, slots) { return slots.filter((slot) => team.includes(slot[0])).length; }',
      'export default function (slots, map, teams) { return total(teams[0], slots) > 0 ? "red" : null; }',
    ].join('\n');
    expect(runWinBy(source, [[1, 0, []]], [0, 0, 1], [[1], []])).toBe('red');
  });

  it('reads rule directives and enforces their presence', () => {
    expect(parseWinByDirectives('// @name Accuracy\n// @scoreboard disable\nexport default () => null;')).toEqual(
      { name: 'Accuracy', scoreboard: false },
    );
    expect(parseWinByDirectives('export default () => null;')).toBeNull();
    expect(parseWinByDirectives('// @name A\n// @name B\nexport default () => null;')).toBeNull();
  });

  it('stores imported rules and protects the built-in rule', () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-winby-'));
    try {
      const store = new WinByStore(dir);
      const added = store.add(
        '// @name Accuracy\n// @scoreboard enable\nexport default function (slots, map, teams) { return "red"; }',
      );
      expect(store.list().map((rule) => rule.id)).toEqual([BUILTIN_WIN_BY_RULE_ID, added.id]);
      expect(store.get(added.id)?.name).toBe('Accuracy');
      expect(store.get(BUILTIN_WIN_BY_RULE_ID)?.builtIn).toBe(true);
      expect(() => store.remove(BUILTIN_WIN_BY_RULE_ID)).toThrow('cannot be removed');

      const reopened = new WinByStore(dir);
      expect(reopened.get(added.id)?.name).toBe('Accuracy');
      reopened.remove(added.id);
      expect(reopened.get(added.id)).toBeNull();
      expect(() => reopened.remove(added.id)).toThrow('not found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
