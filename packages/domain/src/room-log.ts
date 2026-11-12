import type { RoomPlayer, RoomSnapshot } from '@osmaref/contracts';

export type RoomLogChangeType =
  | 'beatmap_changed'
  | 'player_joined'
  | 'player_left'
  | 'room_settings_changed';

export interface RoomLogChange {
  type: RoomLogChangeType;
  summary: string;
  payload: Record<string, unknown>;
}

/**
 * Turns a room snapshot update into lobby-log entries.
 *
 * Transports emit `room_updated` for every BanchoBot/SignalR update, so the
 * diff keeps the log meaningful: only actual beatmap, roster and settings
 * changes produce entries. The first snapshot (previous === null) is a
 * baseline and never reports every player as newly joined.
 */
export function diffRoomSnapshots(
  previous: RoomSnapshot | null,
  next: RoomSnapshot,
): RoomLogChange[] {
  if (!previous) return [];
  const changes: RoomLogChange[] = [];

  if (previous.currentBeatmapId !== next.currentBeatmapId) {
    changes.push({
      type: 'beatmap_changed',
      summary: `beatmap changed: ${previous.currentBeatmapId ?? 'none'} -> ${
        next.currentBeatmapId ?? 'none'
      }`,
      payload: {
        previousBeatmapId: previous.currentBeatmapId,
        beatmapId: next.currentBeatmapId,
      },
    });
  }

  const before = new Map(previous.players.map((player) => [player.userId, player]));
  const after = new Map(next.players.map((player) => [player.userId, player]));
  for (const player of after.values()) {
    if (before.has(player.userId)) continue;
    changes.push({
      type: 'player_joined',
      summary: `player joined: ${playerName(player)}`,
      payload: playerPayload(player),
    });
  }
  for (const player of before.values()) {
    if (after.has(player.userId)) continue;
    changes.push({
      type: 'player_left',
      summary: `player left: ${playerName(player)}`,
      payload: playerPayload(player),
    });
  }

  const settings = describeSettingChanges(previous, next);
  if (settings.length > 0) {
    changes.push({
      type: 'room_settings_changed',
      summary: `room settings changed: ${settings.join('; ')}`,
      payload: {
        previous: {
          name: previous.name,
          matchType: previous.matchType,
          maxParticipants: previous.maxParticipants,
          locked: previous.locked,
        },
        next: {
          name: next.name,
          matchType: next.matchType,
          maxParticipants: next.maxParticipants,
          locked: next.locked,
        },
      },
    });
  }

  return changes;
}

function describeSettingChanges(previous: RoomSnapshot, next: RoomSnapshot): string[] {
  const changes: string[] = [];
  if (previous.name !== next.name) changes.push(`name "${previous.name}" -> "${next.name}"`);
  if (previous.matchType !== next.matchType) {
    changes.push(`match type ${previous.matchType} -> ${next.matchType}`);
  }
  if (previous.maxParticipants !== next.maxParticipants) {
    changes.push(`max participants ${previous.maxParticipants} -> ${next.maxParticipants}`);
  }
  if (previous.locked !== next.locked) {
    changes.push(`locked ${previous.locked} -> ${next.locked}`);
  }
  return changes;
}

function playerName(player: RoomPlayer): string {
  return player.username || `#${player.userId}`;
}

function playerPayload(player: RoomPlayer): Record<string, unknown> {
  return {
    userId: player.userId,
    username: player.username ?? null,
    slot: player.slot,
    team: player.team,
  };
}
