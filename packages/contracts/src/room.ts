import { z } from 'zod';

export const HubTeamSchema = z.enum(['red', 'blue']);
export type HubTeam = z.infer<typeof HubTeamSchema>;

export const RoomPlayerStatusSchema = z.enum([
  'idle',
  'ready',
  'playing',
  'finished_play',
  'spectating',
]);
export type RoomPlayerStatus = z.infer<typeof RoomPlayerStatusSchema>;

export const RoomPlayerSchema = z.object({
  userId: z.number().int().nonnegative(),
  username: z.string().optional(),
  /** Mods the player currently selected for the room's freemod slot. */
  mods: z.array(z.string()).default([]),
  team: HubTeamSchema.nullable().default(null),
  slot: z.number().int().nullable().default(null),
  status: RoomPlayerStatusSchema.default('idle'),
});
export type RoomPlayer = z.infer<typeof RoomPlayerSchema>;

export const PlaylistEntrySchema = z.object({
  id: z.string().min(1),
  beatmapId: z.number().int().positive(),
  rulesetId: z.number().int().min(0).max(3).default(0),
  requiredMods: z.array(z.string()).default([]),
  allowedMods: z.array(z.string()).default([]),
  freestyle: z.boolean().default(false),
  wasPlayed: z.boolean().default(false),
  order: z.number().int().default(0),
});
export type PlaylistEntry = z.infer<typeof PlaylistEntrySchema>;

export const QueueModeSchema = z.enum(['host_only', 'all_players', 'all_players_round_robin']);
export type QueueMode = z.infer<typeof QueueModeSchema>;

/**
 * Normalised view of a multiplayer room, shared by the IRC and Referee Hub
 * transports so the UI never parses a transport payload itself.
 */
export const RoomSnapshotSchema = z.object({
  roomId: z.string().min(1),
  name: z.string().min(1),
  password: z.string().nullable().default(null),
  chatChannelId: z.string().nullable().default(null),
  matchType: z.enum(['head_to_head', 'tag_coop', 'team_versus', 'tag_team_versus']).default('head_to_head'),
  /** Bancho reports this as text (Score, ScoreV2, Accuracy, Combo). */
  winCondition: z.string().nullable().default(null),
  /** Bancho reports the ruleset name, e.g. "CatchTheBeat". */
  ruleset: z.string().nullable().default(null),
  /** Active room mods as reported by Bancho, e.g. ["Freemod"]. */
  mods: z.array(z.string()).default([]),
  queueMode: QueueModeSchema.default('host_only'),
  maxParticipants: z.number().int().min(0).max(16).default(0),
  locked: z.boolean().default(false),
  playlist: z.array(PlaylistEntrySchema).default([]),
  currentPlaylistItemId: z.string().nullable().default(null),
  currentBeatmapId: z.number().int().positive().nullable().default(null),
  players: z.array(RoomPlayerSchema).default([]),
  referees: z.array(z.number().int()).default([]),
  updatedAt: z.string().min(1),
});
export type RoomSnapshot = z.infer<typeof RoomSnapshotSchema>;