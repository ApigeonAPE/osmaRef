import { z } from 'zod';

/**
 * Win-by rules are user-supplied JavaScript functions. They are the only
 * executable configuration in a tournament; everything else stays declarative.
 *
 * A rule file must start with two directives before its code:
 *
 *   // @name Sum of scores
 *   // @scoreboard enable
 *
 * The default export receives three arguments and returns `'red'`, `'blue'`,
 * or `null` when it cannot decide:
 *
 *   slots: Array<[userId, score, mods]>, indexed by room slot
 *   map:   [beatmapId, category, sequence]
 *   teams: [redUserIds, blueUserIds]
 */

export const BUILTIN_WIN_BY_RULE_ID = 'builtin:higher-score';

export const WinByRuleSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(64),
  /** Whether this rule wants the match scoreboard shown. */
  scoreboard: z.boolean(),
  source: z.string().min(1).max(200_000),
  builtIn: z.boolean().default(false),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type WinByRule = z.infer<typeof WinByRuleSchema>;

export const WinByRuleSnapshotSchema = z.object({
  ruleId: z.string().min(1).max(128),
  name: z.string().min(1).max(64),
  scoreboard: z.boolean(),
  source: z.string().min(1).max(200_000),
});
export type WinByRuleSnapshot = z.infer<typeof WinByRuleSnapshotSchema>;

export type WinByWinner = 'red' | 'blue' | null;

const NAME_DIRECTIVE = /^\s*\/\/\s*@name\s+(.+?)\s*$/;
const SCOREBOARD_DIRECTIVE = /^\s*\/\/\s*@scoreboard\s+(enable|disable)\s*$/i;

export interface WinByDirectives {
  name: string;
  scoreboard: boolean;
}

/**
 * Reads the required directives from the top of a rule file. Returns null if
 * either directive is missing, duplicated, or malformed.
 */
export function parseWinByDirectives(source: string): WinByDirectives | null {
  let name: string | null = null;
  let scoreboard: boolean | null = null;
  const lines = source.split(/\r?\n/).slice(0, 20);
  for (const line of lines) {
    const nameMatch = line.match(NAME_DIRECTIVE);
    if (nameMatch) {
      if (name !== null) return null;
      name = nameMatch[1]!.trim();
      continue;
    }
    const scoreboardMatch = line.match(SCOREBOARD_DIRECTIVE);
    if (scoreboardMatch) {
      if (scoreboard !== null) return null;
      scoreboard = scoreboardMatch[1]!.toLowerCase() === 'enable';
    }
  }
  if (!name || name.length > 64 || scoreboard === null) return null;
  return { name, scoreboard };
}

const BUILTIN_SOURCE = `// @name Higher score
// @scoreboard enable
/**
 * @param {Array<[number, number, string[]]>} slots
 * @param {[number, string | 0, number]} map
 * @param {[number[], number[]]} teams
 * @returns {'red' | 'blue' | null}
 */
export default function higherScore(slots, map, teams) {
  const red = new Set(teams[0] || []);
  const blue = new Set(teams[1] || []);
  const totals = [0, 0];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    if (!slot || !slot[0]) continue;
    if (red.has(slot[0])) totals[0] += slot[1] || 0;
    else if (blue.has(slot[0])) totals[1] += slot[1] || 0;
  }
  if (totals[0] === totals[1]) return null;
  return totals[0] > totals[1] ? 'red' : 'blue';
}
`;

export const BUILTIN_WIN_BY_RULE: WinByRule = {
  id: BUILTIN_WIN_BY_RULE_ID,
  name: 'Higher score',
  scoreboard: true,
  source: BUILTIN_SOURCE,
  builtIn: true,
  createdAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

export function winBySnapshot(rule: WinByRule): WinByRuleSnapshot {
  return {
    ruleId: rule.id,
    name: rule.name,
    scoreboard: rule.scoreboard,
    source: rule.source,
  };
}
