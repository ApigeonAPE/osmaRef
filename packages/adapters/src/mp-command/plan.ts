import { KNOWN_MODS } from '@osmaref/contracts';
import type { HubTeam, RoomSnapshot, UserRef } from '../types';
import type {
  HubAction,
  LocalEffect,
  MpCommand,
  MpContext,
  MpError,
  MpPlan,
  PlanResult,
} from './types';
import { SUPPORTED_TEAM_MODES } from './types';

const MAX_MOVE_SLOT = 16;

/**
 * Turns a parsed command into transport-neutral intents.
 * All semantic validation happens here so it is testable without a live hub.
 */
export function buildMpPlan(command: MpCommand, ctx: MpContext): PlanResult {
  switch (command.verb) {
    case 'help':
      return ok([], [{ type: 'help' }], 'showing local !mp compatibility help');

    case 'settings':
      return requireRoom(ctx, (room) =>
        ok([], [{ type: 'showSettings' }], `showing settings for ${room.name}`),
      );

    case 'listrefs':
      return requireRoom(ctx, (room) =>
        ok(
          [],
          [{ type: 'showReferees' }],
          room.referees.length === 0
            ? 'no referees are associated with this room'
            : `${room.referees.length} referee(s): ${room.referees.join(', ')}`,
        ),
      );

    case 'make':
      return unsupported(
        'MP_UNSUPPORTED',
        '!mp make is only available in Bancho IRC mode; create Referee Hub rooms from the create-room dialog.',
      );

    case 'makeprivate':
      return unsupported(
        'MP_UNSUPPORTED',
        '!mp makeprivate is not available through the Referee Hub API: room history privacy has no hub equivalent.',
      );

    case 'name':
      return requireRoom(ctx, (room) =>
        ok(
          [{ type: 'changeSettings', roomId: room.roomId, patch: { name: command.name } }],
          [],
          `room renamed to "${command.name}"`,
        ),
      );

    case 'invite':
      return withUser(ctx, command.user, (user) =>
        requireRoom(ctx, (room) =>
          ok(
            [{ type: 'invitePlayer', roomId: room.roomId, userId: user.userId, username: user.username }],
            [],
            `invited ${user.username}`,
          ),
        ),
      );

    case 'kick':
      return withUser(ctx, command.user, (user) =>
        requireRoom(ctx, (room) =>
          ok(
            [{ type: 'kickPlayer', roomId: room.roomId, userId: user.userId, username: user.username }],
            [],
            `kicked ${user.username}`,
          ),
        ),
      );

    case 'ban':
      return withUser(ctx, command.user, (user) =>
        requireRoom(ctx, (room) =>
          ok(
            [{ type: 'banUser', roomId: room.roomId, userId: user.userId, username: user.username }],
            [],
            `banned ${user.username}`,
          ),
        ),
      );

    case 'addref':
    case 'removeref':
      return planReferees(command.verb, command.users, ctx);

    case 'lock':
    case 'unlock':
      return requireRoom(ctx, (room) =>
        ok(
          [{ type: 'setLock', roomId: room.roomId, locked: command.verb === 'lock' }],
          [],
          command.verb === 'lock' ? 'room locked' : 'room unlocked',
        ),
      );

    case 'size':
      return planSize(command.size, ctx);

    case 'set':
      return planSet(command.teamMode, command.scoreMode, ctx);

    case 'move':
      return withUser(ctx, command.user, (user) =>
        requireRoom(ctx, (room) => {
          const max = room.maxParticipants > 0 ? room.maxParticipants : MAX_MOVE_SLOT;
          if (command.slot < 1 || command.slot > max) {
            return err('MP_BAD_SLOT', `slot must be between 1 and ${max}`);
          }
          return ok(
            [
              {
                type: 'moveUser',
                roomId: room.roomId,
                userId: user.userId,
                username: user.username,
                slot: command.slot - 1,
              },
            ],
            [],
            `moved ${user.username} to slot ${command.slot}`,
          );
        }),
      );

    case 'team':
      return withUser(ctx, command.user, (user) =>
        requireRoom(ctx, (room) => {
          if (room.matchType !== 'team_versus') {
            return err(
              'MP_NOT_TEAM_VERSUS',
              '!mp team only works in Team VS; use !mp set 2 first',
            );
          }
          return ok(
            [
              {
                type: 'moveUser',
                roomId: room.roomId,
                userId: user.userId,
                username: user.username,
                team: command.team as HubTeam,
              },
            ],
            [],
            `moved ${user.username} to ${command.team}`,
          );
        }),
      );

    case 'map':
      return requireRoom(ctx, (room) =>
        ok(
          [
            {
              type: 'editBeatmap',
              roomId: room.roomId,
              patch: {
                beatmapId: command.beatmapId,
                ...(command.playmode !== null ? { rulesetId: command.playmode } : {}),
              },
            },
          ],
          [],
          `selected beatmap ${command.beatmapId}`,
        ),
      );

    case 'mods':
      return planMods(command.mods, ctx);

    case 'password':
      return requireRoom(ctx, (room) =>
        ok(
          [
            {
              type: 'changeSettings',
              roomId: room.roomId,
              patch: { password: command.password },
            },
          ],
          [],
          command.password ? 'room password updated' : 'room password removed',
        ),
      );

    case 'start':
      return planStart(command.seconds, ctx);

    case 'abort':
      return requireRoom(ctx, (room) =>
        ok(
          [{ type: 'abortMatch', roomId: room.roomId }],
          [],
          'match aborted',
        ),
      );

    case 'aborttimer':
      return requireRoom(ctx, (room) =>
        ok(
          [{ type: 'stopMatchCountdown', roomId: room.roomId }],
          [],
          'match start countdown cancelled',
        ),
      );

    case 'close':
      return requireRoom(ctx, (room) =>
        ok([{ type: 'closeRoom', roomId: room.roomId }], [], 'room closed'),
      );

    case 'host':
    case 'clearhost':
      return unsupported(
        'MP_UNSUPPORTED',
        '!mp host and !mp clearhost have no Referee Hub equivalent; manage referees instead.',
      );

    case 'timer':
      return unsupported(
        'MP_UNSUPPORTED',
        '!mp timer (a general room timer) has no hub equivalent. !mp start <seconds> controls the match start countdown only.',
      );

    default: {
      const never: never = command;
      return err('MP_UNKNOWN_COMMAND', `unhandled command ${JSON.stringify(never)}`);
    }
  }
}

function planSize(size: number, ctx: MpContext): PlanResult {
  if (size === 1) {
    return err('MP_BAD_SIZE', 'the Referee Hub does not allow a room size of 1');
  }
  if (size !== 0 && (size < 2 || size > 16)) {
    return err('MP_BAD_SIZE', 'size must be 0 (unlimited) or between 2 and 16');
  }
  return requireRoom(ctx, (room) =>
    ok(
      [{ type: 'changeSettings', roomId: room.roomId, patch: { maxParticipants: size } }],
      [],
      size === 0 ? 'participant limit removed' : `room size set to ${size}`,
    ),
  );
}

function planSet(teamMode: number, scoreMode: number | null, ctx: MpContext): PlanResult {
  const matchType = SUPPORTED_TEAM_MODES[teamMode];
  if (!matchType) {
    return unsupported(
      'MP_BAD_TEAMMODE',
      teamMode === 1 || teamMode === 3
        ? 'Tag Co-op and Tag Team VS are not supported by the Referee Hub'
        : `unknown team mode ${teamMode}; use 0 (Head To Head) or 2 (Team VS)`,
    );
  }
  if (scoreMode !== null) {
    return unsupported(
      'MP_UNSUPPORTED',
      'the score mode argument of !mp set has no Referee Hub equivalent; the hub scores with lazer rules',
    );
  }
  return requireRoom(ctx, (room) =>
    ok(
      [{ type: 'changeSettings', roomId: room.roomId, patch: { matchType } }],
      [],
      `match type set to ${matchType}`,
    ),
  );
}

function planMods(tokens: string[], ctx: MpContext): PlanResult {
  const mods = tokens.map((token) => token.toUpperCase());
  const unknown = mods.filter(
    (mod) => !(KNOWN_MODS as readonly string[]).includes(mod),
  );
  if (unknown.length > 0) {
    return err('MP_BAD_MOD', `unknown mod(s): ${unknown.join(', ')}`);
  }
  const hasNone = mods.includes('NONE');
  const hasFreemod = mods.includes('FREEMOD');
  if (hasNone && mods.length > 1) {
    return err('MP_FREEMOD_CONFLICT', 'NM/None cannot be combined with other mods');
  }
  if (hasFreemod && mods.length > 1) {
    return err('MP_FREEMOD_CONFLICT', 'Freemod cannot be combined with forced mods');
  }

  let requiredMods: string[] = [];
  let allowedMods: string[] = [];
  const freestyle = false;
  if (hasFreemod) {
    // Freemod lets players choose any mod that is valid for the current
    // ruleset; it is not freestyle (which also allows difficulty adjustment).
    allowedMods = ctx.freemodPool
      ? [...ctx.freemodPool]
      : KNOWN_MODS.filter(
          (mod) => mod !== 'NM' && mod !== 'FREEMOD' && mod !== 'NONE' && mod !== 'V2',
        );
  } else if (!hasNone) {
    requiredMods = mods.filter((mod) => mod !== 'NM');
  }

  return requireRoom(ctx, (room) =>
    ok(
      [
        {
          type: 'editBeatmap',
          roomId: room.roomId,
          patch: { requiredMods, allowedMods, freestyle },
        },
      ],
      [],
      hasFreemod
        ? 'freemod enabled; players may choose any valid mod'
        : requiredMods.length === 0
          ? 'mods cleared'
          : `mods set to ${requiredMods.join(' ')}`,
    ),
  );
}

function planStart(seconds: number | null, ctx: MpContext): PlanResult {
  if (seconds !== null && (seconds < 0 || seconds > 600)) {
    return err('MP_BAD_COUNTDOWN', 'start countdown must be between 0 and 600 seconds');
  }
  const countdown = seconds === null || seconds === 0 ? null : seconds;
  return requireRoom(ctx, (room) => {
    if (room.players.length === 0) {
      return err('MP_NOT_READY', 'cannot start: no players are in the room');
    }
    const notReady = room.players.filter(
      (player) => player.status !== 'ready' && !room.referees.includes(player.userId),
    );
    if (notReady.length > 0) {
      const names = notReady
        .map((player) => player.username ?? `#${player.userId}`)
        .join(', ');
      return err('MP_NOT_READY', `cannot start: not ready: ${names}`);
    }
    return ok(
      [{ type: 'startMatch', roomId: room.roomId, countdown }],
      [],
      countdown === null ? 'match starting now' : `match starting in ${countdown}s`,
    );
  });
}

function planReferees(
  verb: 'addref' | 'removeref',
  names: string[],
  ctx: MpContext,
): PlanResult {
  const resolved: UserRef[] = [];
  for (const name of names) {
    const user = resolveUser(name, ctx.users);
    if (!user) {
      return err('MP_UNKNOWN_USER', `unknown user "${name}"`);
    }
    resolved.push(user);
  }
  return requireRoom(ctx, (room) => {
    const actions: HubAction[] = resolved.map((user) =>
      verb === 'addref'
        ? { type: 'addReferee', roomId: room.roomId, userId: user.userId, username: user.username }
        : { type: 'removeReferee', roomId: room.roomId, userId: user.userId, username: user.username },
    );
    const label = resolved.map((user) => user.username).join(', ');
    return ok(
      actions,
      [],
      `${verb === 'addref' ? 'adding' : 'removing'} referee(s): ${label}`,
    );
  });
}

export function resolveUser(token: string, users: UserRef[]): UserRef | null {
  const trimmed = token.trim();
  const idMatch = /^#(\d+)$/.exec(trimmed);
  if (idMatch) {
    const userId = Number(idMatch[1]);
    const known = users.find((user) => user.userId === userId);
    return { userId, username: known?.username || `#${userId}` };
  }
  const needle = normalizeName(trimmed);
  return users.find((user) => normalizeName(user.username) === needle) ?? null;
}

export function normalizeName(value: string): string {
  return value.replace(/_/g, ' ').trim().toLowerCase();
}

function withUser(
  ctx: MpContext,
  token: string,
  next: (user: UserRef) => PlanResult,
): PlanResult {
  const user = resolveUser(token, ctx.users);
  if (!user) {
    return err(
      'MP_UNKNOWN_USER',
      `unknown user "${token}"; check the spelling or use #user_id`,
    );
  }
  return next(user);
}

function requireRoom(
  ctx: MpContext,
  next: (room: RoomSnapshot) => PlanResult,
): PlanResult {
  if (!ctx.room) {
    return err('MP_NO_ROOM', 'not connected to a multiplayer room');
  }
  return next(ctx.room);
}

function ok(actions: HubAction[], effects: LocalEffect[], summary: string): PlanResult {
  const plan: MpPlan = { actions, effects, summary };
  return { ok: true, plan };
}

function err(code: MpError['code'], message: string): PlanResult {
  return { ok: false, error: { code, message } };
}

function unsupported(code: MpError['code'], message: string): PlanResult {
  return { ok: false, error: { code, message } };
}