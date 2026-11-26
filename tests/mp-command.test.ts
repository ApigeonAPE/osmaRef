import { describe, expect, it } from 'vitest';
import {
  ChatDispatcher,
  buildMpPlan,
  parseMpCommand,
  resolveUser,
  routeMpCommand,
  type MpContext,
  type RoomSnapshot,
} from '@osmaref/adapters';

function room(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    roomId: '1001',
    name: 'Test Cup: A vs B',
    password: 'secret',
    chatChannelId: '500',
    matchType: 'team_versus',
    winCondition: 'ScoreV2',
    ruleset: null,
    mods: [],
    queueMode: 'host_only',
    maxParticipants: 8,
    locked: false,
    playlist: [],
    currentPlaylistItemId: null,
    currentBeatmapId: null,
    players: [],
    referees: [1],
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function context(overrides: Partial<MpContext> = {}): MpContext {
  return {
    room: room(),
    users: [
      { userId: 1, username: 'Ref One' },
      { userId: 2, username: 'Player One' },
      { userId: 3, username: 'Player_Two' },
      { userId: 4, username: '[NOC] Kamiina-Botan' },
    ],
    self: { userId: 1, username: 'Ref One' },
    defaultRulesetId: 0,
    defaultBeatmapId: 12345,
    defaultMatchType: 'team_versus',
    defaultMaxParticipants: 8,
    ...overrides,
  };
}

describe('!mp prefix and verb casing', () => {
  it.each(['!mp', '!MP', '!Mp', '!mP', '!mp   '])('treats %s as help', (input) => {
    expect(parseMpCommand(input).kind).toBe('parsed');
  });

  it.each(['!mp START', '!MP start', '!Mp StArT 5', '!mP sTaRt 5'])(
    'matches %s case-insensitively',
    (input) => {
      const parsed = parseMpCommand(input);
      expect(parsed.kind).toBe('parsed');
      if (parsed.kind !== 'parsed') return;
      expect(parsed.command.verb).toBe('start');
    },
  );

  it('does not treat inner !mp text as a command', () => {
    expect(parseMpCommand('please run !mp start').kind).toBe('not_mp');
    expect(parseMpCommand('x!mp start').kind).toBe('not_mp');
    expect(parseMpCommand('!mpx start').kind).toBe('not_mp');
  });
});

describe('referee hub !mp mapping', () => {
  it('maps map with playmode to an editBeatmap intent', () => {
    const result = routeMpCommand('!Mp MaP 123 2', context());
    expect(result.ok).toBe(true);
    expect(result.actions).toEqual([
      { type: 'editBeatmap', roomId: '1001', patch: { beatmapId: 123, rulesetId: 2 } },
    ]);
  });

  it('converts the 1-based !mp move slot to the hub index', () => {
    const result = routeMpCommand('!mp move Player_One 4', context());
    expect(result.ok).toBe(true);
    expect(result.actions).toEqual([
      { type: 'moveUser', roomId: '1001', userId: 2, username: 'Player One', slot: 3 },
    ]);
  });

  it('resolves users by id and by underscored name', () => {
    const byId = routeMpCommand('!mp invite #3', context());
    expect(byId.actions[0]).toEqual({
      type: 'invitePlayer',
      roomId: '1001',
      userId: 3,
      username: 'Player_Two',
    });

    const byName = routeMpCommand('!mp invite Player Two', context());
    expect(byName.ok).toBe(true);
    expect(byName.actions[0]).toMatchObject({ type: 'invitePlayer', userId: 3 });

    const byUnderscore = routeMpCommand('!mp invite Player_Two', context());
    expect(byUnderscore.actions[0]).toEqual({
      type: 'invitePlayer',
      roomId: '1001',
      userId: 3,
      username: 'Player_Two',
    });
  });

  it('keeps spaces and symbols in usernames', () => {
    const invite = routeMpCommand('!mp invite [NOC] Kamiina-Botan', context());
    expect(invite.actions[0]).toEqual({
      type: 'invitePlayer',
      roomId: '1001',
      userId: 4,
      username: '[NOC] Kamiina-Botan',
    });

    const move = routeMpCommand('!mp move [NOC] Kamiina-Botan 3', context());
    expect(move.actions[0]).toMatchObject({ type: 'moveUser', userId: 4, slot: 2 });

    const quoted = routeMpCommand('!mp invite "Player One"', context());
    expect(quoted.actions[0]).toMatchObject({ type: 'invitePlayer', userId: 2 });
  });

  it('maps Freemod to all mods without enabling freestyle', () => {
    const result = buildMpPlan(
      { verb: 'mods', mods: ['Freemod'] },
      context({ room: room({ currentPlaylistItemId: '9' }) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = (result.plan.actions[0] as { patch: Record<string, unknown> }).patch;
    expect(patch.freestyle).toBe(false);
    expect(patch.requiredMods).toEqual(['NF']);
    expect(patch.allowedMods).toContain('SO');
    expect(patch.allowedMods).toContain('HD');
    expect(patch.allowedMods).not.toContain('NM');
    expect(patch.allowedMods).not.toContain('NF');
  });

  it('uses the configured freemod range when provided', () => {
    const result = buildMpPlan(
      { verb: 'mods', mods: ['Freemod'] },
      context({
        room: room({ currentPlaylistItemId: '9' }),
        freemodPool: { required: [], allowed: ['HD', 'DT'] },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = (result.plan.actions[0] as { patch: Record<string, unknown> }).patch;
    expect(patch).toEqual({
      requiredMods: [],
      allowedMods: ['HD', 'DT'],
      freestyle: false,
    });
  });

  it('clears freestyle when forcing specific mods', () => {
    const result = buildMpPlan(
      { verb: 'mods', mods: ['HD'] },
      context({ room: room({ currentPlaylistItemId: '9' }) }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const patch = (result.plan.actions[0] as { patch: Record<string, unknown> }).patch;
    expect(patch).toEqual({ requiredMods: ['HD'], allowedMods: [], freestyle: false });
  });

  it('rejects Freemod combined with a forced mod', () => {
    const result = buildMpPlan({ verb: 'mods', mods: ['Freemod', 'HD'] }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MP_FREEMOD_CONFLICT');
  });

  it('rejects an unknown mod instead of silently dropping it', () => {
    const result = buildMpPlan({ verb: 'mods', mods: ['HD', 'XX'] }, context());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('MP_BAD_MOD');
  });

  it('maps start with and without countdown', () => {
    const ready = context({
      room: room({
        players: [
          { userId: 2, mods: [], team: 'red', slot: 0, status: 'ready' },
          { userId: 3, mods: [], team: 'blue', slot: 1, status: 'ready' },
        ],
      }),
    });
    const immediate = routeMpCommand('!mp start', ready);
    expect(immediate.actions[0]).toEqual({ type: 'startMatch', roomId: '1001', countdown: null });

    const delayed = routeMpCommand('!MP START 5', ready);
    expect(delayed.actions[0]).toEqual({ type: 'startMatch', roomId: '1001', countdown: 5 });
  });

  it('refuses to start before every player is ready', () => {
    const result = routeMpCommand(
      '!mp start',
      context({
        room: room({
          players: [{ userId: 2, mods: [], team: 'red', slot: 0, status: 'idle' }],
        }),
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorCode).toBe('MP_NOT_READY');
  });

  it('ignores referees when checking readiness', () => {
    const result = routeMpCommand(
      '!mp start',
      context({
        room: room({
          referees: [1],
          players: [
            { userId: 1, mods: [], team: null, slot: null, status: 'idle' },
            { userId: 2, mods: [], team: 'red', slot: 0, status: 'ready' },
            { userId: 3, mods: [], team: 'blue', slot: 1, status: 'ready' },
          ],
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions[0]).toEqual({ type: 'startMatch', roomId: '1001', countdown: null });
  });

  it('maps lock and aborttimer', () => {
    expect(routeMpCommand('!mp lock', context()).actions[0]).toEqual({
      type: 'setLock',
      roomId: '1001',
      locked: true,
    });
    expect(routeMpCommand('!mp aborttimer', context()).actions[0]).toEqual({
      type: 'stopMatchCountdown',
      roomId: '1001',
    });
  });

  it('keeps password values out of the summary', () => {
    const result = routeMpCommand('!mp password hunter2', context());
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.message)).not.toContain('hunter2');
    expect(result.actions[0]).toMatchObject({ type: 'changeSettings' });
  });

  it('clears the password when no argument is given', () => {
    const result = routeMpCommand('!mp password', context());
    expect(result.ok).toBe(true);
    expect(result.actions[0]).toEqual({
      type: 'changeSettings',
      roomId: '1001',
      patch: { password: '' },
    });
  });

  it('maps every addref user, and fails atomically on an unknown one', () => {
    const ok = routeMpCommand('!mp addref Player_One, #3', context());
    expect(ok.actions).toEqual([
      { type: 'addReferee', roomId: '1001', userId: 2, username: 'Player One' },
      { type: 'addReferee', roomId: '1001', userId: 3, username: 'Player_Two' },
    ]);

    const bad = routeMpCommand('!mp addref Player_One, UnknownUser', context());
    expect(bad.ok).toBe(false);
    expect(bad.actions).toEqual([]);
  });

  it('rejects size 1 but accepts 0 and 2-16', () => {
    expect(routeMpCommand('!mp size 1', context()).ok).toBe(false);
    expect(routeMpCommand('!mp size 0', context()).actions[0]).toMatchObject({
      type: 'changeSettings',
      patch: { maxParticipants: 0 },
    });
    expect(routeMpCommand('!mp size 16', context()).ok).toBe(true);
    expect(routeMpCommand('!mp size 17', context()).ok).toBe(false);
  });

  it('only accepts head-to-head and team-versus in !mp set', () => {
    expect(routeMpCommand('!mp set 0', context()).actions[0]).toMatchObject({
      patch: { matchType: 'head_to_head' },
    });
    expect(routeMpCommand('!mp set 2', context()).actions[0]).toMatchObject({
      patch: { matchType: 'team_versus' },
    });
    expect(routeMpCommand('!mp set 1', context()).ok).toBe(false);
    expect(routeMpCommand('!mp set 3', context()).ok).toBe(false);
    // A score mode argument has no hub equivalent and must not be guessed.
    expect(routeMpCommand('!mp set 2 1', context()).ok).toBe(false);
  });

  it('rejects team changes outside Team VS', () => {
    const result = routeMpCommand(
      '!mp team Player_One red',
      context({ room: room({ matchType: 'head_to_head' }) }),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MP_NOT_TEAM_VERSUS');
  });

  it.each([
    ['!mp makeprivate Secret Cup', 'MP_UNSUPPORTED'],
    ['!mp host Player_One', 'MP_UNSUPPORTED'],
    ['!mp clearhost', 'MP_UNSUPPORTED'],
    ['!mp timer 60', 'MP_UNSUPPORTED'],
  ])('documents %s as unsupported', (input, code) => {
    const result = routeMpCommand(input, context());
    expect(result.handled).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(code);
  });

  it('requires a room for room-scoped commands', () => {
    const result = routeMpCommand('!mp invite Player_One', context({ room: null }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MP_NO_ROOM');
  });

  it('rejects !mp make because Referee Hub rooms are created from the UI', () => {
    const result = routeMpCommand('!mp make New Cup', context());
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MP_UNSUPPORTED');
  });
});

describe('ChatDispatcher', () => {
  function makeDispatcher(sent: string[], executed: string[] = []) {
    return new ChatDispatcher({
      getContext: () => context(),
      sendChat: async (text) => {
        sent.push(text);
      },
      execute: async (actions) => {
        executed.push(...actions.map((action) => action.type));
        return { ok: true, message: 'applied' };
      },
    });
  }

  it('sends ordinary chat exactly once', async () => {
    const sent: string[] = [];
    const outcome = await makeDispatcher(sent).submit('hello there');
    expect(outcome.handled).toBe(false);
    expect(sent).toEqual(['hello there']);
  });

  it.each([
    '!mp help',
    '!MP START',
    '!Mp MaP 123',
    '!mp mods HD',
    '!mp nonsense',
    '!mp size 1',
    '!mp makeprivate x',
  ])('never forwards recognised command %s to chat', async (input) => {
    const sent: string[] = [];
    const outcome = await makeDispatcher(sent).submit(input);
    expect(outcome.handled).toBe(true);
    expect(sent).toEqual([]);
  });

  it('executes planned intents and reports success', async () => {
    const sent: string[] = [];
    const executed: string[] = [];
    const outcome = await makeDispatcher(sent, executed).submit('!mp lock');
    expect(sent).toEqual([]);
    expect(executed).toEqual(['setLock']);
    expect(outcome.ok).toBe(true);
  });

  it('does not execute anything when validation fails', async () => {
    const sent: string[] = [];
    const executed: string[] = [];
    const outcome = await makeDispatcher(sent, executed).submit('!mp move Nobody 2');
    expect(sent).toEqual([]);
    expect(executed).toEqual([]);
    expect(outcome.ok).toBe(false);
  });
});
describe('user references', () => {
  it('falls back to #id when the roster has no username', () => {
    expect(resolveUser('#42', [{ userId: 42, username: '' }])).toEqual({
      userId: 42,
      username: '#42',
    });
    expect(resolveUser('#7', [])).toEqual({ userId: 7, username: '#7' });
  });
});
