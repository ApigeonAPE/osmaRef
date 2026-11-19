import type { HubTeam, RoomSnapshot, UserRef } from '../types';

/** Commands recognised by the local compatibility layer. */
export type MpVerb =
  | 'help'
  | 'make'
  | 'makeprivate'
  | 'name'
  | 'invite'
  | 'lock'
  | 'unlock'
  | 'size'
  | 'set'
  | 'move'
  | 'host'
  | 'clearhost'
  | 'settings'
  | 'start'
  | 'abort'
  | 'team'
  | 'map'
  | 'mods'
  | 'timer'
  | 'aborttimer'
  | 'kick'
  | 'ban'
  | 'password'
  | 'addref'
  | 'removeref'
  | 'listrefs'
  | 'close';

export type MpCommand =
  | { verb: 'help' }
  | { verb: 'make'; name: string }
  | { verb: 'makeprivate'; name: string }
  | { verb: 'name'; name: string }
  | { verb: 'invite'; user: string }
  | { verb: 'lock' }
  | { verb: 'unlock' }
  | { verb: 'size'; size: number }
  | { verb: 'set'; teamMode: number; scoreMode: number | null }
  | { verb: 'move'; user: string; slot: number }
  | { verb: 'host'; user: string }
  | { verb: 'clearhost' }
  | { verb: 'settings' }
  | { verb: 'start'; seconds: number | null }
  | { verb: 'abort' }
  | { verb: 'team'; user: string; team: HubTeam }
  | { verb: 'map'; beatmapId: number; playmode: number | null }
  | { verb: 'mods'; mods: string[] }
  | { verb: 'timer'; seconds: number | null }
  | { verb: 'aborttimer' }
  | { verb: 'kick'; user: string }
  | { verb: 'ban'; user: string }
  | { verb: 'password'; password: string }
  | { verb: 'addref'; users: string[] }
  | { verb: 'removeref'; users: string[] }
  | { verb: 'listrefs' }
  | { verb: 'close' };

export type MpErrorCode =
  | 'MP_UNKNOWN_COMMAND'
  | 'MP_BAD_ARGS'
  | 'MP_UNSUPPORTED'
  | 'MP_NO_ROOM'
  | 'MP_UNKNOWN_USER'
  | 'MP_BAD_SLOT'
  | 'MP_BAD_MOD'
  | 'MP_BAD_SIZE'
  | 'MP_BAD_COUNTDOWN'
  | 'MP_NOT_TEAM_VERSUS'
  | 'MP_BAD_TEAMMODE'
  | 'MP_NOT_READY'
  | 'MP_FREEMOD_CONFLICT';

export interface MpError {
  code: MpErrorCode;
  message: string;
}

export type ParseResult =
  | { kind: 'not_mp' }
  | { kind: 'parsed'; command: MpCommand; raw: string }
  | { kind: 'invalid'; error: MpError; raw: string };

/**
 * Transport-neutral intents produced by the planner.
 * The executor maps these onto the Referee Hub client (or the IRC client).
 */
export type HubAction =
  | {
      type: 'changeSettings';
      roomId: string;
      patch: {
        name?: string;
        password?: string;
        matchType?: 'head_to_head' | 'team_versus';
        maxParticipants?: number;
      };
    }
  | { type: 'invitePlayer'; roomId: string; userId: number; username: string }
  | { type: 'kickPlayer'; roomId: string; userId: number; username: string }
  | { type: 'banUser'; roomId: string; userId: number; username: string }
  | { type: 'addReferee'; roomId: string; userId: number; username: string }
  | { type: 'removeReferee'; roomId: string; userId: number; username: string }
  | { type: 'editBeatmap'; roomId: string; patch: { beatmapId?: number; rulesetId?: number; requiredMods?: string[]; allowedMods?: string[]; freestyle?: boolean } }
  | { type: 'moveUser'; roomId: string; userId: number; username: string; slot?: number; team?: HubTeam }
  | { type: 'setLock'; roomId: string; locked: boolean }
  | { type: 'roll'; roomId: string; max?: number }
  | { type: 'startMatch'; roomId: string; countdown: number | null }
  | { type: 'stopMatchCountdown'; roomId: string }
  | { type: 'abortMatch'; roomId: string }
  | { type: 'closeRoom'; roomId: string };

export type LocalEffect =
  | { type: 'help' }
  | { type: 'showSettings' }
  | { type: 'showReferees' };

export interface MpPlan {
  actions: HubAction[];
  effects: LocalEffect[];
  summary: string;
}

export interface MpContext {
  room: RoomSnapshot | null;
  /** Known users the planner may resolve; usually participants plus referees. */
  users: UserRef[];
  self: UserRef | null;
  defaultRulesetId: number;
  /** Used by `!mp make`; without it the command is rejected. */
  defaultBeatmapId: number | null;
  defaultMatchType: 'head_to_head' | 'team_versus';
  defaultMaxParticipants: number;
  /** Allowed mods injected by `Freemod`. */
  freemodPool?: string[];
  maxParticipantsLimit?: number;
}

export type PlanResult =
  | { ok: true; plan: MpPlan }
  | { ok: false; error: MpError };

export const SUPPORTED_TEAM_MODES: Record<number, 'head_to_head' | 'team_versus'> = {
  0: 'head_to_head',
  2: 'team_versus',
};

export const MP_COMMAND_VERBS: MpVerb[] = [
  'help',
  'make',
  'makeprivate',
  'name',
  'invite',
  'lock',
  'unlock',
  'size',
  'set',
  'move',
  'host',
  'clearhost',
  'settings',
  'start',
  'abort',
  'team',
  'map',
  'mods',
  'timer',
  'aborttimer',
  'kick',
  'ban',
  'password',
  'addref',
  'removeref',
  'listrefs',
  'close',
];