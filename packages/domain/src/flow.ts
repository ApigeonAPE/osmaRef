import type { MatchFlow, PendingAction, TeamSide } from '@osmaref/contracts';

export interface FlowStageCounts {
  bans: number;
  protects: number;
}

/**
 * Expands a phase-based flow into a flat action queue.
 *
 * Ban/protect phases use their own count or the stage count. A pick phase is
 * open-ended in the configuration; its per-team count is derived from the
 * stage best-of so the editor never asks for a pick round count.
 */
export function buildActionQueue(
  flow: MatchFlow,
  bestOf: number,
  teamOneId: string,
  teamTwoId: string,
  stageCounts: FlowStageCounts,
): PendingAction[] {
  const actions: PendingAction[] = [];
  for (const phase of flow.phases) {
    const count = phaseCount(phase, bestOf, stageCounts);
    if (count <= 0) continue;
    const sides: TeamSide[] = [];
    if (phase.phaseOrder === 'sequential') {
      for (let index = 0; index < count; index += 1) sides.push('team_one');
      for (let index = 0; index < count; index += 1) sides.push('team_two');
    } else {
      for (let index = 0; index < count; index += 1) sides.push('team_one', 'team_two');
    }
    sides.forEach((side, index) => {
      actions.push(
        makeAction(phase.id, phase.action, side, index + 1, count, teamOneId, teamTwoId),
      );
    });
  }
  return actions;
}

function phaseCount(
  phase: MatchFlow['phases'][number],
  bestOf: number,
  stageCounts: FlowStageCounts,
): number {
  if (phase.action === 'pick') return Math.max(1, Math.ceil(bestOf / 2));
  if (phase.useStageCount) {
    return phase.action === 'ban' ? stageCounts.bans : stageCounts.protects;
  }
  return phase.countPerTeam ?? 0;
}

function makeAction(
  phaseId: string,
  kind: PendingAction['kind'],
  side: TeamSide,
  index: number,
  count: number,
  teamOneId: string,
  teamTwoId: string,
): PendingAction {
  const teamId = side === 'team_one' ? teamOneId : teamTwoId;
  return {
    id: `${phaseId}:${teamId}:${index}`,
    stepId: phaseId,
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
