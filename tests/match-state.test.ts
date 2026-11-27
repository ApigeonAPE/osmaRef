import { describe, expect, it } from 'vitest';
import {
  applyAction,
  adjustWins,
  amendResult,
  closeRoomSession,
  createSession,
  captureMatchPlayers,
  setFirstTeams,
  recordResult,
  reopenRoomSession,
  undoLast,
  DomainError,
  buildActionQueue,
  renderTemplate,
  protectedSlotLabels,
  usedSlotLabels,
} from '@osmaref/domain';
import {
  MatchSessionSchema,
  requiredWins,
  type BeatmapResult,
  type CreateSessionInput,
  type MatchFlow,
} from '@osmaref/contracts';

const TEAM_ONE = 'team_red';
const TEAM_TWO = 'team_blue';

const flow: MatchFlow = {
  id: 'flow_test',
  name: 'Test flow',
  phases: [
    {
      id: 'phase_ban',
      action: 'ban',
      countPerTeam: 1,
      useStageCount: false,
      phaseOrder: 'alternate',
    },
    {
      id: 'phase_pick',
      action: 'pick',
      countPerTeam: null,
      useStageCount: false,
      phaseOrder: 'alternate',
    },
  ],
  triggers: [],
};

function session(bestOf = 3) {
  const input: CreateSessionInput = {
    id: 'session_1',
    tournamentId: 't1',
    matchId: 'm1',
    matchName: 'A vs B',
    teamOneId: TEAM_ONE,
    teamTwoId: TEAM_TWO,
    tournamentRevision: 1,
    rulesetId: 0,
    matchType: 'team_versus',
    transport: 'referee_hub',
    bestOf,
    now: '2026-01-01T00:00:00.000Z',
  };
  return createSession(input, flow);
}

function at(second: number): string {
  return `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}

function result(winner: 'team_one' | 'team_two', slot: string, second: number): BeatmapResult {
  return {
    id: `${slot}-${second}`,
    slotLabel: slot,
    beatmapId: 100 + second,
    scores: [],
    winner,
    winByRuleId: null,
    teamMapScores: {
      team_one: winner === 'team_one' ? 1000 : 500,
      team_two: winner === 'team_two' ? 1000 : 500,
    },
    source: 'manual',
    recordedAt: at(second),
    needsReview: false,
  };
}

describe('flow expansion', () => {
  it('alternates both teams for every phase', () => {
    const queue = buildActionQueue(flow, 3, TEAM_ONE, TEAM_TWO, { bans: 1, protects: 0 });
    expect(queue.slice(0, 2).map((action) => action.side)).toEqual(['team_one', 'team_two']);
    expect(queue[0]?.kind).toBe('ban');
    expect(queue[2]?.kind).toBe('pick');
  });

  it('derives pick counts from the best-of', () => {
    const queue = buildActionQueue(flow, 5, TEAM_ONE, TEAM_TWO, { bans: 1, protects: 0 });
    const picks = queue.filter((action) => action.kind === 'pick');
    expect(picks).toHaveLength(6);
    expect(picks[0]?.count).toBe(3);
    expect(picks.map((action) => action.side)).toEqual([
      'team_one',
      'team_two',
      'team_one',
      'team_two',
      'team_one',
      'team_two',
    ]);
  });

  it('takes ban counts from the stage when a phase asks for them', () => {
    const queue = buildActionQueue(
      {
        id: 'stage-count',
        name: 'stage count',
        phases: [
          {
            id: 'b',
            action: 'ban',
            countPerTeam: 1,
            useStageCount: true,
            phaseOrder: 'alternate',
          },
        ],
        triggers: [],
      },
      9,
      TEAM_ONE,
      TEAM_TWO,
      { bans: 2, protects: 0 },
    );
    expect(queue.filter((action) => action.kind === 'ban')).toHaveLength(4);
    expect(queue[0]?.count).toBe(2);
  });

  it('supports per-team counts and sequential ordering', () => {
    const queue = buildActionQueue(
      {
        id: 'f',
        name: 'f',
        phases: [
          {
            id: 'p',
            action: 'protect',
            countPerTeam: 2,
            useStageCount: false,
            phaseOrder: 'sequential',
          },
        ],
        triggers: [],
      },
      3,
      TEAM_ONE,
      TEAM_TWO,
      { bans: 0, protects: 0 },
    );
    expect(queue.map((action) => action.side)).toEqual([
      'team_one',
      'team_one',
      'team_two',
      'team_two',
    ]);
  });
});

describe('match state machine', () => {
  it('captures room slots and teams when a map starts', () => {
    const captured = captureMatchPlayers(
      session(),
      [
        {
          userId: 1,
          username: 'Player_One',
          mods: [],
          team: 'red',
          slot: 0,
          status: 'ready',
        },
        {
          userId: 2,
          username: 'Player_Two',
          mods: [],
          team: 'blue',
          slot: 1,
          status: 'playing',
        },
      ],
      at(1),
    );
    expect(captured.matchPlayers).toEqual([
      { userId: 1, username: 'Player_One', slot: 0, team: 'red' },
      { userId: 2, username: 'Player_Two', slot: 1, team: 'blue' },
    ]);
  });

  it('replaces a recorded result and recomputes totals', () => {
    const first = recordResult(session(), result('team_one', 'NM1', 1));
    const corrected = {
      ...first.results[0]!,
      winner: 'team_two' as const,
      teamMapScores: { team_one: 400, team_two: 500 },
      scores: [],
    };
    const next = amendResult(first, corrected.id, corrected, at(2));
    expect(next.results).toHaveLength(1);
    expect(next.results[0]).toEqual(corrected);
    expect(next.wins).toEqual({ team_one: 0, team_two: 1 });
  });

  it('rejects amending a result that was never recorded', () => {
    expect(() => amendResult(session(), 'missing', result('team_one', 'NM1', 1))).toThrowError(
      DomainError,
    );
  });

  it('records a result without a pick for playlist-driven rooms', () => {
    const state = recordResult(session(), result('team_one', 'NM1', 1));
    expect(state.results).toHaveLength(1);
    expect(state.wins.team_one).toBe(1);
  });

  it('records lobby results without wins, review, or finishing', () => {
    const lobby = MatchSessionSchema.parse({
      ...session(3),
      id: 'session_lobby',
      matchKind: 'lobby',
      participantIds: [TEAM_ONE, TEAM_TWO, 'team_third'],
      currentSlotLabel: 'HB1',
      currentBeatmapId: 5,
      phase: 'lobby',
    });
    const lobbyResult = {
      ...result('team_one', 'HB1', 1),
      winner: null,
      teamMapScores: { team_one: null, team_two: null },
    };
    const once = recordResult(lobby, lobbyResult);
    expect(once.results).toHaveLength(1);
    expect(once.wins).toEqual({ team_one: 0, team_two: 0 });
    expect(once.needsReview).toEqual([]);
    expect(once.status).toBe('active');
    expect(once.currentSlotLabel).toBeNull();
    expect(once.currentBeatmapId).toBeNull();

    const twice = recordResult(once, { ...lobbyResult, id: 'HB1-2' });
    expect(twice.results).toHaveLength(2);
    expect(twice.status).toBe('active');
  });

  it('never blocks recording another result for the same slot', () => {
    const first = recordResult(session(), result('team_one', 'NM1', 1));
    const second = recordResult(first, result('team_two', 'NM1', 2));
    expect(second.results).toHaveLength(2);
    expect(second.wins).toEqual({ team_one: 1, team_two: 1 });
  });

  it('rejects an action from the wrong team', () => {
    const state = session();
    expect(() =>
      applyAction(state, {
        kind: 'ban',
        teamId: TEAM_TWO,
        slotLabel: 'NM1',
        beatmapId: 1,
        byUserId: 2,
        at: at(1),
      }),
    ).toThrowError(DomainError);
  });

  it('rejects the wrong action kind', () => {
    const state = session();
    expect(() =>
      applyAction(state, {
        kind: 'pick',
        teamId: TEAM_ONE,
        slotLabel: 'NM1',
        beatmapId: 1,
        byUserId: 1,
        at: at(1),
      }),
    ).toThrow(/expected ban/);
  });

  it('runs a full best-of-three', () => {
    let state = session(3);
    expect(requiredWins(3)).toBe(2);

    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'DT1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_TWO,
      slotLabel: 'DT2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });

    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(3),
    });
    expect(state.phase).toBe('playing');
    state = recordResult(state, result('team_one', 'NM1', 4));
    expect(state.wins).toEqual({ team_one: 1, team_two: 0 });
    expect(state.phase).toBe('pick');

    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_TWO,
      slotLabel: 'NM2',
      beatmapId: 12,
      byUserId: 2,
      at: at(5),
    });
    state = recordResult(state, result('team_two', 'NM2', 6));
    expect(state.wins).toEqual({ team_one: 1, team_two: 1 });

    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'HD1',
      beatmapId: 13,
      byUserId: 1,
      at: at(7),
    });
    state = recordResult(state, result('team_one', 'HD1', 8));

    expect(state.wins).toEqual({ team_one: 2, team_two: 1 });
    expect(state.status).toBe('finished');
    expect(state.phase).toBe('finished');
  });

  it('requires a result before the next action', () => {
    let state = session(3);
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'DT1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_TWO,
      slotLabel: 'DT2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(3),
    });
    expect(() =>
      applyAction(state, {
        kind: 'pick',
        teamId: TEAM_TWO,
        slotLabel: 'NM2',
        beatmapId: 12,
        byUserId: 2,
        at: at(4),
      }),
    ).toThrow(/record a result/);
  });

  it('rejects a reused slot', () => {
    let state = session(3);
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'DT1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_TWO,
      slotLabel: 'DT2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(3),
    });
    state = recordResult(state, result('team_one', 'NM1', 4));
    expect(() =>
      applyAction(state, {
        kind: 'pick',
        teamId: TEAM_TWO,
        slotLabel: 'dt1',
        beatmapId: 11,
        byUserId: 2,
        at: at(5),
      }),
    ).toThrow(/already been used/);
  });

  it('does not award a point for a tie and flags the result', () => {
    const tie: BeatmapResult = {
      id: 'NM1-tie',
      slotLabel: 'NM1',
      beatmapId: 11,
      scores: [],
      winner: null,
      winByRuleId: 'builtin:higher-score',
      teamMapScores: { team_one: 1000, team_two: 1000 },
      source: 'manual',
      recordedAt: at(4),
      needsReview: true,
    };
    let state = session(1);
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'DT1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_TWO,
      slotLabel: 'DT2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(3),
    });
    state = recordResult(state, tie);
    expect(state.wins).toEqual({ team_one: 0, team_two: 0 });
    expect(state.needsReview.length).toBeGreaterThan(0);
  });

  it('undoes the last pick and its result', () => {
    let state = session(3);
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'DT1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_TWO,
      slotLabel: 'DT2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(3),
    });
    state = recordResult(state, result('team_one', 'NM1', 4));
    expect(state.wins.team_one).toBe(1);

    state = undoLast(state, at(5));
    expect(state.wins).toEqual({ team_one: 0, team_two: 0 });
    expect(state.results).toHaveLength(0);
    expect(state.actions).toHaveLength(2);
    expect(state.phase).toBe('pick');
    expect(state.currentSlotLabel).toBeNull();
  });

  it('ends with a review flag when the flow runs out before the target', () => {
    const shortFlow: MatchFlow = {
      id: 'short',
      name: 'short',
      phases: [
        {
          id: 'p',
          action: 'pick',
          countPerTeam: null,
          useStageCount: false,
          phaseOrder: 'alternate',
        },
      ],
      triggers: [],
    };
    let state = createSession(
      {
        id: 's',
        tournamentId: 't',
        matchId: 'm',
        matchName: 'm',
        teamOneId: TEAM_ONE,
        teamTwoId: TEAM_TWO,
        tournamentRevision: 1,
        rulesetId: 0,
        matchType: 'team_versus',
        transport: 'referee_hub',
        bestOf: 1,
        now: at(0),
      },
      shortFlow,
    );
    // One pick per team: both actions must be consumed before the flow ends.
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    state = recordResult(state, {
      ...result('team_one', 'NM1', 2),
      winner: null,
      teamMapScores: { team_one: 0, team_two: 0 },
    });
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_TWO,
      slotLabel: 'NM2',
      beatmapId: 2,
      byUserId: 2,
      at: at(3),
    });
    state = recordResult(state, {
      ...result('team_two', 'NM2', 4),
      winner: null,
      teamMapScores: { team_one: 0, team_two: 0 },
    });
    expect(state.status).toBe('finished');
    expect(state.needsReview.join(' ')).toMatch(/flow ended/);
  });
});

describe('protect', () => {
  it('treats protect as protection, not as a consumed map', () => {
    const protectFlow: MatchFlow = {
      id: 'protect_flow',
      name: 'protect flow',
      phases: [
        {
          id: 'p',
          action: 'protect',
          countPerTeam: 1,
          useStageCount: false,
          phaseOrder: 'alternate',
        },
        {
          id: 'b',
          action: 'ban',
          countPerTeam: 1,
          useStageCount: false,
          phaseOrder: 'alternate',
        },
        {
          id: 'pick',
          action: 'pick',
          countPerTeam: null,
          useStageCount: false,
          phaseOrder: 'alternate',
        },
      ],
      triggers: [],
    };
    let state = createSession(
      {
        id: 'protect_session',
        tournamentId: 't',
        matchId: 'm',
        matchName: 'm',
        teamOneId: TEAM_ONE,
        teamTwoId: TEAM_TWO,
        tournamentRevision: 1,
        rulesetId: 0,
        matchType: 'team_versus',
        transport: 'irc',
        bestOf: 3,
        now: at(0),
      },
      protectFlow,
    );

    // Both teams protect once, alternating.
    state = applyAction(state, {
      kind: 'protect',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 1,
      byUserId: 1,
      at: at(1),
    });
    expect(protectedSlotLabels(state).has('NM1')).toBe(true);
    expect(usedSlotLabels(state).has('NM1')).toBe(false);

    state = applyAction(state, {
      kind: 'protect',
      teamId: TEAM_TWO,
      slotLabel: 'NM2',
      beatmapId: 2,
      byUserId: 2,
      at: at(2),
    });
    expect(protectedSlotLabels(state).size).toBe(2);

    expect(() =>
      applyAction(state, {
        kind: 'ban',
        teamId: TEAM_ONE,
        slotLabel: 'NM1',
        beatmapId: 1,
        byUserId: 1,
        at: at(3),
      }),
    ).toThrow(/protected/);

    state = applyAction(state, {
      kind: 'ban',
      teamId: TEAM_ONE,
      slotLabel: 'NM3',
      beatmapId: 3,
      byUserId: 1,
      at: at(4),
    });
    expect(state.actions.at(-1)?.kind).toBe('ban');
    expect(usedSlotLabels(state).has('NM3')).toBe(true);
  });

  it('grants score-triggered actions and records trigger counts', () => {
    const triggerFlow: MatchFlow = {
      id: 'trigger_flow',
      name: 'trigger flow',
      phases: [
        {
          id: 'p',
          action: 'pick',
          countPerTeam: null,
          useStageCount: false,
          phaseOrder: 'alternate',
        },
      ],
      triggers: [
        {
          id: 't1',
          subject: 'team_one',
          threshold: 1,
          action: 'ban',
          count: 2,
          repeatEvery: null,
          grantTo: 'opponent',
        },
        {
          id: 't2',
          subject: 'team_one',
          threshold: 2,
          action: 'protect',
          count: 1,
          repeatEvery: 1,
          grantTo: 'subject',
        },
      ],
    };
    let state = createSession(
      {
        id: 'trigger_session',
        tournamentId: 't',
        matchId: 'm',
        matchName: 'm',
        teamOneId: TEAM_ONE,
        teamTwoId: TEAM_TWO,
        tournamentRevision: 1,
        rulesetId: 0,
        matchType: 'team_versus',
        transport: 'irc',
        bestOf: 5,
        now: at(0),
      },
      triggerFlow,
    );

    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_ONE,
      slotLabel: 'NM1',
      beatmapId: 11,
      byUserId: 1,
      at: at(1),
    });
    state = recordResult(state, result('team_one', 'NM1', 2));

    expect(state.triggerCounts.t1).toBe(1);
    expect(state.queue[state.cursor]).toMatchObject({ kind: 'ban', side: 'team_two' });
    expect(state.queue.filter((action) => action.stepId === 'trigger:t1')).toHaveLength(2);
  });

  it('renders templates without executing code', () => {
    expect(
      renderTemplate('{{team_red}} {{score_red}}', { team_red: 'Red', score_red: 2 }),
    ).toBe('Red 2');
    expect(renderTemplate('{{constructor}}', {})).toBe('{{constructor}}');
  });
});
describe('closing a room', () => {
  it('marks the session closed and keeps the room association', () => {
    const opened = { ...session(), roomId: '1001', roomName: 'Final' };
    const closed = closeRoomSession(opened, at(9));
    expect(closed.status).toBe('closed');
    expect(closed.roomId).toBe('1001');
    expect(closed.roomName).toBe('Final');
    expect(closed.phase).toBe('aborted');
  });

  it('reopens a closed session when its room is joined again', () => {
    const closed = closeRoomSession({ ...session(), roomId: '1001', roomName: 'Final' }, at(9));
    const opened = reopenRoomSession(closed, at(10));
    expect(opened.status).toBe('active');
    expect(opened.phase).toBe('ban');
    expect(opened.roomId).toBe('1001');
  });
});

describe('manual score and first teams', () => {
  it('adjusts wins within bounds', () => {
    let state = session();
    state = adjustWins(state, 'team_one', -1, at(1));
    expect(state.wins.team_one).toBe(0);
    state = adjustWins(state, 'team_one', 2, at(2));
    expect(state.wins.team_one).toBe(2);
  });

  it('alternates each step from the selected first team', () => {
    const state = setFirstTeams(session(), [
      { stepId: 'phase_ban', teamId: TEAM_TWO },
      { stepId: 'phase_pick', teamId: TEAM_ONE },
    ]);
    expect(state.firstTeamsSet).toBe(true);
    expect(state.queue[0]?.side).toBe('team_two');
    expect(state.queue[1]?.side).toBe('team_one');
    expect(state.queue[2]?.side).toBe('team_one');
    expect(state.queue[3]?.side).toBe('team_two');
  });
});
