import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type ChatMessage,
  type DesktopApi,
  type DesktopEvent,
  type ImportPreview,
  type LobbyLogSummary,
  type LogEntry,
  type MatchSession,
  type MpCommandResult,
  type RemoteTournamentSummary,
  type RoomSnapshot,
  type ServerStatus,
  type SessionEvent,
  type Settings,
  type Tournament,
  type WinByRule,
} from '@osmaref/contracts';

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

const api: DesktopApi = {
  app: {
    getState: () => invoke(IPC.appState),
    getVersion: () => invoke<string>(IPC.appVersion),
    getSettings: () => invoke<Settings>(IPC.appSettings),
    saveSettings: (patch) => invoke<Settings>(IPC.appSettingsSave, patch),
    setIrcPassword: (password) => invoke<void>(IPC.appIrcPassword, password),
    clearIrcPassword: () => invoke<void>(IPC.appIrcPasswordClear),
    hasIrcPassword: () => invoke<boolean>(IPC.appIrcPasswordHas),
    openExternal: (url) => invoke<void>(IPC.appOpenExternal, url),
    getLogs: (limit) => invoke<LogEntry[]>(IPC.appLogs, limit),
    getConnectionDiagnostics: (limit) =>
      invoke<LogEntry[]>(IPC.appConnectionDiagnostics, limit),
    exportRuntimeLog: () => invoke<string | null>(IPC.appExportRuntimeLog),
    onEvent: (listener) => {
      const handler = (_event: unknown, payload: DesktopEvent) => listener(payload);
      ipcRenderer.on(IPC.event, handler);
      return () => {
        ipcRenderer.removeListener(IPC.event, handler);
      };
    },
  },
  tournaments: {
    list: () => invoke<Tournament[]>(IPC.tournamentsList),
    get: (id) => invoke<Tournament | null>(IPC.tournamentsGet, id),
    save: (tournament) => invoke<Tournament>(IPC.tournamentsSave, tournament),
    remove: (id) => invoke<void>(IPC.tournamentsRemove, id),
    create: (name) => invoke<Tournament>(IPC.tournamentsCreate, name),
    exportFile: (id) => invoke<string | null>(IPC.tournamentsExport, id),
    importFile: () => invoke<ImportPreview | null>(IPC.tournamentsImportFile),
    importBracket: () => invoke<ImportPreview | null>(IPC.tournamentsImportBracket),
    applyImport: (preview) => invoke<Tournament>(IPC.tournamentsApplyImport, preview),
    listRemote: () => invoke<RemoteTournamentSummary[]>(IPC.tournamentsRemoteList),
    previewRemote: (id) => invoke<ImportPreview>(IPC.tournamentsRemotePreview, id),
  },
  sessions: {
    list: () => invoke<MatchSession[]>(IPC.sessionsList),
    get: (id) => invoke<MatchSession | null>(IPC.sessionsGet, id),
    open: (input) => invoke<MatchSession>(IPC.sessionsOpen, input),
    openQuick: (input) => invoke<MatchSession>(IPC.sessionsOpenQuick, input),
    join: (input) => invoke<MatchSession>(IPC.sessionsJoin, input),
    close: (id) => invoke<void>(IPC.sessionsClose, id),
    remove: (id) => invoke<void>(IPC.sessionsRemove, id),
    applyAction: (input) => invoke<MatchSession>(IPC.sessionsApplyAction, input),
    recordResult: (input) => invoke<MatchSession>(IPC.sessionsRecordResult, input),
    undo: (id) => invoke<MatchSession>(IPC.sessionsUndo, id),
    adjustScore: (input) => invoke<MatchSession>(IPC.sessionsAdjustScore, input),
    setFirstTeams: (input) => invoke<MatchSession>(IPC.sessionsSetFirstTeams, input),
    setPlaylistMods: (input) => invoke<void>(IPC.sessionsSetPlaylistMods, input),
    selectBeatmap: (input) => invoke(IPC.sessionsSelectBeatmap, input),
    startMatch: (input) => invoke<void>(IPC.sessionsStartMatch, input),
    addPlaylistBeatmap: (input) => invoke<void>(IPC.sessionsAddPlaylistBeatmap, input),
    removePlaylistBeatmap: (input) => invoke<void>(IPC.sessionsRemovePlaylistBeatmap, input),
    invitePlayer: (input) => invoke<void>(IPC.sessionsInvitePlayer, input),
    kickPlayer: (input) => invoke<void>(IPC.sessionsKickPlayer, input),
    getEvents: (id) => invoke<SessionEvent[]>(IPC.sessionsEvents, id),
    getRoom: (id) => invoke<RoomSnapshot | null>(IPC.sessionsRoom, id),
    listLogs: () => invoke<LobbyLogSummary[]>(IPC.sessionsListLogs),
    exportLog: (sessionId) => invoke<string | null>(IPC.sessionsExportLog, sessionId),
    deleteLog: (sessionId) => invoke<void>(IPC.sessionsDeleteLog, sessionId),
  },
  winby: {
    list: () => invoke<WinByRule[]>(IPC.winbyList),
    importFile: () => invoke<WinByRule | null>(IPC.winbyImportFile),
    exportFile: (id) => invoke<string | null>(IPC.winbyExport, id),
    remove: (id) => invoke<WinByRule[]>(IPC.winbyRemove, id),
  },
  connection: {
    connectIrc: (input) => invoke(IPC.connectionConnectIrc, input),
    autoConnect: () => invoke(IPC.connectionAutoConnect),
    connectHub: () => invoke(IPC.connectionConnectHub),
    disconnect: (kind) => invoke(IPC.connectionDisconnect, kind),
    joinChannel: (channel) => invoke<void>(IPC.connectionJoinChannel, channel),
  },
  chat: {
    send: (sessionId, text) => invoke<MpCommandResult | null>(IPC.chatSend, sessionId, text),
    history: (sessionId, limit) => invoke<ChatMessage[]>(IPC.chatHistory, sessionId, limit),
  },
  auth: {
    login: () => invoke<ServerStatus>(IPC.authLogin),
    logout: () => invoke<ServerStatus>(IPC.authLogout),
    status: () => invoke<ServerStatus>(IPC.authStatus),
  },
  osu: {
    lookupUser: (userId) => invoke(IPC.osuLookupUser, userId),
    lookupBeatmaps: (input) => invoke(IPC.osuLookupBeatmaps, input),
  },
};

contextBridge.exposeInMainWorld('osmaRef', api);