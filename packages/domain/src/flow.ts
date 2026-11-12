import type { MatchFlow, PendingAction, TeamSide } from '@osmaref/contracts';

/**
 * Expands a declarative flow into a flat, ordered action queue.
 *
 * `side: 'both'` alternates team one / team two for each repetition, which is
 * how most osu! tournaments describe "one ban each" style steps. A flow can
 * still spell out asymmetric rounds by using consecutive team-specific steps.
 */
export function buildActionQueue(
  flow: MatchFlow,
  teamOneId: string,
  teamTwoId: string,
): PendingAction[] {
  const actions: PendingAction[] = [];
  for (const step of flow.steps) {
    if (step.side === 'both') {
      for (let index = 1; index <= step.count; index += 1) {
        actions.push(makeAction(step.id, step.kind, 'team_one', index, step.count, teamOneId, teamTwoId));
        actions.push(makeAction(step.id, step.kind, 'team_two', index, step.count, teamOneId, teamTwoId));
      }
      continue;
    }
    for (let index = 1; index <= step.count; index += 1) {
      actions.push(makeAction(step.id, step.kind, step.side, index, step.count, teamOneId, teamTwoId));
    }
  }
  return actions;
}

function makeAction(
  stepId: string,
  kind: PendingAction['kind'],
  side: TeamSide,
  index: number,
  count: number,
  teamOneId: string,
  teamTwoId: string,
): PendingAction {
  const teamId = side === 'team_one' ? teamOneId : teamTwoId;
  return {
    id: `${stepId}:${teamId}:${index}`,
    stepId,
    kind,
    side,
    index,
    count,
  };
}

export function sideOfTeam(side: TeamSide, teamOneId: string, teamTwoId: string): string {
  return side === 'team_one' ? teamOneId : teamTwoId;
}

export function oppositeSide(side: TeamSide): TeamSide {
  return side === 'team_one' ? 'team_two' : 'team_one';
}

export function describePendingAction(
  action: PendingAction | null,
  teamOneId: string,
  teamTwoId: string,
): string {
  if (!action) return 'Flow complete';
  const teamId = sideOfTeam(action.side, teamOneId, teamTwoId);
  const label = action.kind === 'protect' ? 'protect' : action.kind;
  return `${teamId} ${label} ${action.index}/${action.count}`;
}