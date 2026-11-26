import { randomUUID } from 'node:crypto';
import {
  BUILTIN_WIN_BY_RULE,
  findMatch,
  findSlotByLabel,
  findStageForMatch,
  findTeam,
  matchTeamIds,
  buildRoomName,
  matchSessionName,
  slotLabelSequence,
  winBySnapshot,
  type AppState,
  type AutomationTrigger,
  type BeatmapInfo,
  type BeatmapLookupFailure,
  type BeatmapLookupResult,
  type BeatmapResult,
  type ChatMessage,
  type ConnectionKind,
  type ConnectionState,
  type DesktopEvent,
  type LogLevel,
  type Match,
  type MatchFlow,
  type MatchSession,
  type MpCommandResult,
  type PlayerScore,
  type RoomSnapshot,
  type SessionEvent,
  type SessionEventCategory,
  type SessionEventType,
  type Tournament,
  type TournamentMode,
  type Webhook,
  sessionEventCategory,
  toLobbyLogSession,
} from '@osmaref/contracts';
import {
  adjustWins,
  amendResult,
  applyAction as applySessionAction,
  DEFAULT_QUICK_BEST_OF,
  buildQuickTournament,
  buildTemplateContext,
  captureMatchPlayers,
  checkCompletedBeatmap,
  closeRoomSession,
  createSession,
  diffRoomSnapshots,
  evaluateWinBy,
  automationActionsFor,
  expandAutomationMessages,
  type TemplateContext,
  linkRoom,
  normalizeBestOf,
  recordResult as recordSessionResult,
  reopenRoomSession,
  setFirstTeams as setSessionFirstTeams,
  undoLast,
} from '@osmaref/domain';
import {
  ChatDispatcher,
  HttpResultProvider,
  IrcChatTransport,
  IrcMatchTransport,
  isMpCommand,
  MP_HELP_TEXT,
  OsuChatSocket,
  parseMpCommand,
  RefereeHubTransport,
  resolvePlaylistRuleset,
  WebChatClient,
  executeHubActions,
  hasCompleteTeamScores,
  mergeScores,
  mplinkGames,
  buildAutomationEmbeds,
  payloadFromEmbeds,
  sendDiscordWebhook,
  type DiscordEmbed,
  type DiscordWebhookStyle,
  scoresDiffer,
  selectLatestGame,
  type ChatEnvelope,
  type ChatTransport,
  type MatchTransport,
  type MplinkGame,
  type MpContext,
  type TransportEvent,
} from '@osmaref/adapters';
import type { AppStore } from './store';
import type { ServerClient } from './server-client';
import type { SettingsStore } from './settings';
import type { AppLogger } from './logger';
import type { WinByStore } from './winby-store';
import { runWinBy } from './winby';
const MODE_RULESETS: Record<Exclude<TournamentMode, 'multi'>, number> = {
  osu: 0,
  taiko: 1,
  catch: 2,
  mania: 3,
};

/** Ruleset used for room creation and map submission under the tournament mode. */
function resolveTournamentRuleset(
  mode: TournamentMode,
  slots: { rulesetId: number | null }[],
): number {
  if (mode !== 'multi') return MODE_RULESETS[mode];
  const explicit = slots.find((slot) => slot.rulesetId !== null)?.rulesetId;
  return explicit ?? 0;
}

export interface ConnectionManagerDeps {
  store: AppStore;
  settings: SettingsStore;
  winby: WinByStore;
  server: ServerClient;
  logger: AppLogger;
  emit: (event: DesktopEvent) => void;
}

interface ChatTarget {
  transport: ChatTransport;
  channelId: string;
}

export class ConnectionManager {
  private readonly store: AppStore;
  private readonly settings: SettingsStore;
  private readonly winby: WinByStore;
  private readonly server: ServerClient;
  private readonly logger: AppLogger;
  private emit: (event: DesktopEvent) => void;

  private irc: IrcMatchTransport | null = null;
  private ircChat: IrcChatTransport | null = null;
  private hub: RefereeHubTransport | null = null;
  private webChat: WebChatClient | null = null;
  private socket: OsuChatSocket | null = null;
  /** IRC and osu!web chat are independent and may both be online. */
  private webChatReady = false;
  private webChatError: string | null = null;
  private chatReconnectTimer: NodeJS.Timeout | null = null;
  private chatReconnectAttempt = 0;
  private chatReconnectEnabled = false;
  private chatGeneration = 0;
  private chatPollTimer: NodeJS.Timeout | null = null;
  private chatPolling = false;
  private webChatPollError: string | null = null;
  private readonly webChatSeen = new Set<string>();
  /** Debounces local chat echoes against the transport's own echo of the same line. */
  private readonly recentSelfChat = new Map<
    string,
    { local: number[]; remote: number[] }
  >();
  /** Users resolved from osu! by username while handling !mp commands. */
  private readonly resolvedUsers = new Map<number, { userId: number; username: string }>();
  private readonly resolvedNames = new Map<string, number>();
  /** Room players the Hub only identifies by user id. */
  private readonly userNameCache = new Map<number, string>();
  private readonly pendingUserNames = new Set<number>();

  private readonly snapshots = new Map<string, RoomSnapshot>();
  private readonly channels = new Map<string, string>();
  private readonly joinedChannels = new Set<string>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly statuses = new Map<ConnectionKind, ConnectionState>();
  private readonly closingSessions = new Set<string>();
  private readonly verifyingRooms = new Set<string>();

  private activeSessionId: string | null = null;
  private serverUser: { userId: number; username: string } | null = null;
  private autoConnectAttempted = false;
  /** Per-session scores reported by Bancho for the current map. */
  private readonly ircScores = new Map<
    string,
    Map<string, { score: number; passed: boolean }>
  >();
  private readonly beatmapCache = new Map<number, BeatmapInfo>();
  private readonly automationQueues = new Map<string, Promise<void>>();
  /** Result ids already sent through the mplink correction pass. */
  private readonly mplinkCorrections = new Set<string>();

  constructor(deps: ConnectionManagerDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.winby = deps.winby;
    this.server = deps.server;
    this.logger = deps.logger;
    this.emit = deps.emit;

    const now = new Date().toISOString();
    for (const kind of ['irc', 'referee_hub', 'chat'] as ConnectionKind[]) {
      this.statuses.set(kind, { kind, status: 'disconnected', detail: null, updatedAt: now });
    }
  }

  /** Built per call so a settings change takes effect without a restart. */
  private resultsProvider(): HttpResultProvider {
    return new HttpResultProvider({ client: this.server.osu });
  }

  // --- state ---------------------------------------------------------------

  /** Replaces the renderer sink; events emitted before a window exists are dropped. */
  setEmitter(emit: (event: DesktopEvent) => void): void {
    this.emit = emit;
  }

  getAppState(): AppState {
    const sessions = this.store.listSessions();
    return {
      user: this.serverUser,
      server: {
        baseUrl: this.settings.get().serverBaseUrl,
        authenticated: this.serverUser !== null,
      },
      connections: [...this.statuses.values()],
      rooms: sessions
        .filter(
          (session) =>
            (session.status === 'active' || session.status === 'finished') &&
            session.roomId !== null,
        )
        .map((session) => ({
          sessionId: session.id,
          roomId: session.roomId!,
          name: session.roomName ?? session.matchName,
          transport: session.transport,
        })),
      activeSessionId: this.activeSessionId,
    };
  }

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
    this.emitState();
  }

  async refreshServerStatus(): Promise<void> {
    const status = await this.server.status();
    this.serverUser =
      status.authenticated && status.userId && status.username
        ? { userId: status.userId, username: status.username }
        : null;
    this.emitState();
  }

  async lookupBeatmaps(ids: number[]): Promise<BeatmapLookupResult> {
    const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
    const missing = unique.filter((id) => !this.beatmapCache.has(id));
    const failed: BeatmapLookupFailure[] = [];
    for (let index = 0; index < missing.length; index += 4) {
      const chunk = missing.slice(index, index + 4);
      await Promise.all(
        chunk.map(async (id) => {
          try {
            const info = await this.server.osu.getBeatmap(id);
            this.beatmapCache.set(id, {
              id: info.id,
              title: info.title,
              artist: info.artist,
              difficultyName: info.difficultyName,
              mapper: info.mapper,
              mode: info.mode,
              beatmapsetId: info.beatmapsetId,
              beatmapUrl: info.beatmapUrl,
              coverUrl: info.coverUrl,
            });
          } catch (error) {
            const message = errorMessage(error);
            failed.push({ id, message, notFound: /\(404\)/.test(message) });
            this.diagnose('warn', 'osu', `could not load beatmap ${id}: ${message}`);
          }
        }),
      );
    }
    const beatmaps = unique
      .map((id) => this.beatmapCache.get(id))
      .filter((info): info is BeatmapInfo => info !== undefined);
    return { beatmaps, failed };
  }

  // --- connections ---------------------------------------------------------

  /**
   * Called once by the renderer after it has subscribed to events. Uses the
   * saved IRC credentials when the user enabled auto-connect.
   */
  async autoConnect(): Promise<AppState> {
    if (this.autoConnectAttempted) return this.getAppState();
    this.autoConnectAttempted = true;

    const settings = this.settings.get();
    // Hub and IRC are independent; start both without letting one block the other.
    const hubTask = this.autoConnectHub();

    if (!settings.ircAutoConnect || !settings.ircUsername || this.irc) {
      await hubTask;
      return this.getAppState();
    }

    const password = this.settings.getIrcPassword();
    if (!password) {
      this.diagnose('info', 'irc', 'auto-connect skipped: no stored IRC password');
      await hubTask;
      return this.getAppState();
    }

    try {
      // Pass the stored password implicitly: connectIrc falls back to it, and
      // omitting it here avoids rewriting the sealed credential file on every
      // startup (which fails when security software makes the profile read-only).
      await this.connectIrc({
        username: settings.ircUsername,
        host: settings.ircHost,
        port: settings.ircPort,
        useTls: settings.ircUseTls,
        channels: settings.ircDefaultChannels,
      });
    } catch (error) {
      this.diagnose('warn', 'irc', `auto-connect failed: ${errorMessage(error)}`);
    }
    await hubTask;
    return this.getAppState();
  }

  private async autoConnectHub(): Promise<void> {
    if (this.hub) return;
    try {
      const status = await this.server.status();
      if (status.authenticated) await this.connectHub();
    } catch (error) {
      this.diagnose('warn', 'referee_hub', `auto-connect failed: ${errorMessage(error)}`);
    }
  }

  async connectIrc(input: {
    username: string;
    password?: string;
    host?: string;
    port?: number;
    useTls?: boolean;
    channels?: string[];
  }): Promise<AppState> {
    if (this.irc) {
      await this.irc.disconnect();
      this.irc = null;
    }
    const settings = this.settings.get();
    const password = input.password && input.password.length > 0 ? input.password : this.settings.getIrcPassword();
    if (!input.username) throw new Error('IRC username is required');
    if (!password) throw new Error('IRC password is required');

    if (input.password) {
      try {
        await this.settings.setIrcPassword(input.password);
      } catch (error) {
        // The in-memory password is already set, so the connection can proceed
        // even when the credential file cannot be written.
        this.log('warn', 'irc', `could not store the IRC password: ${errorMessage(error)}`);
      }
    }

    const transport = new IrcMatchTransport({
      host: input.host ?? settings.ircHost,
      port: input.port ?? settings.ircPort,
      useTls: input.useTls ?? settings.ircUseTls,
      username: input.username.replace(/\s+/g, '_'),
      password,
      channels: input.channels ?? settings.ircDefaultChannels,
    });
    this.setStatus('irc', 'connecting', `${settings.ircHost}:${settings.ircPort}`);
    const off = transport.onEvent((event) => this.onTransportEvent('irc', event));
    this.unsubscribers.push(off);

    try {
      await transport.connect();
    } catch (error) {
      off();
      this.setStatus('irc', 'error', errorMessage(error));
      throw error;
    }

    this.irc = transport;
    const client = transport.irc;
    if (client) {
      const chat = new IrcChatTransport(client, input.username);
      this.ircChat = chat;
      this.unsubscribers.push(chat.onMessage((message) => this.onChat(message, 'irc')));
    }
    this.setStatus('irc', 'connected', input.username);
    await this.restoreRooms('irc');
    this.emitState();
    return this.getAppState();
  }

  private async startWebChatSocket(): Promise<boolean> {
    if (!this.webChat) return false;
    const generation = ++this.chatGeneration;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    const socket = new OsuChatSocket({
      url: this.settings.get().chatWebsocketUrl,
      getAccessToken: () => this.server.accessToken(),
      onMessage: (payload) => this.webChat?.ingest(payload),
      onStatus: (socketStatus, detail) => {
        if (this.socket !== socket || this.chatGeneration !== generation) return;
        if (socketStatus === 'open') {
          this.webChatReady = true;
          this.webChatError = null;
          this.chatReconnectAttempt = 0;
        } else if (socketStatus === 'closed' || socketStatus === 'error') {
          this.webChatReady = false;
          this.webChatError = detail ?? socketStatus;
          this.scheduleChatReconnect();
        } else {
          this.webChatReady = false;
          if (this.chatReconnectEnabled) this.setStatus('chat', 'reconnecting', 'connecting');
          return;
        }
        this.refreshChatStatus();
      },
    });
    this.socket = socket;
    try {
      await socket.connect();
      if (this.chatGeneration !== generation || this.socket !== socket) return false;
      this.webChatReady = true;
      this.webChatError = null;
      this.chatReconnectAttempt = 0;
      this.refreshChatStatus();
      return true;
    } catch (error) {
      if (this.chatGeneration !== generation) return false;
      if (this.socket === socket) this.socket = null;
      try {
        socket.close();
      } catch {
        // the socket is already gone
      }
      this.webChatReady = false;
      this.webChatError = errorMessage(error);
      this.scheduleChatReconnect();
      this.refreshChatStatus();
      return false;
    }
  }

  private scheduleChatReconnect(delayOverride?: number): void {
    if (!this.chatReconnectEnabled || this.chatReconnectTimer) return;
    const delay =
      delayOverride ?? Math.min(30_000, 1_000 * 2 ** Math.min(this.chatReconnectAttempt++, 5));
    this.chatReconnectTimer = setTimeout(() => {
      this.chatReconnectTimer = null;
      void this.reconnectWebChat();
    }, delay);
    this.chatReconnectTimer.unref?.();
  }

  private clearChatReconnect(): void {
    if (this.chatReconnectTimer) {
      clearTimeout(this.chatReconnectTimer);
      this.chatReconnectTimer = null;
    }
  }

  private async reconnectWebChat(): Promise<void> {
    if (!this.chatReconnectEnabled || !this.webChat) return;
    if (this.socket?.isOpen) {
      this.webChatReady = true;
      this.webChatError = null;
      this.refreshChatStatus();
      await this.rejoinChatChannels();
      return;
    }
    const connected = await this.startWebChatSocket();
    if (!connected) return;
    await this.rejoinChatChannels();
  }

  private async rejoinChatChannels(): Promise<void> {
    for (const session of this.store.listSessions()) {
      if (
        (session.status !== 'active' && session.status !== 'finished') ||
        session.transport !== 'referee_hub'
      )
        continue;
      if (!this.channels.has(session.id)) continue;
      await this.ensureChatChannel(session, this.snapshots.get(session.id));
    }
    this.socket?.startChat();
  }

  async connectHub(): Promise<AppState> {
    if (this.hub && this.statuses.get('referee_hub')?.status === 'connected') {
      if (!this.socket?.isOpen) {
        this.chatReconnectEnabled = true;
        await this.reconnectWebChat();
        this.emitState();
      }
      return this.getAppState();
    }
    if (this.hub) {
      await this.hub.disconnect();
      this.hub = null;
    }
    const status = await this.server.status();
    if (!status.authenticated) {
      throw new Error('sign in to the companion server before connecting to the Referee Hub');
    }
    this.serverUser =
      status.userId && status.username ? { userId: status.userId, username: status.username } : null;

    const hub = new RefereeHubTransport({
      baseUrl: this.settings.get().hubBaseUrl,
      getAccessToken: () => this.server.accessToken(),
      onResync: (snapshots) => {
        for (const snapshot of snapshots) {
          const session = this.findSessionByRoom('referee_hub', snapshot.roomId);
          if (session) {
            const safe = sanitizeSnapshot(snapshot);
            this.snapshots.set(session.id, safe);
          }
        }
        this.emitState();
      },
    });
    this.setStatus('referee_hub', 'connecting', this.settings.get().hubBaseUrl);
    this.unsubscribers.push(hub.onEvent((event) => this.onTransportEvent('referee_hub', event)));
    this.hub = hub;

    try {
      await hub.connect();
    } catch (error) {
      this.hub = null;
      this.setStatus('referee_hub', 'error', errorMessage(error));
      throw error;
    }
    this.setStatus('referee_hub', 'connected', this.settings.get().hubBaseUrl);

    this.chatReconnectEnabled = true;
    this.chatGeneration += 1;
    this.clearChatReconnect();
    this.socket?.close();
    this.socket = null;
    this.webChatReady = false;
    this.webChatError = null;
    this.refreshChatStatus();
    this.webChat = new WebChatClient({
      client: this.server.osu,
      selfUserId: status.userId,
    });
    this.unsubscribers.push(this.webChat.onMessage((message) => this.onChat(message, 'referee_hub')));

    await this.startWebChatSocket();
    this.startChatPolling();

    await this.recoverClosedLobbies();
    await this.restoreRooms('referee_hub');
    this.emitState();
    return this.getAppState();
  }

  async disconnect(kind: ConnectionKind): Promise<AppState> {
    if (kind === 'irc') {
      await this.irc?.disconnect();
      this.irc = null;
      this.ircChat = null;
      this.setStatus('irc', 'disconnected', null);
    } else if (kind === 'referee_hub') {
      this.chatReconnectEnabled = false;
      this.chatGeneration += 1;
      this.clearChatReconnect();
      await this.hub?.disconnect();
      this.hub = null;
      this.socket?.close();
      this.socket = null;
      this.webChat = null;
      this.joinedChannels.clear();
      this.webChatReady = false;
      this.webChatError = null;
      this.stopChatPolling();
      this.setStatus('referee_hub', 'disconnected', null);
      this.refreshChatStatus();
    } else {
      this.chatReconnectEnabled = false;
      this.chatGeneration += 1;
      this.clearChatReconnect();
      this.socket?.close();
      this.socket = null;
      this.webChatReady = false;
      this.webChatError = null;
      this.refreshChatStatus();
    }
    this.emitState();
    return this.getAppState();
  }

  async joinChannel(channel: string): Promise<void> {
    if (!this.ircChat) throw new Error('IRC is not connected');
    await this.ircChat.join(channel);
    this.joinedChannels.add(channel);
  }

  // --- rooms and sessions --------------------------------------------------

  async openRoom(input: { tournamentId: string; matchId: string }): Promise<MatchSession> {
    const tournament = this.store.getTournament(input.tournamentId);
    if (!tournament) throw new Error('tournament not found');
    const match = findMatch(tournament, input.matchId);
    if (!match) throw new Error('match not found');
    const stage = findStageForMatch(tournament, match.id);
    if (!stage) throw new Error('stage not found');
    const flow = stage.flow;

    const kind = tournament.platform === 'lazer' ? 'referee_hub' : 'irc';
    const transport = kind === 'irc' ? this.irc : this.hub;
    if (!transport) {
      throw new Error(
        kind === 'irc' ? 'connect to Bancho IRC first' : 'connect to the Referee Hub first',
      );
    }

    const beatmapId = kind === 'referee_hub' ? stage.slots[0]?.beatmapId ?? null : null;
    if (!beatmapId && kind === 'referee_hub') {
      throw new Error('the Referee Hub requires a mappool beatmap; add one to the stage');
    }

    const participants = matchTeamIds(match);
    const name = buildRoomName(tournament, stage, match);
    const maxParticipants = Math.min(
      16,
      Math.max(2, tournament.teamSize * participants.length + 2),
    );

    const snapshot = await transport.createRoom({
      name,
      rulesetId: resolveTournamentRuleset(tournament.mode, stage.slots),
      ...(beatmapId ? { beatmapId } : {}),
      teamMode: match.roomMode,
      winCondition: tournament.platform === 'lazer' ? 'score' : stage.winCondition,
      maxParticipants,
    });

    return this.registerRoom({
      tournament,
      match,
      flow: match.type === 'lobby'
        ? { id: `flow_${stage.id}`, name: stage.name, phases: [], triggers: [] }
        : flow,
      bestOf: stage.bestOf,
      bans: stage.bans,
      protects: stage.protects,
      kind,
      snapshot,
      configSnapshot: tournament,
    });
  }

  /**
   * Creates a room with no stored tournament. The generated configuration is
   * embedded in the session so the workbench and audit log survive a restart.
   */
  async openQuickRoom(input: {
    name: string;
    beatmapId: number | null;
    rulesetId: number;
    matchType: 'head_to_head' | 'team_versus';
    transport: 'irc' | 'referee_hub';
    maxParticipants: number;
    bestOf: number;
  }): Promise<MatchSession> {
    const transport =
      input.transport === 'irc' ? this.irc : this.hub;
    if (!transport) {
      throw new Error(
        input.transport === 'irc' ? 'connect to Bancho IRC first' : 'connect to the Referee Hub first',
      );
    }
    const name = input.name.trim() || 'Quick room';
    const bestOf = normalizeBestOf(input.bestOf);
    const beatmapId =
      input.beatmapId !== null && Number.isFinite(input.beatmapId) && input.beatmapId > 0
        ? Math.round(input.beatmapId)
        : null;
    if (!beatmapId && input.transport === 'referee_hub') {
      throw new Error('the Referee Hub requires an initial beatmap; enter a beatmap id');
    }
    const tournament = buildQuickTournament({
      name,
      beatmapId,
      rulesetId: input.rulesetId,
      matchType: input.matchType,
      transport: input.transport,
      bestOf,
      referee: this.serverUser,
    });
    const stage = tournament.stages[0];
    const match = stage?.matches[0];
    const flow = stage?.flow;
    if (!match || !flow) throw new Error('failed to build the quick room configuration');

    const quickWinCondition = input.transport === 'referee_hub' ? 'score' : 'score_v2';
    const maxParticipants =
      input.maxParticipants <= 0 ? 0 : Math.min(16, input.maxParticipants * 2 + 2);

    const snapshot = await transport.createRoom({
      name,
      rulesetId: input.rulesetId,
      ...(beatmapId ? { beatmapId } : {}),
      teamMode: input.matchType,
      winCondition: quickWinCondition,
      maxParticipants,
    });

    return this.registerRoom({
      tournament,
      match,
      flow,
      bestOf,
      bans: stage.bans,
      protects: stage.protects,
      kind: input.transport,
      snapshot,
      configSnapshot: tournament,
      firstTeamsSet: true,
    });
  }

  async joinRoom(input: {
    transport: 'irc' | 'referee_hub';
    channel?: string;
    roomId?: string;
  }): Promise<MatchSession> {
    const kind = input.transport;
    const transport = kind === 'irc' ? this.irc : this.hub;
    if (!transport) {
      throw new Error(kind === 'irc' ? 'connect to Bancho IRC first' : 'connect to the Referee Hub first');
    }

    let roomId: string;
    let chatOnly = false;
    let chatChannel: string | null = null;
    if (kind === 'irc') {
      const raw = input.channel?.trim() ?? '';
      if (!raw) throw new Error('enter an IRC channel or username');
      const channel = raw.startsWith('#') || !/^mp_\d+$/i.test(raw) ? raw : `#${raw}`;
      const mp = /^#mp_(\d+)$/i.exec(channel);
      if (mp) {
        roomId = mp[1]!;
      } else {
        chatOnly = true;
        chatChannel = channel;
        roomId = channel;
      }
    } else {
      if (!input.roomId) throw new Error('enter a Referee Hub room id');
      roomId = input.roomId;
    }

    const existing = this.store
      .listSessions()
      .find(
        (session) =>
          (session.status === 'active' || session.status === 'finished') &&
          session.transport === kind &&
          session.roomId === roomId,
      );
    if (existing) {
      this.activeSessionId = existing.id;
      this.appendEvent(existing, 'room_joined', `rejoined room ${roomId}`);
      this.log('info', 'room', `joined room ${roomId} (${kind})`);
      return existing;
    }

    if (chatOnly && chatChannel?.startsWith('#')) {
      if (!this.ircChat) throw new Error('IRC chat is not connected');
      await this.ircChat.join(chatChannel);
    }

    const snapshot = chatOnly
      ? this.chatChannelSnapshot(chatChannel ?? roomId, chatChannel ?? roomId)
      : await transport.joinRoom(roomId);
    const activeItem = snapshot.playlist.find(
      (item) => item.id === snapshot.currentPlaylistItemId,
    );
    // A joined room has no tournament; reuse the best-of of the session that
    // already belonged to this room instead of inventing one.
    const previousSession = this.store
      .listSessions()
      .find((session) => session.transport === kind && session.roomId === roomId);
    const bestOf = previousSession?.bestOf ?? DEFAULT_QUICK_BEST_OF;
    const tournament = buildQuickTournament({
      name: snapshot.name,
      beatmapId: snapshot.currentBeatmapId ?? activeItem?.beatmapId ?? null,
      rulesetId: activeItem?.rulesetId ?? 0,
      matchType: snapshot.matchType === 'team_versus' ? 'team_versus' : 'head_to_head',
      transport: kind,
      bestOf,
      referee: this.serverUser,
    });
    const stage = tournament.stages[0];
    const match = stage?.matches[0];
    const flow = stage?.flow;
    if (!match || !flow) throw new Error('failed to prepare the joined room');
    return this.registerRoom({
      tournament,
      match,
      flow,
      bestOf,
      bans: stage.bans,
      protects: stage.protects,
      kind,
      snapshot,
      configSnapshot: tournament,
      firstTeamsSet: true,
      chatOnly,
    });
  }

  private async registerRoom(params: {
    tournament: Tournament;
    match: Match;
    flow: MatchFlow;
    bestOf: number;
    bans: number;
    protects: number;
    kind: 'irc' | 'referee_hub';
    snapshot: RoomSnapshot;
    configSnapshot: Tournament | null;
    firstTeamsSet?: boolean;
    chatOnly?: boolean;
  }): Promise<MatchSession> {
    const now = new Date().toISOString();
    const stage = findStageForMatch(params.tournament, params.match.id);
    const winBy = stage ? this.winby.get(stage.winByRuleId) : null;
    const session = createSession(
      {
        id: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        tournamentId: params.tournament.id,
        matchId: params.match.id,
        matchName: params.chatOnly
          ? params.snapshot.name
          : (() => {
              const stage = findStageForMatch(params.tournament, params.match.id);
              return stage
                ? matchSessionName(params.tournament, stage, params.match)
                : params.match.id;
            })(),
        matchKind: params.match.type,
        participantIds: matchTeamIds(params.match).map(String),
        teamOneId: String(matchTeamIds(params.match)[0] ?? 0),
        teamTwoId: String(matchTeamIds(params.match)[1] ?? 0),
        tournamentRevision: params.tournament.revision,
        rulesetId: resolveTournamentRuleset(params.tournament.mode, []),
        matchType: params.match.roomMode,
        transport: params.kind,
        bestOf: params.bestOf,
        bans: params.bans,
        protects: params.protects,
        configSnapshot: params.configSnapshot,
        winBy: winBy ? winBySnapshot(winBy) : null,
        firstTeamsSet: params.firstTeamsSet ?? false,
        now,
      },
      params.flow,
    );
    const linked = linkRoom(session, params.snapshot.roomId, params.snapshot.name, now);
    if (params.chatOnly) linked.chatOnly = true;
    const snapshot = sanitizeSnapshot(params.snapshot);
    this.persistSession(linked);
    this.appendEvent(linked, 'session_created', `opened room ${snapshot.roomId}`, {
      roomId: snapshot.roomId,
      transport: params.kind,
    });
    this.appendEvent(linked, 'room_linked', `linked room ${snapshot.name}`, snapshot);

    this.snapshots.set(linked.id, snapshot);
    this.activeSessionId = linked.id;
    await this.ensureChatChannel(linked, snapshot);

    this.emit({ type: 'session_updated', session: linked });
    this.emit({ type: 'room_snapshot', sessionId: linked.id, snapshot });
    this.runAutomation(params.tournament, linked, 'match_created');
    this.emitState();
    this.log(
      'info',
      'room',
      `${params.chatOnly ? 'joined chat channel' : 'opened room'} ${snapshot.roomId} (${params.kind})`,
    );
    return linked;
  }

  /**
   * Quick rooms carry their configuration inside the session; stored
   * tournaments are looked up by id.
   */
  private tournamentForSession(session: MatchSession): Tournament | null {
    return session.configSnapshot ?? this.store.getTournament(session.tournamentId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const transport = session.transport === 'irc' ? this.irc : this.hub;
    if (session.chatOnly && session.transport === 'irc' && session.roomId?.startsWith('#')) {
      try {
        await this.ircChat?.part(session.roomId);
      } catch (error) {
        this.diagnose('warn', 'chat', `could not leave ${session.roomId}: ${errorMessage(error)}`);
      }
    }
    if (!session.chatOnly && transport && session.roomId) {
      const channelId =
        this.channels.get(session.id) ?? (session.roomId ? `#mp_${session.roomId}` : 'local');
      if (session.transport === 'irc') {
        this.appendLocalChat(session, '!mp close', channelId, 'irc');
      } else {
        this.emiteSystemChat(session, 'room closed');
      }
      try {
        this.closingSessions.add(session.id);
        await transport.closeRoom(session.roomId);
      } catch (error) {
        this.log('warn', 'room', `could not close room: ${errorMessage(error)}`);
      } finally {
        this.closingSessions.delete(session.id);
      }
    }
    const aborted = closeRoomSession(session, new Date().toISOString());
    this.persistSession(aborted);
    this.appendEvent(aborted, 'room_left', 'session closed by referee');
    this.snapshots.delete(sessionId);
    this.channels.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    this.emit({ type: 'session_updated', session: aborted });
    this.emitState();
    this.log('info', 'room', `closed room ${session.roomId ?? session.id}`);
  }

  async adjustScore(input: {
    sessionId: string;
    side: 'team_one' | 'team_two';
    delta: number;
  }): Promise<MatchSession> {
    const session = this.requireSession(input.sessionId);
    if (session.status !== 'active' && session.status !== 'finished')
      throw new Error('the room is no longer active');
    const next = adjustWins(session, input.side, input.delta, new Date().toISOString());
    this.persistSession(next);
    this.appendEvent(
      next,
      'manual_adjustment',
      `score ${input.side} ${input.delta > 0 ? '+' : ''}${input.delta}`,
      { wins: next.wins },
    );
    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async setFirstTeams(input: {
    sessionId: string;
    assignments: { stepId: string; teamId: string }[];
  }): Promise<MatchSession> {
    const session = this.requireSession(input.sessionId);
    if (session.status !== 'active' && session.status !== 'finished')
      throw new Error('the room is no longer active');
    const next = setSessionFirstTeams(session, input.assignments);
    this.persistSession(next);
    this.appendEvent(next, 'manual_adjustment', 'first teams updated', {
      assignments: input.assignments,
    });
    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async setPlaylistMods(input: {
    sessionId: string;
    playlistItemId: string;
    requiredMods: string[];
    allowedMods: string[];
    freestyle: boolean;
  }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (session.transport !== 'referee_hub' || !session.roomId) {
      throw new Error('playlist mods are only editable through the Referee Hub');
    }
    if (!this.hub) throw new Error('connect to the Referee Hub first');
    await this.hub.editPlaylistItem(session.roomId, input.playlistItemId, {
      requiredMods: input.requiredMods,
      allowedMods: input.freestyle ? [] : input.allowedMods,
      freestyle: input.freestyle,
    });
    const snapshot = this.snapshots.get(session.id);
    const item = snapshot?.playlist.find((entry) => entry.id === input.playlistItemId);
    if (snapshot && item) {
      item.requiredMods = [...input.requiredMods];
      item.allowedMods = input.freestyle ? [] : [...input.allowedMods];
      item.freestyle = input.freestyle;
      snapshot.updatedAt = new Date().toISOString();
      this.emit({ type: 'room_snapshot', sessionId: session.id, snapshot });
    }
    this.appendEvent(session, 'manual_adjustment', 'playlist mods updated', input);
  }

  /**
   * Lobby rooms select mappool beatmaps directly. There is no pick/ban flow and
   * no score to record, so only the room map and the session's current beatmap
   * change.
   */
  async selectBeatmap(input: { sessionId: string; slotLabel: string }): Promise<MatchSession> {
    const session = this.requireSession(input.sessionId);
    if (session.matchKind !== 'lobby' && session.status !== 'finished') {
      throw new Error('direct beatmap selection is only available for lobby fixtures or finished rooms');
    }
    const tournament = this.tournamentForSession(session);
    if (!tournament) throw new Error('tournament not found');
    const match = findMatch(tournament, session.matchId);
    const stage = match ? findStageForMatch(tournament, match.id) : undefined;
    const slot = stage ? findSlotByLabel(stage, input.slotLabel) : undefined;
    if (!slot) throw new Error(`unknown mappool slot "${input.slotLabel}"`);

    const transport = session.transport === 'irc' ? this.irc : this.hub;
    if (transport && session.roomId) {
      await transport.editBeatmap(session.roomId, {
        beatmapId: slot.beatmapId,
        rulesetId: slot.rulesetId ?? undefined,
        requiredMods: slot.requiredMods,
        allowedMods: slot.allowedMods,
        freestyle: slot.freestyle,
        freemod: slot.freemod,
      });
    }

    const next: MatchSession = {
      ...session,
      currentSlotLabel: slot.label,
      currentBeatmapId: slot.beatmapId,
      updatedAt: new Date().toISOString(),
    };
    this.persistSession(next);
    this.appendEvent(next, 'beatmap_changed', `selected ${slot.label}`, {
      slotLabel: slot.label,
      beatmapId: slot.beatmapId,
    });
    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async startMatch(input: { sessionId: string; countdown: number | null }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (session.status !== 'active' && session.status !== 'finished')
      throw new Error('the match is not active');
    if (!session.roomId) throw new Error('the match has no room id yet');
    const transport = session.transport === 'irc' ? this.irc : this.hub;
    if (!transport) throw new Error('connect to the match platform first');
    await transport.startMatch(session.roomId, input.countdown);
    this.appendEvent(
      session,
      'manual_adjustment',
      input.countdown === null ? 'match started' : `match started with ${input.countdown}s countdown`,
    );
  }

  async addPlaylistBeatmap(input: {
    sessionId: string;
    beatmapId: number;
    rulesetId: number;
  }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (!session.roomId) throw new Error('the match has no room id yet');
    const beatmap = await this.server.osu.getBeatmap(input.beatmapId);
    const rulesetId = resolvePlaylistRuleset(beatmap.mode, input.rulesetId);
    if (session.transport === 'irc') {
      const transport = this.irc;
      if (!transport) throw new Error('connect to Bancho IRC first');
      await transport.editBeatmap(session.roomId, {
        beatmapId: input.beatmapId,
        rulesetId,
      });
      const next: MatchSession = {
        ...session,
        currentBeatmapId: input.beatmapId,
        updatedAt: new Date().toISOString(),
      };
      this.persistSession(next);
      this.appendEvent(next, 'beatmap_changed', `changed beatmap to ${input.beatmapId}`, {
        beatmapId: input.beatmapId,
        rulesetId,
      });
      this.emit({ type: 'session_updated', session: next });
      return;
    }
    if (!this.hub) throw new Error('connect to the Referee Hub first');
    await this.hub.addPlaylistItem(session.roomId, {
      beatmapId: input.beatmapId,
      rulesetId,
    });
    this.appendEvent(
      session,
      'manual_adjustment',
      `playlist beatmap added: ${input.beatmapId} (ruleset ${rulesetId})`,
    );
  }

  async removePlaylistBeatmap(input: {
    sessionId: string;
    playlistItemId: string;
  }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (session.transport !== 'referee_hub' || !session.roomId) {
      throw new Error('playlist editing is only available through the Referee Hub');
    }
    if (!this.hub) throw new Error('connect to the Referee Hub first');
    const snapshot = this.snapshots.get(session.id);
    if (snapshot && snapshot.playlist.length <= 1) {
      throw new Error('a room must keep at least one playlist item');
    }
    if (snapshot?.playlist.find((item) => item.id === input.playlistItemId)?.wasPlayed) {
      throw new Error('the Referee Hub does not allow removing a playlist item that has already been played');
    }
    await this.hub.removePlaylistItem(session.roomId, input.playlistItemId);
    this.appendEvent(session, 'manual_adjustment', `playlist item removed: ${input.playlistItemId}`);
  }

  async invitePlayer(input: { sessionId: string; user: string }): Promise<void> {
    const token = input.user.trim();
    const explicitId = /^#(\d+)$/.exec(token);
    if (explicitId) {
      const userId = Number(explicitId[1]);
      if (!Number.isInteger(userId) || userId <= 0) throw new Error('invalid user id');
      const username =
        this.snapshots
          .get(input.sessionId)
          ?.players.find((player) => player.userId === userId)?.username ??
        this.userNameCache.get(userId) ??
        `#${userId}`;
      await this.applyPlayerAction({ sessionId: input.sessionId, userId }, 'invite', username);
      return;
    }

    const user = await this.server.osu.getUserByName(token);
    if (!user.userId) throw new Error(`could not resolve user "${token}"`);
    this.resolvedUsers.set(user.userId, user);
    this.resolvedNames.set(normalizePlayerName(user.username), user.userId);
    await this.applyPlayerAction(
      { sessionId: input.sessionId, userId: user.userId },
      'invite',
      user.username,
    );
  }

  async kickPlayer(input: { sessionId: string; userId: number }): Promise<void> {
    await this.applyPlayerAction(input, 'kick');
  }

  private async applyPlayerAction(
    input: { sessionId: string; userId: number },
    action: 'invite' | 'kick',
    usernameOverride?: string,
  ): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (!session.roomId) throw new Error('the session has no room');
    const transport = session.transport === 'irc' ? this.irc : this.hub;
    if (!transport) {
      throw new Error(
        session.transport === 'irc'
          ? 'connect to Bancho IRC first'
          : 'connect to the Referee Hub first',
      );
    }
    const username =
      usernameOverride ??
      this.snapshots.get(session.id)?.players.find((player) => player.userId === input.userId)
        ?.username ??
      this.userNameCache.get(input.userId) ??
      `#${input.userId}`;
    const user = { userId: input.userId, username };
    if (action === 'invite') await transport.invitePlayer(session.roomId, user);
    else await transport.kickPlayer(session.roomId, user);
    const channelId =
      this.channels.get(session.id) ?? (session.roomId ? `#mp_${session.roomId}` : 'local');
    if (session.transport === 'irc') {
      this.appendLocalChat(
        session,
        `!mp ${action === 'invite' ? 'invite' : 'kick'} ${username}`,
        channelId,
        'irc',
      );
    } else {
      this.emiteSystemChat(
        session,
        `${action === 'invite' ? 'invited' : 'kicked'} ${username}`,
      );
    }
    this.appendEvent(
      session,
      'manual_adjustment',
      `player ${action === 'invite' ? 'invited' : 'kicked'}: ${username}`,
    );
  }

  private isQuickSession(session: MatchSession): boolean {
    return (
      session.tournamentId.startsWith('adhoc_') ||
      session.configSnapshot?.id.startsWith('adhoc_') === true
    );
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.status === 'active' || session.status === 'finished') {
      throw new Error('close the room before removing it');
    }
    this.snapshots.delete(sessionId);
    this.channels.delete(sessionId);
    this.ircScores.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    this.store.deleteSession(sessionId);
    this.emitState();
    this.log('info', 'room', `removed session ${sessionId} (lobby log kept)`);
  }

  async applyAction(input: {
    sessionId: string;
    kind: 'protect' | 'ban' | 'pick';
    teamId: string;
    slotLabel: string;
    beatmapId?: number;
  }): Promise<MatchSession> {
    const session = this.requireSession(input.sessionId);
    if (!session.firstTeamsSet && !this.isQuickSession(session)) {
      const reason = 'set the first team for every flow step before picking or banning';
      this.appendEvent(session, 'action_rejected', `${input.kind} ${input.slotLabel}: ${reason}`, {
        kind: input.kind,
        teamId: input.teamId,
        slotLabel: input.slotLabel,
        reason,
      });
      throw new Error(reason);
    }
    const tournament = this.tournamentForSession(session);
    if (!tournament) {
      this.appendEvent(session, 'action_rejected', `${input.kind} ${input.slotLabel}: tournament not found`, {
        kind: input.kind,
        teamId: input.teamId,
        slotLabel: input.slotLabel,
        reason: 'tournament not found',
      });
      throw new Error('tournament not found');
    }
    const match = findMatch(tournament, session.matchId);
    const pool = match ? findStageForMatch(tournament, match.id) : undefined;
    const slot = pool ? findSlotByLabel(pool, input.slotLabel) : undefined;
    if (!slot) {
      const reason = `unknown mappool slot "${input.slotLabel}"`;
      this.appendEvent(session, 'action_rejected', `${input.kind} ${input.slotLabel}: ${reason}`, {
        kind: input.kind,
        teamId: input.teamId,
        slotLabel: input.slotLabel,
        reason,
      });
      throw new Error(reason);
    }
    const beatmapId = slot.beatmapId;

    const next = applySessionAction(session, {
      kind: input.kind,
      teamId: input.teamId,
      slotLabel: input.slotLabel,
      beatmapId,
      byUserId: this.serverUser?.userId ?? null,
      at: new Date().toISOString(),
    });

    this.persistSession(next);
    this.appendEvent(next, 'action_applied', `${input.kind} ${input.slotLabel} by ${input.teamId}`, {
      kind: input.kind,
      teamId: input.teamId,
      slotLabel: input.slotLabel,
    });

    if (slot && next.roomId) {
      const transport = next.transport === 'irc' ? this.irc : this.hub;
      try {
        await transport?.editBeatmap(next.roomId, {
          beatmapId: slot.beatmapId,
          rulesetId: slot.rulesetId ?? undefined,
          requiredMods: slot.requiredMods,
          allowedMods: slot.allowedMods,
          freestyle: slot.freestyle,
          freemod: slot.freemod,
        });
      } catch (error) {
        this.emitNotice('warn', `room did not accept the beatmap: ${errorMessage(error)}`);
      }
    }

    this.runAutomation(tournament, next, 'action_applied', {
      slot: input.slotLabel,
      beatmap_id: String(beatmapId),
    });
    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async recordScores(input: {
    sessionId: string;
    slotLabel: string;
    /** Required when the beatmap is not in the mappool (Hub playlist/quick room). */
    beatmapId?: number;
    scores: {
      userId: number;
      username?: string;
      score: number;
      accuracy: number;
      maxCombo: number;
      misses: number;
      mods: string[];
      passed: boolean;
    }[];
    source: 'irc' | 'referee_hub' | 'manual';
  }): Promise<MatchSession> {
    const session = this.requireSession(input.sessionId);
    const tournament = this.tournamentForSession(session);
    if (!tournament) throw new Error('tournament not found');
    const match = findMatch(tournament, session.matchId);
    const stage = match ? findStageForMatch(tournament, match.id) : undefined;
    const slot = stage ? findSlotByLabel(stage, input.slotLabel) : undefined;
    const beatmapId = slot?.beatmapId ?? input.beatmapId ?? session.currentBeatmapId;
    if (!beatmapId) {
      throw new Error(`unknown mappool slot "${input.slotLabel}" and no beatmap id supplied`);
    }

    const snapshot = this.snapshots.get(session.id) ?? null;
    const knownNames = new Map<number, string>();
    for (const team of tournament.teams) {
      for (const member of team.members) knownNames.set(member.userId, member.username);
    }
    for (const player of session.matchPlayers) {
      if (player.username) knownNames.set(player.userId, player.username);
    }
    for (const player of snapshot?.players ?? []) {
      if (player.username) knownNames.set(player.userId, player.username);
    }
    for (const user of this.resolvedUsers.values()) knownNames.set(user.userId, user.username);

    const scores = input.scores
      .filter((score) => score.userId > 0)
      .map((score) => {
        const username = score.username ?? knownNames.get(score.userId);
        return { ...score, username };
      });

    const recordedAt = new Date().toISOString();
    const winBy =
      session.winBy ??
      winBySnapshot(
        (stage ? this.winby.get(stage.winByRuleId) : null) ?? BUILTIN_WIN_BY_RULE,
      );
    const players = session.matchPlayers.length
      ? session.matchPlayers
      : (snapshot?.players ?? []);
    const [teamOneMembers, teamTwoMembers] = this.winByTeamMembers(
      session,
      tournament,
      players,
    );
    const evaluation =
      session.matchKind === 'lobby'
        ? null
        : evaluateWinBy({
            scores,
            players,
            teamOneMembers,
            teamTwoMembers,
            teamSize: tournament.teamSize,
            beatmapId,
            category: slot?.category ?? null,
            sequence: Number(slotLabelSequence(input.slotLabel)) || 0,
            decide: (slots, map, teams) => runWinBy(winBy.source, slots, map, teams),
          });
    const needsReview = evaluation?.needsReview ?? false;
    const result: BeatmapResult = {
      id: `${input.slotLabel}:${recordedAt}`,
      slotLabel: input.slotLabel,
      beatmapId,
      scores,
      winner: evaluation?.winner ?? null,
      teamValues: evaluation?.teamValues ?? { team_one: null, team_two: null },
      source: input.source,
      recordedAt,
      winByRuleId: evaluation ? winBy.ruleId : null,
      needsReview,
    };

    const next = recordSessionResult(session, result);
    this.persistSession(next);
    this.appendEvent(
      next,
      needsReview ? 'result_needs_review' : 'result_recorded',
      `${input.slotLabel}: ${result.winner ?? (needsReview ? 'needs review' : 'recorded')}`,
      result,
    );
    if (needsReview && evaluation?.reviewReason) {
      this.emiteSystemChat(next, `Result for ${input.slotLabel} needs review: ${evaluation.reviewReason}`);
    }

    this.runAutomation(tournament, next, 'beatmap_completed', {
      winner: result.winner ?? '',
      slot: input.slotLabel,
      beatmap_id: String(beatmapId),
    });
    if (next.status === 'finished') {
      this.runAutomation(tournament, next, 'match_finished');
      this.syncMatchResult(tournament, next);
    }

    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  /** Writes a finished two-team match's map wins back into the tournament. */
  private syncMatchResult(tournament: Tournament, session: MatchSession): void {
    if (session.matchKind !== 'match') return;
    const stage = findStageForMatch(tournament, session.matchId);
    const match = stage?.matches.find((entry) => entry.id === session.matchId);
    if (!stage || !match || match.type !== 'match') return;
    const result = { scoreRed: session.wins.team_one, scoreBlue: session.wins.team_two };
    if (match.result.scoreRed === result.scoreRed && match.result.scoreBlue === result.scoreBlue) {
      return;
    }
    const next: Tournament = {
      ...tournament,
      stages: tournament.stages.map((entry) =>
        entry.id !== stage.id
          ? entry
          : {
              ...entry,
              matches: entry.matches.map((fixture) =>
                fixture.id !== match.id ? fixture : { ...fixture, result },
              ),
            },
      ),
    };
    try {
      this.store.saveTournament(next);
      this.log('info', 'tournament', `synced result ${result.scoreRed}-${result.scoreBlue} for match ${match.id}`);
    } catch (error) {
      this.log('warn', 'tournament', `could not sync match result: ${errorMessage(error)}`);
    }
  }

  async undo(sessionId: string): Promise<MatchSession> {
    const session = this.requireSession(sessionId);
    const tournament = this.tournamentForSession(session);
    const next = undoLast(session, new Date().toISOString());
    this.persistSession(next);
    this.appendEvent(next, 'manual_adjustment', 'undo of the last action');
    if (tournament) {
      this.syncMatchResult(tournament, next);
    }
    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async sendChat(sessionId: string, text: string): Promise<MpCommandResult | null> {
    let session = this.requireSession(sessionId);
    const target = this.chatTargetFor(session);

    // Bancho executes !mp natively; the local compatibility layer exists only
    // because the Referee Hub does not expose Bancho's chat commands.
    if (session.transport === 'irc') {
      const join = /^\/(?:join|j)\s+(\S+)\s*$/i.exec(text.trim());
      if (join) {
        await this.joinRoom({ transport: 'irc', channel: join[1]! });
        return null;
      }
      await target.transport.send(target.channelId, text);
      // Bancho does not echo our own commands; show the line locally. Only
      // real chat is persisted, so `!mp password` never reaches the log.
      this.appendLocalChat(session, text, target.channelId, 'irc', !isMpCommand(text));
      return null;
    }

    const transport = this.hub;
    await this.preResolveUsers(sessionId, text);

    const dispatcher = new ChatDispatcher({
      getContext: () => this.buildMpContext(sessionId),
      sendChat: (message) => target.transport.send(target.channelId, message),
      execute: async (actions) => {
        if (!transport) return { ok: false, message: 'transport is not connected' };
        return executeHubActions(transport, actions);
      },
    });

    const outcomeRaw = await (async () => {
      try {
        return await dispatcher.submit(text);
      } catch (error) {
        if (isMpCommand(text)) throw error;
        const recovered = await this.recoverWebChat(target.channelId, error);
        if (!recovered) throw error;
        try {
          return await dispatcher.submit(text);
        } catch (retryError) {
          this.webChatError = errorMessage(retryError);
          this.refreshChatStatus();
          throw retryError;
        }
      }
    })();
    const outcome = outcomeRaw;
    if (!isMpCommand(text) && this.socket?.isOpen) {
      this.webChatReady = true;
      this.webChatError = null;
      this.refreshChatStatus();
    }
    if (outcome.ok && !isMpCommand(text)) {
      this.appendLocalChat(session, text, target.channelId, 'referee_hub');
    }
    if (!outcome.handled) return null;

    if (outcome.ok && outcome.effects.some((effect) => effect.type === 'help')) {
      this.emiteSystemChat(session, MP_HELP_TEXT);
    }
    if (outcome.ok && outcome.effects.some((effect) => effect.type === 'showSettings')) {
      this.emiteSystemChat(session, formatSnapshot(this.snapshots.get(sessionId) ?? null, this.tournamentForSession(session)));
    }
    if (outcome.ok && outcome.effects.some((effect) => effect.type === 'showReferees')) {
      const snapshot = this.snapshots.get(sessionId);
      const referees = snapshot?.referees.length
        ? snapshot.referees.map((id) => `#${id}`).join(', ')
        : 'none';
      this.emiteSystemChat(session, `Referees: ${referees}`);
    }
    const detailedOutput = outcome.effects.some(
      (effect) =>
        effect.type === 'help' ||
        effect.type === 'showSettings' ||
        effect.type === 'showReferees',
    );
    if (outcome.ok && outcome.message && !detailedOutput) {
      this.emiteSystemChat(session, outcome.message);
    }
    if (!outcome.ok && outcome.message) {
      this.emiteSystemChat(session, `!mp error: ${outcome.message}`);
    }

    if (outcome.ok && outcome.actions.includes('closeRoom')) {
      const latest = this.store.getSession(session.id) ?? session;
      if (latest.status !== 'closed') {
        const closed = closeRoomSession(latest, new Date().toISOString());
        this.persistSession(closed);
        this.snapshots.delete(session.id);
        this.channels.delete(session.id);
        if (this.activeSessionId === session.id) this.activeSessionId = null;
        this.appendEvent(closed, 'room_left', 'room closed by !mp close');
        this.emit({ type: 'session_updated', session: closed });
        session = closed;
      } else {
        session = latest;
      }
    }

    const result: MpCommandResult = {
      handled: outcome.handled,
      ok: outcome.ok,
      command: outcome.command,
      message: outcome.message,
      actions: outcome.actions,
      at: outcome.at,
    };
    this.appendEvent(
      session,
      outcome.ok ? 'command_received' : 'command_rejected',
      `${outcome.command ?? 'chat'}: ${outcome.message}`,
      { actions: outcome.actions },
    );
    this.emit({ type: 'mp_result', result });
    return result;
  }

  async chatHistory(sessionId: string, limit = 100): Promise<ChatMessage[]> {
    const session = this.requireSession(sessionId);
    const target = this.chatTargetFor(session);
    const history = await target.transport.history(target.channelId, limit);
    return history
      .filter((message) => session.transport !== 'irc' || !this.isSelfIrcMpCommand(message))
      .map((message) => this.toChatMessage(message, sessionId, session.transport));
  }

  getRoomSnapshot(sessionId: string): RoomSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  /**
   * Re-joins rooms that were active before the app restarted. Finished rooms
   * stay joined as well: a finished match does not close its hub room, so the
   * referee keeps the chat channel and can still manage it until it is closed.
   *
   * IRC: rejoin `#mp_<id>` and ask BanchoBot for `!mp settings` so the snapshot
   * (name, team mode, players) is authoritative again.
   * Hub: `ListRooms`/`JoinRoom` already ran during connect; here we only make
   * sure the chat channel is joined for each restored room.
   */
  private async restoreRooms(kind: 'irc' | 'referee_hub'): Promise<void> {
    const sessions = this.store
      .listSessions()
      .filter(
        (session) =>
          (session.status === 'active' || session.status === 'finished') &&
          session.roomId !== null &&
          session.transport === kind,
      );
    if (sessions.length === 0) return;

    for (const session of sessions) {
      const roomId = session.roomId!;
      try {
        if (kind === 'irc') {
          const transport = this.irc;
          if (!transport) return;
          if (session.chatOnly) {
            if (roomId.startsWith('#')) await this.ircChat?.join(roomId);
            const safe = this.chatChannelSnapshot(roomId, roomId);
            this.snapshots.set(session.id, safe);
            this.channels.set(session.id, roomId);
            this.emit({ type: 'room_snapshot', sessionId: session.id, snapshot: safe });
            continue;
          }
          const snapshot = await transport.joinRoom(roomId);
          const safe = sanitizeSnapshot(snapshot);
          this.snapshots.set(session.id, safe);
          this.channels.set(session.id, safe.chatChannelId ?? `#mp_${roomId}`);
          this.emit({ type: 'room_snapshot', sessionId: session.id, snapshot: safe });
          // The join needs a moment before Bancho answers in the channel.
          setTimeout(() => {
            try {
              transport.requestRoomSettings(roomId);
            } catch {
              // transport disconnected in the meantime
            }
          }, 800);
        } else {
          const transport = this.hub;
          if (!transport) return;
          let snapshot = this.snapshots.get(session.id) ?? null;
          if (!snapshot) snapshot = sanitizeSnapshot(await transport.joinRoom(roomId));
          this.snapshots.set(session.id, snapshot);
          this.emit({ type: 'room_snapshot', sessionId: session.id, snapshot });
          void this.resolvePlayerNames(session.id);
          await this.ensureChatChannel(session, snapshot);
        }
        this.log('info', 'room', `restored ${kind} room ${roomId}`);
        this.appendEvent(session, 'transport_event', `restored ${kind} room ${roomId}`);
      } catch (error) {
        this.log('warn', 'room', `could not restore room ${roomId}: ${errorMessage(error)}`);
        if (session.status === 'active') {
          this.emiteSystemChat(session, `could not rejoin room ${roomId}: ${errorMessage(error)}`);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopChatPolling();
    for (const off of this.unsubscribers.splice(0)) off();
    this.socket?.close();
    await this.hub?.disconnect();
    await this.irc?.disconnect();
  }

  // --- transport events ----------------------------------------------------

  private async confirmRoomClosed(session: MatchSession): Promise<void> {
    if (
      (session.status !== 'active' && session.status !== 'finished') ||
      this.closingSessions.has(session.id) ||
      this.verifyingRooms.has(session.id)
    ) {
      return;
    }
    const roomId = session.roomId;
    if (session.transport === 'referee_hub' && this.hub && roomId) {
      this.verifyingRooms.add(session.id);
      try {
        await this.hub.joinRoom(roomId);
        return;
      } catch (error) {
        const detail = errorMessage(error);
        this.diagnose('warn', 'referee_hub', `room ${roomId} is not joinable: ${detail}`);
        // Without a live hub link the join result proves nothing; keep the
        // session active and wait for the reconnect resync instead of closing
        // a room that may still be running.
        if (!this.hub.isConnected) {
          return;
        }
      } finally {
        this.verifyingRooms.delete(session.id);
      }
    }
    const current = this.store.getSession(session.id) ?? session;
    if (current.status !== 'active' && current.status !== 'finished') return;
    const closed = closeRoomSession(current, new Date().toISOString());
    this.persistSession(closed);
    this.snapshots.delete(session.id);
    this.channels.delete(session.id);
    this.ircScores.delete(session.id);
    if (this.activeSessionId === session.id) this.activeSessionId = null;
    this.appendEvent(closed, 'room_left', 'room was closed');
    this.emitLifecycleChat(closed, 'the room was closed');
    this.log('info', 'room', `room ${roomId ?? session.id} was closed`);
    this.emit({ type: 'session_updated', session: closed });
    this.emitState();
  }

  private async onTransportEvent(kind: 'irc' | 'referee_hub', event: TransportEvent): Promise<void> {
    switch (event.type) {
      case 'connection': {
        this.setStatus(kind, event.status, event.detail ?? null);
        return;
      }
      case 'room_created': {
        if (kind !== 'irc') return;
        void this.joinRoom({ transport: 'irc', channel: `#mp_${event.roomId}` }).catch(
          (error: unknown) => {
            this.log('warn', 'room', `could not join created room ${event.roomId}: ${errorMessage(error)}`);
          },
        );
        return;
      }
      case 'room_joined':
      case 'room_updated': {
        const session = this.findSessionByRoom(kind, event.snapshot.roomId);
        if (!session) return;
        const previous = this.snapshots.get(session.id) ?? null;
        const snapshot = sanitizeSnapshot(event.snapshot);
        let current = session;
        if (session.status === 'closed' && session.matchKind === 'lobby') {
          current = reopenRoomSession(session, new Date().toISOString());
          this.persistSession(current);
          this.appendEvent(current, 'transport_event', `reopened room ${event.snapshot.roomId}`);
          this.emit({ type: 'session_updated', session: current });
        }
        if (session.roomId && snapshot.name && snapshot.name !== session.roomName) {
          current = linkRoom(current, current.roomId ?? session.roomId, snapshot.name, new Date().toISOString());
          this.persistSession(current);
          this.emit({ type: 'session_updated', session: current });
        }
        for (const change of diffRoomSnapshots(previous, snapshot)) {
          this.appendEvent(current, change.type, change.summary, change.payload);
        }
        if (!current.chatOnly) this.store.upsertLobbyLogSession(toLobbyLogSession(current));
        this.snapshots.set(current.id, snapshot);
        void this.ensureChatChannel(current, snapshot);
        this.emit({ type: 'room_snapshot', sessionId: current.id, snapshot });
        void this.resolvePlayerNames(current.id);
        return;
      }
      case 'room_closed': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (!session) return;
        await this.confirmRoomClosed(session);
        return;
      }
      case 'match_started': {
        let session = this.findSessionByRoom(kind, event.roomId);
        if (!session) return;
        const startSnapshot = this.snapshots.get(session.id);
        if (startSnapshot) {
          session = captureMatchPlayers(session, startSnapshot.players, new Date().toISOString());
          this.persistSession(session);
        }
        this.ircScores.delete(session.id);
        this.appendEvent(
          session,
          'match_started',
          `match started (slot ${session.currentSlotLabel ?? '-'}, beatmap ${
            session.currentBeatmapId ?? '-'
          })`,
          {
            slotLabel: session.currentSlotLabel,
            beatmapId: session.currentBeatmapId,
          },
        );
        this.emitLifecycleChat(session, 'match started');
        const tournament = this.tournamentForSession(session);
        if (tournament) this.runAutomation(tournament, session, 'beatmap_started');
        return;
      }
      case 'player_finished': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (!session) return;
        const scores = this.ircScores.get(session.id) ?? new Map();
        scores.set(normalizePlayerName(event.username), {
          score: event.score,
          passed: event.passed,
        });
        this.ircScores.set(session.id, scores);
        this.appendEvent(
          session,
          'player_finished',
          `${event.username} finished (${event.score}, ${event.passed ? 'PASSED' : 'FAILED'})`,
          { username: event.username, score: event.score, passed: event.passed },
        );
        return;
      }
      case 'match_finished': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (!session) return;
        this.appendEvent(session, 'match_finished', 'match finished');
        this.emitLifecycleChat(session, 'match finished');
        void this.handleIrcMatchFinished(session);
        return;
      }
      case 'match_aborted': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (session) {
          this.appendEvent(session, 'match_aborted', 'match aborted');
          this.emitLifecycleChat(session, 'match aborted');
        }
        return;
      }
      case 'match_completed': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (session) {
          this.appendEvent(
            session,
            'match_completed',
            `match completed (playlist item ${event.playlistItemId})`,
            { playlistItemId: event.playlistItemId },
          );
        }
        void this.handleMatchCompleted(kind, event.roomId, event.playlistItemId);
        return;
      }
      case 'countdown': {
        const session = this.findSessionByRoom(kind, event.roomId);
        if (!session) return;
        this.appendEvent(
          session,
          'countdown',
          `${event.kind} countdown: ${event.seconds}s`,
          { kind: event.kind, seconds: event.seconds },
        );
        if (event.kind === 'server_shutting_down') {
          this.emiteSystemChat(
            session,
            'spectator server shutdown announced: finish the current game, then reopen the room on the new instance',
          );
        } else {
          this.emitLifecycleChat(session, `${event.kind === 'timer' ? 'timer' : 'match start'} countdown: ${event.seconds}s`);
        }
        return;
      }
      case 'notice': {
        this.diagnose(event.level === 'error' ? 'error' : event.level, kind, event.message);
        return;
      }
      default:
        return;
    }
  }

  /**
   * IRC reports only total scores. They are still handed to the active Win-by
   * rule; a rule that needs richer data returns null and the result is flagged
   * for review instead of being guessed.
   */
  private async handleIrcMatchFinished(session: MatchSession): Promise<void> {
    const slotLabel = session.currentSlotLabel;
    if (!slotLabel) {
      this.emiteSystemChat(session, 'match finished but no pick is active; enter the result manually');
      return;
    }
    const tournament = this.tournamentForSession(session);
    const match = tournament ? findMatch(tournament, session.matchId) : undefined;
    const pool = tournament && match ? findStageForMatch(tournament, match.id) : undefined;
    const slot = pool ? findSlotByLabel(pool, slotLabel) : undefined;
    if (!tournament || !slot) {
      this.emiteSystemChat(session, 'cannot resolve the match configuration; enter the result manually');
      return;
    }

    const reported =
      this.ircScores.get(session.id) ?? new Map<string, { score: number; passed: boolean }>();
    const storedScores = this.ircScores.get(session.id);

    const members = tournament.teams.flatMap((team) => team.members);
    const nameToId = new Map<string, { userId: number; username: string }>();
    for (const member of members) {
      nameToId.set(normalizePlayerName(member.username), {
        userId: member.userId,
        username: member.username,
      });
    }
    const roomPlayers =
      session.matchPlayers.length > 0
        ? session.matchPlayers
        : (this.snapshots.get(session.id)?.players ?? []).map((player) => ({
            userId: player.userId,
            username: player.username,
            team: player.team,
          }));
    for (const player of roomPlayers) {
      if (!player.username) continue;
      const key = normalizePlayerName(player.username);
      if (!nameToId.has(key)) {
        nameToId.set(key, { userId: player.userId, username: player.username });
      }
    }
    for (const user of this.resolvedUsers.values()) {
      const key = normalizePlayerName(user.username);
      if (!nameToId.has(key)) nameToId.set(key, user);
    }

    // Bancho only reports names; resolve each name to an osu! user id before
    // matching teams, so the actual result path compares ids only.
    const scores: PlayerScore[] = [];
    for (const [name, entry] of reported.entries()) {
      let identity = nameToId.get(name);
      if (!identity) {
        try {
          const user = await this.server.osu.getUserByName(name);
          if (user.userId > 0) {
            identity = user;
            this.resolvedUsers.set(user.userId, user);
            this.resolvedNames.set(normalizePlayerName(user.username), user.userId);
            this.resolvedNames.set(name, user.userId);
            nameToId.set(name, user);
          }
        } catch (error) {
          this.diagnose('warn', 'chat', `could not resolve IRC user "${name}": ${errorMessage(error)}`);
        }
      }
      if (!identity) continue;
      scores.push({
        userId: identity.userId,
        username: identity.username,
        score: entry.score,
        accuracy: 0,
        maxCombo: 0,
        misses: 0,
        mods: [],
        passed: entry.passed,
      });
    }

    const beatmapId = slot.beatmapId ?? session.currentBeatmapId;
    if (!beatmapId) {
      this.emiteSystemChat(session, 'match finished but the beatmap is unknown; enter the result manually');
      return;
    }
    const teamByUser = this.memberTeamFor(session, tournament);
    const teamSize = (this.snapshots.get(session.id)?.matchType ?? session.matchType) === 'team_versus'
      ? tournament.teamSize
      : 1;
    const complete = hasCompleteTeamScores(
      scores,
      teamByUser,
      teamSize,
      session.teamOneId,
      session.teamTwoId,
    );

    try {
      let finalScores = scores;
      if (!complete) {
        const merged = await this.waitForMplinkScores(
          session,
          beatmapId,
          scores,
          teamByUser,
          teamSize,
        );
        if (merged) {
          finalScores = merged;
        } else if (scores.length === 0) {
          this.emiteSystemChat(session, 'no player scores were reported; enter the result manually');
          return;
        } else {
          this.emiteSystemChat(
            session,
            'mplink scores were not available in time; recording the IRC scores',
          );
        }
      }

      const recorded = await this.recordScores({
        sessionId: session.id,
        slotLabel,
        scores: finalScores,
        source: 'irc',
      });
      if (complete) {
        const result = recorded.results.at(-1);
        if (result) void this.correctIrcResultWithMplink(recorded.id, result.id);
      }
    } catch (error) {
      this.emiteSystemChat(session, `automatic IRC result failed: ${errorMessage(error)}`);
    } finally {
      if (storedScores && this.ircScores.get(session.id) === storedScores) {
        this.ircScores.delete(session.id);
      }
    }
  }

  /** Roster and room colours as user-id -> team-id, used for scoring and completeness. */
  private memberTeamFor(session: MatchSession, tournament: Tournament): Map<number, string> {
    const teamByUser = new Map<number, string>();
    for (const team of tournament.teams) {
      const teamId = String(team.id);
      for (const member of team.members) teamByUser.set(member.userId, teamId);
    }
    for (const player of session.matchPlayers) {
      if (teamByUser.has(player.userId)) continue;
      if (player.team === 'red') teamByUser.set(player.userId, session.teamOneId);
      else if (player.team === 'blue') teamByUser.set(player.userId, session.teamTwoId);
    }
    return teamByUser;
  }

  /** Roster ids, falling back to the room teams when no roster is stored. */
  private winByTeamMembers(
    session: MatchSession,
    tournament: Tournament,
    players: readonly { userId: number }[],
  ): [number[], number[]] {
    const teamByUser = this.memberTeamFor(session, tournament);
    const membersFor = (teamId: string, rosterId: string): number[] => {
      const roster = findTeam(tournament, rosterId)?.members.map((member) => member.userId) ?? [];
      if (roster.length > 0) return roster;
      return players
        .filter((player) => teamByUser.get(player.userId) === teamId)
        .map((player) => player.userId);
    };
    return [
      membersFor(session.teamOneId, session.teamOneId),
      membersFor(session.teamTwoId, session.teamTwoId),
    ];
  }

  /** Merges the latest mplink game with the IRC report for one beatmap. */
  private async mplinkScores(
    session: MatchSession,
    beatmapId: number,
    ircScores: readonly PlayerScore[],
    at = new Date().toISOString(),
  ): Promise<PlayerScore[] | null> {
    const roomId = Number(session.roomId);
    if (!Number.isInteger(roomId) || roomId <= 0) return null;
    const match = await this.server.osu.getMatch(roomId);
    const game: MplinkGame | null = selectLatestGame(mplinkGames(match), beatmapId, at);
    if (!game || game.scores.length === 0) return null;
    return mergeScores(ircScores, game.scores);
  }

  /**
   * IRC can drop players or report a stale score. Wait briefly for mplink so an
   * incomplete IRC report is completed before the result is recorded.
   */
  private async waitForMplinkScores(
    session: MatchSession,
    beatmapId: number,
    ircScores: readonly PlayerScore[],
    teamByUser: ReadonlyMap<number, string>,
    teamSize: number,
  ): Promise<PlayerScore[] | null> {
    const deadline = Date.now() + 120_000;
    let latest: PlayerScore[] | null = null;
    while (Date.now() < deadline) {
      try {
        const merged = await this.mplinkScores(session, beatmapId, ircScores);
        if (merged) {
          latest = merged;
          if (
            hasCompleteTeamScores(
              merged,
              teamByUser,
              teamSize,
              session.teamOneId,
              session.teamTwoId,
            )
          ) {
            return merged;
          }
        }
      } catch (error) {
        this.diagnose('warn', 'osu', `mplink lookup failed: ${errorMessage(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    return latest;
  }

  /** Formats a before/after score summary for the correction toast. */
  private scoreCorrectionMessage(before: BeatmapResult, after: BeatmapResult): string {
    const names = new Map<number, string>();
    for (const score of [...before.scores, ...after.scores]) {
      if (score.username) names.set(score.userId, score.username);
    }
    const oldById = new Map(before.scores.map((score) => [score.userId, score]));
    const newById = new Map(after.scores.map((score) => [score.userId, score]));
    const ids = [...new Set([...oldById.keys(), ...newById.keys()])];
    const lines: string[] = [];
    for (const id of ids) {
      const oldScore = oldById.get(id)?.score ?? 0;
      const newScore = newById.get(id)?.score ?? 0;
      const oldPassed = oldById.get(id)?.passed ?? false;
      const newPassed = newById.get(id)?.passed ?? false;
      if (oldScore === newScore && oldPassed === newPassed) continue;
      lines.push(
        `${names.get(id) ?? `#${id}`} - ${oldScore.toLocaleString('en-US')} --> ${newScore.toLocaleString('en-US')}`,
      );
    }
    return `${after.slotLabel} score has been corrected from MP link:\n${lines.join('\n')}`;
  }

  /** Replaces an IRC result with the merged IRC+mplink scores once mplink catches up. */
  private async correctIrcResultWithMplink(sessionId: string, resultId: string): Promise<void> {
    if (this.mplinkCorrections.has(resultId)) return;
    this.mplinkCorrections.add(resultId);
    try {
      const session = this.requireSession(sessionId);
      const result = session.results.find((entry) => entry.id === resultId);
      if (!result || result.source !== 'irc') return;
      const tournament = this.tournamentForSession(session);
      const match = tournament ? findMatch(tournament, session.matchId) : undefined;
      const stage = tournament && match ? findStageForMatch(tournament, match.id) : undefined;
      const slot = stage ? findSlotByLabel(stage, result.slotLabel) : undefined;
      if (!tournament || !stage || !slot) return;
      const winBy =
        session.winBy ?? winBySnapshot(this.winby.get(stage.winByRuleId) ?? BUILTIN_WIN_BY_RULE);
      const teamByUser = this.memberTeamFor(session, tournament);
      const teamSize =
        (this.snapshots.get(session.id)?.matchType ?? session.matchType) === 'team_versus'
          ? tournament.teamSize
          : 1;

      let merged: PlayerScore[] | null = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          merged = await this.mplinkScores(session, result.beatmapId, result.scores, result.recordedAt);
        } catch (error) {
          this.diagnose('warn', 'osu', `mplink correction lookup failed: ${errorMessage(error)}`);
        }
        if (
          merged &&
          scoresDiffer(result.scores, merged) &&
          hasCompleteTeamScores(
            merged,
            teamByUser,
            teamSize,
            session.teamOneId,
            session.teamTwoId,
          )
        ) {
          break;
        }
        merged = null;
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      if (!merged || !scoresDiffer(result.scores, merged)) return;

      const players = session.matchPlayers.length
        ? session.matchPlayers
        : (this.snapshots.get(session.id)?.players ?? []);
      const [teamOneMembers, teamTwoMembers] = this.winByTeamMembers(
        session,
        tournament,
        players,
      );
      const evaluation = evaluateWinBy({
        scores: merged,
        players,
        teamOneMembers,
        teamTwoMembers,
        teamSize,
        beatmapId: result.beatmapId,
        category: slot.category,
        sequence: Number(slotLabelSequence(result.slotLabel)) || 0,
        decide: (slots, map, teams) => runWinBy(winBy.source, slots, map, teams),
      });
      const corrected: BeatmapResult = {
        id: result.id,
        slotLabel: result.slotLabel,
        beatmapId: result.beatmapId,
        scores: merged,
        winner: evaluation.winner,
        teamValues: evaluation.teamValues,
        source: 'irc',
        recordedAt: result.recordedAt,
        winByRuleId: winBy.ruleId,
        needsReview: evaluation.needsReview,
      };
      if (!scoresDiffer(result.scores, corrected.scores)) return;

      const next = amendResult(session, result.id, corrected, new Date().toISOString());
      this.persistSession(next);
      this.appendEvent(
        next,
        'result_recorded',
        `${result.slotLabel}: corrected from mplink`,
        corrected,
      );
      this.emit({
        type: 'toast',
        kind: 'success',
        message: this.scoreCorrectionMessage(result, corrected),
      });
      if (evaluation.needsReview) {
        this.emiteSystemChat(
          next,
          `Result for ${result.slotLabel} needs review: ${evaluation.reviewReason ?? 'unknown reason'}`,
        );
      }
      if (next.status === 'finished') this.syncMatchResult(tournament, next);
      this.emit({ type: 'session_updated', session: next });
    } catch (error) {
      this.diagnose('warn', 'osu', `mplink correction failed: ${errorMessage(error)}`);
    }
  }

  private async handleMatchCompleted(
    kind: 'irc' | 'referee_hub',
    roomId: string,
    playlistItemId: string,
  ): Promise<void> {
    const session = this.findSessionByRoom(kind, roomId);
    if (!session) return;
    const tournament = this.tournamentForSession(session);
    if (!tournament) return;

    const snapshot = this.snapshots.get(session.id) ?? null;
    const match = findMatch(tournament, session.matchId);
    const pool = match ? findStageForMatch(tournament, match.id) : undefined;
    const completed = snapshot?.playlist.find((entry) => entry.id === playlistItemId);
    const completedBeatmapId =
      completed?.beatmapId ?? snapshot?.currentBeatmapId ?? session.currentBeatmapId;
    if (!completedBeatmapId) {
      this.emiteSystemChat(session, 'match completed but the beatmap is unknown; enter the result manually');
      return;
    }

    let slotLabel = session.currentSlotLabel;
    let slot = slotLabel && pool ? findSlotByLabel(pool, slotLabel) : undefined;
    // Referees may play straight from the room playlist without a pick; in that
    // case the completed item's beatmap identifies the mappool slot.
    if (!slot && pool) {
      slot = pool.slots.find((candidate) => candidate.beatmapId === completedBeatmapId);
    }
    if (slot) {
      slotLabel = slot.label;
    } else if (!slotLabel) {
      // Quick rooms / playlist maps outside the mappool still get a result.
      slotLabel = `#${completedBeatmapId}`;
    }

    if (slot && completed) {
      const beatmapMismatch = this.verifyPlaylistItem(
        session,
        tournament,
        snapshot,
        slotLabel,
        playlistItemId,
      );
      if (beatmapMismatch) {
        this.emiteSystemChat(session, beatmapMismatch);
        this.appendEvent(session, 'result_needs_review', beatmapMismatch);
        return;
      }
    }

    try {
      const scores = await this.fetchScoresWithRetry(roomId, playlistItemId);
      if (scores.scores.length === 0) {
        this.emiteSystemChat(session, 'no scores were returned yet; record the result manually or retry');
        return;
      }

      const players = snapshot?.players ?? [];
      const rosterMembers = tournament.teams.flatMap((team) => team.members);
      for (const score of scores.scores) {
        const name =
          score.username ??
          players.find((player) => player.userId === score.userId)?.username ??
          rosterMembers.find((member) => member.userId === score.userId)?.username ??
          this.userNameCache.get(score.userId) ??
          `#${score.userId}`;
        this.emiteSystemChat(
          session,
          `${name} finished playing (Score: ${score.score.toLocaleString('en-US')}, ${
            score.passed ? 'PASSED' : 'FAILED'
          }).`,
        );
      }

      await this.recordScores({
        sessionId: session.id,
        slotLabel,
        beatmapId: completedBeatmapId,
        scores: scores.scores,
        source: 'referee_hub',
      });
      if (!scores.complete) {
        this.emiteSystemChat(session, 'score pages were truncated; verify the result before continuing');
      }
    } catch (error) {
      this.emiteSystemChat(session, `automatic result failed: ${errorMessage(error)}`);
      this.appendEvent(session, 'result_needs_review', 'automatic result fetch failed', {
        error: errorMessage(error),
      });
    }
  }

  /**
   * Confirms that the completed playlist item is the beatmap the session is
   * waiting for. Returns a review message when it is not, otherwise null.
   */
  private verifyPlaylistItem(
    session: MatchSession,
    tournament: Tournament,
    snapshot: RoomSnapshot | null,
    slotLabel: string,
    playlistItemId: string,
  ): string | null {
    const match = findMatch(tournament, session.matchId);
    const pool = match ? findStageForMatch(tournament, match.id) : undefined;
    const slot = pool ? findSlotByLabel(pool, slotLabel) : undefined;
    if (!slot) {
      return `the completed beatmap does not belong to slot ${slotLabel}; verify the result manually`;
    }
    return checkCompletedBeatmap({
      playlistItemId,
      playlist: (snapshot?.playlist ?? []).map((entry) => ({
        id: entry.id,
        beatmapId: entry.beatmapId,
      })),
      slotBeatmapId: slot.beatmapId,
      currentBeatmapId: session.currentBeatmapId,
    });
  }

  private async fetchScoresWithRetry(
    roomId: string,
    playlistItemId: string,
  ): Promise<Awaited<ReturnType<HttpResultProvider['fetchScores']>>> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.resultsProvider().fetchScores(roomId, playlistItemId);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    throw lastError;
  }

  // --- helpers -------------------------------------------------------------

  private requireSession(sessionId: string): MatchSession {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error('session not found');
    return session;
  }

  private findSessionByRoom(
    kind: 'irc' | 'referee_hub',
    roomId: string,
  ): MatchSession | null {
    const sessions = this.store
      .listSessions()
      .filter((session) => session.transport === kind && session.roomId === roomId);
    return (
      sessions.find((session) => session.status === 'active' || session.status === 'finished') ??
      sessions.find((session) => session.status === 'closed' && session.matchKind === 'lobby') ??
      null
    );
  }

  private persistSession(session: MatchSession): void {
    this.store.saveSession(session);
  }

  private appendEvent(
    session: MatchSession,
    type: SessionEventType,
    summary: string,
    payload?: unknown,
    options: { id?: string; actorUserId?: number | null; category?: SessionEventCategory } = {},
  ): void {
    const event: SessionEvent = {
      id: options.id ?? randomUUID(),
      sessionId: session.id,
      at: new Date().toISOString(),
      type,
      category: options.category ?? sessionEventCategory(type),
      actorUserId:
        options.actorUserId === undefined
          ? this.serverUser?.userId ?? null
          : options.actorUserId,
      summary: summary.trim() || type,
      ...(payload === undefined ? {} : { payload }),
    };
    try {
      if (!session.chatOnly) this.store.upsertLobbyLogSession(toLobbyLogSession(session));
    } catch (error) {
      this.log('warn', 'lobby-log', `could not store lobby log metadata: ${errorMessage(error)}`);
    }
    try {
      this.store.appendEvent(event);
    } catch (error) {
      this.log('warn', 'lobby-log', `could not store lobby log entry: ${errorMessage(error)}`);
    }
    this.emit({ type: 'session_event', event });
  }

  private async recoverClosedLobbies(): Promise<void> {
    if (!this.hub) return;
    const sessions = this.store.listSessions();
    const active = sessions.filter((session) => session.status === 'active');
    const recovered = new Set<string>();
    for (const session of sessions) {
      if (
        session.status !== 'closed' ||
        session.matchKind !== 'lobby' ||
        session.transport !== 'referee_hub' ||
        session.roomId !== null
      ) {
        continue;
      }
      const log = this.store.getLobbyLogSession(session.id);
      if (!log?.roomId || recovered.has(log.roomId)) continue;
      const covered = active.some(
        (other) =>
          other.roomId === log.roomId ||
          (other.tournamentId === session.tournamentId && other.matchId === session.matchId),
      );
      if (covered) continue;
      try {
        const snapshot = await this.hub.joinRoom(log.roomId);
        recovered.add(log.roomId);
        const at = new Date().toISOString();
        const linked = linkRoom(session, log.roomId, snapshot.name, at);
        const reopened = reopenRoomSession(linked, at);
        this.persistSession(reopened);
        this.snapshots.set(reopened.id, sanitizeSnapshot(snapshot));
        this.appendEvent(reopened, 'room_joined', `recovered room ${log.roomId}`);
        void this.ensureChatChannel(reopened, snapshot);
        this.emit({ type: 'session_updated', session: reopened });
        this.emit({ type: 'room_snapshot', sessionId: reopened.id, snapshot: this.snapshots.get(reopened.id)! });
      } catch {
        // The room is gone; the session stays closed.
      }
    }
  }

  private async joinWebChatChannel(channelId: string, joinViaApi = true): Promise<boolean> {
    if (!this.webChat) return false;
    if (!joinViaApi) {
      // Referee Hub channels are lazer MULTIPLAYER channels (#lazermp_*).
      // osu!web's chat join endpoint rejects them by design
      // (OsuAuthorize::checkChatChannelJoin returns null for multiplayer and
      // team channels; membership is established by the room endpoint), and
      // the lazer client has already joined the channel.
      this.joinedChannels.add(channelId);
      this.refreshChatStatus();
      this.socket?.startChat();
      this.diagnose('info', 'chat', `using room channel ${channelId} without chat join`);
      return true;
    }
    try {
      await this.webChat.join(channelId);
      this.joinedChannels.add(channelId);
      this.webChatError = null;
      if (this.socket?.isOpen) this.webChatReady = true;
      this.refreshChatStatus();
      this.socket?.startChat();
      return true;
    } catch (error) {
      const detail = errorMessage(error);
      // The lazer client joins referee channels itself; osu!web rejects the
      // web join endpoint for these tournament channels with 403. History and
      // the notification socket still work, so this is not a connection error.
      if (/\(403\)/.test(detail)) {
        this.joinedChannels.add(channelId);
        this.webChatError = null;
        this.refreshChatStatus();
        this.diagnose('info', 'chat', `join ${channelId} skipped: ${detail}`);
        return true;
      }
      this.joinedChannels.delete(channelId);
      if (detail !== this.webChatError) {
        this.webChatError = detail;
        this.refreshChatStatus();
        this.diagnose('warn', 'chat', `could not join ${channelId}: ${detail}`);
      }
      return false;
    }
  }

  private async recoverWebChat(channelId: string, error: unknown): Promise<boolean> {
    const detail = errorMessage(error);
    if (!/\(403\)|没有权限/.test(detail)) return false;
    this.joinedChannels.delete(channelId);
    return this.joinWebChatChannel(channelId, false);
  }

  private async ensureChatChannel(session: MatchSession, snapshot?: RoomSnapshot): Promise<void> {
    const view = snapshot ?? this.snapshots.get(session.id);
    if (!view) return;
    const channelId =
      view.chatChannelId ?? (session.transport === 'irc' && session.roomId ? `#mp_${session.roomId}` : null);
    if (!channelId) return;
    this.channels.set(session.id, channelId);

    if (session.transport === 'irc') {
      this.joinedChannels.add(channelId);
      return;
    }
    if (session.transport === 'referee_hub') {
      if (this.joinedChannels.has(channelId) && !this.webChatError) {
        this.socket?.startChat();
        return;
      }
      await this.joinWebChatChannel(channelId, false);
      return;
    }
    if (!this.webChat || this.joinedChannels.has(channelId)) return;
    try {
      await this.webChat.join(channelId);
      this.joinedChannels.add(channelId);
      this.socket?.startChat();
    } catch (error) {
      this.diagnose('warn', 'chat', `could not join ${channelId}: ${errorMessage(error)}`);
    }
  }

  private chatTargetFor(session: MatchSession): ChatTarget {
    const channelId =
      this.channels.get(session.id) ??
      (session.transport === 'irc' && session.roomId ? `#mp_${session.roomId}` : null);
    if (!channelId) throw new Error('this session has no chat channel yet');

    const transport = session.transport === 'irc' ? this.ircChat : this.webChat;
    if (!transport) throw new Error('chat is not connected');
    return { transport, channelId };
  }

  private async preResolveUsers(sessionId: string, text: string): Promise<void> {
    const parsed = parseMpCommand(text);
    if (parsed.kind !== 'parsed') return;
    const command = parsed.command;
    let tokens: string[] = [];
    switch (command.verb) {
      case 'invite':
      case 'kick':
      case 'ban':
      case 'host':
      case 'move':
      case 'team':
        tokens = [command.user];
        break;
      case 'addref':
      case 'removeref':
        tokens = command.users;
        break;
      default:
        return;
    }

    const known = new Map(
      this.buildMpContext(sessionId).users.map((user) => [
        normalizePlayerName(user.username),
        user,
      ]),
    );
    for (const token of tokens) {
      const name = token.trim();
      if (!name || /^#\d+$/.test(name)) continue;
      const key = normalizePlayerName(name);
      if (this.resolvedNames.has(key)) continue;
      const existing = known.get(key);
      if (existing) {
        this.resolvedNames.set(key, existing.userId);
        continue;
      }
      try {
        const user = await this.server.osu.getUserByName(name);
        if (user.userId > 0) {
          this.resolvedUsers.set(user.userId, user);
          this.resolvedNames.set(normalizePlayerName(user.username), user.userId);
          this.resolvedNames.set(key, user.userId);
        }
      } catch (error) {
        this.diagnose('warn', 'chat', `could not resolve user "${name}": ${errorMessage(error)}`);
      }
    }
  }

  /** Fills in usernames the Referee Hub omits, using the roster or osu!web. */
  private async resolvePlayerNames(sessionId: string): Promise<void> {
    const session = this.store.getSession(sessionId);
    const snapshot = this.snapshots.get(sessionId);
    if (!session || !snapshot) return;

    const known = new Map<number, string>();
    const tournament = this.tournamentForSession(session);
    for (const team of tournament?.teams ?? []) {
      for (const member of team.members) known.set(member.userId, member.username);
    }

    let changed = false;
    for (const player of snapshot.players) {
      if (player.username) {
        this.userNameCache.set(player.userId, player.username);
        continue;
      }
      const name = this.userNameCache.get(player.userId) ?? known.get(player.userId);
      if (name) {
        player.username = name;
        this.userNameCache.set(player.userId, name);
        changed = true;
      }
    }

    const missing = snapshot.players.filter(
      (player) => !player.username && !this.pendingUserNames.has(player.userId),
    );
    if (missing.length === 0) {
      if (changed) this.emit({ type: 'room_snapshot', sessionId, snapshot });
      return;
    }

    for (const player of missing) {
      this.pendingUserNames.add(player.userId);
      try {
        const user = await this.server.lookupUser(player.userId);
        if (user.username) {
          this.userNameCache.set(player.userId, user.username);
          this.resolvedUsers.set(user.userId, user);
        }
      } catch (error) {
        this.log('warn', 'room', `could not resolve user #${player.userId}: ${errorMessage(error)}`);
      } finally {
        this.pendingUserNames.delete(player.userId);
      }
    }

    const current = this.snapshots.get(sessionId);
    if (!current) return;
    for (const player of current.players) {
      if (player.username) continue;
      const name = this.userNameCache.get(player.userId);
      if (name) {
        player.username = name;
        changed = true;
      }
    }
    if (changed) this.emit({ type: 'room_snapshot', sessionId, snapshot: current });
  }

  private buildMpContext(sessionId: string): MpContext {
    const session = this.requireSession(sessionId);
    const tournament = this.tournamentForSession(session);
    const snapshot = this.snapshots.get(sessionId) ?? null;
    const match = tournament ? findMatch(tournament, session.matchId) : undefined;
    const pool = tournament && match ? findStageForMatch(tournament, match.id) : undefined;

    const users = new Map<number, { userId: number; username: string }>();
    if (tournament) {
      for (const team of tournament.teams) {
        for (const member of team.members) {
          users.set(member.userId, { userId: member.userId, username: member.username });
        }
      }
      for (const userId of match?.refereeIds ?? []) {
        users.set(
          userId,
          this.resolvedUsers.get(userId) ?? {
            userId,
            username: this.userNameCache.get(userId) ?? `#${userId}`,
          },
        );
      }
    }
    if (this.serverUser) users.set(this.serverUser.userId, this.serverUser);
    for (const user of this.resolvedUsers.values()) users.set(user.userId, user);
    for (const player of snapshot?.players ?? []) {
      const username = player.username ?? this.userNameCache.get(player.userId);
      if (username) users.set(player.userId, { userId: player.userId, username });
    }

    return {
      room: snapshot,
      users: [...users.values()],
      self: this.serverUser,
      defaultRulesetId: tournament ? resolveTournamentRuleset(tournament.mode, pool?.slots ?? []) : 0,
      defaultBeatmapId: pool?.slots[0]?.beatmapId ?? null,
      defaultMatchType:
        match?.roomMode === 'head_to_head' || match?.roomMode === 'tag_coop'
          ? match.roomMode === 'tag_coop'
            ? 'team_versus'
            : 'head_to_head'
          : 'team_versus',
      defaultMaxParticipants: snapshot?.maxParticipants ?? 0,
      freemodPool: this.settings.get().freemodMods,
    };
  }

  private onChat(envelope: ChatEnvelope, source: 'irc' | 'referee_hub'): void {
    if (source === 'irc' && this.isSelfIrcMpCommand(envelope)) return;
    const sessionId = [...this.channels.entries()].find(([, channel]) => channel === envelope.channelId)?.[0];
    if (!sessionId && source === 'irc' && !/^#mp_\d+$/i.test(envelope.channelId)) {
      void this.ensureIrcChatSession(envelope.channelId, envelope.username).then((created) => {
        if (!created) return;
        const createdMessage = this.toChatMessage(envelope, created.id, source);
        this.appendChatLog(created, createdMessage);
        this.emit({ type: 'chat_message', message: createdMessage });
      });
      return;
    }
    const message = this.toChatMessage(envelope, sessionId ?? null, source);
    const session = sessionId ? this.store.getSession(sessionId) : null;
    if (session) this.appendChatLog(session, message);
    this.emit({ type: 'chat_message', message });
  }

  private isSelfIrcMpCommand(message: ChatEnvelope): boolean {
    if (!isMpCommand(message.text)) return false;
    const self = this.settings.get().ircUsername || this.serverUser?.username || '';
    return Boolean(self) && normalizePlayerName(message.username) === normalizePlayerName(self);
  }

  private async ensureIrcChatSession(channel: string, username: string): Promise<MatchSession | null> {
    const existing = this.store
      .listSessions()
      .find(
        (session) =>
          session.chatOnly && session.transport === 'irc' && session.roomId === channel,
      );
    if (existing) return existing;
    try {
      const snapshot = this.chatChannelSnapshot(channel, channel);
      const bestOf = 9;
      const tournament = buildQuickTournament({
        name: channel,
        beatmapId: null,
        rulesetId: 0,
        matchType: 'head_to_head',
        transport: 'irc',
        bestOf,
        referee: this.serverUser,
      });
      const stage = tournament.stages[0];
      const match = stage?.matches[0];
      const flow = stage?.flow;
      if (!match || !flow) return null;
      const linked = await this.registerRoom({
        tournament,
        match,
        flow,
        bestOf,
        bans: stage.bans,
        protects: stage.protects,
        kind: 'irc',
        snapshot,
        configSnapshot: tournament,
        firstTeamsSet: true,
        chatOnly: true,
      });
      this.appendEvent(linked, 'session_created', `joined IRC channel ${channel} (${username})`);
      return linked;
    } catch (error) {
      this.diagnose('warn', 'chat', `could not add IRC channel ${channel}: ${errorMessage(error)}`);
      return null;
    }
  }

  private chatChannelSnapshot(channel: string, name: string): RoomSnapshot {
    return {
      roomId: channel,
      name,
      password: null,
      chatChannelId: channel,
      matchType: 'head_to_head',
      winCondition: null,
      ruleset: null,
      mods: [],
      queueMode: 'host_only',
      maxParticipants: 0,
      locked: false,
      playlist: [],
      currentPlaylistItemId: null,
      currentBeatmapId: null,
      players: [],
      referees: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private toChatMessage(
    envelope: ChatEnvelope,
    sessionId: string | null,
    transport: 'irc' | 'referee_hub',
  ): ChatMessage {
    return {
      id: envelope.id,
      channelId: envelope.channelId,
      sessionId,
      userId: envelope.userId,
      username: envelope.username,
      text: envelope.text,
      at: envelope.at,
      self: envelope.self,
      system: envelope.system,
      action: envelope.action ?? false,
      source: transport === 'irc' ? 'irc' : 'web',
    };
  }

  private appendLocalChat(
    session: MatchSession,
    text: string,
    channelId: string,
    transport: 'irc' | 'referee_hub',
    recordInLobby = false,
  ): void {
    const message: ChatMessage = {
      id: `local:${randomUUID()}`,
      channelId,
      sessionId: session.id,
      userId: this.serverUser?.userId ?? null,
      username:
        transport === 'irc'
          ? this.settings.get().ircUsername || this.serverUser?.username || 'you'
          : this.serverUser?.username || 'you',
      text,
      at: new Date().toISOString(),
      self: true,
      system: false,
      action: false,
      source: transport === 'irc' ? 'irc' : 'web',
    };
    if (recordInLobby) this.appendChatLog(session, message);
    this.emit({ type: 'chat_message', message });
  }

  private appendChatLog(session: MatchSession, message: ChatMessage): void {
    if (message.self && !message.system) {
      // Bancho may or may not echo our own IRC line. Pair each server echo
      // with at most one optimistic local copy so repeated identical lines
      // are logged once per send.
      const key = `${session.id}\u0000${message.text}`;
      const at = Date.parse(message.at);
      const entry = this.recentSelfChat.get(key) ?? { local: [], remote: [] };
      const prune = (times: number[]) =>
        times.filter((time) => Math.abs(at - time) < 30_000);
      entry.local = prune(entry.local);
      entry.remote = prune(entry.remote);
      const isLocal = message.id.startsWith('local:');
      const pending = isLocal ? entry.remote : entry.local;
      let record = true;
      if (pending.length > 0) {
        pending.shift();
        record = false;
      } else {
        (isLocal ? entry.local : entry.remote).push(at);
      }
      if (entry.local.length === 0 && entry.remote.length === 0) {
        this.recentSelfChat.delete(key);
      } else {
        this.recentSelfChat.set(key, entry);
        if (this.recentSelfChat.size > 500) {
          const oldest = this.recentSelfChat.keys().next().value;
          if (oldest !== undefined) this.recentSelfChat.delete(oldest);
        }
      }
      if (!record) return;
    }
    const summary = `${message.username}: ${message.action ? '* ' : ''}${message.text}`;
    this.appendEvent(
      session,
      'chat_message',
      summary,
      {
        messageId: message.id,
        userId: message.userId,
        username: message.username,
        text: message.text,
        source: message.source,
        self: message.self,
        system: message.system,
        action: message.action,
      },
      {
        id: `chat:${session.id}:${message.id}`,
        actorUserId: message.userId && message.userId > 0 ? message.userId : null,
      },
    );
  }

  /**
   * BanchoBot announces room lifecycle lines (start, abort, finish, countdown,
   * room closed) in `#mp_<id>`. The Referee Hub has no bot, so only hub
   * sessions get the local copy instead of repeating what BanchoBot just said.
   */
  private emitLifecycleChat(session: MatchSession, text: string): void {
    if (session.transport === 'irc') return;
    this.emiteSystemChat(session, text);
  }

  private emiteSystemChat(session: MatchSession, text: string): void {
    const channelId = this.channels.get(session.id) ?? (session.roomId ? `#mp_${session.roomId}` : 'local');
    const message: ChatMessage = {
      id: randomUUID(),
      channelId,
      sessionId: session.id,
      userId: null,
      username: 'osmaRef',
      text,
      at: new Date().toISOString(),
      self: false,
      system: true,
      action: false,
      source: 'local',
    };
    this.emit({ type: 'chat_message', message });
  }

  private runAutomation(
    tournament: Tournament,
    session: MatchSession,
    trigger: AutomationTrigger,
    extra: Partial<TemplateContext> = {},
  ): void {
    const actions = automationActionsFor(tournament.automation, trigger);
    const webhooks =
      session.chatOnly && trigger === 'match_created'
        ? []
        : tournament.webhooks.filter((webhook) => webhook.triggers.includes(trigger));
    if (actions.length === 0 && webhooks.length === 0) return;

    // Chain per session so messages from consecutive triggers are sent in the
    // order the triggers happened, not in parallel.
    const previous = this.automationQueues.get(session.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        const context = this.automationContext(tournament, session, trigger, extra);
        const messages: string[] = [];
        for (const action of actions) {
          switch (action.type) {
            case 'chat': {
              const [message] = expandAutomationMessages([action.template], context);
              if (message) messages.push(message);
              break;
            }
          }
        }
        for (const message of messages) {
          const target = this.chatTargetFor(session);
          await target.transport.send(target.channelId, message);
          // IRC servers do not echo the sender's own PRIVMSG back, so show
          // the automatic line locally and record it in the room log.
          this.appendLocalChat(session, message, target.channelId, session.transport, true);
          this.log('info', 'automation', `sent ${trigger}: ${message}`);
        }
        const embeds = buildAutomationEmbeds({
          trigger,
          tournament,
          session,
          context,
          beatmap: this.beatmapForContext(tournament, session, context),
          refereeName: this.serverUser?.username ?? null,
        });
        await this.sendAutomationWebhooks(webhooks, embeds);
      } catch (error) {
        this.log('warn', 'automation', errorMessage(error));
      }
    });
    this.automationQueues.set(session.id, next);
    void next.then(
      () => {
        if (this.automationQueues.get(session.id) === next) {
          this.automationQueues.delete(session.id);
        }
      },
      () => {
        if (this.automationQueues.get(session.id) === next) {
          this.automationQueues.delete(session.id);
        }
      },
    );
  }

  private async sendAutomationWebhooks(
    webhooks: Webhook[],
    embeds: DiscordEmbed[],
  ): Promise<void> {
    if (webhooks.length === 0 || embeds.length === 0) return;
    const payload = payloadFromEmbeds(embeds, this.discordWebhookStyle());
    for (const webhook of webhooks) {
      switch (webhook.kind) {
        case 'discord': {
          const result = await sendDiscordWebhook(webhook.url, payload);
          if (!result.ok) {
            this.log(
              'warn',
              'automation',
              `discord webhook ${webhook.name} failed: ${result.status} ${result.error ?? ''}`.trim(),
            );
          }
          break;
        }
      }
    }
  }

  /** Presentation settings shared by every outgoing webhook. */
  private discordWebhookStyle(): DiscordWebhookStyle {
    const settings = this.settings.get();
    return {
      authorImage: settings.discordAuthorImage,
      authorName: settings.discordAuthorName,
      bottomImage: settings.discordBottomImage,
      footerIconUrl: settings.discordFooterIconUrl,
      footerText: settings.discordFooterText,
    };
  }

  /** Cached beatmap metadata for the map referenced by an automation context. */
  private beatmapForContext(
    tournament: Tournament,
    session: MatchSession,
    context: TemplateContext,
  ): BeatmapInfo | null {
    const id = Number(context.beatmap_id);
    const cached = Number.isInteger(id) && id > 0 ? this.beatmapCache.get(id) : undefined;
    if (cached) return cached;
    const stage = findStageForMatch(tournament, session.matchId);
    const slot = stage && context.slot ? findSlotByLabel(stage, context.slot) : undefined;
    return slot?.beatmap ? { ...slot.beatmap, mode: 'osu' } : null;
  }

  private automationContext(
    tournament: Tournament,
    session: MatchSession,
    trigger: AutomationTrigger,
    extra: Partial<TemplateContext>,
  ): TemplateContext {
    const lastResult = session.results.at(-1);
    const usesCurrentMap =
      trigger === 'beatmap_completed' ||
      trigger === 'match_finished';
    const extraBeatmapId = Number(extra.beatmap_id);
    const beatmapId =
      Number.isInteger(extraBeatmapId) && extraBeatmapId > 0
        ? extraBeatmapId
        : session.currentBeatmapId ?? (usesCurrentMap ? lastResult?.beatmapId ?? null : null);
    const info = beatmapId ? this.beatmapCache.get(beatmapId) : undefined;
    const mapScores = usesCurrentMap ? this.mapScores(session, lastResult) : null;
    return buildTemplateContext(
      tournament,
      session,
      findTeam(tournament, session.teamOneId)?.name ?? 'Team 1',
      findTeam(tournament, session.teamTwoId)?.name ?? 'Team 2',
      {
        ...extra,
        beatmap: info ? `${info.title} - [${info.difficultyName}]` : '',
        beatmap_id: beatmapId ? String(beatmapId) : '',
        mapscore_red: mapScores?.red ?? 0,
        mapscore_blue: mapScores?.blue ?? 0,
      },
    );
  }

  /** Raw total score of each room team on one recorded map. */
  private mapScores(
    session: MatchSession,
    result: MatchSession['results'][number] | undefined,
  ): { red: number; blue: number } | null {
    if (!result) return null;
    const teamByUser = new Map<number, 'red' | 'blue'>();
    for (const player of session.matchPlayers) {
      if (player.team) teamByUser.set(player.userId, player.team);
    }
    if (teamByUser.size > 0 && result.scores.length > 0) {
      let red = 0;
      let blue = 0;
      for (const score of result.scores) {
        const team = teamByUser.get(score.userId);
        if (team === 'red') red += score.score;
        else if (team === 'blue') blue += score.score;
      }
      return { red, blue };
    }
    return {
      red: result.teamValues.team_one ?? 0,
      blue: result.teamValues.team_two ?? 0,
    };
  }

  private emitNotice(level: 'info' | 'warn' | 'error', message: string): void {
    this.log(level, 'notify', message);
  }

  private startChatPolling(): void {
    if (this.chatPollTimer) return;
    this.chatPollTimer = setInterval(() => void this.pollWebChat(), 4_000);
    this.chatPollTimer.unref?.();
    void this.pollWebChat();
  }

  private stopChatPolling(): void {
    if (this.chatPollTimer) {
      clearInterval(this.chatPollTimer);
      this.chatPollTimer = null;
    }
  }

  /**
   * Fallback for the osu!web notification socket. Sending uses HTTP anyway, so
   * polling channel history keeps incoming messages visible even when the
   * websocket is unavailable or misses events.
   */
  private async pollWebChat(): Promise<void> {
    if (this.chatPolling || !this.webChat) return;
    this.chatPolling = true;
    try {
      const sessions = this.store
        .listSessions()
        .filter(
          (session) =>
            (session.status === 'active' || session.status === 'finished') &&
            session.transport === 'referee_hub' &&
            this.channels.has(session.id),
        );
      for (const session of sessions) {
        const channelId = this.channels.get(session.id);
        if (!channelId) continue;
        let messages;
        try {
          messages = await this.webChat.history(channelId, 20);
        } catch (error) {
          // Re-join once; a stale channel association also breaks history reads.
          // Referee Hub channels are lazer room channels and are joined by the
          // room endpoint, so the chat join API must not be called here.
          const rejoined = await this.joinWebChatChannel(channelId, false);
          if (!rejoined) throw error;
          messages = await this.webChat.history(channelId, 20);
        }
        for (const message of messages) {
          if (this.webChatSeen.has(message.id)) continue;
          this.webChatSeen.add(message.id);
          if (this.webChatSeen.size > 5000) {
            const first = this.webChatSeen.values().next().value;
            if (first) this.webChatSeen.delete(first);
          }
          this.onChat(message, 'referee_hub');
        }
      }
      this.webChatPollError = null;
    } catch (error) {
      const detail = errorMessage(error);
      if (detail !== this.webChatPollError) {
        this.webChatPollError = detail;
        this.diagnose('warn', 'chat', `history polling failed: ${detail}`);
      }
    } finally {
      this.chatPolling = false;
    }
  }

  /**
   * The `chat` connection describes the osu!web chat API only. Bancho IRC chat
   * is part of the `irc` connection; the UI picks the matching one per session.
   */
  private refreshChatStatus(): void {
    if (this.chatReconnectTimer) {
      this.setStatus('chat', 'reconnecting', this.webChatError ?? 'waiting to reconnect');
    } else if (this.webChatError) {
      this.setStatus('chat', 'error', this.webChatError);
    } else if (this.webChatReady) {
      this.setStatus('chat', 'connected', 'osu!web');
    } else {
      this.setStatus('chat', 'disconnected', null);
    }
  }

  private setStatus(kind: ConnectionKind, status: ConnectionState['status'], detail: string | null): void {
    const previous = this.statuses.get(kind);
    const changed = !previous || previous.status !== status || previous.detail !== detail;
    this.statuses.set(kind, {
      kind,
      status,
      detail,
      updatedAt: new Date().toISOString(),
    });
    if (changed) {
      const level: LogLevel =
        status === 'error' ? 'error' : status === 'reconnecting' ? 'warn' : 'info';
      this.diagnose(level, kind, detail ? `${status}: ${detail}` : status);
    }
    this.emitState();
  }

  private emitState(): void {
    this.emit({ type: 'app_state', state: this.getAppState() });
  }

  private log(level: LogLevel, scope: string, message: string): void {
    this.logger.runtime(level, scope, message);
  }

  private diagnose(level: LogLevel, scope: string, message: string): void {
    this.logger.diagnostic(level, scope, message);
  }
}

function formatSnapshot(snapshot: RoomSnapshot | null, _tournament: Tournament | null): string {
  if (!snapshot) return 'No room snapshot is available yet.';
  const players = snapshot.players
    .map((player) => `${player.username ?? `#${player.userId}`}${player.team ? ` (${player.team})` : ''}`)
    .join(', ');
  return [
    `Room: ${snapshot.name} (#${snapshot.roomId})`,
    `Type: ${snapshot.matchType}${snapshot.locked ? ', locked' : ''}`,
    `Size: ${snapshot.maxParticipants === 0 ? 'unlimited' : snapshot.maxParticipants}`,
    `Beatmap: ${snapshot.currentBeatmapId ?? 'none'}`,
    `Players: ${players || 'none'}`,
    `Referees: ${snapshot.referees.length > 0 ? snapshot.referees.map((id) => `#${id}`).join(', ') : 'none'}`,
  ].join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Room passwords are only meaningful to the transport. Never persist or send
 * them to the renderer/audit log.
 */
export function sanitizeSnapshot(snapshot: RoomSnapshot): RoomSnapshot {
  const clone = structuredClone(snapshot);
  clone.password = null;
  return clone;
}

function normalizePlayerName(value: string): string {
  return value.replace(/_/g, ' ').trim().toLowerCase();
}