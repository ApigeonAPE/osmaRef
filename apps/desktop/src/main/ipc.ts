import { ipcMain, dialog, shell, type BrowserWindow } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  AdjustScoreInputSchema,
  ApplyActionInputSchema,
  ConnectIrcInputSchema,
  ImportPreviewSchema,
  IPC,
  OpenRoomInputSchema,
  AddPlaylistBeatmapInputSchema,
  SelectBeatmapInputSchema,
  StartMatchInputSchema,
  JoinRoomInputSchema,
  PlaylistModsInputSchema,
  PlayerActionInputSchema,
  PlayerInviteInputSchema,
  RemovePlaylistBeatmapInputSchema,
  QuickRoomInputSchema,
  RecordResultInputSchema,
  SettingsPatchSchema,
  SetFirstTeamsInputSchema,
  TournamentSchema,
  type DesktopEvent,
  type Settings,
} from '@osmaref/contracts';
import { z } from 'zod';
import type { AppStore } from './store';
import type { SettingsStore } from './settings';
import type { ServerClient } from './server-client';
import type { ConnectionManager } from './connections';
import type { TournamentImporter } from './importer';
import type { AppLogger } from './logger';
import type { WinByStore } from './winby-store';
import { exportRuntimeLog, exportSessionLog } from './log-export';

export interface IpcContext {
  store: AppStore;
  settings: SettingsStore;
  server: ServerClient;
  connections: ConnectionManager;
  importer: TournamentImporter;
  winby: WinByStore;
  logger: AppLogger;
  getWindow: () => BrowserWindow | null;
}

export function registerIpc(ctx: IpcContext): void {
  const parse = <S extends z.ZodTypeAny>(schema: S, value: unknown, label: string): z.infer<S> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const details = result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
        .join('; ');
      throw new Error(`${label}: ${details}`);
    }
    return result.data;
  };

  const emit = (event: DesktopEvent): void => {
    const window = ctx.getWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.event, event);
    }
  };

  // Wire transport events to the renderer.
  ctx.connections.setEmitter(emit);
  ctx.logger.setEmitter(emit);

  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args);
      } catch (error) {
        // IPC errors are serialised to the renderer as readable messages and
        // recorded in the runtime log so failures survive a restart.
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.runtime(
          'error',
          'ipc',
          `${channel}: ${message}`,
          error instanceof Error ? error.stack : undefined,
        );
        throw new Error(message);
      }
    });
  };

  handle(IPC.appState, () => ctx.connections.getAppState());
  handle(IPC.appSettings, () => ctx.settings.get());
  handle(IPC.appSettingsSave, (patch) => {
    const parsed = parse(SettingsPatchSchema, patch, 'settings');
    const settings = ctx.settings.update(parsed as Partial<Settings>);
    emit({ type: 'app_state', state: ctx.connections.getAppState() });
    return settings;
  });
  handle(IPC.appIrcPassword, async (password) => {
    await ctx.settings.setIrcPassword(String(password ?? ''));
  });
  handle(IPC.appIrcPasswordClear, () => {
    ctx.settings.clearIrcPassword();
  });
  handle(IPC.appIrcPasswordHas, () => ctx.settings.hasIrcPassword());
  handle(IPC.appOpenExternal, async (url) => {
    const value = String(url ?? '');
    if (!/^https?:\/\//i.test(value)) throw new Error('only http(s) links can be opened');
    await shell.openExternal(value);
  });
  handle(IPC.appLogs, (limit) =>
    ctx.logger.getRuntimeLogs(typeof limit === 'number' ? limit : 200),
  );
  handle(IPC.appConnectionDiagnostics, (limit) =>
    ctx.logger.getDiagnostics(typeof limit === 'number' ? limit : 200),
  );
  handle(IPC.appExportRuntimeLog, () => exportRuntimeLog(ctx.store));

  handle(IPC.winbyList, () => ctx.winby.list());
  handle(IPC.winbyImportFile, async () => {
    const window = ctx.getWindow();
    const options = {
      title: 'Import Win-by rule',
      filters: [{ name: 'JavaScript', extensions: ['js', 'mjs'] }],
      properties: ['openFile' as const],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return ctx.winby.add(readFileSync(path, 'utf8'));
  });
  handle(IPC.winbyExport, async (id) => {
    const rule = ctx.winby.get(String(id));
    if (!rule) throw new Error('Win-by rule not found');
    const window = ctx.getWindow();
    const name = rule.name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'win-by';
    const options = {
      title: 'Export Win-by rule',
      defaultPath: `${name}.js`,
      filters: [{ name: 'JavaScript', extensions: ['js'] }],
    };
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    writeFileSync(result.filePath, rule.source, 'utf8');
    return result.filePath;
  });
  handle(IPC.winbyRemove, (id) => {
    ctx.winby.remove(String(id));
    return ctx.winby.list();
  });

  handle(IPC.tournamentsList, () => ctx.store.listTournaments());
  handle(IPC.tournamentsGet, (id) => ctx.store.getTournament(String(id)));
  handle(IPC.tournamentsSave, (tournament) => {
    const saved = ctx.store.saveTournament(parse(TournamentSchema, tournament, 'tournament'));
    ctx.logger.runtime(
      'info',
      'tournament',
      `saved "${saved.name}" revision ${saved.revision}`,
    );
    return saved;
  });
  handle(IPC.tournamentsRemove, (id) => {
    const tournament = ctx.store.getTournament(String(id));
    ctx.store.deleteTournament(String(id));
    ctx.logger.runtime(
      'info',
      'tournament',
      `deleted tournament "${tournament?.name ?? String(id)}"`,
    );
  });
  handle(IPC.tournamentsCreate, (name) => ctx.importer.createBlank(String(name || 'New tournament')));
  handle(IPC.tournamentsExport, (id) => ctx.importer.exportToFile(String(id)));
  handle(IPC.tournamentsImportFile, () => ctx.importer.importFromFile());
  handle(IPC.tournamentsImportBracket, () => ctx.importer.importBracketFromFile());
  handle(IPC.tournamentsApplyImport, (preview) =>
    ctx.importer.apply(parse(ImportPreviewSchema, preview, 'import preview')),
  );
  handle(IPC.tournamentsRemoteList, () => ctx.importer.listRemote());
  handle(IPC.tournamentsRemotePreview, (id) => ctx.importer.previewRemote(String(id)));

  handle(IPC.sessionsList, () => ctx.store.listSessions());
  handle(IPC.sessionsListLogs, () => ctx.store.listLobbyLogs());
  handle(IPC.sessionsExportLog, (sessionId) =>
    exportSessionLog(ctx.store, parse(z.string().min(1).max(128), sessionId, 'session id')),
  );
  handle(IPC.sessionsDeleteLog, (sessionId) => {
    const id = parse(z.string().min(1).max(128), sessionId, 'session id');
    const summary = ctx.store.listLobbyLogs().find((entry) => entry.sessionId === id);
    ctx.store.deleteLobbyLog(id);
    ctx.logger.runtime(
      'info',
      'lobby-log',
      `deleted room log "${summary?.matchName ?? id}" (${summary?.entryCount ?? 0} entries)`,
    );
  });
  handle(IPC.sessionsGet, (id) => ctx.store.getSession(String(id)));
  handle(IPC.sessionsOpen, (input) =>
    ctx.connections.openRoom(parse(OpenRoomInputSchema, input, 'open room')),
  );
  handle(IPC.sessionsOpenQuick, (input) =>
    ctx.connections.openQuickRoom(parse(QuickRoomInputSchema, input, 'quick room')),
  );
  handle(IPC.sessionsJoin, (input) =>
    ctx.connections.joinRoom(parse(JoinRoomInputSchema, input, 'join room')),
  );
  handle(IPC.sessionsClose, (id) => ctx.connections.closeSession(String(id)));
  handle(IPC.sessionsRemove, (id) => ctx.connections.removeSession(String(id)));
  handle(IPC.sessionsApplyAction, (input) =>
    ctx.connections.applyAction(parse(ApplyActionInputSchema, input, 'apply action')),
  );
  handle(IPC.sessionsRecordResult, (input) =>
    ctx.connections.recordScores(parse(RecordResultInputSchema, input, 'record result')),
  );
  handle(IPC.sessionsUndo, (id) => ctx.connections.undo(String(id)));
  handle(IPC.sessionsAdjustScore, (input) =>
    ctx.connections.adjustScore(parse(AdjustScoreInputSchema, input, 'score adjustment')),
  );
  handle(IPC.sessionsSetFirstTeams, (input) =>
    ctx.connections.setFirstTeams(parse(SetFirstTeamsInputSchema, input, 'first teams')),
  );
  handle(IPC.sessionsSetPlaylistMods, (input) =>
    ctx.connections.setPlaylistMods(parse(PlaylistModsInputSchema, input, 'playlist mods')),
  );
  handle(IPC.sessionsSelectBeatmap, (input) =>
    ctx.connections.selectBeatmap(parse(SelectBeatmapInputSchema, input, 'beatmap selection')),
  );
  handle(IPC.sessionsStartMatch, (input) =>
    ctx.connections.startMatch(parse(StartMatchInputSchema, input, 'start match')),
  );
  handle(IPC.sessionsAddPlaylistBeatmap, (input) =>
    ctx.connections.addPlaylistBeatmap(
      parse(AddPlaylistBeatmapInputSchema, input, 'playlist beatmap'),
    ),
  );
  handle(IPC.sessionsRemovePlaylistBeatmap, (input) =>
    ctx.connections.removePlaylistBeatmap(
      parse(RemovePlaylistBeatmapInputSchema, input, 'playlist item removal'),
    ),
  );
  handle(IPC.sessionsInvitePlayer, (input) =>
    ctx.connections.invitePlayer(parse(PlayerInviteInputSchema, input, 'player invite')),
  );
  handle(IPC.sessionsKickPlayer, (input) =>
    ctx.connections.kickPlayer(parse(PlayerActionInputSchema, input, 'player kick')),
  );
  handle(IPC.sessionsEvents, (id) => ctx.store.listEvents(String(id)));
  handle(IPC.sessionsRoom, (id) => ctx.connections.getRoomSnapshot(String(id)));

  handle(IPC.connectionConnectIrc, (input) =>
    ctx.connections.connectIrc(parse(ConnectIrcInputSchema, input, 'IRC connection')),
  );
  handle(IPC.connectionConnectHub, () => ctx.connections.connectHub());
  handle(IPC.connectionAutoConnect, () => ctx.connections.autoConnect());
  handle(IPC.connectionDisconnect, (kind) =>
    ctx.connections.disconnect(
      parse(z.enum(['irc', 'referee_hub', 'chat']), kind, 'connection kind'),
    ),
  );
  handle(IPC.connectionJoinChannel, (channel) => ctx.connections.joinChannel(String(channel)));

  handle(IPC.chatSend, (sessionId, text) => ctx.connections.sendChat(String(sessionId), String(text)));
  handle(IPC.chatHistory, (sessionId, limit) =>
    ctx.connections.chatHistory(String(sessionId), typeof limit === 'number' ? limit : 100),
  );

  handle(IPC.authLogin, async () => {
    const status = await ctx.server.login();
    await ctx.connections.refreshServerStatus();
    if (status.authenticated) {
      // Signing in exists for the Referee Hub; connect it without another click.
      try {
        await ctx.connections.connectHub();
      } catch (error) {
        console.warn('[osmaRef] automatic Referee Hub connection failed:', error);
      }
    }
    return status;
  });
  handle(IPC.authLogout, async () => {
    const status = await ctx.server.logout();
    // The Referee Hub and osu!web chat use the same token; drop them with it.
    try {
      await ctx.connections.disconnect('referee_hub');
    } catch (error) {
      console.warn('[osmaRef] Referee Hub disconnect on logout failed:', error);
    }
    await ctx.connections.refreshServerStatus();
    return status;
  });
  handle(IPC.authStatus, async () => {
    const status = await ctx.server.status();
    await ctx.connections.refreshServerStatus();
    return status;
  });

  handle(IPC.osuLookupUser, (userId) =>
    ctx.server.lookupUser(parse(z.number().int().positive(), userId, 'user id')),
  );
  handle(IPC.osuLookupBeatmaps, (ids) =>
    ctx.connections.lookupBeatmaps(
      parse(z.array(z.number().int().positive()).max(100), ids, 'beatmap ids'),
    ),
  );
}