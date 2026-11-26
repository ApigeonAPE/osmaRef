import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertMayumiToTournament,
  parseTournament,
  type MayumiSnapshot,
} from '@osmaref/contracts';

function base(overrides: Partial<MayumiSnapshot> = {}): MayumiSnapshot {
  return {
    info: {
      name: 'Test Cup',
      abbreviation: 'TESTCUP',
      mode: 'mania',
      is_group: true,
      status: 'approved',
    },
    players: {
      groups: [
        { name: 'Alpha', members: [11, 12], captains: [10] },
        { name: 'Beta', members: [21], captains: [20] },
      ],
      players: [
        { uid: 10, name: 'Captain A', player: true },
        { uid: 11, name: 'Member A', player: true },
        { uid: 12, name: 'Member A2', player: true },
        { uid: 20, name: 'Captain B', player: true },
        { uid: 21, name: 'Member B', player: true },
        { uid: 99, name: 'Referee', player: false },
      ],
    },
    schedule: [
      {
        stage_name: 'Quarterfinal',
        is_lobby: false,
        match_info: [
          {
            match_id: 'q1',
            datetime: '2026-11-01T13:00:00Z',
            team1: { uid: [10], name: 'Alpha' },
            team2: { uid: [20], name: 'Beta' },
            team1_score: 5,
            team2_score: 2,
            is_winner_bracket: true,
          },
        ],
        lobby_info: [],
      },
    ],
    mapPools: [
      {
        stage_name: 'Quarterfinal',
        mod_bracket: [
          {
            mod: 'NM',
            maps: [
              { map_id: 101, map_name: 'Song One', mapper: 'Mapper', diff_name: 'Insane' },
              { map_id: 102, map_name: 'Song Two', mapper: 'Mapper' },
            ],
          },
          { mod: 'TB', maps: [{ map_id: 103, map_name: 'Tiebreaker' }] },
          { mod: 'FM', maps: [{ map_id: 104, map_name: 'Free' }] },
        ],
      },
    ],
    roundInfo: [
      { stage_name: 'Quarterfinal', is_lobby: false, is_solo_qualifier: false },
    ],
    draw: {
      format: 'single',
      entrants: [
        { id: 'team:Alpha', name: 'Alpha' },
        { id: 'team:Beta', name: 'Beta' },
      ],
      rounds: [
        { id: 'R1', name: 'Quarterfinal', bracket: 'winner', best_of: 7, stage_name: 'Quarterfinal' },
      ],
      matches: [],
    },
    bracket: null,
    ...overrides,
  };
}

function parse(tournament: ReturnType<typeof convertMayumiToTournament>['tournament']): void {
  const parsed = parseTournament(tournament);
  if (!parsed.success) {
    throw new Error(JSON.stringify(parsed.error.issues, null, 2));
  }
}

describe('Mayumi import', () => {
  it('converts a team tournament', () => {
    const { tournament, notes } = convertMayumiToTournament(base(), { platform: 'stable' });
    parse(tournament);

    expect(tournament.teams.map((team) => team.name)).toEqual(['Alpha', 'Beta']);
    expect(tournament.teams[0]!.members.map((member) => member.userId)).toEqual([10, 11, 12]);
    expect(tournament.teams[0]!.captainUserId).toBe(10);
    expect(tournament.teams[0]!.seed).toBe(1);
    expect(tournament.teams[1]!.seed).toBe(2);
    expect(tournament.teamSize).toBe(3);
    expect(tournament.mode).toBe('mania');

    expect(tournament.stages).toHaveLength(1);
    const stage = tournament.stages[0]!;
    expect(stage.name).toBe('Quarterfinal');
    expect(stage.type).toBe('knockout');
    expect(stage.bestOf).toBe(7);
    expect(stage.bans).toBe(0);
    expect(stage.slots.map((slot) => slot.label)).toEqual(['NM1', 'NM2', 'TB', 'FM']);
    expect(stage.slots[0]!.beatmap?.title).toBe('Song One');
    expect(stage.matches).toHaveLength(1);
    const match = stage.matches[0]!;
    expect(match.type).toBe('match');
    if (match.type === 'match') {
      expect(match.teamRedId).toBe(0);
      expect(match.teamBlueId).toBe(1);
      expect(match.result).toEqual({ scoreRed: 5, scoreBlue: 2 });
      expect(match.scheduledAt).toBe('2026-11-01T13:00:00.000Z');
    }
    expect(notes).toEqual([]);
  });

  it('reads best-of and bans from the bracket configuration', () => {
    const { tournament } = convertMayumiToTournament(
      base({
        bracket: {
          settings: { rounds: { Quarterfinal: { bestOf: 9, banCount: 2 } } },
        },
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages[0]!.bestOf).toBe(9);
    expect(tournament.stages[0]!.bans).toBe(2);
    expect(tournament.stages[0]!.flow.phases[0]).toMatchObject({
      action: 'ban',
      useStageCount: true,
    });
  });

  it('maps FM by platform', () => {
    const stable = convertMayumiToTournament(base(), { platform: 'stable' }).tournament;
    const stableFm = stable.stages[0]!.slots.find((slot) => slot.category === 'FM');
    expect(stableFm?.freemod).toBe(true);
    expect(stableFm?.freestyle).toBe(false);

    const lazer = convertMayumiToTournament(base(), { platform: 'lazer' }).tournament;
    const lazerFm = lazer.stages[0]!.slots.find((slot) => slot.category === 'FM');
    expect(lazerFm?.freemod).toBe(false);
    expect(lazerFm?.freestyle).toBe(true);
    expect(lazer.stages[0]!.winCondition).toBe('score');
  });

  it('normalises pool codes and rulesets', () => {
    const { tournament } = convertMayumiToTournament(
      base({
        mapPools: [
          {
            stage_name: 'Quarterfinal',
            mod_bracket: [
              { mod: 'O!M4K', maps: [{ map_id: 201 }] },
              { mod: 'HD', maps: [{ map_id: 202 }] },
            ],
          },
        ],
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    const slots = tournament.stages[0]!.slots;
    expect(slots.map((slot) => slot.category)).toEqual(['OM4K', 'HD']);
    expect(slots[0]!.rulesetId).toBe(3);
    expect(slots[0]!.requiredMods).toEqual([]);
    expect(slots[1]!.requiredMods).toEqual(['HD']);
    expect(slots[0]!.label).toBe('OM4K');

    const taiko = convertMayumiToTournament(
      base({
        mapPools: [
          {
            stage_name: 'Quarterfinal',
            mod_bracket: [
              { mod: 'TAIKO', maps: [{ map_id: 301 }] },
              { mod: 'STD', maps: [{ map_id: 302 }] },
            ],
          },
        ],
      }),
      { platform: 'stable' },
    );
    expect(taiko.tournament.stages[0]!.slots.map((slot) => slot.category)).toEqual([
      'TAIKO',
      'STD',
    ]);
    expect(taiko.tournament.stages[0]!.slots[0]!.rulesetId).toBe(1);
    expect(slots[1]!.label).toBe('HD');
  });

  it('adjusts an even best-of and caps bans', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({
        draw: {
          entrants: [],
          rounds: [{ id: 'R1', stage_name: 'Quarterfinal', best_of: 6 }],
          matches: [],
        },
        bracket: { settings: { rounds: { Quarterfinal: { banCount: 40 } } } },
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages[0]!.bestOf).toBe(7);
    expect(tournament.stages[0]!.bans).toBe(10);
    expect(notes.some((note) => note.includes('adjusted to 7'))).toBe(true);
  });

  it('falls back to 9 when no best-of is published', () => {
    const { tournament } = convertMayumiToTournament(
      base({ draw: { entrants: [], rounds: [], matches: [] } }),
      { platform: 'stable' },
    );
    expect(tournament.stages[0]!.bestOf).toBe(9);
  });

  it('stores a forfeit as 0:0 and notes it', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({
        schedule: [
          {
            stage_name: 'Quarterfinal',
            match_info: [
              {
                match_id: 'q1',
                datetime: '2026-11-01T13:00:00Z',
                team1: { uid: [10], name: 'Alpha' },
                team2: { uid: [20], name: 'Beta' },
                team1_score: -1,
                team2_score: 0,
              },
            ],
          },
        ],
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    const match = tournament.stages[0]!.matches[0]!;
    expect(match.result).toEqual({ scoreRed: 0, scoreBlue: 0 });
    expect(notes.some((note) => note.includes('forfeit'))).toBe(true);
  });

  it('skips matches without decided teams', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({
        schedule: [
          {
            stage_name: 'Quarterfinal',
            match_info: [
              {
                match_id: 'q1',
                datetime: '2026-11-01T13:00:00Z',
                team1: null,
                team2: null,
              },
            ],
          },
        ],
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages[0]!.matches).toHaveLength(0);
    expect(notes.some((note) => note.includes('no decided teams'))).toBe(true);
  });

  it('matches teams by captain uid before falling back to the name', () => {
    const { tournament } = convertMayumiToTournament(
      base({
        schedule: [
          {
            stage_name: 'Quarterfinal',
            match_info: [
              {
                match_id: 'q1',
                datetime: '2026-11-01T13:00:00Z',
                // Renamed teams: only the captain uid still identifies them.
                team1: { uid: [10], name: 'Alpha (old name)' },
                team2: { uid: [20], name: 'Beta (old name)' },
              },
            ],
          },
        ],
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages[0]!.matches).toHaveLength(1);
  });

  it('keeps working when the schedule and pool are empty', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({ schedule: null, mapPools: null, roundInfo: null, draw: null }),
      { platform: 'lazer' },
    );
    parse(tournament);
    expect(tournament.stages).toEqual([]);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('maps mode all to multi', () => {
    const { tournament } = convertMayumiToTournament(
      base({ info: { name: 'Multi', abbreviation: 'MULTI', mode: 'all', is_group: true } }),
      { platform: 'stable' },
    );
    expect(tournament.mode).toBe('multi');
  });

  it('drops the solo qualifier when team rosters exist', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({
        schedule: [
          {
            stage_name: 'Qualifier',
            is_lobby: true,
            lobby_info: [
              {
                lobby_name: 'Lobby A',
                match_id: 'l1',
                datetime: '2026-10-01T12:00:00Z',
                participants: [{ uid: [99], name: 'Referee' }],
              },
            ],
          },
          {
            stage_name: 'Quarterfinal',
            is_lobby: false,
            match_info: [
              {
                match_id: 'q1',
                datetime: '2026-11-01T13:00:00Z',
                team1: { uid: [10], name: 'Alpha' },
                team2: { uid: [20], name: 'Beta' },
              },
            ],
          },
        ],
        roundInfo: [
          { stage_name: 'Qualifier', is_lobby: true, is_solo_qualifier: true },
          { stage_name: 'Quarterfinal', is_lobby: false },
        ],
      }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages.map((stage) => stage.name)).toEqual(['Quarterfinal']);
    expect(notes.some((note) => note.includes('Dropped qualifier'))).toBe(true);
  });

  it('builds one-person teams from lobby participants when nobody is grouped', () => {
    const { tournament } = convertMayumiToTournament(
      {
        info: { name: 'Solo Cup', abbreviation: 'SOLO', mode: 'mania', is_group: false },
        players: {
          groups: null,
          players: [
            { uid: 501, name: 'Solo A', player: true },
            { uid: 502, name: 'Solo B', player: true },
            { uid: 503, name: 'Staff', player: false },
          ],
        },
        schedule: [
          {
            stage_name: 'Qualifier',
            is_lobby: true,
            lobby_info: [
              {
                lobby_name: 'Lobby A',
                match_id: 'l1',
                datetime: '2026-10-01T12:00:00Z',
                participants: [{ uid: [501], name: 'Solo A' }, { uid: [502], name: 'Solo B' }],
              },
            ],
            match_info: [],
          },
        ],
        mapPools: null,
        roundInfo: [{ stage_name: 'Qualifier', is_lobby: true, is_solo_qualifier: true }],
        draw: null,
        bracket: null,
      },
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.teamSize).toBe(1);
    expect(tournament.teams.map((team) => team.name)).toEqual(['Solo A', 'Solo B']);
    const match = tournament.stages[0]!.matches[0]!;
    expect(match.type).toBe('lobby');
    if (match.type === 'lobby') {
      expect(match.roomMode).toBe('head_to_head');
      expect(match.teamIds).toEqual([0, 1]);
    }
  });

  it('creates a stage without a pool when the pool stage is missing', () => {
    const { tournament, notes } = convertMayumiToTournament(
      base({ mapPools: [] }),
      { platform: 'stable' },
    );
    parse(tournament);
    expect(tournament.stages[0]!.slots).toEqual([]);
    expect(notes.some((note) => note.includes('no published mappool'))).toBe(false);
  });

  it('notes a missing draw', () => {
    const { tournament, notes } = convertMayumiToTournament(base({ draw: null }), {
      platform: 'stable',
    });
    parse(tournament);
    expect(notes.some((note) => note.includes('draw is not published'))).toBe(true);
  });
});

describe('Mayumi import: NOC26FALL snapshot', () => {
  const snapshot = JSON.parse(
    readFileSync(resolve(process.cwd(), 'tests/fixtures/mayumi-nocfall.json'), 'utf8'),
  ) as MayumiSnapshot;

  const { tournament, notes } = convertMayumiToTournament(snapshot, { platform: 'stable' });

  it('converts the real tournament', () => {
    parse(tournament);
    expect(tournament.teams).toHaveLength(4);
    for (const team of tournament.teams) {
      expect(team.members).toHaveLength(4);
      expect(team.members[0]!.userId).toBe(team.captainUserId);
    }
    expect(tournament.teamSize).toBe(4);
    expect(tournament.mode).toBe('mania');
  });

  it('drops the solo qualifier and keeps the knockout stages', () => {
    expect(tournament.stages.map((stage) => stage.name)).toEqual(['半决赛', '决赛', '总决赛']);
    expect(tournament.stages.map((stage) => stage.bestOf)).toEqual([9, 11, 13]);
    expect(tournament.stages.map((stage) => stage.slots.length)).toEqual([13, 15, 17]);
    expect(notes.some((note) => note.includes('Dropped qualifier'))).toBe(true);
  });

  it('keeps every scheduled match with its score and time', () => {
    const matches = tournament.stages.flatMap((stage) => stage.matches);
    expect(matches).toHaveLength(6);
    const first = matches[0]!;
    expect(first.scheduledAt).toBe('2026-10-17T13:00:00.000Z');
    expect(first.result).toEqual({ scoreRed: 2, scoreBlue: 5 });
    for (const match of matches) {
      expect(match.type).toBe('match');
      if (match.type === 'match' && match.notes?.includes('losers bracket')) {
        expect(match.notes).toContain('Mayumi match');
      }
    }
  });

  it('keeps pool labels in pool order per category', () => {
    const slots = tournament.stages[0]!.slots;
    const labels = slots.map((slot) => slot.label);
    expect(labels.every((label) => /^[A-Z0-9]+$/.test(label))).toBe(true);
    const tb = slots.filter((slot) => slot.category === 'TB');
    expect(tb).toHaveLength(1);
    expect(tb[0]!.label).toBe('TB');
  });
});
