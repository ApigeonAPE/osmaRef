import { describe, expect, it } from 'vitest';
import {
  TournamentSchema,
  buildRoomName,
  composeSlotLabel,
  createEmptyTournament,
  findSlotByLabel,
  normalizeSlotLabel,
  parseTournament,
  slotLabelSequence,
  validateTournamentReferences,
  type MappoolSlot,
} from '@osmaref/contracts';

function slot(overrides: Partial<MappoolSlot> & Pick<MappoolSlot, 'id' | 'label' | 'beatmapId'>): MappoolSlot {
  return {
    category: 'NM',
    beatmap: null,
    rulesetId: null,
    requiredMods: [],
    allowedMods: [],
    freestyle: false,
    freemod: false,
    ...overrides,
  };
}

function twoTeamMatch(id = 'm1') {
  return {
    id,
    type: 'match' as const,
    groupId: null,
    teamRedId: 0,
    teamBlueId: 1,
    refereeIds: [],
    scheduledAt: '2026-01-01T00:00:00.000Z',
    result: { scoreRed: 0, scoreBlue: 0 },
    roomMode: 'team_versus' as const,
  };
}

describe('room names', () => {
  it('uses the abbreviation and bracketed team names', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.abbreviation = 'TC';
    tournament.teams = [
      { id: 0, name: 'Alpha', captainUserId: null, members: [], seed: null },
      { id: 1, name: 'Beta', captainUserId: null, members: [], seed: null },
    ];
    const stage = tournament.stages[0]!;
    const match = { ...twoTeamMatch('m1'), teamRedId: 0, teamBlueId: 1 };
    expect(buildRoomName(tournament, stage, match)).toBe('TC: (Alpha) vs (Beta)');
  });

  it('numbers lobby rooms within the stage', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.abbreviation = 'TC';
    const stage = tournament.stages[0]!;
    const lobby = (id: string) => ({
      ...twoTeamMatch(id),
      type: 'lobby' as const,
      teamIds: [0, 1],
    });
    stage.matches = [lobby('l1'), twoTeamMatch('m1'), lobby('l2')];
    expect(buildRoomName(tournament, stage, stage.matches[2]!)).toBe('TC: (Lobby) vs (#3)');
  });
});

describe('tournament schema (stages v4)', () => {
  it('accepts a freshly created tournament', () => {
    const tournament = createEmptyTournament('Test Cup');
    const parsed = TournamentSchema.safeParse(tournament);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data.platform).toBe('stable');
    expect(parsed.data.stages[0]?.flow.phases.map((phase) => phase.action)).toEqual([
      'ban',
      'pick',
    ]);
    expect(parsed.data.stages[0]?.bans).toBe(1);
    expect(parsed.data.stages[0]?.flow.phases[1]?.countPerTeam).toBeNull();
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

  it('accepts a category without matching required mods', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'HD1', category: 'HD', beatmapId: 1 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
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
      ...twoTeamMatch(),
      groupId: 'missing_group',
      teamBlueId: 99,
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
      ...twoTeamMatch(),
      scheduledAt: '2026-01-01T08:00:00+08:00',
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires at least one team in a lobby fixture', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.matches.push({
      ...twoTeamMatch(),
      type: 'lobby',
      teamIds: [],
      roomMode: 'head_to_head',
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts a lobby fixture with one or two teams', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.matches.push({
      ...twoTeamMatch(),
      type: 'lobby',
      teamIds: [0],
      roomMode: 'head_to_head',
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
    tournament.stages[0]!.matches[0] = {
      ...twoTeamMatch(),
      type: 'lobby',
      teamIds: [0, 1],
      roomMode: 'head_to_head',
    };
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('accepts a lobby fixture with three or more teams', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.teams.push({ id: 2, name: 'Team 3', captainUserId: null, members: [], seed: null });
    tournament.stages[0]!.matches.push({
      ...twoTeamMatch(),
      type: 'lobby',
      teamIds: [0, 1, 2],
      roomMode: 'head_to_head',
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
});

describe('platform room options', () => {
  it('rejects tag team modes on lazer', () => {
    const tournament = createEmptyTournament('Lazer Cup');
    tournament.platform = 'lazer';
    tournament.stages[0]!.matches.push({
      ...twoTeamMatch(),
      roomMode: 'tag_coop',
    });
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/not available on the lazer platform/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('ignores the room win condition on lazer', () => {
    const tournament = createEmptyTournament('Lazer Cup');
    tournament.platform = 'lazer';
    tournament.stages[0]!.winCondition = 'score_v2';
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
    tournament.stages[0]!.winCondition = 'combo';
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
    tournament.stages[0]!.winCondition = 'accuracy';
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('defaults a missing room win condition to Score', () => {
    const tournament = createEmptyTournament('Lazer Cup');
    tournament.platform = 'lazer';
    const raw = JSON.parse(JSON.stringify(tournament)) as {
      stages: { winCondition?: string }[];
    };
    delete raw.stages[0]!.winCondition;
    const parsed = TournamentSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.stages[0]?.winCondition).toBe('score');
  });

  it('migrates a stored lazer room condition without applying it', () => {
    const tournament = createEmptyTournament('Lazer Cup');
    tournament.platform = 'lazer';
    tournament.stages[0]!.matches.push(twoTeamMatch());
    const raw = JSON.parse(JSON.stringify(tournament)) as {
      schemaVersion: number;
      stages: { winCondition?: string; winByRuleId?: string; matches: { winCondition?: string }[] }[];
    };
    raw.schemaVersion = 4;
    const stage = raw.stages[0]!;
    delete stage.winCondition;
    delete stage.winByRuleId;
    stage.matches[0]!.winCondition = 'score_v2';
    const parsed = parseTournament(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.stages[0]?.winCondition).toBe('score_v2');
  });

  it('accepts all room options on stable', () => {
    const tournament = createEmptyTournament('Stable Cup');
    tournament.stages[0]!.winCondition = 'combo';
    tournament.stages[0]!.matches.push({
      ...twoTeamMatch(),
      roomMode: 'tag_team_versus',
    });
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
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
      ...twoTeamMatch(),
      groupId: 'g1',
    });
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/outside group/);
  });
});

describe('legacy documents', () => {
  it('does not silently migrate v1/v2/v3 tournaments', () => {
    for (const schemaVersion of [1, 2, 3]) {
      const legacy = {
        schemaVersion,
        id: 'legacy',
        name: 'Legacy Cup',
        abbreviation: 'LC',
        rounds: [],
      };
      expect(parseTournament(legacy).success).toBe(false);
    }
  });

  it('normalises hand-edited v4 abbreviations while loading', () => {
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

describe('match flow phases', () => {
  it('requires pick phases to be auto-sized', () => {
    const tournament = createEmptyTournament('Phase Cup');
    tournament.stages[0]!.flow.phases = [
      {
        id: 'pick',
        action: 'pick',
        countPerTeam: 5,
        useStageCount: false,
        phaseOrder: 'alternate',
      },
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires a pick phase and rejects empty flows', () => {
    const tournament = createEmptyTournament('Phase Cup');
    tournament.stages[0]!.flow.phases = [
      {
        id: 'ban',
        action: 'ban',
        countPerTeam: 1,
        useStageCount: false,
        phaseOrder: 'alternate',
      },
    ];
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/needs a pick phase/);
    tournament.stages[0]!.flow.phases = [];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects a stage-count phase when the stage allows no actions', () => {
    const tournament = createEmptyTournament('Phase Cup');
    tournament.stages[0]!.bans = 0;
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/stage allows no bans/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts sequential ban phases', () => {
    const tournament = createEmptyTournament('Phase Cup');
    tournament.stages[0]!.flow.phases[0]!.phaseOrder = 'sequential';
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
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

  it('splits and composes sequence numbers', () => {
    expect(slotLabelSequence('HB2')).toBe('2');
    expect(slotLabelSequence('4K10')).toBe('10');
    expect(slotLabelSequence('TB')).toBe('');
    expect(composeSlotLabel('HB', '2')).toBe('HB2');
    expect(composeSlotLabel('4K', '10')).toBe('4K10');
    expect(composeSlotLabel('TB', '3')).toBe('TB3');
  });

  it('accepts tiebreaker slots with a sequence number', () => {
    const tournament = createEmptyTournament('Label Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: 'TB3', category: 'TB', beatmapId: 1 }),
    ];
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).not.toMatch(/tiebreaker slots/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('reports a blank slot created by the editor', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.stages[0]!.slots = [
      slot({ id: 's1', label: '', category: '', beatmapId: 0 }),
    ];
    const messages = validateTournamentReferences(tournament)
      .map((issue) => issue.message)
      .join('\n');
    expect(messages).toMatch(/slot label is empty/);
    expect(messages).toMatch(/slot category is empty/);
    expect(messages).toMatch(/beatmap id must be a positive number/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });
});
