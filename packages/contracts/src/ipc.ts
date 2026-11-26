import { z } from 'zod';
import { TournamentSchema, type Tournament } from './tournament';
import {
  MatchSessionSchema,
  SessionEventSchema,
  type LobbyLogSummary,
  type MatchSession,
  type SessionEvent,
} from './session';
import { RoomSnapshotSchema, type RoomSnapshot } from './room';
import type { WinByRule } from './winby';

export const ConnectionKindSchema = z.enum(['irc', 'referee_hub', 'chat']);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

export const ConnectionStatusSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'reconnecting',
  'error',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ConnectionStateSchema = z.object({
  kind: ConnectionKindSchema,
  status: ConnectionStatusSchema,
  detail: z.string().nullable().default(null),
  updatedAt: z.string().min(1),
});
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const RoomSummarySchema = z.object({
  sessionId: z.string().min(1),
  roomId: z.string().min(1),
  name: z.string().min(1),
  transport: z.enum(['irc', 'referee_hub']),
});
export type RoomSummary = z.infer<typeof RoomSummarySchema>;

export const AppStateSchema = z.object({
  user: z
    .object({ userId: z.number().int().positive(), username: z.string().min(1) })
    .nullable()
    .default(null),
  server: z.object({
    baseUrl: z.string().min(1),
    authenticated: z.boolean(),
  }),
  connections: z.array(ConnectionStateSchema).default([]),
  rooms: z.array(RoomSummarySchema).default([]),
  activeSessionId: z.string().min(1).nullable().default(null),
});
export type AppState = z.infer<typeof AppStateSchema>;

export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  channelId: z.string().min(1),
  sessionId: z.string().min(1).nullable().default(null),
  userId: z.number().int().positive().nullable().default(null),
  username: z.string().min(1),
  text: z.string(),
  at: z.string().min(1),
  self: z.boolean().default(false),
  system: z.boolean().default(false),
  /** IRC CTCP ACTION (/me) message. */
  action: z.boolean().default(false),
  source: z.enum(['irc', 'web', 'local']).default('local'),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LanguageSettingSchema = z.enum(['auto', 'en', 'zh-CN']);
export type LanguageSetting = z.infer<typeof LanguageSettingSchema>;

export const LogEntrySchema = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  level: LogLevelSchema,
  scope: z.string().min(1),
  message: z.string().min(1),
  /** Optional stack trace or diagnostic context; capped to keep exports small. */
  details: z.string().max(8000).nullable().default(null),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const MpCommandResultSchema = z.object({
  handled: z.boolean(),
  ok: z.boolean(),
  command: z.string().nullable().default(null),
  message: z.string(),
  actions: z.array(z.string()).default([]),
  at: z.string().min(1),
});
export type MpCommandResult = z.infer<typeof MpCommandResultSchema>;

export const DesktopEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('app_state'), state: AppStateSchema }),
  z.object({ type: z.literal('chat_message'), message: ChatMessageSchema }),
  z.object({ type: z.literal('chat_history'), sessionId: z.string().nullable(), messages: z.array(ChatMessageSchema) }),
  z.object({ type: z.literal('session_updated'), session: MatchSessionSchema }),
  z.object({ type: z.literal('session_deleted'), sessionId: z.string().min(1) }),
  z.object({ type: z.literal('room_snapshot'), sessionId: z.string().min(1), snapshot: RoomSnapshotSchema }),
  z.object({ type: z.literal('mp_result'), result: MpCommandResultSchema }),
  z.object({ type: z.literal('log'), entry: LogEntrySchema }),
  z.object({ type: z.literal('connection_log'), entry: LogEntrySchema }),
  z.object({ type: z.literal('session_event'), event: SessionEventSchema }),
  z.object({
    type: z.literal('toast'),
    kind: z.enum(['info', 'success', 'error']).default('info'),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('update_available'),
    version: z.string().min(1),
    size: z.number().nonnegative().default(0),
    notes: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('update_progress'),
    percent: z.number().min(0).max(100),
    transferred: z.number().nonnegative(),
    total: z.number().nonnegative(),
    bytesPerSecond: z.number().nonnegative(),
  }),
  z.object({ type: z.literal('update_downloaded') }),
  z.object({ type: z.literal('update_error'), message: z.string().min(1) }),
]);
export type DesktopEvent = z.infer<typeof DesktopEventSchema>;

export interface RemoteTournamentSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
}

export interface ImportPreview {
  provider: 'file' | 'http';
  remoteId: string;
  remoteRevision: string | null;
  etag: string | null;
  tournament: Tournament;
  changed: boolean;
  issues: { path: (string | number)[]; message: string }[];
  /** Non-blocking conversion notes, e.g. values adjusted by a bracket import. */
  notes: string[];
}

export interface ServerStatus {
  baseUrl: string;
  authenticated: boolean;
  username: string | null;
  userId: number | null;
  expiresAt: string | null;
}

export interface OsuUserSummary {
  userId: number;
  username: string;
}

export interface BeatmapInfo {
  id: number;
  title: string;
  artist: string;
  difficultyName: string;
  mapper: string;
  mode: string;
  beatmapsetId: number | null;
  beatmapUrl: string;
  coverUrl: string;
}

export interface BeatmapLookupFailure {
  id: number;
  message: string;
  /** The API answered 404: the beatmap does not exist. */
  notFound: boolean;
}

export interface BeatmapLookupResult {
  beatmaps: BeatmapInfo[];
  failed: BeatmapLookupFailure[];
}

export const UpdateChannelSchema = z.enum(['release', 'preview']);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

export type UpdateCheckResult =
  | { status: 'unsupported' }
  | { status: 'none'; version: string }
  | { status: 'available'; version: string; size: number; notes: string | null };

export interface FreemodPool {
  /** Mods forced onto every pick while Freemod is active. */
  required: string[];
  /** Mods players may opt into while Freemod is active. */
  allowed: string[];
}

export interface Settings {
  language: LanguageSetting;
  updateChannel: UpdateChannel;
  serverBaseUrl: string;
  ircAutoConnect: boolean;
  ircHost: string;
  ircPort: number;
  ircUseTls: boolean;
  ircUsername: string;
  ircDefaultChannels: string[];
  hubBaseUrl: string;
  chatWebsocketUrl: string;
  /** Mods injected by `!mp mods freemod` in Referee Hub rooms. */
  freemodMods: FreemodPool;
  chatFontFamily: string;
  chatFontSize: number;
  chatLineHeight: number;
  storeIrcPassword: boolean;
  logLevel: LogLevel;
  discordAuthorImage: string;
  discordAuthorName: string;
  discordBottomImage: string;
  discordFooterIconUrl: string;
  discordFooterText: string;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'auto',
  updateChannel: 'release',
  ircAutoConnect: true,
  serverBaseUrl: 'https://osmaref-oauth.a-pigeon.de',
  ircHost: 'irc.ppy.sh',
  ircPort: 6667,
  ircUseTls: false,
  ircUsername: '',
  ircDefaultChannels: ['#osu'],
  hubBaseUrl: 'https://spectator.osu.ppy.sh',
  chatWebsocketUrl: 'wss://notify.ppy.sh',
  freemodMods: { required: ['NF'], allowed: ['HD', 'HR', 'EZ', 'DT', 'FL', 'HT'] },
  chatFontFamily: 'Cascadia Mono, Consolas, monospace',
  chatFontSize: 13,
  chatLineHeight: 1.35,
  storeIrcPassword: true,
  logLevel: 'info',
  discordAuthorImage: '',
  discordAuthorName: '',
  discordBottomImage: '',
  discordFooterIconUrl: '',
  discordFooterText: '',
};

export interface JoinRoomInput {
  transport: 'irc' | 'referee_hub';
  /** IRC channel such as `#mp_123`. */
  channel?: string;
  /** Referee Hub room id. */
  roomId?: string;
}

export interface QuickRoomInput {  name: string;
  /** null is allowed for Bancho IRC; the Referee Hub requires a beatmap. */
  beatmapId: number | null;
  rulesetId: number;
  matchType: 'head_to_head' | 'team_versus';
  transport: 'irc' | 'referee_hub';
  maxParticipants: number;
  bestOf: number;
}

const ChannelSchema = z
  .string()
  .regex(/^#?[^\s#]+$/, 'channels must not contain spaces')
  .max(64);
const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL');
const WebSocketUrlSchema = z
  .string()
  .url()
  .refine((value) => /^wss?:\/\//i.test(value), 'must be a ws(s) URL');
const OptionalHttpsUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(
    (value) => value.length === 0 || /^https:\/\//i.test(value),
    'must be an https URL or empty',
  );

export const SettingsPatchSchema = z.object({
  language: LanguageSettingSchema.optional(),
  updateChannel: UpdateChannelSchema.optional(),
  serverBaseUrl: HttpUrlSchema.optional(),
  ircAutoConnect: z.boolean().optional(),
  ircHost: z.string().min(1).max(255).optional(),
  ircPort: z.number().int().min(1).max(65535).optional(),
  ircUseTls: z.boolean().optional(),
  ircUsername: z.string().max(64).optional(),
  ircDefaultChannels: z.array(ChannelSchema).max(20).optional(),
  hubBaseUrl: HttpUrlSchema.optional(),
  chatWebsocketUrl: WebSocketUrlSchema.optional(),
  freemodMods: z
    .object({
      required: z.array(z.string().min(1).max(16)).max(40),
      allowed: z.array(z.string().min(1).max(16)).max(40),
    })
    .optional(),
  chatFontFamily: z.string().min(1).max(120).optional(),
  chatFontSize: z.number().min(9).max(28).optional(),
  chatLineHeight: z.number().min(1).max(2.4).optional(),
  storeIrcPassword: z.boolean().optional(),
  logLevel: LogLevelSchema.optional(),
  discordAuthorImage: OptionalHttpsUrlSchema.optional(),
  discordAuthorName: z.string().max(80).optional(),
  discordBottomImage: OptionalHttpsUrlSchema.optional(),
  discordFooterIconUrl: OptionalHttpsUrlSchema.optional(),
  discordFooterText: z.string().max(2048).optional(),
});

export const ConnectIrcInputSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().max(256).optional(),
  host: z.string().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useTls: z.boolean().optional(),
  channels: z.array(ChannelSchema).max(20).optional(),
});

export const OpenRoomInputSchema = z.object({
  tournamentId: z.string().min(1).max(128),
  matchId: z.string().min(1).max(128),
});

export const JoinRoomInputSchema = z.object({
  transport: z.enum(['irc', 'referee_hub']),
  channel: z.string().min(1).max(64).optional(),
  roomId: z.string().regex(/^\d{1,20}$/).optional(),
});

export const QuickRoomInputSchema = z.object({
  name: z.string().min(1).max(120),
  beatmapId: z.number().int().nullable(),
  rulesetId: z.number().int().min(0).max(3),
  matchType: z.enum(['head_to_head', 'team_versus']),
  transport: z.enum(['irc', 'referee_hub']),
  maxParticipants: z.number().int().min(0).max(16),
  bestOf: z.number().int().min(1).max(31),
});

export const ApplyActionInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  kind: z.enum(['protect', 'ban', 'pick']),
  teamId: z.string().min(1).max(128),
  slotLabel: z.string().min(1).max(12),
  beatmapId: z.number().int().positive().optional(),
});

export const AdjustScoreInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  side: z.enum(['team_one', 'team_two']),
  delta: z.number().int().min(-10).max(10),
});

export const SetFirstTeamsInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  assignments: z
    .array(
      z.object({
        stepId: z.string().min(1).max(128),
        teamId: z.string().min(1).max(128),
      }),
    )
    .max(64),
});

export const PlaylistModsInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  playlistItemId: z.string().min(1).max(64),
  requiredMods: z.array(z.string().min(1).max(16)).max(30),
  allowedMods: z.array(z.string().min(1).max(16)).max(40),
  freestyle: z.boolean(),
});

export const SelectBeatmapInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  slotLabel: z.string().min(1).max(12),
});

export const StartMatchInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  countdown: z.number().int().min(0).max(120).nullable(),
});

export const AddPlaylistBeatmapInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  beatmapId: z.number().int().positive(),
  rulesetId: z.number().int().min(0).max(3),
});

export const RemovePlaylistBeatmapInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  playlistItemId: z.string().min(1).max(64),
});

export const PlayerActionInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  userId: z.number().int().positive(),
});

export const PlayerInviteInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  /** Username, `#user_id`, or a cleaned user URL. */
  user: z.string().min(1).max(64),
});

export const PlayerScoreInputSchema = z.object({  userId: z.number().int().positive(),
  username: z.string().max(64).optional(),
  score: z.number().nonnegative(),
  accuracy: z.number().min(0).max(1),
  maxCombo: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  mods: z.array(z.string().max(16)).max(20),
  passed: z.boolean(),
});

export const RecordResultInputSchema = z.object({
  sessionId: z.string().min(1).max(128),
  slotLabel: z.string().min(1).max(12),
  beatmapId: z.number().int().positive().optional(),
  scores: z.array(PlayerScoreInputSchema).max(64),
  source: z.enum(['irc', 'referee_hub', 'manual']),
});

export const ImportPreviewSchema = z.object({
  provider: z.enum(['file', 'http']),
  remoteId: z.string().min(1).max(200),
  remoteRevision: z.string().max(100).nullable(),
  etag: z.string().max(200).nullable(),
  tournament: TournamentSchema,
  changed: z.boolean(),
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string().max(500),
    }),
  ),
  notes: z.array(z.string().max(2000)).default([]),
});

export interface DesktopApi {
  app: {
    getState(): Promise<AppState>;
    getVersion(): Promise<string>;
    getSettings(): Promise<Settings>;
    saveSettings(patch: Partial<Settings>): Promise<Settings>;
    setIrcPassword(password: string): Promise<void>;
    clearIrcPassword(): Promise<void>;
    hasIrcPassword(): Promise<boolean>;
    openExternal(url: string): Promise<void>;
    getLogs(limit?: number): Promise<LogEntry[]>;
    /** Connection problems for the current run; cleared on restart. */
    getConnectionDiagnostics(limit?: number): Promise<LogEntry[]>;
    exportRuntimeLog(): Promise<string | null>;
    /** Returns `unsupported` for the portable zip build, which has no updater feed. */
    isUpdateSupported(): Promise<boolean>;
    checkUpdate(): Promise<UpdateCheckResult>;
    downloadUpdate(): Promise<void>;
    installUpdate(): Promise<void>;
    onEvent(listener: (event: DesktopEvent) => void): () => void;
  };
  tournaments: {
    list(): Promise<Tournament[]>;
    get(id: string): Promise<Tournament | null>;
    save(tournament: Tournament): Promise<Tournament>;
    remove(id: string): Promise<void>;
    create(name: string): Promise<Tournament>;
    exportFile(id: string): Promise<string | null>;
    importFile(): Promise<ImportPreview | null>;
    /** Imports an osu! tournament client `bracket.json`, converted to a tournament. */
    importBracket(): Promise<ImportPreview | null>;
    applyImport(preview: ImportPreview): Promise<Tournament>;
    listRemote(): Promise<RemoteTournamentSummary[]>;
    previewRemote(id: string): Promise<ImportPreview>;
  };
  sessions: {
    list(): Promise<MatchSession[]>;
    get(id: string): Promise<MatchSession | null>;
    open(input: { tournamentId: string; matchId: string }): Promise<MatchSession>;
    /** Creates a room without any stored tournament or match. */
    openQuick(input: QuickRoomInput): Promise<MatchSession>;
    /** Joins an existing IRC/Hub room without creating a new one. */
    join(input: JoinRoomInput): Promise<MatchSession>;
    close(sessionId: string): Promise<void>;
    /** Removes a closed/aborted session and its room references. */
    remove(sessionId: string): Promise<void>;
    applyAction(input: {
      sessionId: string;
      kind: 'protect' | 'ban' | 'pick';
      teamId: string;
      slotLabel: string;
      beatmapId?: number;
    }): Promise<MatchSession>;
    recordResult(input: {
      sessionId: string;
      slotLabel: string;
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
    }): Promise<MatchSession>;
    undo(sessionId: string): Promise<MatchSession>;
    adjustScore(input: { sessionId: string; side: 'team_one' | 'team_two'; delta: number }): Promise<MatchSession>;
    setFirstTeams(input: {
      sessionId: string;
      assignments: { stepId: string; teamId: string }[];
    }): Promise<MatchSession>;
    setPlaylistMods(input: {
      sessionId: string;
      playlistItemId: string;
      requiredMods: string[];
      allowedMods: string[];
      freestyle: boolean;
    }): Promise<void>;
    selectBeatmap(input: { sessionId: string; slotLabel: string }): Promise<MatchSession>;
    startMatch(input: { sessionId: string; countdown: number | null }): Promise<void>;
    addPlaylistBeatmap(input: {
      sessionId: string;
      beatmapId: number;
      rulesetId: number;
    }): Promise<void>;
    removePlaylistBeatmap(input: { sessionId: string; playlistItemId: string }): Promise<void>;
    invitePlayer(input: { sessionId: string; user: string }): Promise<void>;
    kickPlayer(input: { sessionId: string; userId: number }): Promise<void>;
    getEvents(sessionId: string): Promise<SessionEvent[]>;
    getRoom(sessionId: string): Promise<RoomSnapshot | null>;
    /** Room logs, including rooms already removed from the session list. */
    listLogs(): Promise<LobbyLogSummary[]>;
    exportLog(sessionId: string): Promise<string | null>;
    deleteLog(sessionId: string): Promise<void>;
  };
  winby: {
    /** Built-in rule first, then custom rules stored under the app profile. */
    list(): Promise<WinByRule[]>;
    importFile(): Promise<WinByRule | null>;
    exportFile(id: string): Promise<string | null>;
    remove(id: string): Promise<WinByRule[]>;
  };
  connection: {
    connectIrc(input: { username: string; password?: string; host?: string; port?: number; useTls?: boolean; channels?: string[] }): Promise<AppState>;
    /** Connects with saved credentials when `ircAutoConnect` is enabled. */
    autoConnect(): Promise<AppState>;
    connectHub(): Promise<AppState>;
    disconnect(kind: ConnectionKind): Promise<AppState>;
    joinChannel(channel: string): Promise<void>;
  };
  chat: {
    send(sessionId: string, text: string): Promise<MpCommandResult | null>;
    history(sessionId: string, limit?: number): Promise<ChatMessage[]>;
  };
  auth: {
    login(): Promise<ServerStatus>;
    logout(): Promise<ServerStatus>;
    status(): Promise<ServerStatus>;
  };
  osu: {
    /** Resolves a username from an osu! user id through the companion server. */
    lookupUser(userId: number): Promise<OsuUserSummary>;
    /** Fetches title/artist/difficulty/mapper metadata for beatmap ids. */
    lookupBeatmaps(input: {
      ids: number[];
      /** Saves cover thumbnails under this tournament and returns local URLs. */
      tournamentId?: string;
    }): Promise<BeatmapLookupResult>;
  };
}

export const IPC = {
  appState: 'app:state',
  appVersion: 'app:version',
  appSettings: 'app:settings',
  appSettingsSave: 'app:settings-save',
  appIrcPassword: 'app:irc-password',
  appIrcPasswordClear: 'app:irc-password-clear',
  appIrcPasswordHas: 'app:irc-password-has',
  appOpenExternal: 'app:open-external',
  appLogs: 'app:logs',
  appConnectionDiagnostics: 'app:connection-diagnostics',
  appExportRuntimeLog: 'app:export-runtime-log',
  appUpdateCheck: 'app:update-check',
  appUpdateSupported: 'app:update-supported',
  appUpdateDownload: 'app:update-download',
  appUpdateInstall: 'app:update-install',

  tournamentsList: 'tournaments:list',
  tournamentsGet: 'tournaments:get',
  tournamentsSave: 'tournaments:save',
  tournamentsRemove: 'tournaments:remove',
  tournamentsCreate: 'tournaments:create',
  tournamentsExport: 'tournaments:export',
  tournamentsImportFile: 'tournaments:import-file',
  tournamentsImportBracket: 'tournaments:import-bracket',
  tournamentsApplyImport: 'tournaments:apply-import',
  tournamentsRemoteList: 'tournaments:remote-list',
  tournamentsRemotePreview: 'tournaments:remote-preview',

  sessionsList: 'sessions:list',
  sessionsListLogs: 'sessions:list-logs',
  sessionsExportLog: 'sessions:export-log',
  sessionsDeleteLog: 'sessions:delete-log',

  winbyList: 'winby:list',
  winbyImportFile: 'winby:import-file',
  winbyExport: 'winby:export',
  winbyRemove: 'winby:remove',
  sessionsGet: 'sessions:get',
  sessionsOpen: 'sessions:open',
  sessionsOpenQuick: 'sessions:open-quick',
  sessionsJoin: 'sessions:join',
  sessionsClose: 'sessions:close',
  sessionsRemove: 'sessions:remove',
  sessionsApplyAction: 'sessions:apply-action',
  sessionsRecordResult: 'sessions:record-result',
  sessionsUndo: 'sessions:undo',
  sessionsAdjustScore: 'sessions:adjust-score',
  sessionsSetFirstTeams: 'sessions:set-first-teams',
  sessionsSetPlaylistMods: 'sessions:set-playlist-mods',
  sessionsSelectBeatmap: 'sessions:select-beatmap',
  sessionsStartMatch: 'sessions:start-match',
  sessionsAddPlaylistBeatmap: 'sessions:add-playlist-beatmap',
  sessionsRemovePlaylistBeatmap: 'sessions:remove-playlist-beatmap',
  sessionsInvitePlayer: 'sessions:invite-player',
  sessionsKickPlayer: 'sessions:kick-player',
  sessionsEvents: 'sessions:events',
  sessionsRoom: 'sessions:room',

  connectionConnectIrc: 'connection:connect-irc',
  connectionAutoConnect: 'connection:auto-connect',
  connectionConnectHub: 'connection:connect-hub',
  connectionDisconnect: 'connection:disconnect',
  connectionJoinChannel: 'connection:join-channel',

  chatSend: 'chat:send',
  chatHistory: 'chat:history',

  authLogin: 'auth:login',
  authLogout: 'auth:logout',
  authStatus: 'auth:status',
  osuLookupUser: 'osu:lookup-user',
  osuLookupBeatmaps: 'osu:lookup-beatmaps',

  event: 'osmaRef:event',
} as const;