import { describe, expect, it } from 'vitest';
import {
  activePlaylistItem,
  applyRoomSettings,
  mapPlaylistEvent,
  mapRoomJoined,
  resolvePlaylistRuleset,
} from '@osmaref/adapters';

describe('Referee Hub playlist mapping', () => {
  it('submits non-osu! beatmaps with their native ruleset', () => {
    expect(resolvePlaylistRuleset('taiko', 0)).toBe(1);
    expect(resolvePlaylistRuleset('fruits', 0)).toBe(2);
    expect(resolvePlaylistRuleset('mania', 2)).toBe(3);
    // osu! beatmaps (and unknown modes) keep the mode picked in the UI.
    expect(resolvePlaylistRuleset('osu', 3)).toBe(3);
    expect(resolvePlaylistRuleset('', 2)).toBe(2);
  });

  it('maps the room slot array onto players', () => {
    const snapshot = mapRoomJoined({
      room_id: 1001,
      chat_channel_id: 500,
      name: 'Final',
      password: '',
      max_participants: 4,
      State: { type: 'team_versus', locked: false, slots: [null, 42, 43, null] },
      queue_mode: 'host_only',
      playlist: [],
      players: [
        { user_id: 42, status: 'ready', style: {}, mods: [], team: 'red' },
        { user_id: 43, status: 'idle', style: {}, mods: [], team: 'blue' },
      ],
      referees: [],
    });
    expect(snapshot.players.map((player) => player.slot)).toEqual([1, 2]);
  });

  it('reads PlaylistItemChanged payloads nested under playlist_item', () => {
    const entry = mapPlaylistEvent({
      room_id: 1001,
      playlist_item: {
        id: 7,
        ruleset_id: 3,
        beatmap_id: 3958820,
        required_mods: [{ acronym: 'HD' }],
        allowed_mods: [],
        freestyle: false,
        was_played: false,
        order: 2,
      },
    });
    expect(entry).toEqual({
      id: '7',
      beatmapId: 3958820,
      rulesetId: 3,
      requiredMods: ['HD'],
      allowedMods: [],
      freestyle: false,
      wasPlayed: false,
      order: 2,
    });
  });

  it('maps a joined room playlist and participants', () => {
    const snapshot = mapRoomJoined({
      room_id: 1001,
      chat_channel_id: 500,
      name: 'Final',
      password: 'secret',
      max_participants: 8,
      State: { type: 'team_versus', locked: false, slots: null },
      queue_mode: 'host_only',
      playlist: [
        {
          id: 9,
          ruleset_id: 0,
          beatmap_id: 123,
          required_mods: [],
          allowed_mods: [],
          freestyle: true,
          was_played: true,
          order: 0,
        },
      ],
      players: [{ user_id: 42, status: 'ready', style: {}, mods: [], team: 'red' }],
      referees: [{ user_id: 7 }],
    });

    expect(snapshot.roomId).toBe('1001');
    expect(snapshot.playlist[0]).toMatchObject({ id: '9', beatmapId: 123, freestyle: true });
    expect(snapshot.players[0]).toMatchObject({ userId: 42, team: 'red', status: 'ready' });
    expect(snapshot.referees).toEqual([7]);
    expect(snapshot.currentBeatmapId).toBe(123);
    expect(snapshot.ruleset).toBe('osu!');
    expect(snapshot.mods).toEqual(['Freestyle']);
  });

  it('treats a null max_participants as unlimited', () => {
    const snapshot = mapRoomJoined({
      room_id: 1,
      chat_channel_id: 2,
      name: 'Room',
      password: '',
      max_participants: 8,
      State: { type: 'head_to_head', locked: false, slots: [] },
      queue_mode: 'host_only',
      playlist: [],
      players: [],
      referees: [],
    });
    applyRoomSettings(snapshot, { max_participants: null });
    expect(snapshot.maxParticipants).toBe(0);
    applyRoomSettings(snapshot, { max_participants: 4 });
    expect(snapshot.maxParticipants).toBe(4);
  });

  it('uses the current or first unplayed playlist item as the upcoming map', () => {
    const snapshot = mapRoomJoined({
      room_id: 1,
      chat_channel_id: 2,
      name: 'Room',
      password: '',
      max_participants: 8,
      State: { type: 'head_to_head', locked: false, slots: [] },
      queue_mode: 'host_only',
      playlist: [
        {
          id: 1,
          ruleset_id: 0,
          beatmap_id: 11,
          required_mods: [],
          allowed_mods: [],
          freestyle: false,
          was_played: true,
          order: 0,
        },
        {
          id: 2,
          ruleset_id: 3,
          beatmap_id: 22,
          required_mods: [{ acronym: 'HD' }],
          allowed_mods: [],
          freestyle: false,
          was_played: false,
          order: 1,
        },
      ],
      players: [],
      referees: [],
    });
    expect(activePlaylistItem(snapshot)?.id).toBe('2');
    expect(snapshot.currentBeatmapId).toBe(22);
    expect(snapshot.ruleset).toBe('osu!mania');
    expect(snapshot.mods).toEqual(['HD']);

    applyRoomSettings(snapshot, { playlist_item_id: 1 });
    expect(activePlaylistItem(snapshot)?.id).toBe('1');
    expect(snapshot.currentBeatmapId).toBe(11);
  });

  it('rejects malformed playlist events without an id', () => {
    expect(mapPlaylistEvent({ room_id: 1, playlist_item: { beatmap_id: 5 } })).toBeNull();
  });
});