import { describe, expect, it } from 'vitest';
import { RoomSnapshotSchema, type RoomSnapshot } from '@osmaref/contracts';
import { diffRoomSnapshots } from '@osmaref/domain';

function snapshot(overrides: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return RoomSnapshotSchema.parse({
    roomId: '123',
    name: 'Room',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

describe('room snapshot → lobby log changes', () => {
  it('reports a beatmap change', () => {
    const changes = diffRoomSnapshots(
      snapshot({ currentBeatmapId: 100 }),
      snapshot({ currentBeatmapId: 200 }),
    );
    expect(changes).toEqual([
      {
        type: 'beatmap_changed',
        summary: 'beatmap changed: 100 -> 200',
        payload: { previousBeatmapId: 100, beatmapId: 200 },
      },
    ]);
  });

  it('reports players joining and leaving by user id', () => {
    const changes = diffRoomSnapshots(
      snapshot({
        players: [
          { userId: 1, username: 'Alpha', team: 'red', slot: 0, status: 'idle', mods: [] },
          { userId: 2, username: 'Beta', team: 'blue', slot: 1, status: 'idle', mods: [] },
        ],
      }),
      snapshot({
        players: [
          { userId: 2, username: 'Beta', team: 'blue', slot: 1, status: 'ready', mods: [] },
          { userId: 3, username: 'Gamma', team: 'red', slot: 2, status: 'idle', mods: [] },
        ],
      }),
    );
    expect(changes.map((change) => change.type)).toEqual(['player_joined', 'player_left']);
    expect(changes[0]?.summary).toBe('player joined: Gamma');
    expect(changes[1]?.summary).toBe('player left: Alpha');
  });

  it('reports settings changes as one entry', () => {
    const changes = diffRoomSnapshots(
      snapshot({ name: 'Old', maxParticipants: 8, locked: false }),
      snapshot({ name: 'New', maxParticipants: 16, locked: true }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.type).toBe('room_settings_changed');
    expect(changes[0]?.summary).toContain('name "Old" -> "New"');
    expect(changes[0]?.summary).toContain('max participants 8 -> 16');
    expect(changes[0]?.summary).toContain('locked false -> true');
  });

  it('ignores status-only player updates and the initial baseline', () => {
    const players = [
      { userId: 1, username: 'Alpha', team: 'red' as const, slot: 0, status: 'idle' as const, mods: [] },
    ];
    expect(
      diffRoomSnapshots(
        snapshot({ players }),
        snapshot({ players: [{ ...players[0]!, status: 'ready' as const }] }),
      ),
    ).toEqual([]);
    expect(diffRoomSnapshots(null, snapshot({ currentBeatmapId: 100 }))).toEqual([]);
  });
});
