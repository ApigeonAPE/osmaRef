import { randomUUID } from 'node:crypto';
import {
  findMatch,
  findRound,
  findScoring,
  findSlotByLabel,
  findTeam,
  renderRoomName,
  type AppState,
  type BeatmapInfo,
  type ChatMessage,
  type ConnectionKind,
  type ConnectionState,
  type DesktopEvent,
  type LogLevel,
  type Match,
  type MatchFlow,
  type MatchSession,
  type MpCommandResult,
  type RoomSnapshot,
  type SessionEvent,
  type SessionEventCategory,
  type SessionEventType,
  type Tournament,
  sessionEventCategory,
  toLobbyLogSession,
} from '@osmaref/contracts';
import {
  adjustWins,
  applyAction as applySessionAction,
  buildQuickTournament,
  buildTemplateContext,
  captureMatchPlayers,
  checkCompletedBeatmap,
  closeRoomSession,
  createSession,
  diffRoomSnapshots,
  evaluateBeatmap,
  expandAutomationMessages,
  linkRoom,
  normalizeBestOf,
  recordResult as recordSessionResult,
  selectAutomationRules,
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
  type ChatEnvelope,
  type ChatTransport,
  type MatchTransport,
  type MpContext,
  type TransportEvent,
} from '@osmaref/adapters';
import type { AppStore } from './store';
import type { ServerClient } from './server-client';
import type { SettingsStore } from './settings';
import type { AppLogger } from './logger';

export interface ConnectionManagerDeps {
  store: AppStore;
  settings: SettingsStore;
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
  private chatPollTimer: NodeJS.Timeout | null = null;
  private chatPolling = false;
  private webChatPollError: string | null = null;
  private readonly webChatSeen = new Set<string>();
  /** Debounces local chat echoes against the transport's own echo of the same line. */
  private readonly recentSelfChat = new Map<string, number>();
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

  private activeSessionId: string | null = null;
  private serverUser: { userId: number; username: string } | null = null;
  private autoConnectAttempted = false;
  /** Per-session scores reported by Bancho for the current map. */
  private readonly ircScores = new Map<
    string,
    Map<string, { score: number; passed: boolean }>
  >();
  private readonly beatmapCache = new Map<number, BeatmapInfo>();

  constructor(deps: ConnectionManagerDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
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
        .filter((session) => session.roomId !== null)
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

  async lookupBeatmaps(ids: number[]): Promise<BeatmapInfo[]> {
    const unique = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
    const missing = unique.filter((id) => !this.beatmapCache.has(id));
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
            });
          } catch (error) {
            this.diagnose('warn', 'osu', `could not load beatmap ${id}: ${errorMessage(error)}`);
          }
        }),
      );
    }
    return unique
      .map((id) => this.beatmapCache.get(id))
      .filter((info): info is BeatmapInfo => info !== undefined);
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
        this.settings.setIrcPassword(input.password);
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
      channels: (input.channels ?? settings.ircDefaultChannels).map((channel) =>
        channel.startsWith('#') ? channel : `#${channel}`,
      ),
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

  private async chatWebsocketUrl(): Promise<string> {
    const configured = this.settings.get().chatWebsocketUrl;
    if (/^wss?:\/\//i.test(configured) && configured !== 'wss://osu.ppy.sh/websocket') {
      return configured;
    }
    // `/notifications` requires the lazer-only `*` scope; the public notification
    // host accepts normal OAuth scopes (chat.read).
    return 'wss://notify.ppy.sh';
  }

  async connectHub(): Promise<AppState> {
    if (this.hub && this.statuses.get('referee_hub')?.status === 'connected') {
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
          const session = this.findSessionByRoom(snapshot.roomId);
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

    try {
      await hub.connect();
    } catch (error) {
      this.setStatus('referee_hub', 'error', errorMessage(error));
      throw error;
    }
    this.hub = hub;
    this.setStatus('referee_hub', 'connected', this.settings.get().hubBaseUrl);

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

    try {
      const socket = new OsuChatSocket({
        url: await this.chatWebsocketUrl(),
        getAccessToken: () => this.server.accessToken(),
        onMessage: (payload) => this.webChat?.ingest(payload),
        onStatus: (socketStatus, detail) => {
          if (this.socket !== socket) return;
          this.webChatReady = socketStatus === 'open';
          if (socketStatus === 'open') {
            this.webChatError = null;
          } else if (socketStatus === 'closed' || socketStatus === 'error') {
            this.webChatError = detail ?? socketStatus;
          }
          this.refreshChatStatus();
        },
        onKeepalive: () => this.server.osu.chatKeepalive(),
      });
      this.socket = socket;
      await socket.connect();
      this.webChatReady = true;
      this.webChatError = null;
      this.refreshChatStatus();
    } catch (error) {
      this.webChatReady = false;
      this.webChatError = errorMessage(error);
      this.refreshChatStatus();
    }

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

  async openRoom(input: {
    tournamentId: string;
    matchId: string;
    transport?: 'irc' | 'referee_hub';
  }): Promise<MatchSession> {
    const tournament = this.store.getTournament(input.tournamentId);
    if (!tournament) throw new Error('tournament not found');
    const match = findMatch(tournament, input.matchId);
    if (!match) throw new Error('match not found');
    const round = findRound(tournament, match.roundId);
    if (!round) throw new Error('round not found');
    const flow = round.flow;

    const kind = input.transport ?? match.transport;
    const transport = kind === 'irc' ? this.irc : this.hub;
    if (!transport) {
      throw new Error(
        kind === 'irc' ? 'connect to Bancho IRC first' : 'connect to the Referee Hub first',
      );
    }

    const beatmapId = match.initialBeatmapId ?? round.slots[0]?.beatmapId ?? null;
    if (!beatmapId && kind === 'referee_hub') {
      throw new Error('the Referee Hub requires an initial beatmap; add one to the mappool');
    }

    const teamOne = findTeam(tournament, match.teamOneId);
    const teamTwo = findTeam(tournament, match.teamTwoId);
    const name = renderRoomName(match.roomNameTemplate, {
      tournament: tournament.name,
      stage: round.name,
      team_one: teamOne?.name ?? 'Team 1',
      team_two: teamTwo?.name ?? 'Team 2',
    });
    // A tournament may list more than two teams (brackets do); the room is
    // sized for the two teams playing this match, not for the whole bracket.
    const roster = (teamOne?.members.length ?? 0) + (teamTwo?.members.length ?? 0);
    const maxParticipants = roster === 0 ? 0 : Math.min(16, Math.max(2, roster));

    const snapshot = await transport.createRoom({
      name,
      rulesetId: tournament.rulesetId,
      ...(beatmapId ? { beatmapId } : {}),
      matchType: tournament.defaultMatchType,
      maxParticipants,
    });

    const now = new Date().toISOString();
    return this.registerRoom({
      tournament,
      match,
      flow,
      bestOf: round.bestOf,
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
    const match = tournament.matches[0];
    const flow = tournament.rounds[0]?.flow;
    if (!match || !flow) throw new Error('failed to build the quick room configuration');

    const requested = Math.round(input.maxParticipants);
    const maxParticipants = requested <= 0 ? 0 : Math.min(16, Math.max(2, requested));

    const snapshot = await transport.createRoom({
      name,
      rulesetId: input.rulesetId,
      ...(beatmapId ? { beatmapId } : {}),
      matchType: input.matchType,
      maxParticipants,
    });

    return this.registerRoom({
      tournament,
      match,
      flow,
      bestOf,
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
          session.status === 'active' &&
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
    const activeItem =
      snapshot.playlist.find((item) => item.id === snapshot.currentPlaylistItemId) ??
      snapshot.playlist.find((item) => !item.wasPlayed) ??
      snapshot.playlist[0];
    const bestOf = 9;
    const tournament = buildQuickTournament({
      name: snapshot.name,
      beatmapId: snapshot.currentBeatmapId ?? activeItem?.beatmapId ?? null,
      rulesetId: activeItem?.rulesetId ?? 0,
      matchType: snapshot.matchType,
      transport: kind,
      bestOf,
      referee: this.serverUser,
    });
    const match = tournament.matches[0];
    const flow = tournament.rounds[0]?.flow;
    if (!match || !flow) throw new Error('failed to prepare the joined room');
    return this.registerRoom({
      tournament,
      match,
      flow,
      bestOf,
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
    kind: 'irc' | 'referee_hub';
    snapshot: RoomSnapshot;
    configSnapshot: Tournament | null;
    firstTeamsSet?: boolean;
    chatOnly?: boolean;
  }): Promise<MatchSession> {
    const now = new Date().toISOString();
    const session = createSession(
      {
        id: `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        tournamentId: params.tournament.id,
        matchId: params.match.id,
        matchName: params.match.name,
        teamOneId: params.match.teamOneId,
        teamTwoId: params.match.teamTwoId,
        tournamentRevision: params.tournament.revision,
        rulesetId: params.tournament.rulesetId,
        matchType: params.tournament.defaultMatchType,
        transport: params.kind,
        bestOf: params.bestOf,
        configSnapshot: params.configSnapshot,
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
        await transport.closeRoom(session.roomId);
      } catch (error) {
        this.log('warn', 'room', `could not close room: ${errorMessage(error)}`);
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
    if (session.status !== 'active') throw new Error('the room is no longer active');
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
    if (session.status !== 'active') throw new Error('the room is no longer active');
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

  async addPlaylistBeatmap(input: {
    sessionId: string;
    beatmapId: number;
    rulesetId: number;
  }): Promise<void> {
    const session = this.requireSession(input.sessionId);
    if (session.transport !== 'referee_hub' || !session.roomId) {
      throw new Error('playlist editing is only available through the Referee Hub');
    }
    if (!this.hub) throw new Error('connect to the Referee Hub first');
    const beatmap = await this.server.osu.getBeatmap(input.beatmapId);
    const rulesetId = resolvePlaylistRuleset(beatmap.mode, input.rulesetId);
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
    if (session.status === 'active') {
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
    const pool = match ? findRound(tournament, match.roundId) : undefined;
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
          rulesetId: slot.rulesetId,
          requiredMods: slot.requiredMods,
          allowedMods: slot.allowedMods,
          freestyle: slot.freestyle,
        });
      } catch (error) {
        this.emitNotice('warn', `room did not accept the beatmap: ${errorMessage(error)}`);
      }
    }

    this.runAutomation(tournament, next, 'action_applied');
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
    const scoring = match ? findScoring(tournament, match.scoringId) : undefined;
    if (!scoring) throw new Error('scoring scheme not found');
    const pool = match ? findRound(tournament, match.roundId) : undefined;
    const slot = pool ? findSlotByLabel(pool, input.slotLabel) : undefined;
    const beatmapId = slot?.beatmapId ?? input.beatmapId ?? session.currentBeatmapId;
    if (!beatmapId) {
      throw new Error(`unknown mappool slot "${input.slotLabel}" and no beatmap id supplied`);
    }

    const snapshot = this.snapshots.get(session.id) ?? null;
    const isTeamVersus = (snapshot?.matchType ?? session.matchType) === 'team_versus';
    const rosterById = new Map<number, string>();
    for (const team of tournament.teams) {
      for (const member of team.members) rosterById.set(member.userId, team.id);
    }

    const roomTeamById = new Map<number, 'red' | 'blue'>();
    const addRoomPlayer = (player: {
      userId: number;
      username?: string;
      team: 'red' | 'blue' | null;
    }) => {
      if (player.team) roomTeamById.set(player.userId, player.team);
    };
    session.matchPlayers.forEach(addRoomPlayer);
    if (session.matchPlayers.length === 0) {
      (snapshot?.players ?? []).forEach(addRoomPlayer);
    }

    const memberTeam = new Map<number, string>(rosterById);
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
        if (isTeamVersus) {
          // Hub/IRC scores carry user ids; only fall back to the red/blue teams
          // captured at map start when the roster has no matching entry.
          let teamId = rosterById.get(score.userId);
          if (!teamId) {
            const color = roomTeamById.get(score.userId);
            if (color === 'red') teamId = session.teamOneId;
            else if (color === 'blue') teamId = session.teamTwoId;
          }
          if (teamId) memberTeam.set(score.userId, teamId);
        }
        return { ...score, username };
      });

    const evaluation = evaluateBeatmap({
      slotLabel: input.slotLabel,
      beatmapId,
      scores,
      teamOneId: session.teamOneId,
      teamTwoId: session.teamTwoId,
      memberTeam,
      scheme: scoring,
      winCondition: slot?.winCondition,
      winner: slot?.winConditionWinner,
      recordedAt: new Date().toISOString(),
      source: input.source,
    });

    const next = recordSessionResult(session, evaluation.result);
    this.persistSession(next);
    this.appendEvent(
      next,
      evaluation.needsReview ? 'result_needs_review' : 'result_recorded',
      `${input.slotLabel}: ${evaluation.result.winner ?? 'needs review'}`,
      evaluation.result,
    );
    if (evaluation.needsReview) {
      this.emiteSystemChat(next, `Result for ${input.slotLabel} needs review: ${evaluation.reviewReason}`);
    }

    this.runAutomation(tournament, next, 'beatmap_completed', {
      winner: evaluation.result.winner ?? '',
      slot: input.slotLabel,
    });
    if (next.status === 'finished') {
      this.runAutomation(tournament, next, 'match_finished');
    }

    this.emit({ type: 'session_updated', session: next });
    return next;
  }

  async undo(sessionId: string): Promise<MatchSession> {
    const session = this.requireSession(sessionId);
    const next = undoLast(session, new Date().toISOString());
    this.persistSession(next);
    this.appendEvent(next, 'manual_adjustment', 'undo of the last action');
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

    const outcome = await dispatcher.submit(text);
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
      const closed = closeRoomSession(session, new Date().toISOString());
      this.persistSession(closed);
      this.snapshots.delete(session.id);
      this.channels.delete(session.id);
      if (this.activeSessionId === session.id) this.activeSessionId = null;
      this.appendEvent(closed, 'room_left', 'room closed by !mp close');
      this.emit({ type: 'session_updated', session: closed });
      session = closed;
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
   * Re-joins rooms that were active before the app restarted.
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
          session.status === 'active' &&
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
        this.emiteSystemChat(session, `could not rejoin room ${roomId}: ${errorMessage(error)}`);
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

  private onTransportEvent(kind: 'irc' | 'referee_hub', event: TransportEvent): void {
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
        const session = this.findSessionByRoom(event.snapshot.roomId);
        if (!session) return;
        const previous = this.snapshots.get(session.id) ?? null;
        const snapshot = sanitizeSnapshot(event.snapshot);
        let current = session;
        if (session.roomId && snapshot.name && snapshot.name !== session.roomName) {
          current = linkRoom(session, session.roomId, snapshot.name, new Date().toISOString());
          this.persistSession(current);
          this.emit({ type: 'session_updated', session: current });
        }
        for (const change of diffRoomSnapshots(previous, snapshot)) {
          this.appendEvent(current, change.type, change.summary, change.payload);
        }
        this.store.upsertLobbyLogSession(toLobbyLogSession(current));
        this.snapshots.set(current.id, snapshot);
        void this.ensureChatChannel(current, snapshot);
        this.emit({ type: 'room_snapshot', sessionId: current.id, snapshot });
        void this.resolvePlayerNames(current.id);
        return;
      }
      case 'room_closed': {
        const session = this.findSessionByRoom(event.roomId);
        if (!session) return;
        const closed = closeRoomSession(session, new Date().toISOString());
        this.persistSession(closed);
        this.snapshots.delete(session.id);
        this.channels.delete(session.id);
        this.ircScores.delete(session.id);
        if (this.activeSessionId === session.id) this.activeSessionId = null;
        this.appendEvent(closed, 'room_left', 'room was closed');
        this.emiteSystemChat(closed, 'the room was closed');
        this.log('info', 'room', `room ${event.roomId} was closed`);
        this.emit({ type: 'session_updated', session: closed });
        this.emitState();
        return;
      }
      case 'match_started': {
        let session = this.findSessionByRoom(event.roomId);
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
        this.emiteSystemChat(session, 'match started');
        const tournament = this.tournamentForSession(session);
        if (tournament) this.runAutomation(tournament, session, 'beatmap_started');
        return;
      }
      case 'player_finished': {
        const session = this.findSessionByRoom(event.roomId);
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
        const session = this.findSessionByRoom(event.roomId);
        if (!session) return;
        this.appendEvent(session, 'match_finished', 'match finished');
        this.emiteSystemChat(session, 'match finished');
        void this.handleIrcMatchFinished(session);
        return;
      }
      case 'match_aborted': {
        const session = this.findSessionByRoom(event.roomId);
        if (session) {
          this.appendEvent(session, 'match_aborted', 'match aborted');
          this.emiteSystemChat(session, 'match aborted');
        }
        return;
      }
      case 'match_completed': {
        const session = this.findSessionByRoom(event.roomId);
        if (session) {
          this.appendEvent(
            session,
            'match_completed',
            `match completed (playlist item ${event.playlistItemId})`,
            { playlistItemId: event.playlistItemId },
          );
        }
        void this.handleMatchCompleted(event.roomId, event.playlistItemId);
        return;
      }
      case 'countdown': {
        const session = this.findSessionByRoom(event.roomId);
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
          this.emiteSystemChat(session, `${event.kind === 'timer' ? 'timer' : 'match start'} countdown: ${event.seconds}s`);
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
   * IRC only reports each player's total score, so automatic recording is
   * limited to score-based win conditions. Anything else is left to the referee.
   */
  private async handleIrcMatchFinished(session: MatchSession): Promise<void> {
    const slotLabel = session.currentSlotLabel;
    if (!slotLabel) {
      this.emiteSystemChat(session, 'match finished but no pick is active; enter the result manually');
      return;
    }
    const tournament = this.tournamentForSession(session);
    const match = tournament ? findMatch(tournament, session.matchId) : undefined;
    const scoring = tournament && match ? findScoring(tournament, match.scoringId) : undefined;
    const pool = tournament && match ? findRound(tournament, match.roundId) : undefined;
    const slot = pool ? findSlotByLabel(pool, slotLabel) : undefined;
    if (!tournament || !scoring || !slot) {
      this.emiteSystemChat(session, 'cannot resolve the match configuration; enter the result manually');
      return;
    }

    const condition = slot.winCondition ?? scoring.winCondition;
    if (condition !== 'score' && condition !== 'score_v2') {
      this.emiteSystemChat(
        session,
        `IRC only reports scores, so "${condition}" cannot be recorded automatically`,
      );
      return;
    }

    const reported = this.ircScores.get(session.id);
    if (!reported || reported.size === 0) {
      this.emiteSystemChat(session, 'no player scores were reported; enter the result manually');
      return;
    }

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
    const scores: {
      userId: number;
      username: string;
      score: number;
      accuracy: number;
      maxCombo: number;
      misses: number;
      mods: string[];
      passed: boolean;
    }[] = [];
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

    try {
      await this.recordScores({
        sessionId: session.id,
        slotLabel,
        scores,
        source: 'irc',
      });
    } catch (error) {
      this.emiteSystemChat(session, `automatic IRC result failed: ${errorMessage(error)}`);
    } finally {
      this.ircScores.delete(session.id);
    }
  }

  private async handleMatchCompleted(roomId: string, playlistItemId: string): Promise<void> {
    const session = this.findSessionByRoom(roomId);
    if (!session) return;
    const tournament = this.tournamentForSession(session);
    if (!tournament) return;

    const snapshot = this.snapshots.get(session.id) ?? null;
    const match = findMatch(tournament, session.matchId);
    const pool = match ? findRound(tournament, match.roundId) : undefined;
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
    const pool = match ? findRound(tournament, match.roundId) : undefined;
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

  private findSessionByRoom(roomId: string): MatchSession | null {
    const sessions = this.store
      .listSessions()
      .filter((session) => session.roomId === roomId);
    return sessions.find((session) => session.status === 'active') ?? sessions[0] ?? null;
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
      this.store.upsertLobbyLogSession(toLobbyLogSession(session));
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
    // Referee Hub may or may not allow this account to join the multiplayer
    // channel; try silently so live chat still works when membership exists.
    if (session.transport === 'referee_hub') {
      try {
        await this.webChat?.join(channelId);
        this.joinedChannels.add(channelId);
      } catch {
        // Live-only mode: history stays empty and the WebSocket may still deliver.
      }
      this.socket?.startChat();
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
    const pool = tournament && match ? findRound(tournament, match.roundId) : undefined;

    const users = new Map<number, { userId: number; username: string }>();
    if (tournament) {
      for (const team of tournament.teams) {
        for (const member of team.members) {
          users.set(member.userId, { userId: member.userId, username: member.username });
        }
      }
      for (const referee of tournament.referees) {
        users.set(referee.userId, { userId: referee.userId, username: referee.username });
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
      defaultRulesetId: tournament?.rulesetId ?? 0,
      defaultBeatmapId: match?.initialBeatmapId ?? pool?.slots[0]?.beatmapId ?? null,
      defaultMatchType: tournament?.defaultMatchType ?? 'team_versus',
      defaultMaxParticipants: snapshot?.maxParticipants ?? 0,
      freemodPool: [...this.settings.get().freemodMods],
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
      const match = tournament.matches[0];
      const flow = tournament.rounds[0]?.flow;
      if (!match || !flow) return null;
      const linked = await this.registerRoom({
        tournament,
        match,
        flow,
        bestOf,
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
      // Bancho may or may not echo our own IRC line; the optimistic local
      // echo and the transport copy must produce one lobby-log entry.
      const key = `${session.id}\u0000${message.text}`;
      const at = Date.parse(message.at);
      const previous = this.recentSelfChat.get(key);
      if (previous !== undefined && Math.abs(at - previous) < 30_000) return;
      this.recentSelfChat.set(key, at);
      if (this.recentSelfChat.size > 500) {
        const oldest = this.recentSelfChat.keys().next().value;
        if (oldest !== undefined) this.recentSelfChat.delete(oldest);
      }
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
    trigger: Parameters<typeof selectAutomationRules>[1],
    extra: Record<string, string> = {},
  ): void {
    if (tournament.automation.length === 0) return;
    const rules = selectAutomationRules(tournament.automation, trigger, session.currentSlotLabel);
    if (rules.length === 0) return;
    const context = buildTemplateContext(
      tournament,
      session,
      findTeam(tournament, session.teamOneId)?.name ?? 'Team 1',
      findTeam(tournament, session.teamTwoId)?.name ?? 'Team 2',
      extra,
    );
    for (const message of expandAutomationMessages(rules, context)) {
      const target = this.chatTargetFor(session);
      void target.transport.send(target.channelId, message).catch((error: unknown) => {
        this.log('warn', 'automation', errorMessage(error));
      });
    }
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
            session.status === 'active' &&
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
          this.joinedChannels.delete(channelId);
          await this.webChat.join(channelId);
          this.joinedChannels.add(channelId);
          this.socket?.startChat();
          messages = await this.webChat.history(channelId, 20);
          void error;
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
    if (this.webChatReady) {
      this.setStatus('chat', 'connected', 'osu!web');
    } else if (this.webChatError) {
      this.setStatus('chat', 'error', this.webChatError);
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
  return snapshot.password === null ? snapshot : { ...snapshot, password: null };
}

function normalizePlayerName(value: string): string {
  return value.replace(/_/g, ' ').trim().toLowerCase();
}