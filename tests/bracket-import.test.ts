import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertBracketToTournament,
  matchTeamIds,
  parseTournament,
  TOURNAMENT_ID_PATTERN,
} from '@osmaref/contracts';

const sampleBracket = JSON.parse(
  readFileSync(resolve(process.cwd(), 'bracket.json'), 'utf8'),
) as unknown;

function allMatches(tournament: ReturnType<typeof convertBracketToTournament>['tournament']) {
  return tournament.stages.flatMap((stage) => stage.matches);
}

describe('osu! tournament bracket import', () => {
  const { tournament, notes } = convertBracketToTournament(sampleBracket, {
    name: 'PTCT 6.5',
  });

  it('converts the sample bracket into a storable tournament', () => {
    const parsed = parseTournament(tournament);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(notes).toEqual([]);
    expect(tournament.id).toMatch(TOURNAMENT_ID_PATTERN);
    expect(tournament.mode).toBe('mania');
    expect(tournament.teamSize).toBe(4);
    expect(tournament.stages.every((stage) => stage.scoringScheme.winCondition === 'score_v2')).toBe(
      true,
    );
  });

  it('maps teams with zero-based ids, rosters and seeds', () => {
    expect(tournament.teams).toHaveLength(5);
    const tfs = tournament.teams.find((team) => team.id === 0);
    expect(tfs?.name).toBe('Team Falcoms');
    expect(tfs?.members).toHaveLength(4);
    expect(tfs?.members[0]).toEqual({ userId: 32739668, username: 'AkizukiKanna225' });
    expect(tfs?.seed).toBe(1);
    expect(tfs?.captainUserId).toBeNull();
  });

  it('keeps the generated example file loadable', () => {
    const stored = JSON.parse(
      readFileSync(resolve(process.cwd(), 'examples/tournament.from-bracket.json'), 'utf8'),
    ) as unknown;
    const parsed = parseTournament(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.teams).toHaveLength(5);
    expect(parsed.data.stages).toHaveLength(4);
    expect(allMatches(parsed.data)).toHaveLength(7);
  });

  it('maps rounds to stages with their pools and tiebreakers', () => {
    expect(tournament.stages.map((stage) => stage.name)).toEqual([
      '资格赛',
      '半决赛',
      '决赛',
      '总决赛',
    ]);
    expect(tournament.stages.map((stage) => stage.bestOf)).toEqual([5, 9, 11, 13]);
    expect(tournament.stages.map((stage) => stage.order)).toEqual([0, 1, 2, 3]);

    const qualifiers = tournament.stages[0]!;
    expect(qualifiers.slots).toHaveLength(8);
    expect(qualifiers.slots.map((slot) => slot.label)).toEqual([
      'HB1',
      'HB2',
      'LN1',
      'LN2',
      'RC1',
      'RC2',
      'RC3',
      'SV1',
    ]);

    const semifinal = tournament.stages[1]!;
    const tiebreaker = semifinal.slots.find((slot) => slot.label === 'TB');
    expect(tiebreaker?.category).toBe('TB');
    expect(tiebreaker?.requiredMods).toEqual([]);
  });

  it('derives phase-based flows and stage ban counts from the bracket', () => {
    const first = tournament.stages[0]!;
    expect(first.bans).toBe(1);
    expect(first.flow.phases.map((phase) => phase.action)).toEqual(['ban', 'pick']);
    expect(first.flow.phases[0]?.useStageCount).toBe(true);
    expect(first.flow.phases[1]?.countPerTeam).toBeNull();
    expect(tournament.stages[3]!.bans).toBe(1);
    expect(tournament.platform).toBe('stable');
  });

  it('nests matches under their stage with numeric teams and results', () => {
    const matches = allMatches(tournament);
    expect(matches).toHaveLength(7);

    const matchTwo = matches.find((match) => match.id === 'match_2');
    expect(matchTwo?.type).toBe('match');
    expect(tournament.stages[2]!.matches).toContain(matchTwo);
    if (matchTwo?.type !== 'match') throw new Error('expected a two-team match');
    expect(matchTwo.teamRedId).toBe(3);
    expect(matchTwo.teamBlueId).toBe(1);
    expect(matchTwo.scheduledAt).toBe('2026-10-25T13:00:00.000Z');
    expect(matchTwo.result).toEqual({ scoreRed: 5, scoreBlue: 6 });
    expect(matchTwo.winCondition).toBe('score_v2');
    expect(matchTwo.roomMode).toBe('team_versus');
    expect(matchTwo.notes).toContain('score 5-6');

    const firstMatch = matches.find((match) => match.id === 'match_1');
    expect(tournament.stages[1]!.matches).toContain(firstMatch);
  });
});

describe('bracket conversion edge cases', () => {
  interface TestBracket {
    Ruleset: { OnlineID: number };
    Teams: { Acronym: string; FullName: string; Players: { id: number; Username: string }[] }[];
    PlayersPerTeam?: number;
    Rounds: {
      Name: string;
      BestOf: number;
      BanCount?: number;
      Beatmaps: { ID: number; Mods: string }[];
      Matches: number[];
      StartDate?: string;
    }[];
    Matches: { ID: number; Team1Acronym: string | null; Team2Acronym: string | null; Date: string }[];
  }

  function baseDocument(): TestBracket {
    return {
      Ruleset: { OnlineID: 0 },
      Teams: [
        { Acronym: 'A', FullName: 'Alpha', Players: [{ id: 1, Username: 'a' }] },
        { Acronym: 'B', FullName: 'Beta', Players: [] },
      ],
      Rounds: [
        {
          Name: 'R1',
          BestOf: 8,
          BanCount: 1,
          Beatmaps: [
            { ID: 10, Mods: 'NM' },
            { ID: 10, Mods: 'HD' },
          ],
          Matches: [1],
        },
      ],
      Matches: [
        { ID: 1, Team1Acronym: 'A', Team2Acronym: 'B', Date: '2026-01-01T00:00:00Z' },
      ],
    };
  }

  it('fixes even best-of values and reports the adjustment', () => {
    const { tournament, notes } = convertBracketToTournament(baseDocument(), {
      name: 'Edge Cup',
    });
    expect(tournament.stages[0]?.bestOf).toBe(9);
    expect(notes.join('\n')).toMatch(/best-of 8/);
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('skips duplicate beatmaps in one stage', () => {
    const { tournament, notes } = convertBracketToTournament(baseDocument());
    expect(tournament.stages[0]?.slots).toHaveLength(1);
    expect(tournament.stages[0]?.slots[0]?.beatmapId).toBe(10);
    expect(notes.join('\n')).toMatch(/beatmap 10 twice/);
  });

  it('skips matches with an unknown team', () => {
    const document = baseDocument();
    document.Matches = [
      { ID: 2, Team1Acronym: 'A', Team2Acronym: 'ZZZ', Date: '2026-01-01T00:00:00Z' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    expect(allMatches(tournament)).toHaveLength(0);
    expect(notes.join('\n')).toMatch(/not in the bracket/);
  });

  it('assigns a match that no stage lists by its date', () => {
    const document = baseDocument();
    document.Rounds = [
      {
        Name: 'Early',
        BestOf: 5,
        Beatmaps: [{ ID: 10, Mods: 'NM' }],
        StartDate: '2026-01-01T00:00:00Z',
        Matches: [],
      },
      {
        Name: 'Late',
        BestOf: 5,
        Beatmaps: [{ ID: 20, Mods: 'NM' }],
        StartDate: '2026-02-01T00:00:00Z',
        Matches: [],
      },
    ];
    document.Matches = [
      { ID: 9, Team1Acronym: 'A', Team2Acronym: 'B', Date: '2026-02-10T00:00:00Z' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    expect(tournament.stages[1]?.matches).toHaveLength(1);
    expect(tournament.stages[1]?.slots[0]?.beatmapId).toBe(20);
    expect(notes.join('\n')).toMatch(/assigned to "Late"/);
  });

  it('translates osu! mod codes into required mods and freestyle', () => {
    const document = baseDocument();
    document.Rounds[0]!.Beatmaps = [
      { ID: 1, Mods: 'HD' },
      { ID: 2, Mods: 'FM' },
      { ID: 3, Mods: 'TB' },
    ];
    const { tournament } = convertBracketToTournament(document);
    const slots = tournament.stages[0]!.slots;
    expect(slots[0]?.requiredMods).toEqual(['HD']);
    expect(slots[1]?.freestyle).toBe(true);
    expect(slots[2]?.label).toBe('TB');
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('normalises mod codes that cannot prefix a slot label', () => {
    const document = baseDocument();
    document.Rounds[0]!.Beatmaps = [
      { ID: 1, Mods: '4K+' },
      { ID: 2, Mods: '2' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    expect(tournament.stages[0]?.slots.map((slot) => slot.label)).toEqual(['4K1', 'NM1']);
    expect(notes.join('\n')).toMatch(/normalised/);
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('keeps mania key-count mod codes instead of collapsing them to K', () => {
    const document = baseDocument();
    document.Rounds[0]!.Beatmaps = [
      { ID: 1, Mods: '4K' },
      { ID: 2, Mods: '4K' },
      { ID: 3, Mods: '7K' },
      { ID: 4, Mods: 'TB' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    const slots = tournament.stages[0]!.slots;
    expect(slots.map((slot) => slot.label)).toEqual(['4K1', '4K2', '7K1', 'TB']);
    expect(slots.map((slot) => slot.category)).toEqual(['4K', '4K', '7K', 'TB']);
    expect(notes.join('\n')).not.toMatch(/normalised/);
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('rejects files that are not brackets', () => {
    expect(() => convertBracketToTournament({ hello: 'world' })).toThrow(
      /not an osu! tournament bracket/,
    );
  });
});

describe('bracket files produced by the osu! client', () => {
  function document() {
    return {
      Ruleset: { ShortName: 'fruits', OnlineID: 2 },
      PlayersPerTeam: 3,
      Teams: [
        { Acronym: 'CN', FullName: 'China', Seed: '2', Players: [{ id: 1 }] },
        { Acronym: 'APAC', FullName: 'Asia-Pacific', Seed: null, Players: [{ id: 2 }] },
      ],
      Rounds: [
        {
          Name: 'Round of 32',
          BestOf: 9,
          BanCount: 1,
          Beatmaps: [
            { ID: 10, Mods: 'nm' },
            { ID: 11, Mods: 'tb' },
          ],
          Matches: [1, 2],
        },
      ],
      Matches: [
        {
          ID: 1,
          Team1Acronym: 'CN',
          Team1Score: 5,
          Team2Acronym: 'APAC',
          Team2Score: null,
          Completed: false,
          Losers: false,
          Date: '2026-10-25T07:00:00+00:00',
          PointsToWin: 5,
          PicksBans: [],
        },
        {
          ID: 2,
          Team1Acronym: null,
          Team1Score: null,
          Team2Acronym: null,
          Team2Score: null,
          Completed: false,
          Losers: true,
          Date: '2026-10-26T07:00:00+00:00',
          PointsToWin: 5,
          PicksBans: [],
        },
      ],
    };
  }

  it('accepts null team acronyms, null scores and lower-case mod codes', () => {
    const { tournament, notes } = convertBracketToTournament(document(), {
      name: 'World Cup',
    });
    expect(parseTournament(tournament).success).toBe(true);
    expect(tournament.mode).toBe('catch');
    expect(tournament.teamSize).toBe(3);
    expect(tournament.teams.map((team) => team.seed)).toEqual([2, null]);
    const matches = tournament.stages[0]!.matches;
    expect(matches).toHaveLength(1);
    if (matches[0]?.type !== 'match') throw new Error('expected a two-team match');
    expect(matches[0].teamRedId).toBe(0);
    expect(matches[0].teamBlueId).toBe(1);
    expect(matches[0].scheduledAt).toBe('2026-10-25T07:00:00.000Z');
    expect(matches[0].result).toEqual({ scoreRed: 5, scoreBlue: 0 });
    expect(tournament.stages[0]?.slots.map((slot) => slot.label)).toEqual(['NM1', 'TB']);
    expect(notes.join('\n')).toMatch(/1 bracket match\(es\) have undecided teams/);
  });

  it('defaults Team Size to 4 when the bracket omits PlayersPerTeam', () => {
    const source = document();
    delete (source as { PlayersPerTeam?: number }).PlayersPerTeam;
    const { tournament } = convertBracketToTournament(source);
    expect(tournament.teamSize).toBe(4);
  });
});
