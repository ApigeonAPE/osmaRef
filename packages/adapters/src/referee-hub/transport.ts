import {
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
  type HubConnection,
} from '@microsoft/signalr';
import type {
  BeatmapPatch,
  CreateRoomRequest,
  MatchTransport,
  MoveUserRequest,
  PlaylistEntry,
  RoomPlayer,
  RoomPlayerStatus,
  RoomSettingsPatch,
  RoomSnapshot,
  TransportEvent,
  UserRef,
} from '../types';
import type { TransportKind } from '@osmaref/contracts';

export interface RefereeHubOptions {
  /** e.g. https://spectator.osu.sh — `/referee` is appended. */
  baseUrl: string;
  getAccessToken: () => Promise<string>;
  /** Called after a successful reconnect so callers can refresh their own state. */
  onResync?: (snapshots: RoomSnapshot[]) => void;
}

/**
 * Referee Hub (osu! spectator server) transport.
 *
 * The API is explicitly unstable upstream, so every payload is narrowed
 * defensively: unknown extra fields are ignored, and a required field that is
 * missing degrades the room snapshot instead of throwing in an event handler.
 */
export class RefereeHubTransport implements MatchTransport {
  readonly kind: TransportKind = 'referee_hub';
  private readonly options: RefereeHubOptions;
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly rooms = new Map<string, RoomSnapshot>();
  private connection: HubConnection | null = null;
  private manualClose = false;

  constructor(options: RefereeHubOptions) {
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connection?.state === HubConnectionState.Connected;
  }

  async connect(): Promise<void> {
    if (this.connection && this.connection.state !== HubConnectionState.Disconnected) {
      return;
    }
    const url = new URL('/referee', normalizeBaseUrl(this.options.baseUrl)).toString();
    const connection = new HubConnectionBuilder()
      .withUrl(url, {
        accessTokenFactory: () => this.options.getAccessToken(),
        transport: undefined,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (context) =>
          Math.min(30_000, 500 * 2 ** Math.min(context.previousRetryCount, 6)),
      })
      .configureLogging(LogLevel.Warning)
      .build();

    this.connection = connection;
    this.manualClose = false;
    this.registerHandlers(connection);

    connection.onreconnecting((error) => {
      this.emit({
        type: 'connection',
        status: 'reconnecting',
        detail: error?.message ?? 'connection lost',
      });
    });
    connection.onreconnected(() => {
      this.emit({ type: 'connection', status: 'connected' });
      void this.resync();
    });
    connection.onclose((error) => {
      this.rooms.clear();
      this.emit({
        type: 'connection',
        status: this.manualClose ? 'disconnected' : 'error',
        detail: error?.message ?? (this.manualClose ? 'closed' : 'connection closed'),
      });
    });

    this.emit({ type: 'connection', status: 'reconnecting', detail: 'connecting to referee hub' });
    await connection.start();
    this.emit({ type: 'connection', status: 'connected' });
    await this.resync();
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    const connection = this.connection;
    this.connection = null;
    this.rooms.clear();
    if (connection) {
      await connection.stop();
    }
    this.emit({ type: 'connection', status: 'disconnected', detail: 'requested' });
  }

  async listRooms(): Promise<string[]> {
    const response = await this.invoke('ListRooms');
    const ids = asArray(asRecord(response).room_ids).map((value) => String(num(value)));
    return ids;
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomSnapshot> {
    if (!request.beatmapId || request.beatmapId <= 0) {
      throw new Error(
        'the Referee Hub requires an initial beatmap; pick one in the match configuration or quick-room form',
      );
    }
    const response = await this.invoke('MakeRoom', {
      ruleset_id: request.rulesetId,
      beatmap_id: request.beatmapId,
      name: request.name,
      type: request.teamMode === 'team_versus' ? 'team_versus' : 'head_to_head',
      queue_mode: 'host_only',
      max_participants: request.maxParticipants,
    });
    const snapshot = mapRoomJoined(response);
    this.rooms.set(snapshot.roomId, snapshot);
    this.emit({ type: 'room_joined', snapshot });
    return snapshot;
  }

  async joinRoom(roomId: string): Promise<RoomSnapshot> {
    const response = await this.invoke('JoinRoom', toHubNumber(roomId));
    const snapshot = mapRoomJoined(response);
    this.rooms.set(snapshot.roomId, snapshot);
    this.emit({ type: 'room_joined', snapshot });
    return snapshot;
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.invoke('CloseRoom', toHubNumber(roomId));
    this.rooms.delete(roomId);
    this.emit({ type: 'room_closed', roomId });
  }

  async invitePlayer(roomId: string, user: UserRef): Promise<void> {
    await this.invoke('InvitePlayer', toHubNumber(roomId), user.userId);
  }

  async kickPlayer(roomId: string, user: UserRef): Promise<void> {
    await this.invoke('KickPlayer', toHubNumber(roomId), user.userId);
  }

  async banUser(roomId: string, user: UserRef): Promise<void> {
    await this.invoke('BanUser', toHubNumber(roomId), user.userId);
  }

  async addReferee(roomId: string, user: UserRef): Promise<void> {
    await this.invoke('AddReferee', toHubNumber(roomId), user.userId);
  }

  async removeReferee(roomId: string, user: UserRef): Promise<void> {
    await this.invoke('RemoveReferee', toHubNumber(roomId), user.userId);
  }

  async changeSettings(roomId: string, patch: RoomSettingsPatch): Promise<void> {
    const request: Record<string, unknown> = {};
    if (patch.name !== undefined) request.name = patch.name;
    if (patch.password !== undefined) request.password = patch.password;
    if (patch.teamMode !== undefined) {
      request.type = patch.teamMode === 'team_versus' ? 'team_versus' : 'head_to_head';
    }
    if (patch.maxParticipants !== undefined) request.max_participants = patch.maxParticipants;
    await this.invoke('ChangeRoomSettings', toHubNumber(roomId), request);
  }

  async editBeatmap(roomId: string, patch: BeatmapPatch): Promise<void> {
    await this.editPlaylistItemRequest('EditCurrentPlaylistItem', roomId, {}, patch);
  }

  /** Edits a specific playlist entry, independent of the current item. */
  async editPlaylistItem(
    roomId: string,
    playlistItemId: string,
    patch: BeatmapPatch,
  ): Promise<void> {
    await this.editPlaylistItemRequest('EditPlaylistItem', roomId, {
      playlist_item_id: toHubNumber(playlistItemId),
    }, patch);
  }

  private async editPlaylistItemRequest(
    method: 'EditCurrentPlaylistItem' | 'EditPlaylistItem',
    roomId: string,
    baseRequest: Record<string, unknown>,
    patch: BeatmapPatch,
  ): Promise<void> {
    const allowedMods = [...(patch.allowedMods ?? [])];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const request: Record<string, unknown> = { ...baseRequest };
      if (patch.beatmapId !== undefined) request.beatmap_id = patch.beatmapId;
      if (patch.rulesetId !== undefined) request.ruleset_id = patch.rulesetId;
      if (patch.requiredMods !== undefined) {
        request.required_mods = patch.requiredMods.map((acronym) => ({ acronym }));
      }
      if (patch.allowedMods !== undefined) {
        request.allowed_mods = allowedMods.map((acronym) => ({ acronym }));
      }
      if (patch.freestyle !== undefined) request.freestyle = patch.freestyle;
      try {
        await this.invoke(method, toHubNumber(roomId), request);
        return;
      } catch (error) {
        // The Hub rejects mods that do not exist in the current ruleset even
        // when they are only part of the freemod allow-list. Drop those and
        // retry, keeping forced mods intact.
        const invalid = invalidMods(errorMessage(error));
        if (invalid.size === 0 || patch.requiredMods?.some((mod) => invalid.has(mod))) {
          throw error;
        }
        const next = allowedMods.filter((mod) => !invalid.has(mod));
        if (next.length === allowedMods.length) throw error;
        allowedMods.splice(0, allowedMods.length, ...next);
      }
    }
    throw new Error('could not find a ruleset-valid freemod allow-list');
  }

  async addPlaylistItem(
    roomId: string,
    request: {
      beatmapId: number;
      rulesetId: number;
      requiredMods?: string[];
      allowedMods?: string[];
      freestyle?: boolean;
    },
  ): Promise<void> {
    await this.invoke('AddPlaylistItem', toHubNumber(roomId), {
      ruleset_id: request.rulesetId,
      beatmap_id: request.beatmapId,
      required_mods: (request.requiredMods ?? []).map((acronym) => ({ acronym })),
      allowed_mods: (request.allowedMods ?? []).map((acronym) => ({ acronym })),
      freestyle: request.freestyle ?? false,
    });
  }

  async removePlaylistItem(roomId: string, playlistItemId: string): Promise<void> {
    await this.invoke('RemovePlaylistItem', toHubNumber(roomId), {
      playlist_item_id: toHubNumber(playlistItemId),
    });
  }

  async moveUser(roomId: string, request: MoveUserRequest): Promise<void> {
    const payload: Record<string, unknown> = { user_id: request.userId };
    if (request.slot !== undefined) payload.slot = request.slot;
    if (request.team !== undefined) payload.team = request.team;
    await this.invoke('MoveUser', toHubNumber(roomId), payload);
  }

  async setLock(roomId: string, locked: boolean): Promise<void> {
    await this.invoke('SetLockState', toHubNumber(roomId), { locked });
  }

  async roll(roomId: string, max?: number): Promise<void> {
    await this.invoke('Roll', toHubNumber(roomId), max === undefined ? null : { max });
  }

  async startMatch(roomId: string, countdown: number | null): Promise<void> {
    await this.invoke('StartMatch', toHubNumber(roomId), { countdown });
  }

  async stopCountdown(roomId: string): Promise<void> {
    await this.invoke('StopMatchCountdown', toHubNumber(roomId));
  }

  async abortMatch(roomId: string): Promise<void> {
    await this.invoke('AbortMatch', toHubNumber(roomId));
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(roomId: string): RoomSnapshot | null {
    return this.rooms.get(roomId) ?? null;
  }

  private async invoke(method: string, ...args: unknown[]): Promise<unknown> {
    const connection = this.connection;
    if (!connection || connection.state !== HubConnectionState.Connected) {
      throw new Error('referee hub is not connected');
    }
    return connection.invoke(method, ...args);
  }

  private registerHandlers(connection: HubConnection): void {
    connection.on('UserJoined', (info: unknown) => {
      this.patchPlayer(info, (player: RoomPlayer, raw) => ({ ...player, userId: num(raw.user_id, player.userId) }));
    });
    connection.on('UserLeft', (info: unknown) => this.removePlayer(info));
    connection.on('UserKicked', (info: unknown) => this.removePlayer(info));
    connection.on('UserBanned', (info: unknown) => this.removePlayer(info));
    connection.on('UserStatusChanged', (info: unknown) => {
      this.patchPlayer(info, (player, raw) => ({
        ...player,
        status: (str(raw.status, player.status) as RoomPlayerStatus) ?? player.status,
      }));
    });
    connection.on('UserTeamChanged', (info: unknown) => {
      this.patchPlayer(info, (player, raw) => ({
        ...player,
        team: raw.team === 'red' || raw.team === 'blue' ? raw.team : player.team,
      }));
    });
    connection.on('UserModsChanged', (info: unknown) => {
      this.patchPlayer(info, (player, raw) => ({
        ...player,
        mods: asArray(raw.mods).map((mod) => str(asRecord(mod).acronym)),
      }));
    });
    connection.on('RefereeAdded', (info: unknown) => this.applyRefereeChange(info, true));
    connection.on('RefereeRemoved', (info: unknown) => this.applyRefereeChange(info, false));
    connection.on('RefereeInvited', (info: unknown) => {
      const roomId = roomIdOf(info);
      if (roomId) this.emit({ type: 'referee_invited', roomId });
    });
    connection.on('RoomSettingsChanged', (info: unknown) => this.patchSettings(info));
    connection.on('MatchStateChanged', (info: unknown) => this.patchMatchState(info));
    connection.on('PlaylistItemAdded', (info: unknown) => this.upsertPlaylist(info));
    connection.on('PlaylistItemChanged', (info: unknown) => this.upsertPlaylist(info));
    connection.on('PlaylistItemRemoved', (info: unknown) => this.removePlaylist(info));
    connection.on('RollCompleted', (info: unknown) => {
      const raw = asRecord(info);
      const text = `roll completed${raw.result !== undefined ? `: ${String(raw.result)}` : ''}`;
      const roomId = roomIdOf(info);
      this.emit({ type: 'notice', level: 'info', message: text });
      if (roomId) this.emitUpdated(roomId);
    });
    connection.on('CountdownStarted', (info: unknown) => this.countdownStarted(info));
    connection.on('CountdownStopped', (info: unknown) => {
      const roomId = roomIdOf(info);
      if (roomId) this.emit({ type: 'countdown_stopped', roomId });
    });
    connection.on('MatchStarted', (info: unknown) => {
      const raw = asRecord(info);
      const roomId = roomIdOf(info);
      if (!roomId) return;
      const playlistItemId = raw.playlist_item_id !== undefined ? String(num(raw.playlist_item_id)) : null;
      const snapshot = this.rooms.get(roomId);
      if (snapshot) {
        snapshot.currentPlaylistItemId = playlistItemId;
        snapshot.currentBeatmapId = beatmapIdFor(snapshot, playlistItemId);
        syncPlaylistSelection(snapshot);
        this.emit({ type: 'room_updated', snapshot });
      }
      this.emit({
        type: 'match_started',
        roomId,
        playlistItemId,
      });
    });
    connection.on('MatchAborted', (info: unknown) => {
      const roomId = roomIdOf(info);
      if (roomId) this.emit({ type: 'match_aborted', roomId });
    });
    connection.on('MatchCompleted', (info: unknown) => {
      const raw = asRecord(info);
      const roomId = roomIdOf(info);
      if (!roomId) return;
      this.emit({
        type: 'match_completed',
        roomId,
        playlistItemId: String(num(raw.playlist_item_id)),
      });
    });
  }

  private async resync(): Promise<void> {
    try {
      const ids = await this.listRooms();
      const listed = new Set(ids);
      const targets = new Set([...this.rooms.keys(), ...ids]);
      const joined: RoomSnapshot[] = [];
      for (const roomId of targets) {
        try {
          const response = await this.invoke('JoinRoom', toHubNumber(roomId));
          const snapshot = mapRoomJoined(response);
          this.rooms.set(roomId, snapshot);
          joined.push(snapshot);
          this.emit({ type: 'room_joined', snapshot });
        } catch (error) {
          // A dropped connection is not proof that the room is gone. Only trust
          // the missing-from-list signal while the hub link is actually up.
          if (!listed.has(roomId) && this.isConnected) {
            this.rooms.delete(roomId);
            this.emit({ type: 'room_closed', roomId });
          } else {
            this.emit({
              type: 'notice',
              level: 'warn',
              message: `could not rejoin room ${roomId}: ${errorMessage(error)}`,
            });
          }
        }
      }
      this.options.onResync?.(joined);
    } catch (error) {
      this.emit({
        type: 'notice',
        level: 'error',
        message: `room resynchronisation failed: ${errorMessage(error)}`,
      });
    }
  }

  private patchPlayer(
    info: unknown,
    update: (player: RoomPlayer, raw: Record<string, unknown>) => RoomPlayer,
  ): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    const userId = num(raw.user_id);
    const index = snapshot.players.findIndex((player) => player.userId === userId);
    if (index === -1) {
      snapshot.players.push(
        update({ userId, team: null, slot: null, status: 'idle', mods: [] }, raw),
      );
    } else {
      snapshot.players[index] = update(snapshot.players[index]!, raw);
    }
    this.emit({ type: 'player_changed', roomId, userId });
    this.emit({ type: 'room_updated', snapshot });
  }

  private removePlayer(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    const userId = num(raw.user_id);
    snapshot.players = snapshot.players.filter((player) => player.userId !== userId);
    this.emit({ type: 'player_changed', roomId, userId });
    this.emit({ type: 'room_updated', snapshot });
  }

  private applyRefereeChange(info: unknown, added: boolean): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    const userId = num(raw.user_id);
    if (added) {
      if (!snapshot.referees.includes(userId)) snapshot.referees.push(userId);
    } else {
      snapshot.referees = snapshot.referees.filter((id) => id !== userId);
    }
    this.emit({ type: 'room_updated', snapshot });
  }

  private patchSettings(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    applyRoomSettings(snapshot, raw);
    this.emit({ type: 'room_updated', snapshot });
  }

  private patchMatchState(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    const state = asRecord(raw.state ?? raw);
    if (state.type === 'head_to_head' || state.type === 'team_versus') {
      snapshot.matchType = state.type;
    }
    if (typeof state.locked === 'boolean') snapshot.locked = state.locked;
    if ('slots' in state) applyRoomSlots(snapshot, state.slots);
    snapshot.updatedAt = new Date().toISOString();
    this.emit({ type: 'room_updated', snapshot });
  }

  private upsertPlaylist(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    // PlaylistItemAdded/Changed payloads nest the item under `playlist_item`.
    const entry = mapPlaylistEvent(raw, snapshot.playlist.length);
    if (!entry) return;
    const index = snapshot.playlist.findIndex((existing) => existing.id === entry.id);
    if (index === -1) snapshot.playlist.push(entry);
    else snapshot.playlist[index] = entry;
    snapshot.playlist.sort((a, b) => a.order - b.order);
    snapshot.updatedAt = new Date().toISOString();
    syncPlaylistSelection(snapshot);
    this.emit({ type: 'room_updated', snapshot });
  }

  private removePlaylist(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const snapshot = this.rooms.get(roomId);
    if (!snapshot) return;
    const id = String(num(raw.playlist_item_id ?? raw.id));
    snapshot.playlist = snapshot.playlist.filter((entry) => entry.id !== id);
    if (snapshot.currentPlaylistItemId === id) {
      snapshot.currentPlaylistItemId = null;
    }
    snapshot.updatedAt = new Date().toISOString();
    syncPlaylistSelection(snapshot);
    this.emit({ type: 'room_updated', snapshot });
  }

  private countdownStarted(info: unknown): void {
    const raw = asRecord(info);
    const roomId = roomIdOf(info);
    if (!roomId) return;
    const type = str(raw.type);
    const kind =
      type === 'server_shutting_down'
        ? 'server_shutting_down'
        : type === 'timer'
          ? 'timer'
          : 'match_start';
    const seconds = num(raw.time_remaining ?? raw.seconds ?? 0);
    this.emit({ type: 'countdown', roomId, seconds, kind });
    if (kind === 'server_shutting_down') {
      this.emit({
        type: 'notice',
        level: 'warn',
        message:
          'the spectator server is shutting down; keep the room open, then reconnect to migrate to the new instance',
      });
    }
  }

  private emitUpdated(roomId: string): void {
    const snapshot = this.rooms.get(roomId);
    if (snapshot) this.emit({ type: 'room_updated', snapshot });
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Maps the room's slot array (index -> user id) onto the player entries. */
export function applyRoomSlots(snapshot: RoomSnapshot, slots: unknown): void {
  for (const player of snapshot.players) player.slot = null;
  if (!Array.isArray(slots)) return;
  slots.forEach((value, index) => {
    if (value === null || value === undefined) return;
    const userId = num(value);
    const player = snapshot.players.find((candidate) => candidate.userId === userId);
    if (player) player.slot = index;
  });
}

export function mapRoomJoined(raw: unknown): RoomSnapshot {
  const record = asRecord(raw);
  const state = asRecord(record.State ?? record.state);
  const type =
    state.type === 'team_versus'
      ? 'team_versus'
      : state.type === 'tag_coop'
        ? 'tag_coop'
        : state.type === 'tag_team_versus'
          ? 'tag_team_versus'
          : 'head_to_head';
  const playlist = asArray(record.playlist)
    .map((item, index) => mapPlaylistItem(asRecord(item), index))
    .filter((item): item is PlaylistEntry => item !== null);

  const snapshot: RoomSnapshot = {
    roomId: String(num(record.room_id)),
    name: str(record.name, 'multiplayer room'),
    password: typeof record.password === 'string' ? record.password : null,
    chatChannelId:
      record.chat_channel_id === undefined ? null : String(num(record.chat_channel_id)),
    matchType: type,
    winCondition: null,
    ruleset: null,
    mods: [],
    queueMode:
      record.queue_mode === 'all_players' || record.queue_mode === 'all_players_round_robin'
        ? record.queue_mode
        : 'host_only',
    maxParticipants: num(record.max_participants),
    locked: bool(state.locked),
    playlist,
    currentPlaylistItemId: null,
    currentBeatmapId: null,
    players: asArray(record.players).map((entry) => {
      const player = asRecord(entry);
      return {
        userId: num(player.user_id),
        mods: asArray(player.mods).map((mod) => str(asRecord(mod).acronym)),
        team: player.team === 'red' || player.team === 'blue' ? player.team : null,
        slot: null,
        status: player.status === undefined ? 'idle' : (player.status as RoomPlayerStatus),
      };
    }),
    referees: asArray(record.referees).map((entry) => num(asRecord(entry).user_id)),
    updatedAt: new Date().toISOString(),
  };
  snapshot.playlist.sort((a, b) => a.order - b.order);
  applyRoomSlots(snapshot, state.slots);
  syncPlaylistSelection(snapshot);
  return snapshot;
}

/**
 * A Referee Hub playlist entry carries its own ruleset and mods. The "current"
 * item is the selected one when known, otherwise the first unplayed item (the
 * top of the playlist), which is the next map to be played.
 */
export function applyRoomSettings(
  snapshot: RoomSnapshot,
  raw: Record<string, unknown>,
): void {
  if (typeof raw.name === 'string') snapshot.name = raw.name;
  if (typeof raw.password === 'string') snapshot.password = raw.password;
  if (raw.type === 'head_to_head' || raw.type === 'team_versus') snapshot.matchType = raw.type;
  if (raw.queue_mode === 'all_players' || raw.queue_mode === 'all_players_round_robin') {
    snapshot.queueMode = raw.queue_mode;
  }
  // null/0 means "unlimited": the property is present with null when slots are
  // turned off, so `typeof === 'number'` alone misses that transition.
  if ('max_participants' in raw) {
    const value = raw.max_participants;
    snapshot.maxParticipants =
      value === null || value === undefined ? 0 : Math.max(0, Math.round(num(value)));
    for (const player of snapshot.players) {
      if (snapshot.maxParticipants === 0) {
        player.slot = null;
      } else if (player.slot !== null && player.slot >= snapshot.maxParticipants) {
        player.slot = null;
      }
    }
  }
  if ('playlist_item_id' in raw) {
    const id = num(raw.playlist_item_id, 0);
    snapshot.currentPlaylistItemId = id > 0 ? String(id) : null;
  }
  if (typeof raw.locked === 'boolean') snapshot.locked = raw.locked;
  snapshot.updatedAt = new Date().toISOString();
  syncPlaylistSelection(snapshot);
}

export function activePlaylistItem(snapshot: RoomSnapshot): PlaylistEntry | null {
  const ordered = [...snapshot.playlist].sort((a, b) => a.order - b.order);
  return (
    ordered.find((entry) => entry.id === snapshot.currentPlaylistItemId) ??
    ordered.find((entry) => !entry.wasPlayed) ??
    ordered[0] ??
    null
  );
}

function syncPlaylistSelection(snapshot: RoomSnapshot): void {
  const item = activePlaylistItem(snapshot);
  snapshot.currentBeatmapId = item?.beatmapId ?? null;
  snapshot.ruleset = item ? RULESET_NAMES[item.rulesetId] ?? `ruleset ${item.rulesetId}` : null;
  snapshot.mods = item ? playlistMods(item) : [];
}

function playlistMods(item: PlaylistEntry): string[] {
  const mods = [...item.requiredMods, ...item.allowedMods];
  const unique = [...new Set(mods.filter(Boolean))];
  if (item.freestyle) unique.push('Freestyle');
  return unique.length > 0 ? unique : ['NM'];
}

const RULESET_NAMES: Record<number, string> = {
  0: 'osu!',
  1: 'osu!taiko',
  2: 'osu!catch',
  3: 'osu!mania',
};

export function mapPlaylistEvent(info: unknown, fallbackIndex = 0): PlaylistEntry | null {
  const raw = asRecord(info);
  return mapPlaylistItem(asRecord(raw.playlist_item ?? raw.item ?? raw), fallbackIndex);
}

export function mapPlaylistItem(raw: Record<string, unknown>, index: number): PlaylistEntry | null {
  if (raw.id === undefined) return null;
  return {
    id: String(num(raw.id)),
    beatmapId: num(raw.beatmap_id),
    rulesetId: num(raw.ruleset_id),
    requiredMods: asArray(raw.required_mods).map((mod) => str(asRecord(mod).acronym)),
    allowedMods: asArray(raw.allowed_mods).map((mod) => str(asRecord(mod).acronym)),
    freestyle: bool(raw.freestyle),
    wasPlayed: bool(raw.was_played),
    order: num(raw.order, index),
  };
}

function beatmapIdFor(snapshot: RoomSnapshot, playlistItemId: string | null): number | null {
  if (!playlistItemId) return null;
  const item = snapshot.playlist.find((entry) => entry.id === playlistItemId);
  return item?.beatmapId ?? null;
}

function roomIdOf(info: unknown): string | null {
  const raw = asRecord(info);
  if (raw.room_id === undefined) return null;
  return String(num(raw.room_id));
}

function invalidMods(message: string): Set<string> {
  const match = /specified ruleset:\s*([A-Z0-9,\s]+)/i.exec(message);
  if (!match) return new Set();
  return new Set(
    match[1]!
      .split(/[,\s]+/)
      .map((token) => token.trim().toUpperCase())
      .filter((token) => /^[A-Z]{2,3}$/.test(token)),
  );
}

function toHubNumber(roomId: string): number {  const value = Number(roomId);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`room id "${roomId}" is not a safe integer`);
  }
  return value;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}