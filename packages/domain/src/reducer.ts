import {
  MatchSessionSchema,
  requiredWins,
  type BeatmapResult,
  type CreateSessionInput,
  type MatchAction,
  type MatchFlow,
  type MatchSession,
  type PendingAction,
  type RoomPlayer,
} from '@osmaref/contracts';
import { buildActionQueue, describePendingAction, sideOfTeam } from './flow';

export type DomainErrorCode =
  | 'SESSION_NOT_ACTIVE'
  | 'FLOW_COMPLETE'
  | 'EXPECTED_KIND'
  | 'EXPECTED_TEAM'
  | 'SLOT_ALREADY_USED'
  | 'SLOT_PROTECTED'
  | 'UNKNOWN_SLOT'
  | 'NO_ACTION_TO_UNDO'
  | 'RESULT_REQUIRED';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function createSession(input: CreateSessionInput, flow: MatchFlow): MatchSession {
  const queue = buildActionQueue(flow, input.teamOneId, input.teamTwoId);
  const session: MatchSession = {
    id: input.id,
    tournamentId: input.tournamentId,
    matchId: input.matchId,
    tournamentRevision: input.tournamentRevision,
    matchName: input.matchName,
    teamOneId: input.teamOneId,
    teamTwoId: input.teamTwoId,
    configSnapshot: input.configSnapshot ?? null,
    rulesetId: input.rulesetId,
    matchType: input.matchType,
    transport: input.transport,
    status: 'active',
    phase: queue[0]?.kind ?? 'lobby',
    bestOf: input.bestOf,
    queue,
    flowTriggers: flow.triggers,
    triggerCounts: {},
    cursor: 0,
    wins: { team_one: 0, team_two: 0 },
    firstTeamsSet: input.firstTeamsSet ?? false,
    teamScores: { team_one: 0, team_two: 0 },
    actions: [],
    results: [],
    matchPlayers: [],
    currentSlotLabel: null,
    currentBeatmapId: null,
    roomId: null,
    roomName: null,
    chatOnly: false,
    needsReview: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
  return MatchSessionSchema.parse(session);
}

export interface ApplyActionInput {
  kind: 'protect' | 'ban' | 'pick';
  teamId: string;
  slotLabel: string;
  beatmapId: number | null;
  byUserId: number | null;
  at: string;
  /** Manual correction by the referee; skips expected-kind/team validation. */
  override?: boolean;
  note?: string;
}

export function applyAction(session: MatchSession, input: ApplyActionInput): MatchSession {
  if (session.status !== 'active') {
    throw new DomainError('SESSION_NOT_ACTIVE', `session is ${session.status}`);
  }
  if (session.phase === 'playing' || session.currentSlotLabel !== null) {
    throw new DomainError(
      'RESULT_REQUIRED',
      `record a result for ${session.currentSlotLabel ?? 'the current pick'} before the next action`,
    );
  }
  const expected = session.queue[session.cursor] ?? null;
  if (!expected) {
    throw new DomainError('FLOW_COMPLETE', 'the flow has no remaining actions');
  }
  if (!input.override) {
    if (expected.kind !== input.kind) {
      throw new DomainError(
        'EXPECTED_KIND',
        `expected ${expected.kind}, received ${input.kind}`,
      );
    }
    const expectedTeamId = sideOfTeam(expected.side, session.teamOneId, session.teamTwoId);
    if (expectedTeamId !== input.teamId) {
      throw new DomainError(
        'EXPECTED_TEAM',
        `expected ${expectedTeamId} to ${expected.kind}, received ${input.teamId}`,
      );
    }
  } else if (input.teamId !== session.teamOneId && input.teamId !== session.teamTwoId) {
    throw new DomainError('EXPECTED_TEAM', `unknown team "${input.teamId}"`);
  }

  if (input.kind === 'protect') {
    if (usedSlotLabels(session).has(normalize(input.slotLabel))) {
      throw new DomainError('SLOT_ALREADY_USED', `slot ${input.slotLabel} has already been picked or banned`);
    }
    if (protectedSlotLabels(session).has(normalize(input.slotLabel))) {
      throw new DomainError('SLOT_ALREADY_USED', `slot ${input.slotLabel} is already protected`);
    }
  } else if (usedSlotLabels(session).has(normalize(input.slotLabel))) {
    throw new DomainError('SLOT_ALREADY_USED', `slot ${input.slotLabel} has already been used`);
  } else if (input.kind === 'ban' && protectedSlotLabels(session).has(normalize(input.slotLabel))) {
    throw new DomainError('SLOT_PROTECTED', `slot ${input.slotLabel} is protected and cannot be banned`);
  }

  const action: MatchAction = {
    id: `${session.id}:action:${session.actions.length + 1}`,
    kind: input.kind,
    teamId: input.teamId,
    slotLabel: input.slotLabel,
    beatmapId: input.beatmapId,
    byUserId: input.byUserId,
    at: input.at,
    ...(input.note ? { note: input.note } : {}),
  };

  const next: MatchSession = {
    ...session,
    actions: [...session.actions, action],
    cursor: Math.min(session.cursor + 1, session.queue.length),
    updatedAt: input.at,
  };

  if (input.kind === 'pick') {
    next.currentSlotLabel = input.slotLabel;
    next.currentBeatmapId = input.beatmapId;
    next.phase = 'playing';
  } else {
    next.phase = nextPhase(next);
  }

  return MatchSessionSchema.parse(next);
}

export function recordResult(
  session: MatchSession,
  result: BeatmapResult,
  at = result.recordedAt,
): MatchSession {
  if (session.status !== 'active') {
    throw new DomainError('SESSION_NOT_ACTIVE', `session is ${session.status}`);
  }
  const next: MatchSession = {
    ...session,
    results: [...session.results, result],
    updatedAt: at,
    teamScores: {
      team_one: session.teamScores.team_one + (result.teamValues.team_one ?? 0),
      team_two: session.teamScores.team_two + (result.teamValues.team_two ?? 0),
    },
    wins: {
      team_one: session.wins.team_one + (result.winner === 'team_one' ? 1 : 0),
      team_two: session.wins.team_two + (result.winner === 'team_two' ? 1 : 0),
    },
    currentSlotLabel: null,
    currentBeatmapId: null,
    needsReview: result.needsReview
      ? [...new Set([...session.needsReview, `${result.slotLabel}: score needs review`])]
      : session.needsReview,
  };

  const target = requiredWins(session.bestOf);
  if (next.wins.team_one >= target || next.wins.team_two >= target) {
    next.status = 'finished';
    next.phase = 'finished';
    return MatchSessionSchema.parse(next);
  }

  // Score-based triggers add extra actions before the remaining queue.
  const triggered = applyScoreTriggers(next);
  next.queue = triggered.queue;
  next.triggerCounts = triggered.counts;

  const pending = next.queue[next.cursor] ?? null;
  if (!pending) {
    next.status = 'finished';
    next.phase = 'finished';
    next.needsReview = [
      ...new Set([...next.needsReview, 'flow ended before a team reached the required wins']),
    ];
    return MatchSessionSchema.parse(next);
  }

  next.phase = pending.kind;
  return MatchSessionSchema.parse(next);
}

export function undoLast(session: MatchSession, at: string): MatchSession {
  const last = session.actions[session.actions.length - 1];
  if (!last) {
    throw new DomainError('NO_ACTION_TO_UNDO', 'there is no action to undo');
  }

  let results = session.results;
  let wins = { ...session.wins };
  let teamScores = { ...session.teamScores };
  let needsReview = [...session.needsReview];

  if (last.kind === 'pick') {
    const result = results[results.length - 1];
    if (result && normalize(result.slotLabel) === normalize(last.slotLabel ?? '')) {
      results = results.slice(0, -1);
      needsReview = needsReview.filter((entry) => !entry.startsWith(`${result.slotLabel}:`));
      teamScores = {
        team_one: teamScores.team_one - (result.teamValues.team_one ?? 0),
        team_two: teamScores.team_two - (result.teamValues.team_two ?? 0),
      };
      if (result.winner === 'team_one') wins.team_one -= 1;
      if (result.winner === 'team_two') wins.team_two -= 1;
      if (result.needsReview) {
        needsReview = [
          ...new Set([...needsReview, `${result.slotLabel}: score needs review`]),
        ];
      }
    }
  }

  const next: MatchSession = {
    ...session,
    actions: session.actions.slice(0, -1),
    cursor: Math.max(0, session.cursor - 1),
    results,
    wins,
    teamScores,
    needsReview,
    status: 'active',
    currentSlotLabel: null,
    currentBeatmapId: null,
    updatedAt: at,
  };
  next.phase = nextPhase(next);
  next.triggerCounts = recomputeTriggerCounts(next);
  return MatchSessionSchema.parse(next);
}

/**
 * Builds the extra actions granted by score triggers and records how many
 * times each trigger has fired.
 */
function applyScoreTriggers(session: MatchSession): {
  queue: PendingAction[];
  counts: Record<string, number>;
} {
  const queue = [...session.queue];
  const counts = { ...session.triggerCounts };
  const granted: PendingAction[] = [];

  for (const trigger of session.flowTriggers) {
    const score =
      trigger.team === 'team_one' ? session.wins.team_one : session.wins.team_two;
    if (score < trigger.threshold) continue;

    const desired = trigger.repeatEvery
      ? 1 + Math.floor((score - trigger.threshold) / trigger.repeatEvery)
      : 1;
    const fired = counts[trigger.id] ?? 0;
    if (desired <= fired) continue;

    for (let round = fired; round < desired; round += 1) {
      for (let index = 1; index <= trigger.count; index += 1) {
        granted.push({
          id: `${session.id}:trigger:${trigger.id}:${round}:${index}`,
          stepId: `trigger:${trigger.id}`,
          kind: trigger.action,
          side: trigger.team,
          index,
          count: trigger.count,
        });
      }
    }
    counts[trigger.id] = desired;
  }

  if (granted.length > 0) {
    queue.splice(session.cursor, 0, ...granted);
  }
  return { queue, counts };
}

/** Keeps undo consistent with trigger actions that still exist. */
function recomputeTriggerCounts(session: MatchSession): Record<string, number> {
  const counts: Record<string, number> = {};
  const all = [...session.actions.map((action) => action.id), ...session.queue.map((entry) => entry.id)];
  for (const id of all) {
    const match = /:trigger:([^:]+):(\d+):\d+$/.exec(id);
    if (!match) continue;
    const triggerId = match[1]!;
    const round = Number(match[2]) + 1;
    counts[triggerId] = Math.max(counts[triggerId] ?? 0, round);
  }
  return counts;
}

export function abortSession(session: MatchSession, at: string): MatchSession {
  const next: MatchSession = {
    ...session,
    status: 'aborted',
    phase: 'aborted',
    updatedAt: at,
  };
  return MatchSessionSchema.parse(next);
}

/** Manual score correction from the scoreboard (arrow keys/buttons). */
export function adjustWins(
  session: MatchSession,
  side: 'team_one' | 'team_two',
  delta: number,
  at: string,
): MatchSession {
  const wins = { ...session.wins };
  wins[side] = Math.max(0, Math.min(31, wins[side] + delta));
  return MatchSessionSchema.parse({
    ...session,
    wins,
    updatedAt: at,
  });
}

/**
 * Assigns the first team of each flow step. Actions inside a step alternate
 * between the two teams starting from the selected one.
 */
export function setFirstTeams(
  session: MatchSession,
  assignments: { stepId: string; teamId: string }[],
): MatchSession {
  const firstByStep = new Map<string, string>();
  for (const assignment of assignments) {
    if (assignment.teamId !== session.teamOneId && assignment.teamId !== session.teamTwoId) {
      throw new Error(`unknown team "${assignment.teamId}"`);
    }
    firstByStep.set(assignment.stepId, assignment.teamId);
  }

  const positions = new Map<string, number>();
  const queue = session.queue.map((action) => {
    const first = firstByStep.get(action.stepId);
    if (!first) return action;
    const position = positions.get(action.stepId) ?? 0;
    positions.set(action.stepId, position + 1);
    const firstSide = first === session.teamOneId ? 'team_one' : 'team_two';
    const otherSide = firstSide === 'team_one' ? 'team_two' : 'team_one';
    return {
      ...action,
      side: position % 2 === 0 ? firstSide : otherSide,
    };
  });

  const stepIds = new Set(session.queue.map((action) => action.stepId));
  const complete = [...stepIds].every((stepId) => firstByStep.has(stepId));

  return MatchSessionSchema.parse({
    ...session,
    queue,
    firstTeamsSet: complete,
    updatedAt: new Date().toISOString(),
  });
}
export function closeRoomSession(session: MatchSession, at: string): MatchSession {
  const next: MatchSession = {
    ...session,
    status: 'closed',
    phase: 'aborted',
    roomId: null,
    roomName: null,
    currentSlotLabel: null,
    currentBeatmapId: null,
    updatedAt: at,
  };
  return MatchSessionSchema.parse(next);
}

export function linkRoom(
  session: MatchSession,
  roomId: string,
  roomName: string,
  at: string,
): MatchSession {
  const next: MatchSession = {
    ...session,
    roomId,
    roomName,
    updatedAt: at,
  };
  return MatchSessionSchema.parse(next);
}

/** Freezes the room's slot/team layout when a map starts. */
export function captureMatchPlayers(
  session: MatchSession,
  players: RoomPlayer[],
  at: string,
): MatchSession {
  return MatchSessionSchema.parse({
    ...session,
    matchPlayers: players.map((player) => ({
      userId: player.userId,
      username: player.username,
      slot: player.slot,
      team: player.team,
    })),
    updatedAt: at,
  });
}

/** Labels consumed by a pick or ban. Protects intentionally do not consume a map. */
export function usedSlotLabels(session: MatchSession): Set<string> {
  const used = new Set<string>();
  for (const action of session.actions) {
    if (action.slotLabel && action.kind !== 'protect') used.add(normalize(action.slotLabel));
  }
  return used;
}

export function protectedSlotLabels(session: MatchSession): Set<string> {
  const protectedLabels = new Set<string>();
  for (const action of session.actions) {
    if (action.slotLabel && action.kind === 'protect') {
      protectedLabels.add(normalize(action.slotLabel));
    }
  }
  return protectedLabels;
}

export function nextPhase(session: MatchSession): MatchSession['phase'] {
  if (session.status === 'finished') return 'finished';
  if (session.status === 'aborted') return 'aborted';
  const pending: PendingAction | null = session.queue[session.cursor] ?? null;
  if (!pending) {
    return 'finished';
  }
  return pending.kind;
}

export function pendingDescription(session: MatchSession): string {
  return describePendingAction(
    session.queue[session.cursor] ?? null,
    session.teamOneId,
    session.teamTwoId,
  );
}

function normalize(value: string): string {
  return value.trim().toUpperCase();
}