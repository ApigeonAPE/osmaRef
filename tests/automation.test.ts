import { describe, expect, it } from 'vitest';
import {
  automationMessagesFor,
  buildTemplateContext,
  expandAutomationMessages,
  renderTemplate,
} from '@osmaref/domain';
import {
  createEmptyTournament,
  emptyAutomationMessages,
  parseTournament,
} from '@osmaref/contracts';

describe('automatic messages', () => {
  it('keeps configured order and drops blank messages', () => {
    const messages = expandAutomationMessages(
      ['first {{team_red}}', '', '   ', 'second {{score_blue}}'],
      { team_red: 'Red', score_blue: 3 },
    );
    expect(messages).toEqual(['first Red', 'second 3']);
  });

  it('returns the messages configured for one timing', () => {
    const automation = emptyAutomationMessages();
    automation.beatmap_completed = ['A', 'B'];
    expect(automationMessagesFor(automation, 'beatmap_completed')).toEqual(['A', 'B']);
    expect(automationMessagesFor(automation, 'match_finished')).toEqual([]);
  });

  it('builds the documented template context', () => {
    const tournament = createEmptyTournament('Cup');
    const stage = tournament.stages[0]!;
    stage.matches.push({
      id: 'm',
      type: 'match',
      groupId: null,
      teamRedId: 0,
      teamBlueId: 1,
      refereeIds: [],
      scheduledAt: '2026-01-01T00:00:00.000Z',
      result: { scoreRed: 0, scoreBlue: 0 },
      roomMode: 'team_versus',
      winCondition: 'score',
    });
    const session = {
      id: 's',
      tournamentId: tournament.id,
      matchId: 'm',
      matchName: 'Red vs Blue',
      matchKind: 'match' as const,
      participantIds: ['0', '1'],
      teamOneId: '0',
      teamTwoId: '1',
      tournamentRevision: 1,
      configSnapshot: tournament,
      rulesetId: 0,
      matchType: 'team_versus' as const,
      transport: 'irc' as const,
      status: 'active' as const,
      phase: 'pick' as const,
      bestOf: 9,
      queue: [
        {
          id: 'a',
          stepId: 'p',
          kind: 'pick' as const,
          side: 'team_one' as const,
          index: 1,
          count: 1,
        },
      ],
      flowTriggers: [],
      triggerCounts: {},
      cursor: 0,
      wins: { team_one: 2, team_two: 1 },
      firstTeamsSet: true,
      teamScores: { team_one: 0, team_two: 0 },
      actions: [
        {
          id: 'a0',
          kind: 'ban' as const,
          teamId: '1',
          slotLabel: 'NM2',
          beatmapId: 1,
          byUserId: null,
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
      results: [],
      matchPlayers: [],
      currentSlotLabel: 'NM1',
      currentBeatmapId: 123,
      roomId: null,
      roomName: null,
      chatOnly: false,
      needsReview: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const context = buildTemplateContext(tournament, session, 'Red', 'Blue');
    expect(context).toMatchObject({
      tournament: 'Cup',
      stage: stage.name,
      match: 'Red vs Blue',
      team_red: 'Red',
      team_blue: 'Blue',
      score_red: 2,
      score_blue: 1,
      slot: 'NM1',
      beatmap: '',
      beatmap_id: '123',
      action_team: 'Blue',
      action: 'ban',
      action_next: 'pick',
      next_team: 'Red',
      mapscore_red: 0,
      mapscore_blue: 0,
      winner: '',
    });
    expect(renderTemplate('{{ unknown }}', context)).toBe('{{ unknown }}');
  });

  it('migrates legacy automation rules into timing lists', () => {
    const tournament = createEmptyTournament('Legacy messages');
    const raw = JSON.parse(JSON.stringify(tournament)) as {
      automation: unknown;
    };
    raw.automation = [
      {
        id: 'rule_1',
        name: 'After map',
        trigger: 'beatmap_completed',
        slotLabel: null,
        enabled: true,
        actions: [
          { type: 'chat', template: '{{ team_one }} {{ score_one }}' },
          { type: 'notice', message: 'second' },
        ],
      },
      {
        id: 'rule_2',
        name: 'Created',
        trigger: 'match_created',
        slotLabel: null,
        enabled: true,
        actions: [{ type: 'chat', template: 'created' }],
      },
      {
        id: 'rule_3',
        name: 'Disabled',
        trigger: 'match_finished',
        slotLabel: null,
        enabled: false,
        actions: [{ type: 'chat', template: 'disabled' }],
      },
    ];
    const parsed = parseTournament(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.automation.beatmap_completed).toEqual([
      '{{team_red}} {{score_red}}',
      'second',
    ]);
    expect(parsed.data.automation.match_created).toEqual(['created']);
    expect(parsed.data.automation.match_finished).toEqual([]);
  });
});
