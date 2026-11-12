import { describe, expect, it } from 'vitest';
import {
  AddPlaylistBeatmapInputSchema,
  ApplyActionInputSchema,
  extractOsuId,
  ImportPreviewSchema,
  JoinRoomInputSchema,
  PlaylistModsInputSchema,
  QuickRoomInputSchema,
  RecordResultInputSchema,
  RemovePlaylistBeatmapInputSchema,
  SettingsPatchSchema,
} from '@osmaref/contracts';
import { checkCompletedBeatmap } from '@osmaref/domain';

describe('IPC input validation', () => {
  it('rejects non-http settings URLs and unknown keys are stripped', () => {
    expect(SettingsPatchSchema.safeParse({ serverBaseUrl: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(SettingsPatchSchema.safeParse({ serverBaseUrl: 'https://ref.example.com' }).success).toBe(
      true,
    );
    const parsed = SettingsPatchSchema.parse({ serverBaseUrl: 'https://x.test', extra: 1 });
    expect(parsed).not.toHaveProperty('extra');
    expect(SettingsPatchSchema.safeParse({ freemodMods: ['NF', 'HR'] }).success).toBe(true);
    expect(SettingsPatchSchema.safeParse({ freemodMods: [1] }).success).toBe(false);
  });

  it('validates playlist mod and beatmap inputs', () => {
    expect(
      PlaylistModsInputSchema.safeParse({
        sessionId: 's1',
        playlistItemId: '9',
        requiredMods: ['HD'],
        allowedMods: ['HD', 'DT'],
        freestyle: false,
      }).success,
    ).toBe(true);
    expect(
      AddPlaylistBeatmapInputSchema.safeParse({ sessionId: 's1', beatmapId: 0 }).success,
    ).toBe(false);
    expect(
      AddPlaylistBeatmapInputSchema.safeParse({
        sessionId: 's1',
        beatmapId: 123,
        rulesetId: 3,
      }).success,
    ).toBe(true);
    expect(
      RemovePlaylistBeatmapInputSchema.safeParse({ sessionId: 's1', playlistItemId: '' })
        .success,
    ).toBe(false);
    expect(
      JoinRoomInputSchema.safeParse({ transport: 'irc', channel: '#mp_123' }).success,
    ).toBe(true);
    expect(
      JoinRoomInputSchema.safeParse({ transport: 'referee_hub', roomId: '123' }).success,
    ).toBe(true);
    expect(
      JoinRoomInputSchema.safeParse({ transport: 'referee_hub', roomId: 'abc' }).success,
    ).toBe(false);
  });

  it('validates quick room and action inputs', () => {
    expect(
      QuickRoomInputSchema.safeParse({
        name: 'room',
        beatmapId: null,
        rulesetId: 0,
        matchType: 'head_to_head',
        transport: 'irc',
        maxParticipants: 8,
        bestOf: 9,
      }).success,
    ).toBe(true);
    expect(
      QuickRoomInputSchema.safeParse({
        name: 'room',
        beatmapId: 1,
        rulesetId: 4,
        matchType: 'head_to_head',
        transport: 'irc',
        maxParticipants: 8,
        bestOf: 9,
      }).success,
    ).toBe(false);
    expect(
      ApplyActionInputSchema.safeParse({
        sessionId: 's',
        kind: 'pick',
        teamId: 'team_red',
        slotLabel: 'NM1',
      }).success,
    ).toBe(true);
  });

  it('rejects out-of-range score values', () => {
    expect(
      RecordResultInputSchema.safeParse({
        sessionId: 's',
        slotLabel: 'NM1',
        scores: [
          {
            userId: 1,
            score: 100,
            accuracy: 1.5,
            maxCombo: 0,
            misses: 0,
            mods: [],
            passed: true,
          },
        ],
        source: 'manual',
      }).success,
    ).toBe(false);
  });

  it('requires a valid tournament in an import preview', () => {
    expect(
      ImportPreviewSchema.safeParse({
        provider: 'file',
        remoteId: 'x',
        remoteRevision: null,
        etag: null,
        tournament: { name: 'not enough' },
        changed: true,
        issues: [],
      }).success,
    ).toBe(false);
  });
});

describe('completed beatmap verification', () => {
  const playlist = [{ id: '7', beatmapId: 100 }];

  it('accepts the expected playlist item', () => {
    expect(
      checkCompletedBeatmap({
        playlistItemId: '7',
        playlist,
        slotBeatmapId: 100,
        currentBeatmapId: 100,
      }),
    ).toBeNull();
  });

  it('rejects a playlist item that is not in the snapshot', () => {
    expect(
      checkCompletedBeatmap({
        playlistItemId: '8',
        playlist,
        slotBeatmapId: 100,
        currentBeatmapId: 100,
      }),
    ).toMatch(/not in the room snapshot/);
  });

  it('rejects a different beatmap for the active slot', () => {
    expect(
      checkCompletedBeatmap({
        playlistItemId: '7',
        playlist: [{ id: '7', beatmapId: 999 }],
        slotBeatmapId: 100,
        currentBeatmapId: 100,
      }),
    ).toMatch(/is beatmap 100/);
  });
});
describe('osu! id extraction', () => {
  it('extracts difficulty ids from beatmap links and plain digits', () => {
    expect(extractOsuId('4718189', 'beatmap')).toBe(4718189);
    expect(
      extractOsuId('https://osu.ppy.sh/beatmapsets/2224674#fruits/4718189', 'beatmap'),
    ).toBe(4718189);
    expect(extractOsuId('https://osu.ppy.sh/beatmaps/4718189?m=0', 'beatmap')).toBe(4718189);
    expect(extractOsuId('osu.ppy.sh/b/4718189', 'beatmap')).toBe(4718189);
    expect(extractOsuId('https://osu.ppy.sh/beatmapsets/2224674', 'beatmap')).toBeNull();
  });

  it('extracts user ids and rejects unrelated links', () => {
    expect(extractOsuId('https://osu.ppy.sh/users/32541500', 'user')).toBe(32541500);
    expect(extractOsuId('https://osu.ppy.sh/users/32541500/osu', 'user')).toBe(32541500);
    expect(extractOsuId('https://example.com/users/1', 'user')).toBeNull();
    expect(extractOsuId('not-an-id', 'user')).toBeNull();
    expect(extractOsuId('0', 'user')).toBeNull();
  });
});
