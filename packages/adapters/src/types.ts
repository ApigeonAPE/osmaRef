import type {
  MatchFlow,
  MappoolSlot,
  PlayerScore,
  TeamSide,
  Tournament,
  TransportKind,
  Match,
} from '@osmaref/contracts';
import type { HubTeam, MatchType, RoomSnapshot, RoomWinCondition } from '@osmaref/contracts';

export type { HubTeam, PlaylistEntry, RoomPlayer, RoomPlayerStatus, RoomSnapshot } from '@osmaref/contracts';

/** A user reference that works for both transports (IRC uses the name, hub the id). */
export interface UserRef {
  userId: number;
  username: string;
}

export interface CreateRoomRequest {
  name: string;
  rulesetId: number;
  /** Optional for Bancho IRC (`!mp make` needs no beatmap); required by the Referee Hub. */
  beatmapId?: number;
  teamMode: MatchType;
  winCondition: RoomWinCondition;
  maxParticipants: number;
}

export interface RoomSettingsPatch {
  name?: string;
  password?: string;
  teamMode?: MatchType;
  winCondition?: RoomWinCondition;
  maxParticipants?: number;
}

export interface BeatmapPatch {
  beatmapId?: number;
  rulesetId?: number;
  requiredMods?: string[];
  allowedMods?: string[];
  freestyle?: boolean;
}

export interface MoveUserRequest {
  userId: number;
  /** IRC has no user ids; the roster supplies the name for that transport. */
  username?: string;
  slot?: number;
  team?: HubTeam;
}

export type TransportEvent =
  | { type: 'connection'; status: 'connected' | 'reconnecting' | 'disconnected' | 'error'; detail?: string }
  | { type: 'room_joined'; snapshot: RoomSnapshot }
  | { type: 'room_created'; roomId: string }
  | { type: 'room_updated'; snapshot: RoomSnapshot }
  | { type: 'room_closed'; roomId: string }
  | { type: 'match_started'; roomId: string; playlistItemId: string | null }
  | { type: 'match_finished'; roomId: string }
  | { type: 'player_finished'; roomId: string; username: string; score: number; passed: boolean }
  | { type: 'match_completed'; roomId: string; playlistItemId: string }
  | { type: 'match_aborted'; roomId: string }
  | { type: 'countdown'; roomId: string; seconds: number; kind: 'match_start' | 'timer' | 'server_shutting_down' }
  | { type: 'countdown_stopped'; roomId: string }
  | { type: 'player_changed'; roomId: string; userId: number }
  | { type: 'referee_invited'; roomId: string }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; message: string };

export interface MatchTransport {
  readonly kind: TransportKind;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listRooms(): Promise<string[]>;
  createRoom(request: CreateRoomRequest): Promise<RoomSnapshot>;
  joinRoom(roomId: string): Promise<RoomSnapshot>;
  closeRoom(roomId: string): Promise<void>;
  invitePlayer(roomId: string, user: UserRef): Promise<void>;
  kickPlayer(roomId: string, user: UserRef): Promise<void>;
  banUser(roomId: string, user: UserRef): Promise<void>;
  addReferee(roomId: string, user: UserRef): Promise<void>;
  removeReferee(roomId: string, user: UserRef): Promise<void>;
  changeSettings(roomId: string, patch: RoomSettingsPatch): Promise<void>;
  editBeatmap(roomId: string, patch: BeatmapPatch): Promise<void>;
  moveUser(roomId: string, request: MoveUserRequest): Promise<void>;
  setLock(roomId: string, locked: boolean): Promise<void>;
  roll(roomId: string, max?: number): Promise<void>;
  startMatch(roomId: string, countdown: number | null): Promise<void>;
  stopCountdown(roomId: string): Promise<void>;
  abortMatch(roomId: string): Promise<void>;
  onEvent(listener: (event: TransportEvent) => void): () => void;
}

export interface ChatTransport {
  readonly kind: 'irc' | 'web';
  join(channelId: string): Promise<void>;
  part(channelId: string): Promise<void>;
  send(channelId: string, text: string): Promise<void>;
  history(channelId: string, limit: number): Promise<ChatEnvelope[]>;
  onMessage(listener: (message: ChatEnvelope) => void): () => void;
}

export interface ChatEnvelope {
  id: string;
  channelId: string;
  userId: number | null;
  username: string;
  text: string;
  at: string;
  self: boolean;
  system: boolean;
  action?: boolean;
}

export interface PlaylistScores {
  scores: PlayerScore[];
  roomId: string;
  playlistItemId: string;
  fetchedAt: string;
  complete: boolean;
}

export interface ResultProvider {
  fetchScores(roomId: string, playlistItemId: string): Promise<PlaylistScores>;
}

export interface MatchSetup {
  tournament: Tournament;
  match: Match;
  flow: MatchFlow;
  poolSlots: MappoolSlot[];
  teamOneId: string;
  teamTwoId: string;
}

export function teamSideToId(side: TeamSide, teamOneId: string, teamTwoId: string): string {
  return side === 'team_one' ? teamOneId : teamTwoId;
}