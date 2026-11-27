import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  MatchSessionSchema,
  createEmptyTournament,
  type DesktopEvent,
  type MatchSession,
  type Tournament,
} from '@osmaref/contracts';
import { ConnectionManager } from '../apps/desktop/src/main/connections';
import { createSession } from '@osmaref/domain';
import { createAppStore } from '../apps/desktop/src/main/store';
import type { SettingsStore } from '../apps/desktop/src/main/settings';
import type { ServerClient } from '../apps/desktop/src/main/server-client';
import type { AppLogger } from '../apps/desktop/src/main/logger';
import { WinByStore } from '../apps/desktop/src/main/winby-store';

describe('automatic messages in an IRC room', () => {
  it('sends each configured message in order and echoes it locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-conn-automation-'));
    const store = await createAppStore(dir);
    const emitted: DesktopEvent[] = [];
    const send = vi.fn(async () => undefined);
    const logger = {
      runtime: vi.fn(),
      diagnostic: vi.fn(),
      setEmitter: vi.fn(),
      getRuntimeLogs: vi.fn(() => []),
      getDiagnostics: vi.fn(() => []),
    } as unknown as AppLogger;
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS }),
      getIrcPassword: () => null,
    } as unknown as SettingsStore;
    const server = { osu: {} } as unknown as ServerClient;
    const manager = new ConnectionManager({
      store,
      settings,
      winby: new WinByStore(dir),
      server,
      logger,
      emit: (event) => emitted.push(event),
    });

    try {
      const tournament = createEmptyTournament('Cup');
      tournament.automation.action_applied = [
        { type: 'chat', template: 'first' },
        { type: 'chat', template: 'second' },
      ];
      const session = MatchSessionSchema.parse({
        id: 'session-1',
        tournamentId: tournament.id,
        matchId: 'match-1',
        tournamentRevision: 1,
        matchName: 'Alpha vs Beta',
        teamOneId: '0',
        teamTwoId: '1',
        transport: 'irc',
        status: 'active',
        bestOf: 9,
        roomId: '123',
        roomName: 'Room',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const internal = manager as unknown as {
        ircChat: { send: typeof send };
        channels: Map<string, string>;
        runAutomation: (
          tournament: Tournament,
          session: MatchSession,
          trigger: 'action_applied',
        ) => void;
      };
      internal.ircChat = { send };
      internal.channels.set(session.id, '#mp_123');

      internal.runAutomation(tournament, session, 'action_applied');
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(send.mock.calls).toEqual([
        ['#mp_123', 'first'],
        ['#mp_123', 'second'],
      ]);
      expect(emitted.filter((event) => event.type === 'chat_message')).toHaveLength(2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the acted slot for action_applied messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-conn-automation-'));
    const store = await createAppStore(dir);
    const emitted: DesktopEvent[] = [];
    const send = vi.fn(async () => undefined);
    const logger = {
      runtime: vi.fn(),
      diagnostic: vi.fn(),
      setEmitter: vi.fn(),
      getRuntimeLogs: vi.fn(() => []),
      getDiagnostics: vi.fn(() => []),
    } as unknown as AppLogger;
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS }),
      getIrcPassword: () => null,
    } as unknown as SettingsStore;
    const server = { osu: {} } as unknown as ServerClient;
    const manager = new ConnectionManager({
      store,
      settings,
      winby: new WinByStore(dir),
      server,
      logger,
      emit: (event) => emitted.push(event),
    });

    try {
      const tournament = createEmptyTournament('Cup');
      const stage = tournament.stages[0]!;
      stage.slots = [
        {
          id: 'slot',
          label: 'NM1',
          category: 'NM',
          beatmapId: 111,
          beatmap: null,
          rulesetId: null,
          requiredMods: [],
          allowedMods: [],
          freestyle: false,
          freemod: false,
        },
      ];
      stage.matches.push({
        id: 'm',
        type: 'match',
        groupId: null,
        teamRedId: 0,
        teamBlueId: 1,
        refereeIds: [],
        scheduledAt: '2026-01-01T00:00:00.000Z',
        result: { scoreRed: 0, scoreBlue: 0, roomId: null, beatmaps: [] },
        roomMode: 'team_versus',
      });
      tournament.automation.action_applied = [{ type: 'chat', template: '{{slot}}' }];
      store.saveTournament(tournament);

      const session = createSession(
        {
          id: 's',
          tournamentId: tournament.id,
          matchId: 'm',
          matchName: 'Alpha vs Beta',
          teamOneId: '0',
          teamTwoId: '1',
          tournamentRevision: tournament.revision,
          rulesetId: 0,
          matchType: 'team_versus',
          transport: 'irc',
          bestOf: stage.bestOf,
          bans: stage.bans,
          protects: stage.protects,
          firstTeamsSet: true,
          now: '2026-01-01T00:00:00.000Z',
        },
        stage.flow,
      );
      session.roomId = '123';
      store.saveSession(session);

      const internal = manager as unknown as {
        ircChat: { send: typeof send };
        channels: Map<string, string>;
        applyAction: (input: {
          sessionId: string;
          kind: 'ban';
          teamId: string;
          slotLabel: string;
        }) => Promise<unknown>;
      };
      internal.ircChat = { send };
      internal.channels.set(session.id, '#mp_123');

      await internal.applyAction({
        sessionId: session.id,
        kind: 'ban',
        teamId: '0',
        slotLabel: 'NM1',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(send.mock.calls).toEqual([['#mp_123', 'NM1']]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('posts rendered messages to the configured discord webhooks', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-conn-webhook-'));
    const store = await createAppStore(dir);
    const emitted: DesktopEvent[] = [];
    const send = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = {
      runtime: vi.fn(),
      diagnostic: vi.fn(),
      setEmitter: vi.fn(),
      getRuntimeLogs: vi.fn(() => []),
      getDiagnostics: vi.fn(() => []),
    } as unknown as AppLogger;
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS }),
      getIrcPassword: () => null,
    } as unknown as SettingsStore;
    const server = { osu: {} } as unknown as ServerClient;
    const manager = new ConnectionManager({
      store,
      settings,
      winby: new WinByStore(dir),
      server,
      logger,
      emit: (event) => emitted.push(event),
    });

    try {
      const tournament = createEmptyTournament('Cup');
      tournament.automation.action_applied = [
        { type: 'chat', template: '{{tournament}} updated' },
      ];
      tournament.webhooks = [
        {
          kind: 'discord',
          name: 'Results',
          url: 'https://discord.com/api/webhooks/1/token',
          triggers: ['action_applied'],
        },
      ];
      const session = MatchSessionSchema.parse({
        id: 'session-hook',
        tournamentId: tournament.id,
        matchId: 'match-1',
        tournamentRevision: 1,
        matchName: 'Alpha vs Beta',
        teamOneId: '0',
        teamTwoId: '1',
        transport: 'irc',
        status: 'active',
        bestOf: 9,
        roomId: '123',
        roomName: 'Room',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const internal = manager as unknown as {
        ircChat: { send: typeof send };
        channels: Map<string, string>;
        runAutomation: (
          tournament: Tournament,
          session: MatchSession,
          trigger: 'action_applied',
        ) => void;
      };
      internal.ircChat = { send };
      internal.channels.set(session.id, '#mp_123');

      internal.runAutomation(tournament, session, 'action_applied');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(call[0]).toBe('https://discord.com/api/webhooks/1/token');
      expect(call[1].method).toBe('POST');
      const body = JSON.parse(String(call[1].body)) as {
        embeds: { title?: string; description?: string }[];
      };
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0]?.title).toBe('Manual action - Alpha vs Beta');
      expect(body.embeds[0]?.description).toBe('Alpha vs Beta');
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends structured embeds without any chat message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-conn-webhook-only-'));
    const store = await createAppStore(dir);
    const emitted: DesktopEvent[] = [];
    const send = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const logger = {
      runtime: vi.fn(),
      diagnostic: vi.fn(),
      setEmitter: vi.fn(),
      getRuntimeLogs: vi.fn(() => []),
      getDiagnostics: vi.fn(() => []),
    } as unknown as AppLogger;
    const settings = {
      get: () => ({ ...DEFAULT_SETTINGS }),
      getIrcPassword: () => null,
    } as unknown as SettingsStore;
    const server = { osu: {} } as unknown as ServerClient;
    const manager = new ConnectionManager({
      store,
      settings,
      winby: new WinByStore(dir),
      server,
      logger,
      emit: (event) => emitted.push(event),
    });

    try {
      const tournament = createEmptyTournament('Cup');
      tournament.webhooks = [
        {
          kind: 'discord',
          name: 'Results',
          url: 'https://discord.com/api/webhooks/1/token',
          triggers: ['action_applied'],
        },
      ];
      const session = MatchSessionSchema.parse({
        id: 'session-hook-only',
        tournamentId: tournament.id,
        matchId: 'match-1',
        tournamentRevision: 1,
        matchName: 'Alpha vs Beta',
        teamOneId: '0',
        teamTwoId: '1',
        transport: 'irc',
        status: 'active',
        bestOf: 9,
        roomId: '123',
        roomName: 'Room',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      session.actions = [
        {
          id: 'action-1',
          kind: 'pick',
          teamId: '0',
          slotLabel: 'NM1',
          beatmapId: 12,
          byUserId: null,
          at: '2026-01-01T00:01:00.000Z',
        },
      ];

      const internal = manager as unknown as {
        ircChat: { send: typeof send };
        runAutomation: (
          tournament: Tournament,
          session: MatchSession,
          trigger: 'action_applied',
          extra?: { slot?: string; beatmap_id?: string },
        ) => void;
      };
      internal.ircChat = { send };

      internal.runAutomation(tournament, session, 'action_applied', {
        slot: 'NM1',
        beatmap_id: '12',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(send).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(String(call[1].body)) as {
        embeds: { title?: string; description?: string }[];
      };
      expect(body.embeds[0]?.title).toBe('📌 Pick - Alpha vs Beta');
      expect(body.embeds[0]?.description).toBe('Team 1 picked NM1');
    } finally {
      vi.unstubAllGlobals();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
