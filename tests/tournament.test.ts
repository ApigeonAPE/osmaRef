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
    rulesetId: 0,
    requiredMods: [],
    allowedMods: [],
    freestyle: false,
    winCondition: null,
    winConditionWinner: null,
    ...overrides,
  };
}

describe('tournament schema (rounds v2)', () => {
  it('accepts a freshly created tournament', () => {
    const tournament = createEmptyTournament('Test Cup');
    const parsed = TournamentSchema.safeParse(tournament);
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    }
    expect(parsed.success).toBe(true);
    expect(parsed.data.rounds[0]?.flow.steps.length).toBeGreaterThan(0);
    expect(parsed.data.teams[0]).not.toHaveProperty('color');
  });

  it('rejects duplicate slot labels in one round', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'NM1', beatmapId: 1 }),
      slot({ id: 's2', label: 'nm1', beatmapId: 2 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects freestyle slots that also declare allowed mods', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'FM1', category: 'FM', beatmapId: 1, allowedMods: ['HD'], freestyle: true }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects the same beatmap twice in one round', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'NM1', beatmapId: 42 }),
      slot({ id: 's2', label: 'NM2', beatmapId: 42 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('rejects a category that does not match its required mods', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'HD1', category: 'HD', beatmapId: 1 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('accepts arbitrary category codes such as mania RC/LN/SV', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'RC1', category: 'RC', beatmapId: 1 }),
      slot({ id: 's2', label: 'LN1', category: 'LN', beatmapId: 2 }),
      slot({ id: 's3', label: 'SV1', category: 'SV', beatmapId: 3 }),
    ];
    expect(TournamentSchema.safeParse(tournament).success).toBe(true);
  });

  it('reports dangling references with a path', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.matches.push({
      id: 'm1',
      name: 'A vs B',
      roundId: 'missing_round',
      teamOneId: 'team_one',
      teamTwoId: 'team_two',
      refereeIds: [],
      transport: 'referee_hub',
      scoringId: 'missing_scoring',
      roomNameTemplate: '{tournament}',
      initialBeatmapId: null,
      scheduledAt: null,
    });
    const issues = validateTournamentReferences(tournament);
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(/unknown round/);
    expect(issues.map((issue) => issue.message).join('\n')).toMatch(/unknown scoring/);
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('requires an odd bestOf on a round', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.bestOf = 8;
    expect(TournamentSchema.safeParse(tournament).success).toBe(false);
  });

  it('normalises slot labels for lookup', () => {
    const tournament = createEmptyTournament('Test Cup');
    tournament.rounds[0]!.slots = [
      slot({ id: 's1', label: 'DT2', category: 'DT', beatmapId: 42, requiredMods: ['DT'] }),
    ];
    const round = tournament.rounds[0]!;
    expect(normalizeSlotLabel(' dt2 ')).toBe('DT2');
    expect(findSlotByLabel(round, 'dt2')?.beatmapId).toBe(42);
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

describe('v1 → v2 migration', () => {
  it('folds stages, mappools and flows into rounds', () => {
    const now = new Date().toISOString();
    const v1 = {
      schemaVersion: 1,
      id: 'legacy',
      name: 'Legacy Cup',
      abbreviation: 'LC',
      rulesetId: 0,
      defaultMatchType: 'team_versus',
      teams: [
        { id: 'team_red', name: 'Red', color: 'red', members: [{ userId: 1, username: 'A', captain: false }] },
        { id: 'team_blue', name: 'Blue', color: 'blue', members: [] },
      ],
      referees: [{ userId: 9, username: 'Ref' }],
      stages: [{ id: 'stage_r1', name: 'Round 1', order: 0, bestOf: 9, mappoolId: 'pool_1' }],
      mappools: [
        {
          id: 'pool_1',
          name: 'Pool 1',
          stageId: 'stage_r1',
          slots: [
            {
              id: 's1',
              label: 'NM1',
              category: 'NM',
              beatmapId: 10,
              rulesetId: 0,
              requiredMods: [],
              allowedMods: [],
              freestyle: false,
              winCondition: null,
              winConditionWinner: null,
            },
          ],
        },
      ],
      flows: [
        {
          id: 'flow_1',
          name: 'Flow',
          steps: [{ id: 'step', kind: 'pick', count: 10, side: 'both' }],
          triggers: [],
        },
      ],
      scoringSchemes: [
        { id: 'score', name: 'ScoreV2', winCondition: 'score_v2', aggregation: 'sum', modMultipliers: {} },
      ],
      matches: [
        {
          id: 'm1',
          name: 'A vs B',
          stageId: 'stage_r1',
          teamOneId: 'team_red',
          teamTwoId: 'team_blue',
          refereeIds: [],
          transport: 'irc',
          mappoolId: 'pool_1',
          flowId: 'flow_1',
          scoringId: 'score',
          roomNameTemplate: '{tournament}',
          initialBeatmapId: null,
          scheduledAt: null,
        },
      ],
      automation: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      source: null,
    };

    const parsed = parseTournament(v1);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.schemaVersion).toBe(2);
    expect(parsed.data.rounds[0]?.id).toBe('stage_r1');
    expect(parsed.data.rounds[0]?.slots[0]?.beatmapId).toBe(10);
    expect(parsed.data.rounds[0]?.flow.id).toBe('flow_1');
    expect(parsed.data.matches[0]?.roundId).toBe('stage_r1');
    expect(parsed.data.teams[0]).not.toHaveProperty('color');
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

  it('normalises legacy stored abbreviations while loading', () => {
    const stored = {
      ...createEmptyTournament('Legacy Cup'),
      abbreviation: 'a-very-long-abbreviation',
    };
    const parsed = parseTournament(stored);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.abbreviation).toBe('A-VERY-LON');
  });

  it('creates new tournaments with a short uppercase abbreviation', () => {
    const tournament = createEmptyTournament('a rather long tournament name');
    expect(tournament.abbreviation).toBe('A RATHER L');
    expect(tournament.abbreviation.length).toBeLessThanOrEqual(10);
  });
});