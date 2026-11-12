import { describe, expect, it } from 'vitest';
import {
  applyAction,
  adjustWins,
  closeRoomSession,
  createSession,
  captureMatchPlayers,
  evaluateBeatmap,
  setFirstTeams,
  recordResult,
  undoLast,
  DomainError,
  buildActionQueue,
  renderTemplate,
  protectedSlotLabels,
  usedSlotLabels,
  type EvaluateInput,
} from '@osmaref/domain';
import {
  requiredWins,
  type BeatmapResult,
  type CreateSessionInput,
  type MatchFlow,
  type PlayerScore,
  type ScoringScheme,
} from '@osmaref/contracts';

const TEAM_ONE = 'team_red';
const TEAM_TWO = 'team_blue';

const flow: MatchFlow = {
  id: 'flow_test',
  name: 'Test flow',
  steps: [
    { id: 'step_ban', kind: 'ban', count: 1 },
    { id: 'step_pick', kind: 'pick', count: 10 },
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

const scheme: ScoringScheme = {
  id: 'score',
  name: 'Score',
  winCondition: 'score',
  aggregation: 'sum',
  modMultipliers: { HD: 1.06, HR: 1.1 },
};

function player(userId: number, score: number, mods: string[] = []): PlayerScore {
  return {
    userId,
    score,
    accuracy: 0.9,
    maxCombo: 100,
    misses: 0,
    mods,
    passed: true,
  };
}

function evaluation(scores: PlayerScore[], winCondition: ScoringScheme['winCondition'] = 'score') {
  const input: EvaluateInput = {
    slotLabel: 'NM1',
    beatmapId: 111,
    scores,
    teamOneId: TEAM_ONE,
    teamTwoId: TEAM_TWO,
    memberTeam: new Map([
      [1, TEAM_ONE],
      [2, TEAM_TWO],
    ]),
    scheme: { ...scheme, winCondition },
    recordedAt: at(1),
    source: 'referee_hub',
  };
  return evaluateBeatmap(input);
}

function result(winner: 'team_one' | 'team_two', slot: string, second: number): BeatmapResult {
  return {
    id: `${slot}-${second}`,
    slotLabel: slot,
    beatmapId: 100 + second,
    scores: [],
    winner,
    teamValues: {
      team_one: winner === 'team_one' ? 1000 : 500,
      team_two: winner === 'team_two' ? 1000 : 500,
    },
    source: 'manual',
    recordedAt: at(second),
    needsReview: false,
  };
}

describe('flow expansion', () => {
  it('alternates both teams for every step', () => {
    const queue = buildActionQueue(flow, TEAM_ONE, TEAM_TWO);
    expect(queue.slice(0, 2).map((action) => action.side)).toEqual(['team_one', 'team_two']);
    expect(queue[0]?.kind).toBe('ban');
    expect(queue[2]?.kind).toBe('pick');
  });

  it('treats count as actions per team', () => {
    const queue = buildActionQueue(
      {
        id: 'f',
        name: 'f',
        steps: [{ id: 's', kind: 'protect', count: 2 }],
        triggers: [],
      },
      TEAM_ONE,
      TEAM_TWO,
    );
    expect(queue.map((action) => action.side)).toEqual([
      'team_one',
      'team_two',
      'team_one',
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

  it('records a result without a pick for playlist-driven rooms', () => {
    const state = recordResult(session(), result('team_one', 'NM1', 1));
    expect(state.results).toHaveLength(1);
    expect(state.wins.team_one).toBe(1);
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
    const tie = evaluation([player(1, 1000), player(2, 1000)]);
    expect(tie.result.winner).toBeNull();
    expect(tie.needsReview).toBe(true);

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
    state = recordResult(state, tie.result);
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
      steps: [{ id: 'p', kind: 'pick', count: 1 }],
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
        bestOf: 5,
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
    state = recordResult(state, result('team_one', 'NM1', 2));
    state = applyAction(state, {
      kind: 'pick',
      teamId: TEAM_TWO,
      slotLabel: 'NM2',
      beatmapId: 2,
      byUserId: 2,
      at: at(3),
    });
    state = recordResult(state, result('team_two', 'NM2', 4));
    expect(state.status).toBe('finished');
    expect(state.needsReview.join(' ')).toMatch(/flow ended/);
  });
});

describe('scoring', () => {
  it('applies mod multipliers to score', () => {
    const evaluationResult = evaluation([player(1, 1000, ['HD']), player(2, 1050)]);
    expect(evaluationResult.result.teamValues.team_one).toBeCloseTo(1060);
    expect(evaluationResult.result.winner).toBe('team_one');
  });

  it('treats lower misses as better', () => {
    const low = evaluation([player(1, 900), player(2, 900)], 'misses');
    // both zero misses: tie
    expect(low.result.winner).toBeNull();

    const withMisses = evaluateBeatmap({
      slotLabel: 'NM1',
      beatmapId: 1,
      scores: [
        { ...player(1, 900), misses: 1 },
        { ...player(2, 900), misses: 3 },
      ],
      teamOneId: TEAM_ONE,
      teamTwoId: TEAM_TWO,
      memberTeam: new Map([
        [1, TEAM_ONE],
        [2, TEAM_TWO],
      ]),
      scheme: { ...scheme, winCondition: 'misses' },
      recordedAt: at(1),
      source: 'manual',
    });
    expect(withMisses.result.winner).toBe('team_one');
  });

  it('flags a score whose user is not on either team', () => {
    const result = evaluateBeatmap({
      slotLabel: 'NM1',
      beatmapId: 1,
      scores: [player(1, 100), player(99, 200)],
      teamOneId: TEAM_ONE,
      teamTwoId: TEAM_TWO,
      memberTeam: new Map([[1, TEAM_ONE]]),
      scheme,
      recordedAt: at(1),
      source: 'manual',
    });
    expect(result.needsReview).toBe(true);
    expect(result.reviewReason).toMatch(/team/);
  });

  it('honours per-beatmap win condition overrides', () => {
    const accuracy = evaluateBeatmap({
      slotLabel: 'HD1',
      beatmapId: 1,
      scores: [
        { ...player(1, 900000), accuracy: 0.98 },
        { ...player(2, 800000), accuracy: 1.0 },
      ],
      teamOneId: TEAM_ONE,
      teamTwoId: TEAM_TWO,
      memberTeam: new Map([
        [1, TEAM_ONE],
        [2, TEAM_TWO],
      ]),
      scheme,
      winCondition: 'accuracy',
      recordedAt: at(1),
      source: 'manual',
    });
    expect(accuracy.result.winner).toBe('team_two');
    expect(accuracy.result.teamValues.team_one).toBeCloseTo(0.98);

    const lowestScore = evaluateBeatmap({
      slotLabel: 'FM1',
      beatmapId: 2,
      scores: [player(1, 500000), player(2, 900000)],
      teamOneId: TEAM_ONE,
      teamTwoId: TEAM_TWO,
      memberTeam: new Map([
        [1, TEAM_ONE],
        [2, TEAM_TWO],
      ]),
      scheme,
      winCondition: 'score',
      winner: 'lowest',
      recordedAt: at(1),
      source: 'manual',
    });
    expect(lowestScore.result.winner).toBe('team_one');
  });

  it('treats protect as protection, not as a consumed map', () => {
    const protectFlow: MatchFlow = {
      id: 'protect_flow',
      name: 'protect flow',
      steps: [
        { id: 'p', kind: 'protect', count: 1 },
        { id: 'b', kind: 'ban', count: 1 },
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
      steps: [{ id: 'p', kind: 'pick', count: 5 }],
      triggers: [
        {
          id: 't1',
          team: 'team_one',
          threshold: 1,
          action: 'ban',
          count: 2,
          repeatEvery: null,
        },
        {
          id: 't2',
          team: 'team_one',
          threshold: 2,
          action: 'protect',
          count: 1,
          repeatEvery: 1,
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
    expect(state.queue[state.cursor]).toMatchObject({ kind: 'ban', side: 'team_one' });
    expect(state.queue.filter((action) => action.stepId === 'trigger:t1')).toHaveLength(2);
  });

  it('renders templates without executing code', () => {
    expect(renderTemplate('{{ team_one }} {{score_one}}', { team_one: 'Red', score_one: 2 })).toBe(
      'Red 2',
    );
    expect(renderTemplate('{{constructor}}', {})).toBe('{{constructor}}');
  });
});
describe('closing a room', () => {
  it('marks the session closed and drops room references', () => {
    const opened = { ...session(), roomId: '1001', roomName: 'Final' };
    const closed = closeRoomSession(opened, at(9));
    expect(closed.status).toBe('closed');
    expect(closed.roomId).toBeNull();
    expect(closed.roomName).toBeNull();
    expect(closed.phase).toBe('aborted');
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
      { stepId: 'step_ban', teamId: TEAM_TWO },
      { stepId: 'step_pick', teamId: TEAM_ONE },
    ]);
    expect(state.firstTeamsSet).toBe(true);
    expect(state.queue[0]?.side).toBe('team_two');
    expect(state.queue[1]?.side).toBe('team_one');
    expect(state.queue[2]?.side).toBe('team_one');
    expect(state.queue[3]?.side).toBe('team_two');
  });
});
