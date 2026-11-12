import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertBracketToTournament, parseTournament, TOURNAMENT_ID_PATTERN } from '@osmaref/contracts';

const sampleBracket = JSON.parse(
  readFileSync(resolve(process.cwd(), 'bracket.json'), 'utf8'),
) as unknown;

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
    expect(tournament.rulesetId).toBe(3);
    expect(tournament.scoringSchemes.map((scheme) => scheme.id)).toEqual(['score_default']);
  });

  it('maps teams, rosters and seeding-independent identity', () => {
    expect(tournament.teams).toHaveLength(5);
    const tfs = tournament.teams.find((team) => team.id === 'team_tfs');
    expect(tfs?.name).toBe('Team Falcoms');
    expect(tfs?.members).toHaveLength(4);
    expect(tfs?.members[0]).toEqual({
      userId: 32739668,
      username: 'AkizukiKanna225',
      captain: false,
    });
  });

  it('keeps the generated example file loadable', () => {
    const stored = JSON.parse(
      readFileSync(resolve(process.cwd(), 'examples/tournament.from-bracket.json'), 'utf8'),
    ) as unknown;
    const parsed = parseTournament(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.teams).toHaveLength(5);
    expect(parsed.data.matches).toHaveLength(7);
  });

  it('maps rounds with their pools and tiebreakers', () => {
    expect(tournament.rounds.map((round) => round.name)).toEqual([
      '资格赛',
      '半决赛',
      '决赛',
      '总决赛',
    ]);
    expect(tournament.rounds.map((round) => round.bestOf)).toEqual([5, 9, 11, 13]);
    expect(tournament.rounds.map((round) => round.order)).toEqual([0, 1, 2, 3]);

    const qualifiers = tournament.rounds[0]!;
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
    expect(qualifiers.slots.every((slot) => slot.rulesetId === 3)).toBe(true);

    const semifinal = tournament.rounds[1]!;
    const tiebreaker = semifinal.slots.find((slot) => slot.label === 'TB');
    expect(tiebreaker?.category).toBe('TB');
    expect(tiebreaker?.requiredMods).toEqual([]);
  });

  it('derives a pick/ban flow from best-of and ban count', () => {
    expect(tournament.rounds[0]!.flow.steps).toEqual([
      { id: 'step_ban_round_1', kind: 'ban', count: 1, side: 'both' },
      { id: 'step_pick_round_1', kind: 'pick', count: 3, side: 'both' },
    ]);
    expect(tournament.rounds[3]!.flow.steps[1]?.count).toBe(7);
  });

  it('maps matches to their round, teams and schedule', () => {
    expect(tournament.matches).toHaveLength(7);

    const matchTwo = tournament.matches.find((match) => match.id === 'match_2');
    expect(matchTwo?.roundId).toBe('round_3');
    expect(matchTwo?.teamOneId).toBe('team_smw');
    expect(matchTwo?.teamTwoId).toBe('team_idk');
    expect(matchTwo?.scheduledAt).toBe('2026-10-25T13:00:00.000Z');
    expect(matchTwo?.initialBeatmapId).toBe(3989898);
    expect(matchTwo?.notes).toContain('score 5-6');

    const firstMatch = tournament.matches.find((match) => match.id === 'match_1');
    expect(firstMatch?.roundId).toBe('round_2');
    expect(firstMatch?.initialBeatmapId).toBe(3273376);
  });
});

describe('bracket conversion edge cases', () => {
  interface TestBracket {
    Ruleset: { OnlineID: number };
    Teams: { Acronym: string; FullName: string; Players: { id: number; Username: string }[] }[];
    Rounds: {
      Name: string;
      BestOf: number;
      BanCount?: number;
      Beatmaps: { ID: number; Mods: string }[];
      Matches: number[];
      StartDate?: string;
    }[];
    Matches: { ID: number; Team1Acronym: string; Team2Acronym: string; Date: string }[];
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
    expect(tournament.rounds[0]?.bestOf).toBe(9);
    expect(notes.join('\n')).toMatch(/best-of 8/);
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('skips duplicate beatmaps in one round', () => {
    const { tournament, notes } = convertBracketToTournament(baseDocument());
    expect(tournament.rounds[0]?.slots).toHaveLength(1);
    expect(tournament.rounds[0]?.slots[0]?.beatmapId).toBe(10);
    expect(notes.join('\n')).toMatch(/beatmap 10 twice/);
  });

  it('skips matches with an unknown team', () => {
    const document = baseDocument();
    document.Matches = [
      { ID: 2, Team1Acronym: 'A', Team2Acronym: 'ZZZ', Date: '2026-01-01T00:00:00Z' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    expect(tournament.matches).toHaveLength(0);
    expect(notes.join('\n')).toMatch(/not in the bracket/);
  });

  it('assigns a match that no round lists by its date', () => {
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
    expect(tournament.matches[0]?.roundId).toBe('round_late');
    expect(tournament.matches[0]?.initialBeatmapId).toBe(20);
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
    const slots = tournament.rounds[0]!.slots;
    expect(slots[0]?.requiredMods).toEqual(['HD']);
    expect(slots[1]?.freestyle).toBe(true);
    expect(slots[2]?.label).toBe('TB');
    expect(parseTournament(tournament).success).toBe(true);
  });

  it('normalises mod codes that cannot prefix a slot label', () => {
    const document = baseDocument();
    document.Rounds[0]!.Beatmaps = [
      { ID: 1, Mods: 'V2HD' },
      { ID: 2, Mods: '2' },
    ];
    const { tournament, notes } = convertBracketToTournament(document);
    expect(tournament.rounds[0]?.slots.map((slot) => slot.label)).toEqual(['VHD1', 'NM1']);
    expect(notes.join('\n')).toMatch(/normalised/);
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
      Teams: [
        { Acronym: 'CN', FullName: 'China', Players: [{ id: 1 }] },
        { Acronym: 'APAC', FullName: 'Asia-Pacific', Players: [{ id: 2 }] },
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
    expect(tournament.rulesetId).toBe(2);
    expect(tournament.matches).toHaveLength(1);
    expect(tournament.matches[0]?.teamOneId).toBe('team_cn');
    expect(tournament.matches[0]?.teamTwoId).toBe('team_apac');
    expect(tournament.matches[0]?.scheduledAt).toBe('2026-10-25T07:00:00.000Z');
    expect(tournament.rounds[0]?.slots.map((slot) => slot.label)).toEqual(['NM1', 'TB']);
    expect(notes.join('\n')).toMatch(/1 bracket match\(es\) have undecided teams/);
  });

  it('keeps decided matches when some matches are still TBD', () => {
    const { tournament } = convertBracketToTournament(document());
    expect(tournament.matches.map((match) => match.id)).toEqual(['match_1']);
  });
});
