import type { MatchTransport } from '../types';
import type { HubAction } from './types';

export interface ExecuteResult {
  ok: boolean;
  message: string;
  completed: number;
  total: number;
}

/**
 * Applies planner intents in order.
 *
 * Stops at the first failure and reports how many actions already succeeded, so
 * multi-user commands such as `addref a b` cannot be reported as fully applied
 * when only the first entry worked.
 */
export async function executeHubActions(
  transport: MatchTransport,
  actions: HubAction[],
): Promise<ExecuteResult> {
  let completed = 0;
  for (const action of actions) {
    try {
      await applyAction(transport, action);
      completed += 1;
    } catch (error) {
      return {
        ok: false,
        message: `${describeAction(action)} failed: ${errorMessage(error)}${
          completed > 0 ? ` (${completed}/${actions.length} applied)` : ''
        }`,
        completed,
        total: actions.length,
      };
    }
  }
  return {
    ok: true,
    message: actions.length === 0 ? 'no remote action required' : `${completed} action(s) applied`,
    completed,
    total: actions.length,
  };
}

export async function applyAction(transport: MatchTransport, action: HubAction): Promise<void> {
  switch (action.type) {
    case 'changeSettings':
      await transport.changeSettings(action.roomId, action.patch);
      return;
    case 'invitePlayer':
      await transport.invitePlayer(action.roomId, { userId: action.userId, username: action.username });
      return;
    case 'kickPlayer':
      await transport.kickPlayer(action.roomId, { userId: action.userId, username: action.username });
      return;
    case 'banUser':
      await transport.banUser(action.roomId, { userId: action.userId, username: action.username });
      return;
    case 'addReferee':
      await transport.addReferee(action.roomId, { userId: action.userId, username: action.username });
      return;
    case 'removeReferee':
      await transport.removeReferee(action.roomId, { userId: action.userId, username: action.username });
      return;
    case 'editBeatmap':
      await transport.editBeatmap(action.roomId, action.patch);
      return;
    case 'moveUser':
      await transport.moveUser(action.roomId, {
        userId: action.userId,
        username: action.username,
        ...(action.slot !== undefined ? { slot: action.slot } : {}),
        ...(action.team !== undefined ? { team: action.team } : {}),
      });
      return;
    case 'setLock':
      await transport.setLock(action.roomId, action.locked);
      return;
    case 'roll':
      await transport.roll(action.roomId, action.max);
      return;
    case 'startMatch':
      await transport.startMatch(action.roomId, action.countdown);
      return;
    case 'stopMatchCountdown':
      await transport.stopCountdown(action.roomId);
      return;
    case 'abortMatch':
      await transport.abortMatch(action.roomId);
      return;
    case 'closeRoom':
      await transport.closeRoom(action.roomId);
      return;
    default: {
      const never: never = action;
      throw new Error(`unhandled action ${JSON.stringify(never)}`);
    }
  }
}

function describeAction(action: HubAction): string {
  switch (action.type) {
    case 'changeSettings':
      return 'change room settings';
    case 'invitePlayer':
      return 'invite player';
    case 'kickPlayer':
      return 'kick player';
    case 'banUser':
      return 'ban player';
    case 'addReferee':
      return 'add referee';
    case 'removeReferee':
      return 'remove referee';
    case 'editBeatmap':
      return 'edit beatmap';
    case 'moveUser':
      return 'move player';
    case 'setLock':
      return 'set lock state';
    case 'roll':
      return 'roll';
    case 'startMatch':
      return 'start match';
    case 'stopMatchCountdown':
      return 'stop countdown';
    case 'abortMatch':
      return 'abort match';
    case 'closeRoom':
      return 'close room';
    default:
      return 'action';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}