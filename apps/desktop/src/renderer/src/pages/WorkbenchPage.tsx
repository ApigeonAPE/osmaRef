import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  findRound,
  findMatch,
  findSlotByLabel,
  normalizeSlotLabel,
  type MappoolSlot,
  type PlaylistEntry,
  type BeatmapInfo,
  type RoomPlayer,
} from '@osmaref/contracts';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Empty, Section } from '../ui';
import { ChatPanel } from '../components/ChatPanel';
import { FirstTeamsDialog } from '../components/FirstTeamsDialog';
import { PlaylistModsDialog } from '../components/PlaylistModsDialog';
import { JoinRoomDialog } from '../components/JoinRoomDialog';
import { Toast } from '../components/Toast';
import { IdInput } from '../components/IdInput';
import { ResultDialog, type ResultRow } from '../components/ResultDialog';

export function WorkbenchPage({
  sessionId,
  onSessionChange,
  onBack,
}: {
  sessionId: string | null;
  onSessionChange: (sessionId: string | null) => void;
  onBack: () => void;
}) {
  const model = useModel();
  const { t } = useI18n();
  const [activeId, setActiveId] = useState<string | null>(sessionId);
  const initialSession = model.sessions.find((entry) => entry.id === sessionId);
  const [channel, setChannel] = useState<'irc' | 'referee_hub'>(
    initialSession?.transport ?? 'referee_hub',
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [firstTeamsOpen, setFirstTeamsOpen] = useState(false);
  const [playlistBeatmapId, setPlaylistBeatmapId] = useState('');
  const [playlistRulesetId, setPlaylistRulesetId] = useState(0);
  const [inviteUser, setInviteUser] = useState('');
  const [poolSearch, setPoolSearch] = useState('');
  const [leftWidth, setLeftWidth] = useState(() => loadWorkbenchLayout().leftWidth);
  const [rightWidth, setRightWidth] = useState(() => loadWorkbenchLayout().rightWidth);
  const [chatPercent, setChatPercent] = useState(() => loadWorkbenchLayout().chatPercent);
  const [roomsPercent, setRoomsPercent] = useState(() => loadWorkbenchLayout().roomsPercent);
  const [rightPercent, setRightPercent] = useState(() => loadWorkbenchLayout().rightPercent);
  const [joinOpen, setJoinOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [modsEntry, setModsEntry] = useState<PlaylistEntry | null>(null);

  const channelSessions = useMemo(
    () => model.sessions.filter((entry) => entry.transport === channel),
    [model.sessions, channel],
  );

  useEffect(() => {
    if (!sessionId) return;
    const target = model.sessions.find((entry) => entry.id === sessionId);
    if (target) setChannel(target.transport);
    setActiveId(sessionId);
  }, [sessionId, model.sessions]);

  useEffect(() => {
    const active = model.sessions.find((entry) => entry.id === activeId);
    if (active && active.transport !== channel) setChannel(active.transport);
  }, [activeId, model.sessions]);

  useEffect(() => {
    const valid = model.sessions.find((session) => session.id === activeId);
    if (valid) return;
    const preferred =
      channelSessions.find((session) => session.id === model.state?.activeSessionId) ??
      channelSessions.find((session) => session.roomId !== null) ??
      channelSessions[0] ??
      null;
    setActiveId(preferred?.id ?? null);
  }, [channelSessions, model.state?.activeSessionId, activeId]);

  const session = model.sessions.find((entry) => entry.id === activeId) ?? null;
  const tournament = session
    ? session.configSnapshot ?? model.tournaments.find((entry) => entry.id === session.tournamentId) ?? null
    : null;
  const isQuickRoom = Boolean(
    session && (session.tournamentId.startsWith('adhoc_') || tournament?.id.startsWith('adhoc_')),
  );
  const match = session && tournament ? findMatch(tournament, session.matchId) ?? null : null;
  const round = session && tournament && match ? findRound(tournament, match.roundId) ?? null : null;
  const pool = round ? { slots: round.slots } : null;
  const pending = session ? session.queue[session.cursor] ?? null : null;
  const lastAction = session?.actions.at(-1) ?? null;
  const room = session ? model.snapshots[session.id] ?? null : null;
  const [beatmaps, setBeatmaps] = useState<Record<number, BeatmapInfo>>({});
  const beatmapCache = useRef<Record<number, BeatmapInfo>>({});
  const playlist = room ? [...room.playlist].sort((a, b) => a.order - b.order) : [];
  const visiblePlaylist = playlist.filter((entry) => !entry.wasPlayed);
  const activePlaylistItem = room
    ? playlist.find((entry) => entry.id === room.currentPlaylistItemId) ??
      playlist.find((entry) => !entry.wasPlayed) ??
      playlist[0] ??
      null
    : null;

  const beatmapIds = useMemo(() => {
    const ids = new Set<number>();
    pool?.slots.forEach((slot) => ids.add(slot.beatmapId));
    playlist.forEach((entry) => ids.add(entry.beatmapId));
    if (room?.currentBeatmapId) ids.add(room.currentBeatmapId);
    if (session?.currentBeatmapId) ids.add(session.currentBeatmapId);
    return [...ids].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  }, [pool, playlist, room?.currentBeatmapId, session?.currentBeatmapId]);
  const beatmapKey = beatmapIds.join(',');

  const playlistViews = useMemo(() => {
    if (!session || !room) return [];
    if (session.transport === 'irc') {
      const id = room.currentBeatmapId ?? session.currentBeatmapId;
      if (!id) return [];
      const freemod = room.mods.find((mod) => mod.toUpperCase() === 'FREEMOD');
      return [
        {
          key: 'irc-current',
          item: null,
          beatmapId: id,
          mode: room.ruleset ?? '—',
          required: room.mods.filter((mod) => {
            const upper = mod.toUpperCase();
            return upper !== 'FREEMOD' && upper !== 'NM';
          }),
          allowed: freemod ? [freemod] : [],
          freestyle: false,
          played: false,
          active: true,
        },
      ];
    }
    const activeId = room.currentPlaylistItemId ?? activePlaylistItem?.id ?? null;
    return visiblePlaylist.map((entry) => ({
      key: entry.id,
      item: entry,
      beatmapId: entry.beatmapId,
      mode: rulesetName(entry.rulesetId),
      required: entry.requiredMods,
      allowed: entry.allowedMods,
      freestyle: entry.freestyle,
      played: entry.wasPlayed,
      active: entry.id === activeId,
    }));
  }, [session, room, playlist, activePlaylistItem]);

  const playerRows = useMemo(() => {
    if (!room) return [] as { key: string; slot: number | null; player: RoomPlayer | null }[];
    if (room.maxParticipants <= 0) {
      return room.players.map((player) => ({
        key: `p-${player.userId}`,
        slot: player.slot,
        player,
      }));
    }
    const rows: { key: string; slot: number | null; player: RoomPlayer | null }[] = Array.from(
      { length: room.maxParticipants },
      (_, index) => ({ key: `slot-${index}`, slot: index, player: null }),
    );
    const unplaced: RoomPlayer[] = [];
    for (const player of room.players) {
      const row =
        player.slot !== null && player.slot >= 0 && player.slot < rows.length
          ? rows[player.slot]
          : undefined;
      if (row && row.player === null) row.player = player;
      else unplaced.push(player);
    }
    for (const player of unplaced) {
      const row = rows.find((entry) => entry.player === null);
      if (!row) break;
      row.player = player;
    }
    return rows;
  }, [room]);

  useEffect(() => {
    if (!beatmapKey) return;
    const missing = beatmapIds.filter((id) => !beatmapCache.current[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    void window.osmaRef.osu
      .lookupBeatmaps(missing)
      .then((list) => {
        for (const info of list) beatmapCache.current[info.id] = info;
        if (!cancelled) setBeatmaps({ ...beatmapCache.current });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [beatmapKey]);

  const teamName = (id: string | null | undefined): string =>
    (tournament?.teams.find((team) => team.id === id)?.name ?? id ?? '—') as string;

  const rosterName = (userId: number): string | undefined =>
    tournament?.teams
      .flatMap((team) => team.members)
      .find((member) => member.userId === userId)?.username;

  const invitePlayer = async () => {
    if (!session) return;
    const user = inviteUser.trim();
    if (!user) return;
    await run('invite', async () => {
      await window.osmaRef.sessions.invitePlayer({ sessionId: session.id, user });
      setInviteUser('');
    });
  };

  const kickPlayer = async (player: RoomPlayer) => {
    if (!session) return;
    await run(`kick-${player.userId}`, async () => {
      await window.osmaRef.sessions.kickPlayer({
        sessionId: session.id,
        userId: player.userId,
      });
    });
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeSession = async (id: string) => {
    await run('remove', async () => {
      await window.osmaRef.sessions.remove(id);
      if (activeId === id) {
        setActiveId(null);
        onSessionChange(null);
      }
      await model.refreshSessions();
    });
  };

  const leaveChatChannel = async () => {
    if (!session?.chatOnly) return;
    await run('leave-channel', async () => {
      await window.osmaRef.sessions.close(session.id);
      await window.osmaRef.sessions.remove(session.id);
      setActiveId(null);
      onSessionChange(null);
      await model.refreshSessions();
    });
  };

  const adjustScore = (side: 'team_one' | 'team_two', delta: number) => {
    if (!session || session.status !== 'active') return;
    void run('score', () =>
      window.osmaRef.sessions.adjustScore({ sessionId: session.id, side, delta }),
    );
  };

  const saveFirstTeams = async (assignments: { stepId: string; teamId: string }[]) => {
    if (!session) return;
    await window.osmaRef.sessions.setFirstTeams({ sessionId: session.id, assignments });
    setFirstTeamsOpen(false);
  };

  const savePlaylistMods = async (input: {
    requiredMods: string[];
    allowedMods: string[];
    freestyle: boolean;
  }) => {
    if (!session || !modsEntry) return;
    await window.osmaRef.sessions.setPlaylistMods({
      sessionId: session.id,
      playlistItemId: modsEntry.id,
      ...input,
    });
  };

  const addPlaylistBeatmap = async () => {
    const beatmapId = Number(playlistBeatmapId);
    if (!session || !Number.isSafeInteger(beatmapId) || beatmapId <= 0) return;
    await run('playlist-add', async () => {
      await window.osmaRef.sessions.addPlaylistBeatmap({
        sessionId: session.id,
        beatmapId,
        rulesetId: playlistRulesetId,
      });
      setPlaylistBeatmapId('');
    });
  };

  const removePlaylistBeatmap = async (entry: PlaylistEntry) => {
    if (!session) return;
    await run('playlist-remove', () =>
      window.osmaRef.sessions.removePlaylistBeatmap({
        sessionId: session.id,
        playlistItemId: entry.id,
      }),
    );
  };

  const applySlot = (slot: MappoolSlot) => {
    if (!session) return;
    if (!isQuickRoom && !session.firstTeamsSet) {
      setFirstTeamsOpen(true);
      return;
    }
    if (session.phase === 'playing') {
      setError(t('Record the result before picking the next beatmap.'));
      return;
    }
    if (!pending) {
      setError(t('The flow is complete.'));
      return;
    }
    const teamId = pending.side === 'team_one' ? session.teamOneId : session.teamTwoId;
    void run('action', () =>
      window.osmaRef.sessions.applyAction({
        sessionId: session.id,
        kind: pending.kind,
        teamId,
        slotLabel: slot.label,
        beatmapId: slot.beatmapId,
      }),
    );
  };

  const submitResult = async (rows: ResultRow[]) => {
    if (!session || !session.currentSlotLabel) return;
    await window.osmaRef.sessions.recordResult({
      sessionId: session.id,
      slotLabel: session.currentSlotLabel,
      scores: rows.map((row) => ({ ...row, mods: [] })),
      source: 'manual',
    });
  };

  const usedBySlot = useMemo(() => {
    const map = new Map<string, { kind: string; teamId: string | null }>();
    session?.actions.forEach((action) => {
      if (action.slotLabel && action.kind !== 'protect') {
        map.set(normalizeSlotLabel(action.slotLabel), { kind: action.kind, teamId: action.teamId });
      }
    });
    return map;
  }, [session]);

  const protectedBySlot = useMemo(() => {
    const map = new Map<string, string | null>();
    session?.actions.forEach((action) => {
      if (action.slotLabel && action.kind === 'protect') {
        map.set(normalizeSlotLabel(action.slotLabel), action.teamId);
      }
    });
    return map;
  }, [session]);

  const startColumnResize = (
    side: 'left' | 'right',
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const startX = event.clientX;
    const start = side === 'left' ? leftWidth : rightWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      const raw = side === 'left' ? start + delta : start - delta;
      const next = Math.max(side === 'left' ? 200 : 260, Math.min(520, raw));
      if (side === 'left') setLeftWidth(next);
      else setRightWidth(next);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing-columns');
    };
    document.body.classList.add('resizing-columns');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const startRowResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const height = container.getBoundingClientRect().height;
    const startY = event.clientY;
    const start = chatPercent;
    const move = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / Math.max(height, 1)) * 100;
      setChatPercent(Math.max(25, Math.min(75, start + delta)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing-rows');
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const startLeftRowResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const height = container.getBoundingClientRect().height;
    const startY = event.clientY;
    const start = roomsPercent;
    const move = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / Math.max(height, 1)) * 100;
      setRoomsPercent(Math.max(20, Math.min(80, start + delta)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing-rows');
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const startRightRowResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const height = container.getBoundingClientRect().height;
    const startY = event.clientY;
    const start = rightPercent;
    const move = (moveEvent: PointerEvent) => {
      const delta = ((moveEvent.clientY - startY) / Math.max(height, 1)) * 100;
      setRightPercent(Math.max(20, Math.min(80, start + delta)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.classList.remove('resizing-rows');
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  };

  const switchChannel = () => {
    const next = channel === 'irc' ? 'referee_hub' : 'irc';
    setChannel(next);
    const target = model.sessions.find((entry) => entry.transport === next) ?? null;
    setActiveId(target?.id ?? null);
    onSessionChange(target?.id ?? null);
  };

  useEffect(() => {
    saveWorkbenchLayout({
      leftWidth,
      rightWidth,
      chatPercent,
      roomsPercent,
      rightPercent,
    });
  }, [leftWidth, rightWidth, chatPercent, roomsPercent, rightPercent]);

  const filteredSlots = useMemo(() => {    if (!pool) return [];
    const query = poolSearch.trim().toLowerCase();
    if (!query) return pool.slots;
    return pool.slots.filter((slot) => {
      const info = beatmaps[slot.beatmapId];
      const haystack = [
        slot.label,
        String(slot.beatmapId),
        rulesetName(slot.rulesetId),
        info?.title ?? '',
        info?.artist ?? '',
        info?.difficultyName ?? '',
        info?.mapper ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [pool, poolSearch, beatmaps]);

  const actionLabel = pending
    ? `${t(pending.kind)}`
    : session?.status === 'finished'
      ? t('match finished')
      : t('flow complete');
  const channelLabel = channel === 'irc' ? 'IRC' : 'Referee Hub';

  return (
    <div className="page workbench-page">
      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}
      {model.state?.connections.some((entry) => entry.status === 'error') ? (
        <div className="banner warn">
          {t(
            'A connection reported an error. Check Settings → Diagnostics; room control needs an active transport.',
          )}
        </div>
      ) : null}

      {!session ? (
        <div
          className="workbench-grid sessionless"
          style={{ gridTemplateColumns: `${leftWidth}px` }}
        >
          <aside className="wb-column wb-left">
            <div className="wb-left-actions">
              <button type="button" className="ghost back-button" onClick={onBack}>
                {t('Back')}
              </button>
              <button type="button" className="primary small" onClick={() => setJoinOpen(true)}>
                {t('Join')}
              </button>
              <button
                type="button"
                className="ghost small wb-channel-button"
                onClick={switchChannel}
              >
                {t('Channel')}
              </button>
            </div>
            <Section
              title={t('Rooms')}
              actions={<span className="room-channel-label">{channelLabel}</span>}
            >
              <div className="room-list">
                {channelSessions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="room-list-item"
                    onClick={() => {
                      setActiveId(entry.id);
                      onSessionChange(entry.id);
                    }}
                  >
                    <span className="room-list-name">{entry.roomName ?? entry.matchName}</span>
                    <span className="room-list-meta">{roomRef(entry.roomId)}</span>
                  </button>
                ))}
                {channelSessions.length === 0 ? (
                  <p className="muted small">{t('No rooms in this channel.')}</p>
                ) : null}
              </div>
            </Section>
          </aside>
        </div>
      ) : (
        <div
          className="workbench-grid"
          style={{
            gridTemplateColumns: `${leftWidth}px 6px minmax(0, 1fr) 6px ${rightWidth}px`,
          }}
        >
          <aside className="wb-column wb-left">
            <div className="wb-left-actions">
              <button type="button" className="ghost back-button" onClick={onBack}>
                {t('Back')}
              </button>
              <button type="button" className="ghost back-button" onClick={() => setJoinOpen(true)}>
                {t('Join')}
              </button>
              <button
                type="button"
                className="ghost small wb-channel-button"
                onClick={switchChannel}
              >
                {t('Channel')}
              </button>
            </div>
            <div
              className="wb-left-split"
              style={{ gridTemplateRows: `minmax(80px, ${roomsPercent}%) 8px minmax(80px, 1fr)` }}
            >
              <div className="wb-panel">
                <Section
                  title={t('Rooms')}
                  actions={<span className="room-channel-label">{channelLabel}</span>}
                >
                  <div className="panel-scroll">
                    <div className="room-list">
                      {channelSessions.map((entry) => (
                        <button
                          key={entry.id}
                          type="button"
                          className={`room-list-item${entry.id === activeId ? ' active' : ''}`}
                          onClick={() => {
                            setActiveId(entry.id);
                            onSessionChange(entry.id);
                          }}
                        >
                          <span className="room-list-name">{entry.roomName ?? entry.matchName}</span>
                          <span className="room-list-meta">{roomRef(entry.roomId)}</span>
                        </button>
                      ))}
                      {channelSessions.length === 0 ? (
                        <p className="muted small">{t('No rooms in this channel.')}</p>
                      ) : null}
                    </div>
                  </div>
                </Section>
              </div>
              <div
                className="row-resizer"
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startLeftRowResize}
              />
              <div className="wb-panel">
                <Section
                  title={t('Players')}
                  actions={
                    <div className="player-invite">
                      <IdInput
                        kind="user"
                        allowUsername
                        className="compact-input"
                        value={inviteUser}
                        onChange={setInviteUser}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                          event.preventDefault();
                          if (busy !== null || !inviteUser.trim()) return;
                          void invitePlayer();
                        }}
                        placeholder={t('Username or #UID')}
                      />
                      <button
                        type="button"
                        className="ghost small"
                        disabled={busy !== null || !inviteUser.trim()}
                        onClick={() => void invitePlayer()}
                      >
                        {t('Invite')}
                      </button>
                    </div>
                  }
                >
                  <div className="panel-scroll">
                    {room ? (
                      playerRows.length > 0 ? (
                        <div className="player-list">
                          {playerRows.map(({ key, slot, player }) => (
                            <div
                              key={key}
                              className={`player-row${room.maxParticipants > 0 ? ' slotted' : ''}${
                                player
                                  ? ` ${player.team ?? 'none'}${
                                      player.status === 'ready'
                                        ? ' ready'
                                        : player.status === 'playing'
                                          ? ' playing'
                                          : ''
                                    }`
                                  : ' empty'
                              }`}
                            >
                              <span className="player-remove">
                                {player &&
                                session.transport === 'referee_hub' &&
                                session.status === 'active' ? (
                                  <button
                                    type="button"
                                    className="ghost small playlist-remove-button"
                                    title={t('Remove player')}
                                    aria-label={t('Remove player')}
                                    disabled={busy !== null}
                                    onClick={() => void kickPlayer(player)}
                                  >
                                    <span className="playlist-remove-icon" aria-hidden="true" />
                                  </button>
                                ) : null}
                              </span>
                              {room.maxParticipants > 0 ? (
                                <span className="player-slot">{slot !== null ? slot + 1 : '—'}</span>
                              ) : null}
                              <span className="player-name">
                                {player
                                  ? (player.username ??
                                    rosterName(player.userId) ??
                                    `#${player.userId}`)
                                  : '—'}
                              </span>
                              <span className="player-mods">
                                {player
                                  ? player.mods.length > 0
                                    ? player.mods.map((mod) => (
                                        <span className="mod-chip allowed" key={mod}>
                                          {mod}
                                        </span>
                                      ))
                                    : '—'
                                  : null}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="muted small">{t('No players in the room yet.')}</p>
                      )
                    ) : (
                      <p className="muted small">{t('Waiting for the first snapshot from the transport.')}</p>
                    )}
                  </div>
                </Section>
              </div>
            </div>
          </aside>

          <div
            className="column-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(event) => startColumnResize('left', event)}
          />

          <section className="wb-column wb-center">
            <div className="flat-scoreboard">
              <div className="score-side left">
                {pending?.side === 'team_one' ? (
                  <span className="score-action left">{actionLabel}</span>
                ) : null}
                <div
                  className={`flat-team red${pending?.side === 'team_one' ? ' active' : ''}`}
                  role="group"
                  title={t('left click +1') + ' / ' + t('right click -1')}
                  onClick={() => adjustScore('team_one', 1)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    adjustScore('team_one', -1);
                  }}
                >
                  <strong>{teamName(session.teamOneId)}</strong>
                  <span className="flat-score">{session.wins.team_one}</span>
                </div>
              </div>
              <span className="flat-dash">-</span>
              <div className="score-side right">
                <div
                  className={`flat-team blue${pending?.side === 'team_two' ? ' active' : ''}`}
                  role="group"
                  title={t('left click +1') + ' / ' + t('right click -1')}
                  onClick={() => adjustScore('team_two', 1)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    adjustScore('team_two', -1);
                  }}
                >
                  <span className="flat-score">{session.wins.team_two}</span>
                  <strong>{teamName(session.teamTwoId)}</strong>
                </div>
                {pending?.side === 'team_two' ? (
                  <span className="score-action right">{actionLabel}</span>
                ) : null}
                {session.phase === 'playing' && session.currentSlotLabel ? (
                  <button
                    type="button"
                    className="primary score-result"
                    onClick={() => setResultOpen(true)}
                  >
                    {t('Enter result — {slot}', { slot: session.currentSlotLabel })}
                  </button>
                ) : null}
              </div>
            </div>

            <div
              className="wb-split"
              style={{
                gridTemplateRows: `minmax(180px, ${chatPercent}%) 8px minmax(160px, 1fr)`,
              }}
            >
              <div className="wb-chat">
                <ChatPanel sessionId={session.id} transport={session.transport} />
              </div>

              <div
                className="row-resizer"
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startRowResize}
              />

              <div className="card playlist-panel">
                <div className="playlist-scroll">
              {room ? (
                <div className="room-playlist">
                  {session.transport === 'referee_hub' && session.status === 'active' ? (
                    <div className="playlist-head">
                      <div className="playlist-add">
                        <select
                          value={playlistRulesetId}
                          onChange={(event) => setPlaylistRulesetId(Number(event.target.value))}
                          aria-label={t('Mode')}
                        >
                          {[0, 1, 2, 3].map((rulesetId) => (
                            <option key={rulesetId} value={rulesetId}>
                              {rulesetName(rulesetId)}
                            </option>
                          ))}
                        </select>
                        <IdInput
                          value={playlistBeatmapId}
                          onChange={setPlaylistBeatmapId}
                          kind="beatmap"
                          className="compact-input"
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            if (busy !== null || !playlistBeatmapId) return;
                            void addPlaylistBeatmap();
                          }}
                          placeholder={t('Beatmap ID or link')}
                        />
                        <button
                          type="button"
                          className="ghost small"
                          disabled={busy !== null || !playlistBeatmapId}
                          onClick={() => void addPlaylistBeatmap()}
                        >
                          {t('Add')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {playlistViews.map((entry) => {
                    const info = beatmaps[entry.beatmapId];
                    const slotLabel =
                      pool?.slots.find((slot) => slot.beatmapId === entry.beatmapId)?.label ?? '';
                    return (
                      <div
                        className={`playlist-row${entry.active ? ' active' : ''}${entry.played ? ' played' : ''}`}
                        key={entry.key}
                      >
                        <span className="playlist-remove">
                          {session.transport === 'referee_hub' &&
                          session.status === 'active' &&
                          (entry.played || playlistViews.length > 1) ? (
                            <button
                              type="button"
                              className="ghost playlist-remove playlist-remove-button"
                              title={t('Remove from playlist')}
                              aria-label={t('Remove from playlist')}
                              disabled={busy !== null}
                              onClick={() => {
                                if (entry.item) void removePlaylistBeatmap(entry.item);
                              }}
                            >
                              <span className="playlist-remove-icon" aria-hidden="true" />
                            </button>
                          ) : null}
                        </span>
                        <span className="playlist-slot">
                          {slotLabel ? <span className="slot-tag">{slotLabel}</span> : null}
                        </span>
                        <div className="playlist-main">
                          <div className="beatmap-title">
                            {info
                              ? `${info.title} - ${info.artist}`
                              : `Beatmap #${entry.beatmapId}`}
                          </div>
                          <div className="beatmap-meta">
                            {entry.mode} #{entry.beatmapId}
                            {info?.difficultyName ? ` [${info.difficultyName}]` : ''} -{' '}
                            {info?.mapper || '—'}
                            {entry.played ? ` · ${t('played')}` : entry.active ? ` · ${t('next')}` : ''}
                          </div>
                        </div>
                        <div className="playlist-mods">
                          {entry.required.map((mod) => (
                            <span className="mod-chip required" key={`req-${mod}`}>
                              {mod}
                            </span>
                          ))}
                          {entry.allowed.map((mod) => (
                            <span className="mod-chip allowed" key={`allow-${mod}`}>
                              {mod}
                            </span>
                          ))}
                          {entry.freestyle ? (
                            <span className="mod-chip allowed">Freestyle</span>
                          ) : null}
                          {entry.required.length === 0 &&
                          entry.allowed.length === 0 &&
                          !entry.freestyle ? (
                            <span className="mod-chip">NM</span>
                          ) : null}
                        </div>
                        <span className="playlist-actions">
                          {session.transport === 'referee_hub' &&
                          session.status === 'active' ? (
                            <button
                              type="button"
                              className="ghost small"
                              disabled={busy !== null}
                              onClick={() => {
                                setModsEntry(entry.item);
                                setModsOpen(true);
                              }}
                            >
                              {t('Mods')}
                            </button>
                          ) : null}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted small">{t('Waiting for the first snapshot from the transport.')}</p>
              )}
                </div>
              </div>
            </div>
          </section>

          <div
            className="column-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={(event) => startColumnResize('right', event)}
          />

          <aside className="wb-column wb-right">
            <div className="card room-status-card">
              {room ? (
                <div className="room-status-line">
                  <span>{room.matchType === 'team_versus' ? 'Team VS.' : 'Head to Head'}</span>
                  <span className="status-sep" aria-hidden="true" />
                  <span>
                    {t('locked')}: {room.locked ? t('yes') : t('no')}
                  </span>
                  <span className="status-sep" aria-hidden="true" />
                  <span>
                    {t('size')}:{' '}
                    {room.maxParticipants === 0 ? t('unlimited') : room.maxParticipants}
                  </span>
                  {session.transport === 'irc' ? (
                    <>
                      <span className="status-sep" aria-hidden="true" />
                      <span>{room.winCondition ?? '—'}</span>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="muted small">{t('Waiting for the first snapshot from the transport.')}</p>
              )}
              <div className="room-status-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null || session.status !== 'active'}
                  onClick={() => setFirstTeamsOpen(true)}
                >
                  {t('First teams')}
                </button>
                {session.chatOnly ? (
                  <button
                    type="button"
                    className="ghost small danger"
                    disabled={busy !== null}
                    onClick={() => void leaveChatChannel()}
                  >
                    {t('Leave channel')}
                  </button>
                ) : session.status === 'active' ? (
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(t('Close this multiplayer room?'))) {
                        void run('close', async () => {
                          await window.osmaRef.sessions.close(session.id);
                          setActiveId(null);
                          onSessionChange(null);
                          await model.refreshSessions();
                        });
                      }
                    }}
                  >
                    {t('Close room')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ghost small danger"
                    disabled={busy !== null}
                    onClick={() => void removeSession(session.id)}
                  >
                    {t('Remove room')}
                  </button>
                )}
              </div>
            </div>

            <div
              className="wb-right-split"
              style={{
                gridTemplateRows: `minmax(120px, ${rightPercent}%) 8px minmax(160px, 1fr)`,
              }}
            >
              <div className="wb-panel mappool-panel">
                <Section title={t('Mappool')}>
                  {isQuickRoom ? (
                    <p className="muted small">{t('This match has no mappool.')}</p>
                  ) : (
                    <>
                      <input
                        className="pool-search"
                        value={poolSearch}
                        onChange={(event) => setPoolSearch(event.target.value)}
                        placeholder={t('Search mappool')}
                      />
                      <div className="panel-scroll">
                {!pool ? (
                  <p className="muted small">{t('This match has no mappool.')}</p>
                ) : filteredSlots.length === 0 ? (
                  <p className="muted small">{t('No matching mappool slots.')}</p>
                ) : (
                  <div className="pool-list">
                    {filteredSlots.map((slot) => {
                      const used = usedBySlot.get(normalizeSlotLabel(slot.label));
                      const protector = protectedBySlot.get(normalizeSlotLabel(slot.label));
                      const protectedSlot = protector !== undefined;
                      const current =
                        session.currentSlotLabel &&
                        normalizeSlotLabel(session.currentSlotLabel) ===
                          normalizeSlotLabel(slot.label);
                      const blockedByProtection =
                        (pending?.kind === 'ban' || pending?.kind === 'protect') && protectedSlot;
                      const actionable =
                        session.status === 'active' &&
                        !used &&
                        session.phase !== 'playing' &&
                        Boolean(pending) &&
                        !blockedByProtection;
                      const isLast =
                        session.status === 'active' &&
                        lastAction?.slotLabel !== null &&
                        lastAction?.slotLabel !== undefined &&
                        normalizeSlotLabel(lastAction.slotLabel) ===
                          normalizeSlotLabel(slot.label);
                      const info = beatmaps[slot.beatmapId];
                      const action: { kind: string; teamId: string | null } | null = used
                        ? used
                        : protectedSlot
                          ? { kind: 'protect', teamId: protector ?? null }
                          : null;
                      const teamClass =
                        action?.teamId === session.teamOneId
                          ? ' team-one'
                          : action?.teamId === session.teamTwoId
                            ? ' team-two'
                            : '';
                      const actionClass = action ? ` action-${action.kind}` : '';
                      return (
                        <div
                          key={slot.id}
                          className={`pool-row${teamClass}${actionClass}${
                            current ? ' current' : ''
                          }${actionable ? ' actionable' : ''}`}
                          role={actionable ? 'button' : undefined}
                          tabIndex={actionable ? 0 : -1}
                          onClick={() => {
                            if (actionable) applySlot(slot);
                          }}
                          onKeyDown={(event) => {
                            if (actionable && (event.key === 'Enter' || event.key === ' ')) {
                              event.preventDefault();
                              applySlot(slot);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (!isLast || busy !== null) return;
                            void run('undo', () =>
                              window.osmaRef.sessions.undo(session.id),
                            );
                          }}
                          title={`beatmap ${slot.beatmapId}${
                            action ? ` · ${action.kind} by ${teamName(action.teamId)}` : ''
                          }${isLast ? ` · ${t('right click to undo')}` : ''}`}
                        >
                          <span className="playlist-slot">
                            <span className="slot-tag">{slot.label}</span>
                          </span>
                          <div className="playlist-main">
                            <div className="beatmap-title">
                              {info
                                ? `${info.title} - ${info.artist}`
                                : `Beatmap #${slot.beatmapId}`}
                            </div>
                            <div className="beatmap-meta">
                              {info ? modeLabel(info.mode, slot.rulesetId) : rulesetName(slot.rulesetId)} #
                              {slot.beatmapId}
                              {info?.difficultyName ? ` [${info.difficultyName}]` : ''} -{' '}
                              {info?.mapper || '—'}
                            </div>
                          </div>
                          <div className="playlist-mods">
                            {slot.requiredMods.map((mod) => (
                              <span className="mod-chip required" key={`req-${mod}`}>
                                {mod}
                              </span>
                            ))}
                            {slot.allowedMods.map((mod) => (
                              <span className="mod-chip allowed" key={`allow-${mod}`}>
                                {mod}
                              </span>
                            ))}
                            {slot.freestyle ? (
                              <span className="mod-chip allowed">Freestyle</span>
                            ) : null}
                            {slot.requiredMods.length === 0 &&
                            slot.allowedMods.length === 0 &&
                            !slot.freestyle ? (
                              <span className="mod-chip">NM</span>
                            ) : null}
                          </div>
                          {action && action.kind !== 'pick' ? (
                            <span className="pool-overlay" aria-hidden="true">
                              <span className="pool-overlay-icon" />
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
                      </div>
                    </>
                  )}
                </Section>
              </div>

              <div
                className="row-resizer"
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startRightRowResize}
              />

              <div className="wb-panel results-panel">
                <Section title={t('Results')}>
                  <div className="panel-scroll">
              {session.results.length === 0 ? (
                <p className="muted small">{t('No results recorded yet.')}</p>
              ) : (
                <div className="result-history">
                  {[...session.results].reverse().map((result) => {
                    const info = beatmaps[result.beatmapId];
                    const winner =
                      result.winner === 'team_one'
                        ? teamName(session.teamOneId)
                        : result.winner === 'team_two'
                          ? teamName(session.teamTwoId)
                          : null;
                    return (
                      <div className="result-history-item" key={result.id}>
                        <div className="result-history-head">
                          <span className="slot-tag">{result.slotLabel}</span>
                          <span className="beatmap-title">
                            {info
                              ? `${info.title} - ${info.artist}`
                              : `Beatmap #${result.beatmapId}`}
                          </span>
                          <span className="muted small">
                            {winner ?? (result.needsReview ? t('Needs review') : '—')}
                          </span>
                        </div>
                        <div className="result-history-scores">
                          {[...result.scores]
                            .sort((a, b) => b.score - a.score)
                            .map((score) => (
                              <div className="result-score-row" key={score.userId}>
                                <span className="result-score-name">
                                  {score.username ??
                                    room?.players.find(
                                      (player) => player.userId === score.userId,
                                    )?.username ??
                                    rosterName(score.userId) ??
                                    `#${score.userId}`}
                                </span>
                                <span className="result-score-value">
                                  {score.score.toLocaleString()}
                                </span>
                                <span className="result-score-meta">
                                  {score.accuracy > 0
                                    ? `${(score.accuracy * 100).toFixed(2)}%`
                                    : '—'}
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
                  </div>
                </Section>
              </div>
            </div>
          </aside>
        </div>
      )}

      {resultOpen && session && tournament && session.currentSlotLabel ? (
        <ResultDialog
          session={session}
          tournament={tournament}
          slotLabel={session.currentSlotLabel}
          onClose={() => setResultOpen(false)}
          onSubmit={submitResult}
        />
      ) : null}
      {modsOpen && modsEntry ? (
        <PlaylistModsDialog
          entry={modsEntry}
          onClose={() => {
            setModsOpen(false);
            setModsEntry(null);
          }}
          onSave={savePlaylistMods}
        />
      ) : null}
      {firstTeamsOpen && session ? (
        <FirstTeamsDialog
          session={session}
          onClose={() => setFirstTeamsOpen(false)}
          onSave={saveFirstTeams}
        />
      ) : null}
      {joinOpen ? (
        <JoinRoomDialog
          initialTransport={channel}
          onClose={() => setJoinOpen(false)}
          onJoined={(joined) => {
            setActiveId(joined.id);
            onSessionChange(joined.id);
            void model.refreshSessions();
          }}
        />
      ) : null}
    </div>
  );
}

interface WorkbenchLayout {
  leftWidth: number;
  rightWidth: number;
  chatPercent: number;
  roomsPercent: number;
  rightPercent: number;
}

const WORKBENCH_LAYOUT_KEY = 'osmaRef.workbench.layout';

function loadWorkbenchLayout(): WorkbenchLayout {
  const fallback = {
    leftWidth: 260,
    rightWidth: 340,
    chatPercent: 55,
    roomsPercent: 45,
    rightPercent: 40,
  };
  try {
    const raw = window.localStorage.getItem(WORKBENCH_LAYOUT_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<WorkbenchLayout>;
    return {
      leftWidth: clampLayout(parsed.leftWidth, 200, 520, fallback.leftWidth),
      rightWidth: clampLayout(parsed.rightWidth, 260, 520, fallback.rightWidth),
      chatPercent: clampLayout(parsed.chatPercent, 25, 75, fallback.chatPercent),
      roomsPercent: clampLayout(parsed.roomsPercent, 20, 80, fallback.roomsPercent),
      rightPercent: clampLayout(parsed.rightPercent, 20, 80, fallback.rightPercent),
    };
  } catch {
    return fallback;
  }
}

function saveWorkbenchLayout(layout: WorkbenchLayout): void {
  try {
    window.localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Layout persistence is best effort.
  }
}

function clampLayout(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function rulesetName(rulesetId: number): string {
  return (
    {
      0: 'osu!',
      1: 'osu!taiko',
      2: 'osu!catch',
      3: 'osu!mania',
    }[rulesetId] ?? `ruleset ${rulesetId}`
  );
}

function roomRef(roomId: string | null): string {
  if (!roomId) return '—';
  if (/^\d+$/.test(roomId)) return `#${roomId}`;
  return roomId;
}

function modeLabel(mode: string, fallbackRulesetId: number): string {
  switch (mode.toLowerCase()) {
    case 'osu':
      return 'osu!';
    case 'taiko':
      return 'osu!taiko';
    case 'fruits':
    case 'catch':
      return 'osu!catch';
    case 'mania':
      return 'osu!mania';
    default:
      return rulesetName(fallbackRulesetId);
  }
}

function ScoreCard({
  name,
  wins,
  color,
  active,
  label,
  onAdjust,
}: {
  name: string;
  wins: number;
  color: 'red' | 'blue';
  active: boolean;
  label: string;
  onAdjust: (delta: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className={`score-card ${color}${active ? ' active' : ''}`}
      role="group"
      aria-label={`${label} ${name}: ${wins}`}
      title={`${t('left click +1')} / ${t('right click -1')}`}
      onClick={() => onAdjust(1)}
      onContextMenu={(event) => {
        event.preventDefault();
        onAdjust(-1);
      }}
    >
      <span className="muted small">{label}</span>
      <strong>{name}</strong>
      <span className="score-number">{wins}</span>
    </div>
  );
}
