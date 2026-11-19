import { describe, expect, it } from 'vitest';
import {
  automationActionsFor,
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

  it('returns the actions configured for one timing', () => {
    const automation = emptyAutomationMessages();
    const actions = [
      { type: 'chat' as const, template: 'A' },
      { type: 'chat' as const, template: 'B' },
    ];
    automation.beatmap_completed = actions;
    expect(automationActionsFor(automation, 'beatmap_completed')).toEqual(actions);
    expect(automationActionsFor(automation, 'match_finished')).toEqual([]);
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
      winBy: null,
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

  it('parses chat actions stored on a tournament', () => {
    const tournament = createEmptyTournament('Actions');
    tournament.automation.beatmap_completed = [
      { type: 'chat', template: '{{team_red}} {{score_red}}' },
    ];
    const parsed = parseTournament(JSON.parse(JSON.stringify(tournament)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.automation.beatmap_completed).toEqual([
      { type: 'chat', template: '{{team_red}} {{score_red}}' },
    ]);
  });
  it('defaults the tournament webhook list to empty', () => {
    const tournament = createEmptyTournament('Hooks');
    expect(tournament.webhooks).toEqual([]);
  });

  it('parses discord webhooks stored on the tournament', () => {
    const tournament = createEmptyTournament('Hooks');
    tournament.webhooks = [
      {
        kind: 'discord',
        name: 'Results',
        url: 'https://discord.com/api/webhooks/1/token',
        triggers: ['beatmap_completed'],
      },
    ];
    const parsed = parseTournament(JSON.parse(JSON.stringify(tournament)));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.webhooks).toEqual([
      {
        kind: 'discord',
        name: 'Results',
        url: 'https://discord.com/api/webhooks/1/token',
        triggers: ['beatmap_completed'],
      },
    ]);
  });

  it('rejects discord webhooks that are not https', () => {
    const tournament = createEmptyTournament('Hooks');
    tournament.webhooks = [
      {
        kind: 'discord',
        name: 'Results',
        url: 'http://discord.com/api/webhooks/1/token',
        triggers: ['beatmap_completed'],
      },
    ];
    const parsed = parseTournament(JSON.parse(JSON.stringify(tournament)));
    expect(parsed.success).toBe(false);
  });
});
