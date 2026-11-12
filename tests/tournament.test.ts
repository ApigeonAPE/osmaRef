import { describe, expect, it } from 'vitest';
import {
  TournamentSchema,
  createEmptyTournament,
  findSlotByLabel,
  normalizeSlotLabel,
  parseTournament,
  renderRoomName,
  validateTournamentReferences,
  type MappoolSlot,
} from '@osmaref/contracts';

function slot(overrides: Partial<MappoolSlot> & Pick<MappoolSlot, 'id' | 'label' | 'beatmapId'>): MappoolSlot {
  return {
    category: 'NM',
    rulesetId: null,
    requiredMods: [],
    allowedMods: [],
    freestyle: false,
    winCondition: null,
    winConditionWinner: null,
    ...overrides,
  };
}

describe('tournament schema (stages v3)', () => {
  it('accepts a freshly created tournament', () => {
    const tournament = createEmptyTournament('Test Cup');
    const parsed = TournamentSchema.safeParse(tournament);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data.stages[0]?.flow.steps.length).toBeGreaterThan(0);
    expect(parsed.data.teams[0]).not.toHaveProperty('color');
    expect(parsed.data.teams.map((team) => team.id)).toEqual([0, 1]);
    expect(parsed.data.mode).toBe('osu');
    expect(parsed.data.teamSize).toBe(4);
  });

  it('rejects duplicate slot labels in one stage', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'NM1', beatmapId: 1 }),
      slot({ id: 's2', label: 'nm1', beatmapId: 2 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects freestyle slots that also declare allowed mods', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'FM1', category: 'FM', beatmapId: 1, allowedMods: ['HD'], freestyle: true }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects the same beatmap twice in one stage', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'NM1', beatmapId: 42 }),
      slot({ id: 's2', label: 'NM2', beatmapId: 42 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects a category that does not match its required mods', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'HD1', category: 'HD', beatmapId: 1 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts arbitrary category codes such as mania RC/LN/SV', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'RC1', category: 'RC', beatmapId: 1 }),
      slot({ id: 's2', label: 'LN1', category: 'LN', beatmapId: 2 }),
      slot({ id: 's3', label: 'SV1', category: 'SV', beatmapId: 3 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('reports dangling team and group references with a path', () => {
    const tournament = createEmptyTournament('Test Cup');
    const stage = tournament.stages[0]!;
    stage.matches.push({
      id: 'm1',
      type: 'match',
      name: 'A vs B',
      groupId: 'missing_group',
      teamRedId: 0,
      teamBlueId: 99,
      refereeIds: [],
      transport: 'referee_hub',
      scheduledAt: '2026-01-01T00:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'team_versus',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
    });
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/unknown group/);
    expect(messages).toMatch(/unknown team 99/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires an odd bestOf on a stage', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.bestOf = 8;
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires a UTC timestamp on every match', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.matches.push({
      id: 'm1',
      type: 'match',
      name: 'A vs B',
      groupId: null,
      teamRedId: 0,
      teamBlueId: 1,
      refereeIds: [],
      transport: 'irc',
      scheduledAt: '2026-01-01T08:00:00+08:00',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'team_versus',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires at least three teams in a lobby fixture', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.matches.push({
      id: 'm1',
      type: 'lobby',
      name: 'Multi lobby',
      groupId: null,
      teamIds: [0, 1],
      refereeIds: [],
      transport: 'irc',
      scheduledAt: '2026-01-01T00:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'head_to_head',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts a lobby fixture with three or more teams', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.teams.push({ id: 2, name: 'Team 3', captainUserId: null, members: [], seed: null });
    tournament.stages[0]!.matches.push({
      id: 'm1',
      type: 'lobby',
      name: 'Multi lobby',
      groupId: null,
      teamIds: [0, 1, 2],
      refereeIds: [],
      transport: 'irc',
      scheduledAt: '2026-01-01T00:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'head_to_head',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('normalises slot labels for lookup', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'DT2', category: 'DT', beatmapId: 42, requiredMods: ['DT'] }),
    ];
    const stage = tournament.stages[0]!;
    expect(normalizeSlotLabel(' dt2 ')).toBe('DT2');
    expect(findSlotByLabel(stage, 'dt2')?.beatmapId).toBe(42);
  });

  it('renders room name templates', () => {
    expect(
      renderRoomName('{tournament}: ({team_one}) vs ({team_two})', {
        tournament: 'Cup',
        stage: 'R1',
        team_one: 'Red',
        team_two: 'Blue',
      }),
    ).toBe('Cup: (Red) vs (Blue)');
  });
});

describe('teams, groups and captains', () => {
  it('requires the captain to belong to the roster', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.teams[0]!.captainUserId = 5;
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/not a member/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts a captain from the roster and a numeric seed', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.teams[0] = {
      id: 0,
      name: 'Alpha',
      captainUserId: 5,
      members: [{ userId: 5, username: 'captain' }],
      seed: 1,
    };
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('rejects duplicate team ids', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.teams[1] = { ...tournament.teams[1]!, id: 0 };
    expect(validateTournamentReferences(tournament).length).toBeGreaterThan(0);
  });

  it('assigns a team to at most one group per stage', () => {
    const tournament = createEmptyTournament('Test Cup');
    const stage = tournament.stages[0]!;
    stage.type = 'group';
    stage.groups = [
      { id: 'g1', name: 'A', teamIds: [0] },
      { id: 'g2', name: 'B', teamIds: [0] },
    ];
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/multiple groups/);
  });

  it('rejects a match whose teams are outside its group', () => {
    const tournament = createEmptyTournament('Test Cup');
    const stage = tournament.stages[0]!;
    stage.type = 'group';
    stage.groups = [{ id: 'g1', name: 'A', teamIds: [0] }];
    stage.matches.push({
      id: 'm1',
      type: 'match',
      name: 'A vs B',
      groupId: 'g1',
      teamRedId: 0,
      teamBlueId: 1,
      refereeIds: [],
      transport: 'irc',
      scheduledAt: '2026-01-01T00:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'team_versus',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
    });
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/outside group/);
  });
});

describe('legacy documents', () => {
  it('does not silently migrate v1/v2 tournaments', () => {
    const legacy = {
      schemaVersion: 2,
      id: 'legacy',
      name: 'Legacy Cup',
      abbreviation: 'LC',
      rulesetId: 0,
      teams: [],
      rounds: [],
    };
    expect(parseTournament(legacy).success).toBe(false);
  });

  it('normalises hand-edited v3 abbreviations while loading', () => {
    const stored = {
      ...createEmptyTournament('Legacy Cup'),
      abbreviation: 'a-very-long-abbreviation',
    };
    const parsed = parseTournament(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.abbreviation).toBe('A-VERY-LON');
  });
});

describe('tournament abbreviations', () => {
  it('stores the abbreviation in uppercase', () => {
    const tournament = createEmptyTournament('Test Cup');
    const parsed = TournamentSchema.safeParse({ ...tournament, abbreviation: 'ab12' });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.abbreviation).toBe('AB12');
  });

  it('rejects abbreviations longer than 10 characters', () => {
    const tournament = createEmptyTournament('Test Cup');
    expect(
      TournamentSchema.safeParse({ ...tournament, abbreviation: 'ABCDEFGHIJK' }).success,
    ).toBe(false);
    expect(
      TournamentSchema.safeParse({ ...tournament, abbreviation: 'ABCDEFGHIJ' }).success,
    ).toBe(true);
  });

  it('creates new tournaments with a short uppercase abbreviation', () => {
    const tournament = createEmptyTournament('a rather long tournament name');
    expect(tournament.abbreviation).toBe('A RATHER L');
    expect(tournament.abbreviation.length).toBeLessThanOrEqual(10);
  });
});

describe('flow steps', () => {
  it('drops the legacy "side" field and keeps count as per-team', () => {
    const tournament = createEmptyTournament('Legacy Flow');
    const raw = JSON.parse(JSON.stringify(tournament)) as {
      stages: { flow: { steps: unknown[] } }[];
    };
    raw.stages[0]!.flow.steps = [
      { id: 'legacy_ban', kind: 'ban', count: 1, side: 'team_one' },
      { id: 'legacy_pick', kind: 'pick', count: 5, side: 'both' },
    ];
    const parsed = parseTournament(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.stages[0]?.flow.steps).toEqual([
      { id: 'legacy_ban', kind: 'ban', count: 1 },
      { id: 'legacy_pick', kind: 'pick', count: 5 },
    ]);
  });
});

describe('mappool slot labels', () => {
  function withLabel(label: string) {
    const tournament = createEmptyTournament('Label Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 'slot', label, beatmapId: 1 }),
    ];
    return TournamentSchema.safeParse(tournament).success;
  }

  it('accepts key-count labels such as 4K1', () => {
    expect(withLabel('4K1')).toBe(true);
    expect(withLabel('7K2')).toBe(true);
  });

  it('still rejects labels without a letter or with illegal characters', () => {
    expect(withLabel('123')).toBe(false);
    expect(withLabel('NM 1')).toBe(false);
    expect(withLabel('A'.repeat(13))).toBe(false);
  });
});
