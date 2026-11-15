import { IrcClient, type IrcClientOptions, type Privmsg } from './client';
import {
  applyBanchoEvent,
  createBanchoRoomState,
  parseBanchoLine,
  displayNameFromNick,
  MATCH_URL,
  type BanchoRoomState,
} from './bancho';
import { channelForRoom, roomIdFromChannel } from './parser';
import type {
  BeatmapPatch,
  ChatEnvelope,
  ChatTransport,
  CreateRoomRequest,
  MatchTransport,
  MoveUserRequest,
  RoomPlayer,
  RoomSettingsPatch,
  RoomSnapshot,
  TransportEvent,
  UserRef,
} from '../types';
import type { MatchType, RoomWinCondition, TransportKind } from '@osmaref/contracts';

const BANCHO_BOT = 'BanchoBot';
const TEAM_MODE_NUMBER: Record<MatchType, number> = {
  head_to_head: 0,
  tag_coop: 1,
  team_versus: 2,
  tag_team_versus: 3,
};

const WIN_CONDITION_NUMBER: Record<RoomWinCondition, number> = {
  score: 0,
  accuracy: 1,
  combo: 2,
  score_v2: 3,
};

const WIN_CONDITION_LABEL: Record<RoomWinCondition, string> = {
  score: 'Score',
  accuracy: 'Accuracy',
  combo: 'Combo',
  score_v2: 'ScoreV2',
};

function winConditionFromLabel(label: string | null): RoomWinCondition {
  const normalized = (label ?? '').replace(/\s+/g, '').toLowerCase();
  if (normalized === 'accuracy') return 'accuracy';
  if (normalized === 'combo') return 'combo';
  if (normalized === 'scorev2' || normalized === 'scorev2.0') return 'score_v2';
  return 'score';
}

export interface IrcTransportOptions extends IrcClientOptions {
  channels?: string[];
}

/**
 * Bancho IRC transport.
 *
 * Chat and room control share one IRC connection: commands go to BanchoBot or
 * the `#mp_<id>` channel, and room state is reconstructed from announced lines.
 */
export class IrcMatchTransport implements MatchTransport {
  readonly kind: TransportKind = 'irc';
  private readonly options: IrcTransportOptions;
  private client: IrcClient | null = null;
  private readonly listeners = new Set<(event: TransportEvent) => void>();
  private readonly rooms = new Map<string, BanchoRoomState>();
  private readonly pendingCreated: {
    resolve: (roomId: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly joinedChannels = new Set<string>();
  /**
   * `!mp start <n>` is answered with both "Queued the match to start in <n>
   * seconds" and "Match starts in <n> seconds"; they describe one countdown,
   * so an identical repeat right after the first line is dropped.
   */
  private readonly lastCountdown = new Map<
    string,
    { kind: 'match_start' | 'timer'; seconds: number; at: number }
  >();
  /** Last BanchoBot lines, used to explain a failed `!mp make`. */
  private readonly botLines: string[] = [];
  private manualClose = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connectedOnce = false;

  constructor(options: IrcTransportOptions) {
    this.options = options;
  }

  get irc(): IrcClient | null {
    return this.client;
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    this.reconnectAttempts = 0;
    this.connectedOnce = false;
    await this.openConnection(false);
  }

  private async openConnection(isRetry: boolean): Promise<void> {
    if (this.client?.isConnected) return;
    const client = new IrcClient(this.options);
    this.client = client;

    client.on('privmsg', (message: Privmsg) => this.handleBotMessage(message.from, message.target, message.text));
    client.on('notice', (notice: { from: string; target: string; text: string }) =>
      this.handleBotMessage(notice.from, notice.target, notice.text),
    );
    client.on('message', (message) => {
      if (message.command === 'JOIN' && message.nick) {
        this.joinedChannels.add(message.params[0] ?? '');
      }
    });
    client.on('error', (error: Error) => {
      this.emit({ type: 'connection', status: 'error', detail: error.message });
    });
    client.on('disconnected', (reason: string) => {
      this.joinedChannels.clear();
      this.emit({ type: 'connection', status: 'disconnected', detail: reason });
      this.scheduleReconnect();
    });

    try {
      await client.connect();
    } catch (error) {
      this.client = null;
      if (!isRetry) throw error;
      this.scheduleReconnect();
      return;
    }

    this.reconnectAttempts = 0;
    this.connectedOnce = true;
    for (const channel of this.options.channels ?? []) {
      client.join(channel);
    }
    for (const channel of this.joinedChannels) {
      client.join(channel);
    }
    // Re-join multiplayer rooms that were active before the disconnect.
    for (const roomId of this.rooms.keys()) {
      client.join(channelForRoom(roomId));
      this.emit({ type: 'room_joined', snapshot: this.snapshot(roomId) });
      setTimeout(() => {
        try {
          this.requestRoomSettings(roomId);
        } catch {
          // disconnected again
        }
      }, 800);
    }
    this.emit({ type: 'connection', status: 'connected' });
  }

  private scheduleReconnect(): void {
    if (this.manualClose || !this.connectedOnce || this.reconnectTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectAttempts += 1;
    this.emit({
      type: 'connection',
      status: 'reconnecting',
      detail: `reconnecting in ${Math.round(delay / 1000)}s`,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection(true);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const client = this.client;
    this.client = null;
    client?.disconnect('osmaRef disconnected');
    this.emit({ type: 'connection', status: 'disconnected', detail: 'requested' });
  }

  async listRooms(): Promise<string[]> {
    return [...this.rooms.keys()];
  }

  async createRoom(request: CreateRoomRequest): Promise<RoomSnapshot> {
    const client = this.requireClient();
    this.botLines.length = 0;
    const created = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const detail = this.botLines.length
          ? ` BanchoBot said: ${this.botLines.slice(-3).join(' | ')}`
          : '';
        reject(new Error(`Bancho did not confirm room creation.${detail}`));
      }, 25_000);
      this.pendingCreated.push({
        resolve: (roomId) => {
          clearTimeout(timer);
          resolve(roomId);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });

    client.privmsg(BANCHO_BOT, `!mp make ${request.name}`);
    const roomId = await created;
    client.join(channelForRoom(roomId));
    const teamValue = TEAM_MODE_NUMBER[request.teamMode];
    const winValue = WIN_CONDITION_NUMBER[request.winCondition];
    const size = request.maxParticipants > 0 ? ` ${request.maxParticipants}` : '';
    client.privmsg(channelForRoom(roomId), `!mp set ${teamValue} ${winValue}${size}`);
    if (request.beatmapId && request.beatmapId > 0) {
      client.privmsg(channelForRoom(roomId), `!mp map ${request.beatmapId} ${request.rulesetId}`);
    }

    const state = createBanchoRoomState(roomId);
    state.name = request.name;
    state.size = request.maxParticipants;
    state.matchType = request.teamMode;
    state.winCondition = WIN_CONDITION_LABEL[request.winCondition];
    state.beatmapId = request.beatmapId && request.beatmapId > 0 ? request.beatmapId : null;
    this.rooms.set(roomId, state);

    const snapshot = this.snapshot(roomId);
    this.emit({ type: 'room_joined', snapshot });
    return snapshot;
  }

  async joinRoom(roomId: string): Promise<RoomSnapshot> {
    const client = this.requireClient();
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, createBanchoRoomState(roomId));
    }
    client.join(channelForRoom(roomId));
    this.emit({ type: 'room_joined', snapshot: this.snapshot(roomId) });
    return this.snapshot(roomId);
  }

  /** Asks BanchoBot for the authoritative room settings of a joined room. */
  requestRoomSettings(roomId: string): void {
    this.sendToRoom(roomId, '!mp settings');
  }

  async closeRoom(roomId: string): Promise<void> {
    this.sendToRoom(roomId, '!mp close');
    this.rooms.delete(roomId);
    this.emit({ type: 'room_closed', roomId });
  }

  async invitePlayer(roomId: string, user: UserRef): Promise<void> {
    this.sendToRoom(roomId, `!mp invite ${this.ircUserRef(user)}`);
  }

  async kickPlayer(roomId: string, user: UserRef): Promise<void> {
    this.sendToRoom(roomId, `!mp kick ${this.ircUserRef(user)}`);
  }

  async banUser(roomId: string, user: UserRef): Promise<void> {
    this.sendToRoom(roomId, `!mp ban ${this.ircUserRef(user)}`);
  }

  async addReferee(roomId: string, user: UserRef): Promise<void> {
    this.sendToRoom(roomId, `!mp addref ${this.ircUserRef(user)}`);
  }

  async removeReferee(roomId: string, user: UserRef): Promise<void> {
    this.sendToRoom(roomId, `!mp removeref ${this.ircUserRef(user)}`);
  }

  async changeSettings(roomId: string, patch: RoomSettingsPatch): Promise<void> {
    if (patch.name !== undefined) this.sendToRoom(roomId, `!mp name ${patch.name}`);
    if (patch.password !== undefined) {
      this.sendToRoom(roomId, patch.password ? `!mp password ${patch.password}` : '!mp password');
    }
    if (patch.maxParticipants !== undefined) {
      this.sendToRoom(roomId, `!mp size ${patch.maxParticipants}`);
    }

    // Bancho applies these silently, so refresh the local snapshot immediately;
    // `!mp settings` can still correct any server-side filtering later.
    const state = this.rooms.get(roomId);
    if (patch.teamMode !== undefined || patch.winCondition !== undefined) {
      const teamMode = patch.teamMode ?? state?.matchType ?? 'head_to_head';
      const winCondition =
        patch.winCondition ?? winConditionFromLabel(state?.winCondition ?? null);
      const size =
        patch.maxParticipants ?? state?.size ?? 0;
      this.sendToRoom(
        roomId,
        `!mp set ${TEAM_MODE_NUMBER[teamMode]} ${WIN_CONDITION_NUMBER[winCondition]}${size > 0 ? ` ${size}` : ''}`,
      );
    }

    if (state) {
      if (patch.name !== undefined) state.name = patch.name;
      if (patch.teamMode !== undefined) state.matchType = patch.teamMode;
      if (patch.winCondition !== undefined) {
        state.winCondition = WIN_CONDITION_LABEL[patch.winCondition];
      }
      if (patch.maxParticipants !== undefined) state.size = patch.maxParticipants;
      this.emit({ type: 'room_updated', snapshot: this.snapshot(roomId) });
    }
  }

  async editBeatmap(roomId: string, patch: BeatmapPatch): Promise<void> {
    if (patch.beatmapId !== undefined) {
      const mode = patch.rulesetId !== undefined ? ` ${patch.rulesetId}` : '';
      this.sendToRoom(roomId, `!mp map ${patch.beatmapId}${mode}`);
    }
    if (patch.requiredMods !== undefined || patch.allowedMods !== undefined) {
      const mods =
        patch.requiredMods && patch.requiredMods.length > 0
          ? patch.requiredMods
          : patch.allowedMods && patch.allowedMods.length > 0 && !patch.freestyle
            ? patch.allowedMods
            : patch.allowedMods && patch.allowedMods.length > 0
              ? ['Freemod']
              : [];
      this.sendToRoom(roomId, mods.length === 0 ? '!mp mods None' : `!mp mods ${mods.join(' ')}`);
    }

    const state = this.rooms.get(roomId);
    if (state && patch.beatmapId !== undefined) {
      state.beatmapId = patch.beatmapId;
      this.emit({ type: 'room_updated', snapshot: this.snapshot(roomId) });
    }
  }

  async moveUser(roomId: string, request: MoveUserRequest): Promise<void> {
    const state = this.rooms.get(roomId);
    const username = request.username ?? this.usernameFor(request.userId, state);
    if (request.slot !== undefined) {
      this.sendToRoom(roomId, `!mp move ${ircName(username)} ${request.slot + 1}`);
    }
    if (request.team !== undefined) {
      this.sendToRoom(roomId, `!mp team ${ircName(username)} ${request.team}`);
    }
  }

  async setLock(roomId: string, locked: boolean): Promise<void> {
    this.sendToRoom(roomId, locked ? '!mp lock' : '!mp unlock');
    const state = this.rooms.get(roomId);
    if (state) {
      state.locked = locked;
      this.emit({ type: 'room_updated', snapshot: this.snapshot(roomId) });
    }
  }

  async roll(roomId: string, max?: number): Promise<void> {
    this.sendToRoom(roomId, max ? `!roll ${max}` : '!roll');
  }

  async startMatch(roomId: string, countdown: number | null): Promise<void> {
    this.sendToRoom(roomId, countdown === null ? '!mp start' : `!mp start ${countdown}`);
  }

  async stopCountdown(roomId: string): Promise<void> {
    this.sendToRoom(roomId, '!mp aborttimer');
  }

  async abortMatch(roomId: string): Promise<void> {
    this.sendToRoom(roomId, '!mp abort');
  }

  onEvent(listener: (event: TransportEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(roomId: string): RoomSnapshot {
    const state = this.rooms.get(roomId) ?? createBanchoRoomState(roomId);
    const players: RoomPlayer[] = [...state.players.values()]
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99))
      .map((player) => ({
        userId: player.userId ?? 0,
        username: player.username,
        mods: [],
        team: player.team,
        slot: player.slot,
        status: player.ready ? 'ready' : 'idle',
      }));
    return {
      roomId,
      name: state.name ?? `#mp_${roomId}`,
      password: null,
      chatChannelId: channelForRoom(roomId),
      matchType: state.matchType ?? 'head_to_head',
      winCondition: state.winCondition,
      ruleset: state.ruleset,
      mods: state.mods,
      queueMode: 'host_only',
      maxParticipants: state.size ?? 16,
      locked: state.locked,
      playlist: [],
      currentPlaylistItemId: null,
      currentBeatmapId: state.beatmapId,
      players,
      referees: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private handleBotMessage(from: string, target: string, text: string): void {
    if (from.toLowerCase() !== BANCHO_BOT.toLowerCase()) return;
    const line = text.trim();
    if (line) {
      this.botLines.push(line);
      if (this.botLines.length > 20) this.botLines.shift();
    }

    // A refusal would arrive as a BanchoBot line; without a documented format it
    // is left to the timeout, which reports the actual lines above.

    const event = parseBanchoLine(line);
    if (!event) {
      // Last-resort fallback: while a creation is pending, any match URL in a
      // BanchoBot line identifies the new room, even if the wording changed.
      const matchUrl = MATCH_URL.exec(line);
      if (matchUrl && this.pendingCreated.length > 0) {
        this.pendingCreated.shift()?.resolve(matchUrl[1]!);
      }
      return;
    }

    if (event.kind === 'match_created') {
      const pending = this.pendingCreated.shift();
      if (pending) {
        pending.resolve(event.roomId);
      } else {
        // `!mp make` can be issued manually or from another client; join the
        // new room instead of leaving it undiscovered.
        this.emit({ type: 'room_created', roomId: event.roomId });
      }
      return;
    }

    const roomId = roomIdFromChannel(target) ?? this.roomFromContext();
    if (!roomId) return;

    const state = this.rooms.get(roomId);
    if (!state) return;
    applyBanchoEvent(state, event);

    switch (event.kind) {
      case 'countdown':
      case 'match_starting': {
        const kind = event.kind === 'countdown' ? event.label : 'match_start';
        if (this.repeatsCountdown(roomId, kind, event.seconds)) break;
        this.emit({ type: 'countdown', roomId, seconds: event.seconds, kind });
        break;
      }
      case 'countdown_stopped':
        this.emit({ type: 'countdown_stopped', roomId });
        break;
      case 'match_started':
        this.emit({ type: 'match_started', roomId, playlistItemId: null });
        break;
      case 'match_finished':
        this.emit({ type: 'match_finished', roomId });
        break;
      case 'player_finished':
        this.emit({
          type: 'player_finished',
          roomId,
          username: event.username,
          score: event.score,
          passed: event.passed,
        });
        break;
      case 'match_aborted':
        this.emit({ type: 'match_aborted', roomId });
        break;
      case 'match_closed':
        this.rooms.delete(roomId);
        this.lastCountdown.delete(roomId);
        this.emit({ type: 'room_closed', roomId });
        break;
      default:
        break;
    }

    this.emit({ type: 'room_updated', snapshot: this.snapshot(roomId) });
  }

  private roomFromContext(): string | null {
    if (this.rooms.size === 1) return [...this.rooms.keys()][0] ?? null;
    return null;
  }

  /** True when Bancho repeats a countdown it already announced moments ago. */
  private repeatsCountdown(
    roomId: string,
    kind: 'match_start' | 'timer',
    seconds: number,
  ): boolean {
    const now = Date.now();
    const previous = this.lastCountdown.get(roomId);
    this.lastCountdown.set(roomId, { kind, seconds, at: now });
    return (
      previous !== undefined &&
      previous.kind === kind &&
      previous.seconds === seconds &&
      now - previous.at < 2000
    );
  }

  private sendToRoom(roomId: string, command: string): void {
    const client = this.requireClient();
    client.privmsg(channelForRoom(roomId), command);
  }

  private requireClient(): IrcClient {
    if (!this.client?.isConnected) {
      throw new Error('IRC is not connected');
    }
    return this.client;
  }

  private usernameFor(userId: number, state: BanchoRoomState | undefined): string {
    if (state) {
      for (const player of state.players.values()) {
        if (player.userId === userId) return player.username;
      }
    }
    return `#${userId}`;
  }

  /** Bancho accepts `#123` for invites/refs; usernames are not required. */
  private ircUserRef(user: UserRef): string {
    if (/^#\d+$/.test(user.username)) return user.username;
    if (!user.username) return `#${user.userId}`;
    return ircName(user.username);
  }

  private emit(event: TransportEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Chat side of the same IRC connection. */
export class IrcChatTransport implements ChatTransport {
  readonly kind = 'irc' as const;
  private readonly client: IrcClient;
  private readonly listeners = new Set<(message: ChatEnvelope) => void>();
  private readonly historyByChannel = new Map<string, ChatEnvelope[]>();

  constructor(client: IrcClient, private readonly selfUsername: string = '') {
    this.client = client;
    client.on('privmsg', (message: Privmsg) => {
      const channelId = message.target.startsWith('#') ? message.target : message.from;
      const actionMatch = /^(?:\u0001)?ACTION\s+([\s\S]*?)(?:\u0001)?$/i.exec(
        message.text.trim(),
      );
      const envelope: ChatEnvelope = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channelId,
        userId: null,
        username: displayNameFromNick(message.from),
        text: actionMatch ? actionMatch[1]! : message.text,
        at: new Date().toISOString(),
        self:
          message.from.replace(/ /g, '_').toLowerCase() ===
          this.selfUsername.replace(/ /g, '_').toLowerCase(),
        system: false,
        action: Boolean(actionMatch),
      };
      this.record(envelope);
      for (const listener of this.listeners) listener(envelope);
    });
  }

  async join(channelId: string): Promise<void> {
    this.client.join(channelId);
  }

  async part(channelId: string): Promise<void> {
    this.client.part(channelId);
  }

  async send(channelId: string, text: string): Promise<void> {
    this.client.privmsg(channelId, text);
  }

  async history(channelId: string, limit: number): Promise<ChatEnvelope[]> {
    return (this.historyByChannel.get(channelId) ?? []).slice(-limit);
  }

  onMessage(listener: (message: ChatEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private record(message: ChatEnvelope): void {
    const entries = this.historyByChannel.get(message.channelId) ?? [];
    entries.push(message);
    if (entries.length > 500) entries.splice(0, entries.length - 500);
    this.historyByChannel.set(message.channelId, entries);
  }
}

function ircName(username: string): string {
  return username.replace(/\s+/g, '_');
}