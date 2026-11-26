import { describe, expect, it } from 'vitest';
import {
  LineBuffer,
  parseIrcLine,
  toPrivmsg,
  roomIdFromChannel,
  channelForRoom,
  parseBanchoLine,
  parseModClauses,
  applyBanchoEvent,
  createBanchoRoomState,
  formatIrcLoginFailure,
  IrcMatchTransport,
  type TransportEvent,
} from '@osmaref/adapters';

describe('IRC line parsing', () => {
  it('parses a private message with prefix', () => {
    const message = parseIrcLine(':Player_One!user@host PRIVMSG #mp_123 :hello world');
    expect(message).not.toBeNull();
    expect(message?.command).toBe('PRIVMSG');
    expect(message?.nick).toBe('Player_One');
    expect(message?.params).toEqual(['#mp_123']);
    expect(message?.trailing).toBe('hello world');
    expect(toPrivmsg(message!)).toEqual({
      from: 'Player_One',
      target: '#mp_123',
      text: 'hello world',
    });
  });

  it('parses tags and notices', () => {
    const message = parseIrcLine('@account=42;msgid=abc :BanchoBot!b@h NOTICE Ref :Hi there');
    expect(message?.tags).toEqual({ account: '42', msgid: 'abc' });
    expect(message?.nick).toBe('BanchoBot');
    expect(message?.command).toBe('NOTICE');
    expect(message?.params).toEqual(['Ref']);
    expect(message?.trailing).toBe('Hi there');
  });

  it('handles an empty trailing parameter', () => {
    const message = parseIrcLine(':X!u@h PRIVMSG #mp_1 :');
    expect(message?.trailing).toBe('');
  });

  it('reassembles lines split across TCP chunks', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('PING :abc\r\n:BanchoBot!b@h PRIVMSG #mp_1 :he')).toHaveLength(1);
    const lines = buffer.push('llo\r\n');
    expect(lines).toEqual([':BanchoBot!b@h PRIVMSG #mp_1 :hello']);
  });

  it('derives room ids and channels', () => {
    expect(roomIdFromChannel('#mp_987654')).toBe('987654');
    expect(roomIdFromChannel('#osu')).toBeNull();
    expect(channelForRoom('987654')).toBe('#mp_987654');
  });
});


describe('IRC countdown events', () => {
  // `!mp start 10` is answered twice: "Queued the match to start in 10 seconds"
  // and "Match starts in 10 seconds". Both describe the same countdown.
  it('collapses the queued and the countdown announcement into one event', () => {
    const transport = new IrcMatchTransport({
      host: 'irc.ppy.sh',
      port: 6667,
      username: 'referee',
      password: 'token',
    });
    const internal = transport as unknown as {
      rooms: Map<string, ReturnType<typeof createBanchoRoomState>>;
      handleBotMessage: (from: string, target: string, text: string) => void;
    };
    internal.rooms.set('123', createBanchoRoomState('123'));
    const events: TransportEvent[] = [];
    transport.onEvent((event) => events.push(event));

    internal.handleBotMessage('BanchoBot', '#mp_123', 'Queued the match to start in 10 seconds');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'Match starts in 10 seconds');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'Match starts in 5 seconds');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'Match starts in 4 seconds');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'Match starts in 3 seconds');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'The match has started!');
    internal.handleBotMessage('BanchoBot', '#mp_123', 'Aborted the match');

    expect(events.filter((event) => event.type === 'countdown')).toEqual([
      { type: 'countdown', roomId: '123', seconds: 10, kind: 'match_start' },
      { type: 'countdown', roomId: '123', seconds: 5, kind: 'match_start' },
      { type: 'countdown', roomId: '123', seconds: 4, kind: 'match_start' },
      { type: 'countdown', roomId: '123', seconds: 3, kind: 'match_start' },
    ]);
    expect(events.filter((event) => event.type === 'match_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'match_aborted')).toHaveLength(1);
  });
});

describe('IRC login failures', () => {
  it('surfaces Bancho’s authentication text instead of a bare close', () => {
    const message = formatIrcLoginFailure(
      ['You are required to authenticate before accessing this service.'],
      null,
    );
    expect(message).toContain('You are required to authenticate');
    expect(message).toContain('legacy-api');
  });

  it('mentions throttling and restricted accounts', () => {
    expect(formatIrcLoginFailure([], 'Throttled: too many connections')).toMatch(/throttl/i);
    expect(formatIrcLoginFailure([], 'Your account is restricted')).toMatch(/refused/i);
  });

  it('still gives the password hint when the socket simply closes', () => {
    const message = formatIrcLoginFailure([], null);
    expect(message).toContain('closed before login');
    expect(message).toContain('legacy-api');
  });
});

describe('Bancho bot messages', () => {
  // Sample captured from Bancho in this project:
  // "Created the tournament match https://osu.ppy.sh/mp/122142417 Quick room"
  it('extracts the room id from the observed creation line', () => {
    expect(
      parseBanchoLine('Created the tournament match https://osu.ppy.sh/mp/122142417 Quick room'),
    ).toEqual({ kind: 'match_created', roomId: '122142417' });
  });

  it('parses rolls', () => {
    expect(parseBanchoLine('Player_One rolls 73 point(s)')).toEqual({
      kind: 'roll',
      username: 'Player_One',
      value: 73,
    });
  });

  it('parses finished players', () => {
    expect(parseBanchoLine('Player_One finished playing (Score: 987,654, PASSED)')).toEqual({
      kind: 'player_finished',
      username: 'Player_One',
      score: 987654,
      passed: true,
    });
  });

  it('returns null for unknown lines instead of guessing', () => {
    expect(parseBanchoLine('some new bancho message we do not know')).toBeNull();
    expect(parseBanchoLine('Team Red: lots | Team Blue: some')).toBeNull();
  });

  it('parses the observed lock and unlock confirmations', () => {
    expect(parseBanchoLine('Locked the match')).toEqual({ kind: 'lock_state', locked: true });
    expect(parseBanchoLine('Unlocked the match')).toEqual({ kind: 'lock_state', locked: false });
  });

  it('parses the observed room name update', () => {
    expect(parseBanchoLine('Room name updated to "Test"')).toEqual({
      kind: 'room_name',
      name: 'Test',
    });
  });

  it('parses the observed !mp set and !mp size confirmations', () => {
    expect(parseBanchoLine('Changed match settings to TeamVs, ScoreV2')).toEqual({
      kind: 'room_settings',
      matchType: 'team_versus',
      winCondition: 'ScoreV2',
    });
    expect(parseBanchoLine('Changed match to size 10')).toEqual({ kind: 'room_settings', slots: 10 });
    expect(parseBanchoLine('Room size: 8')).toEqual({ kind: 'room_settings', slots: 8 });
  });

  it('parses the multi-line !mp settings output', () => {
    expect(
      parseBanchoLine(
        'Room name: Quick room, History: https://osu.ppy.sh/mp/122142425',
      ),
    ).toEqual({ kind: 'room_name', name: 'Quick room' });
    expect(
      parseBanchoLine('Team mode: HeadToHead, Win condition: ScoreV2'),
    ).toEqual({
      kind: 'room_settings',
      matchType: 'head_to_head',
      winCondition: 'ScoreV2',
    });
    expect(parseBanchoLine('Players: 0')).toEqual({ kind: 'room_settings', players: 0 });
  });

  it('applies parsed settings to the room state', () => {
    const state = createBanchoRoomState('1');
    applyBanchoEvent(state, {
      kind: 'room_name',
      name: 'Quick room',
    });
    applyBanchoEvent(state, {
      kind: 'room_settings',
      matchType: 'team_versus',
      winCondition: 'ScoreV2',
      slots: 12,
    });
    applyBanchoEvent(state, { kind: 'room_settings', players: 4 });
    expect(state.name).toBe('Quick room');
    expect(state.matchType).toBe('team_versus');
    expect(state.winCondition).toBe('ScoreV2');
    expect(state.size).toBe(12);
    expect(state.playerCount).toBe(4);
  });

  // All samples below are taken from #mp_122128684.messages.ndjson.
  it('parses beatmap info and beatmap changes', () => {
    expect(
      parseBanchoLine('Beatmap: https://osu.ppy.sh/b/5977747 grechka - ty kak vsegda'),
    ).toEqual({ kind: 'beatmap', beatmapId: 5977747, title: 'grechka - ty kak vsegda' });
    expect(
      parseBanchoLine(
        'Changed beatmap to https://osu.ppy.sh/b/2705426 Camellia as "Reverse of Riot" - Completeness Under Incompleteness ("true prooF" Long ver.)',
      ),
    ).toEqual({
      kind: 'beatmap',
      beatmapId: 2705426,
      title:
        'Camellia as "Reverse of Riot" - Completeness Under Incompleteness ("true prooF" Long ver.)',
    });
  });

  it('parses slot lines into roster entries', () => {
    expect(
      parseBanchoLine(
        'Slot 2  Ready     https://osu.ppy.sh/u/3407743 Miyaguni Akari  [Team Red  / NoFail, HardRock]',
      ),
    ).toEqual({
      kind: 'roster',
      player: {
        userId: 3407743,
        username: 'Miyaguni Akari',
        slot: 2,
        team: 'red',
        mods: ['NoFail', 'HardRock'],
        ready: true,
      },
    });
    expect(
      parseBanchoLine(
        'Slot 4  Not Ready https://osu.ppy.sh/u/34934805 NoHaxJustTaiwan [Team Blue]',
      ),
    ).toEqual({
      kind: 'roster',
      player: {
        userId: 34934805,
        username: 'NoHaxJustTaiwan',
        slot: 4,
        team: 'blue',
        mods: [],
        ready: false,
      },
    });
    // Slot lines may carry an "Incorrect slot" warning after the bracket.
    expect(
      parseBanchoLine(
        'Slot 7  Not Ready https://osu.ppy.sh/u/38363768 Vain_ [Team Red ]Incorrect slot, player should be in slot 1, 2 or 3',
      ),
    ).toMatchObject({ kind: 'roster', player: { username: 'Vain_', slot: 7 } });
  });

  it('parses joins, leaves, moves and team changes', () => {
    expect(parseBanchoLine('Murasaki Shion joined in slot 1 for team blue.')).toEqual({
      kind: 'player_joined',
      username: 'Murasaki Shion',
      slot: 1,
      team: 'blue',
    });
    expect(parseBanchoLine('Murasaki Shion left the game.')).toEqual({
      kind: 'player_left',
      username: 'Murasaki Shion',
    });
    expect(parseBanchoLine('Nagato moved to slot 8')).toEqual({
      kind: 'player_moved',
      username: 'Nagato',
      slot: 8,
    });
    expect(parseBanchoLine('AkiYukie changed to Blue')).toEqual({
      kind: 'player_team',
      username: 'AkiYukie',
      team: 'blue',
    });
  });

  it('parses countdowns and match lifecycle lines', () => {
    expect(parseBanchoLine('Countdown ends in 30 seconds')).toEqual({
      kind: 'countdown',
      seconds: 30,
      label: 'timer',
    });
    expect(parseBanchoLine('Countdown ends in 2 minutes')).toEqual({
      kind: 'countdown',
      seconds: 120,
      label: 'timer',
    });
    expect(parseBanchoLine('Match starts in 10 seconds')).toEqual({
      kind: 'countdown',
      seconds: 10,
      label: 'match_start',
    });
    expect(parseBanchoLine('Queued the match to start in 10 seconds')).toEqual({
      kind: 'match_starting',
      seconds: 10,
    });
    expect(parseBanchoLine('Countdown finished')).toEqual({
      kind: 'countdown_stopped',
      reason: 'finished',
    });
    expect(parseBanchoLine('Countdown aborted')).toEqual({
      kind: 'countdown_stopped',
      reason: 'aborted',
    });
    expect(parseBanchoLine('The match has started!')).toEqual({ kind: 'match_started' });
    expect(parseBanchoLine('The match has finished!')).toEqual({ kind: 'match_finished' });
    expect(parseBanchoLine('Aborted the match')).toEqual({ kind: 'match_aborted' });
    expect(parseBanchoLine('Closed the match')).toEqual({ kind: 'match_closed' });
  });

  it('parses settings changes with slot counts', () => {
    expect(parseBanchoLine('Changed match settings to 12 slots, TeamVs, ScoreV2')).toEqual({
      kind: 'room_settings',
      slots: 12,
      matchType: 'team_versus',
      winCondition: 'ScoreV2',
    });
  });

  it('parses active mods and match mode changes', () => {
    expect(parseBanchoLine('Active mods: NoFail, Hidden')).toEqual({
      kind: 'mods',
      mods: ['NoFail', 'Hidden'],
    });
    expect(parseBanchoLine('Changed match mode to CatchTheBeat')).toEqual({
      kind: 'ruleset',
      ruleset: 'CatchTheBeat',
    });
  });

  it('parses mod toggle lines and applies them', () => {
    const state = createBanchoRoomState('1');
    applyBanchoEvent(state, {
      kind: 'mods',
      mods: ['NoFail', 'HardRock'],
    });
    applyBanchoEvent(state, {
      kind: 'mod_toggle',
      clauses: parseModClauses('Disabled all mods, enabled FreeMod')!,
    });
    expect(state.mods).toEqual(['Freemod']);

    applyBanchoEvent(state, {
      kind: 'mod_toggle',
      clauses: parseModClauses('Enabled NoFail, Hidden, disabled FreeMod')!,
    });
    expect(state.mods).toEqual(['NoFail', 'Hidden']);
  });

  it('replaces the mod set when BanchoBot reports newly enabled mods', () => {
    const state = createBanchoRoomState('1');
    applyBanchoEvent(state, {
      kind: 'mod_toggle',
      clauses: parseModClauses('Enabled NoFail, HardRock, disabled FreeMod')!,
    });
    expect(state.mods).toEqual(['NoFail', 'HardRock']);

    applyBanchoEvent(state, {
      kind: 'mod_toggle',
      clauses: parseModClauses('Enabled DoubleTime, enabled FreeMod')!,
    });
    expect(state.mods).toEqual(['DoubleTime', 'Freemod']);
  });

  it('tracks the mod set across consecutive !mp mods calls', () => {
    const state = createBanchoRoomState('1');
    const steps: Array<[string, string[]]> = [
      ['Enabled NoFail, HardRock, disabled FreeMod', ['NoFail', 'HardRock']],
      ['Disabled all mods, enabled FreeMod', ['Freemod']],
      ['Enabled DoubleTime, enabled FreeMod', ['DoubleTime', 'Freemod']],
      ['Enabled NoFail, DoubleTime, disabled FreeMod', ['NoFail', 'DoubleTime']],
      ['Enabled DoubleTime, enabled FreeMod', ['DoubleTime', 'Freemod']],
    ];
    for (const [line, expected] of steps) {
      const event = parseBanchoLine(line);
      expect(event, line).not.toBeNull();
      applyBanchoEvent(state, event!);
      expect(state.mods, line).toEqual(expected);
    }
  });

  it('keeps the per-player mods from slot lines in the room snapshot', () => {
    const transport = new IrcMatchTransport({
      host: 'irc.ppy.sh',
      port: 6667,
      username: 'referee',
      password: 'token',
    });
    const internal = transport as unknown as {
      rooms: Map<string, ReturnType<typeof createBanchoRoomState>>;
      handleBotMessage: (from: string, target: string, text: string) => void;
    };
    internal.rooms.set('123', createBanchoRoomState('123'));
    internal.handleBotMessage(
      'BanchoBot',
      '#mp_123',
      'Slot 2  Ready     https://osu.ppy.sh/u/3407743 Miyaguni Akari  [Team Red  / NoFail, HardRock]',
    );

    const snapshot = transport.snapshot('123');
    expect(snapshot.players).toHaveLength(1);
    expect(snapshot.players[0]?.mods).toEqual(['NoFail', 'HardRock']);
  });

  it('tracks roster and room state from real events', () => {
    const state = createBanchoRoomState('1');
    applyBanchoEvent(state, { kind: 'room_name', name: 'Cup: A vs B' });
    applyBanchoEvent(state, { kind: 'room_settings', slots: 12, matchType: 'team_versus' });
    applyBanchoEvent(state, {
      kind: 'roster',
      player: {
        userId: 3407743,
        username: 'Miyaguni Akari',
        slot: 2,
        team: 'red',
        mods: ['NoFail'],
        ready: true,
      },
    });
    applyBanchoEvent(state, {
      kind: 'player_joined',
      username: 'Nagato',
      slot: 4,
      team: 'blue',
    });
    applyBanchoEvent(state, { kind: 'player_moved', username: 'Nagato', slot: 6 });
    applyBanchoEvent(state, { kind: 'player_team', username: 'Nagato', team: 'red' });
    applyBanchoEvent(state, { kind: 'beatmap', beatmapId: 5, title: 'x - y' });

    expect(state.name).toBe('Cup: A vs B');
    expect(state.size).toBe(12);
    expect(state.players.get('miyaguni akari')?.ready).toBe(true);
    expect(state.players.get('nagato')).toMatchObject({ slot: 6, team: 'red' });
    expect(state.beatmapId).toBe(5);

    applyBanchoEvent(state, { kind: 'player_left', username: 'Nagato' });
    expect(state.players.has('nagato')).toBe(false);
  });
});