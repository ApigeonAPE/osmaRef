import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  findMatch,
  findSlotByLabel,
  findStageForMatch,
  normalizeSlotLabel,
  type MappoolSlot,
  type PlaylistEntry,
  type BeatmapInfo,
  type BeatmapLookupFailure,
  type RoomPlayer,
  type Platform,
} from '@osmaref/contracts';
import {
  formatRandomPickMessage,
  parseRollReply,
  shuffleSlots,
  type RollReply,
} from '@osmaref/domain';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Empty, Section } from '../ui';
import { ChatPanel } from '../components/ChatPanel';
import { FirstTeamsDialog } from '../components/FirstTeamsDialog';
import { BindMatchDialog } from '../components/BindMatchDialog';
import { PlaylistModsDialog } from '../components/PlaylistModsDialog';
import { JoinRoomDialog } from '../components/JoinRoomDialog';
import { useToast } from '../toast';
import { IdInput } from '../components/IdInput';
import { ResultDialog, type ResultRow } from '../components/ResultDialog';
import { MappoolSlotRow } from '../components/MappoolSlotRow';
import { RandomPickDialog, type RandomPickScope } from '../components/RandomPickDialog';
import { RandomRollDialog } from '../components/RandomRollDialog';

const DEFAULT_RANDOM_PROMPT = 'Will pick ONE map randomly from the list below.';
/** Chat backends rate-limit bursts; keep the pool listing readable and deliverable. */
const RANDOM_PICK_SEND_INTERVAL_MS = 400;
const ROLL_LISTEN_TIMEOUT_MS = 10_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RollWait {
  sessionId: string;
  platform: Platform;
  baseline: Set<string>;
}

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
  const toast = useToast();
  const [activeId, setActiveId] = useState<string | null>(sessionId);
  const initialSession = model.sessions.find((entry) => entry.id === sessionId);
  const [channel, setChannel] = useState<'irc' | 'referee_hub'>(
    initialSession?.transport ?? loadWorkbenchLayout().channel,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false);
  const [firstTeamsOpen, setFirstTeamsOpen] = useState(false);
  const [bindOpen, setBindOpen] = useState(false);
  const [playlistBeatmapId, setPlaylistBeatmapId] = useState('');
  const [playlistRulesetId, setPlaylistRulesetId] = useState(0);
  const [inviteUser, setInviteUser] = useState('');
  const [poolSearch, setPoolSearch] = useState('');
  const [resultTab, setResultTab] = useState<'results' | 'teams'>('results');
  const [leftWidth, setLeftWidth] = useState(() => loadWorkbenchLayout().leftWidth);
  const [rightWidth, setRightWidth] = useState(() => loadWorkbenchLayout().rightWidth);
  const [chatPercent, setChatPercent] = useState(() => loadWorkbenchLayout().chatPercent);
  const [roomsPercent, setRoomsPercent] = useState(() => loadWorkbenchLayout().roomsPercent);
  const [rightPercent, setRightPercent] = useState(() => loadWorkbenchLayout().rightPercent);
  const [joinOpen, setJoinOpen] = useState(false);
  const [modsOpen, setModsOpen] = useState(false);
  const [modsEntry, setModsEntry] = useState<PlaylistEntry | null>(null);
  const [startCountdown, setStartCountdown] = useState('10');
  const [startConfirming, setStartConfirming] = useState(false);
  const startConfirmRef = useRef<{ firstAt: number; timeout: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const [randomOpen, setRandomOpen] = useState(false);
  const [randomScope, setRandomScope] = useState<RandomPickScope>('remaining');
  const [randomPrompt, setRandomPrompt] = useState(DEFAULT_RANDOM_PROMPT);
  const [randomSlots, setRandomSlots] = useState<MappoolSlot[]>([]);
  const [randomConfirming, setRandomConfirming] = useState(false);
  const randomConfirmRef = useRef<{ firstAt: number; timeout: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const randomFlowRef = useRef<{ id: number; slots: MappoolSlot[] } | null>(null);
  const [rollWait, setRollWait] = useState<RollWait | null>(null);
  const [rollSlots, setRollSlots] = useState<MappoolSlot[]>([]);
  const [rollResult, setRollResult] = useState<{
    username: string;
    score: string;
    index: string;
  } | null>(null);
  const finishRollRef = useRef<(reply: RollReply | null) => void>(() => {});
  const messagesRef = useRef(model.messages);
  messagesRef.current = model.messages;
  const [resizing, setResizing] = useState<string | null>(null);

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
      channelSessions.find(
        (session) =>
          (session.status === 'active' || session.status === 'finished') &&
          session.roomId !== null,
      ) ??
      channelSessions[0] ??
      null;
    setActiveId(preferred?.id ?? null);
  }, [channelSessions, model.state?.activeSessionId, activeId]);

  useEffect(() => {
    return () => {
      if (startConfirmRef.current) clearTimeout(startConfirmRef.current.timeout);
      if (randomConfirmRef.current) clearTimeout(randomConfirmRef.current.timeout);
    };
  }, []);

  useEffect(() => {
    if (!startConfirmRef.current) return;
    clearTimeout(startConfirmRef.current.timeout);
    startConfirmRef.current = null;
    setStartConfirming(false);
  }, [activeId]);

  useEffect(() => {
    randomFlowRef.current = null;
    if (randomConfirmRef.current) {
      clearTimeout(randomConfirmRef.current.timeout);
      randomConfirmRef.current = null;
    }
    setRandomConfirming(false);
    setRandomOpen(false);
    setRollWait(null);
    setRollSlots([]);
    setRollResult(null);
  }, [activeId]);

  finishRollRef.current = (reply) => {
    if (!randomFlowRef.current) return;
    setRollWait(null);
    setRollResult({
      username: reply?.username ?? '',
      score: reply ? String(reply.score) : '',
      index: reply ? String(reply.score) : '',
    });
  };

  useEffect(() => {
    if (!rollWait) return;
    const reply = messagesRef.current.reduce<RollReply | null>((found, message) => {
      if (found) return found;
      if (message.sessionId !== rollWait.sessionId || message.self) return null;
      if (rollWait.baseline.has(message.id)) return null;
      const fromBot =
        rollWait.platform === 'stable'
          ? message.username.toLowerCase() === 'banchobot'
          : message.system;
      return fromBot ? parseRollReply(message.text, rollWait.platform) : null;
    }, null);
    if (reply) finishRollRef.current(reply);
  }, [model.messages, rollWait]);

  useEffect(() => {
    if (!rollWait) return;
    const timer = setTimeout(() => finishRollRef.current(null), ROLL_LISTEN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [rollWait]);

  const session = model.sessions.find((entry) => entry.id === activeId) ?? null;
  // A finished match does not close its room: keep every room operation
  // available until the referee actually closes it.
  const roomOpen = session?.status === 'active' || session?.status === 'finished';
  const tournament = session
    ? session.configSnapshot ?? model.tournaments.find((entry) => entry.id === session.tournamentId) ?? null
    : null;
  const isQuickRoom = Boolean(
    session && (session.tournamentId.startsWith('adhoc_') || tournament?.id.startsWith('adhoc_')),
  );
  const coverTournamentId = tournament && !isQuickRoom ? tournament.id : undefined;
  const match = session && tournament ? findMatch(tournament, session.matchId) ?? null : null;
  const round = session && tournament && match ? findStageForMatch(tournament, match.id) ?? null : null;
  const pool = useMemo(() => (round ? { slots: round.slots } : null), [round]);
  const platform: Platform =
    tournament?.platform ?? (session?.transport === 'referee_hub' ? 'lazer' : 'stable');
  const pending = session ? session.queue[session.cursor] ?? null : null;
  const lastAction = session?.actions.at(-1) ?? null;
  const room = session ? model.snapshots[session.id] ?? null : null;
  const [beatmaps, setBeatmaps] = useState<Record<number, BeatmapInfo>>({});
  const [beatmapFailures, setBeatmapFailures] = useState<Record<number, BeatmapLookupFailure>>({});
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const beatmapCache = useRef<Record<number, BeatmapInfo>>({});
  // Mappool slots already carry metadata saved from the tournament config.
  const savedBeatmaps = useMemo(() => {
    const map: Record<number, BeatmapInfo> = {};
    pool?.slots.forEach((slot) => {
      if (!slot.beatmap) return;
      map[slot.beatmapId] = { ...slot.beatmap, mode: 'osu' };
    });
    return map;
  }, [pool]);
  const resolvedBeatmaps = useMemo(
    () => ({ ...savedBeatmaps, ...beatmaps }),
    [savedBeatmaps, beatmaps],
  );
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
    // The mappool is the authoritative list: a room may have no playlist yet,
    // and the slot thumbnails must still resolve before the first pick.
    round?.slots.forEach((slot) => ids.add(slot.beatmapId));
    playlist.forEach((entry) => ids.add(entry.beatmapId));
    if (room?.currentBeatmapId) ids.add(room.currentBeatmapId);
    if (session?.currentBeatmapId) ids.add(session.currentBeatmapId);
    return [...ids]
      .filter((id) => {
        if (!Number.isSafeInteger(id) || id <= 0) return false;
        const saved = savedBeatmaps[id];
        // A saved slot is used as is unless it still points at the remote cover;
        // that one lookup copies the image into the tournament's cover folder.
        return !saved || saved.coverUrl === '' || /^https?:\/\//i.test(saved.coverUrl);
      })
      .sort((a, b) => a - b);
  }, [round, playlist, room?.currentBeatmapId, session?.currentBeatmapId, savedBeatmaps]);
  const beatmapKey = beatmapIds.join(',');
  const failedCount = Object.values(beatmapFailures).filter(
    (failure) => !failure.notFound,
  ).length;

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
    const missing = beatmapIds.filter(
      (id) => !beatmapCache.current[id] && beatmapFailures[id] === undefined,
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void window.osmaRef.osu
      .lookupBeatmaps({ ids: missing, tournamentId: coverTournamentId })
      .then((result) => {
        for (const info of result.beatmaps) beatmapCache.current[info.id] = info;
        if (cancelled) return;
        setBeatmaps({ ...beatmapCache.current });
        if (result.failed.length > 0) {
          setBeatmapFailures((previous) => {
            const next = { ...previous };
            for (const failure of result.failed) next[failure.id] = failure;
            return next;
          });
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setBeatmapFailures((previous) => {
          const next = { ...previous };
          for (const id of missing) next[id] = { id, message, notFound: false };
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [beatmapKey, lookupAttempt, coverTournamentId]);

  const retryBeatmapLookup = () => {
    setBeatmapFailures((previous) => {
      const next: Record<number, BeatmapLookupFailure> = {};
      for (const [id, failure] of Object.entries(previous)) {
        if (failure.notFound) next[Number(id)] = failure;
      }
      return next;
    });
    setLookupAttempt((value) => value + 1);
  };

  const teamName = (id: string | null | undefined): string =>
    (tournament?.teams.find((team) => String(team.id) === id)?.name ?? id ?? '—') as string;

  const rosterName = (userId: number): string | undefined =>
    tournament?.teams
      .flatMap((team) => team.members)
      .find((member) => member.userId === userId)?.username;

  const teamForUser = (userId: number): 'red' | 'blue' | null => {
    const player =
      session?.matchPlayers.find((entry) => entry.userId === userId) ??
      room?.players.find((entry) => entry.userId === userId);
    if (player?.team) return player.team;
    const redTeam = tournament?.teams.find((team) => String(team.id) === session?.teamOneId);
    if (redTeam?.members.some((member) => member.userId === userId)) return 'red';
    const blueTeam = tournament?.teams.find((team) => String(team.id) === session?.teamTwoId);
    if (blueTeam?.members.some((member) => member.userId === userId)) return 'blue';
    return null;
  };

  const matchTeams = [session?.teamOneId, session?.teamTwoId].flatMap((id, index) => {
    const team = tournament?.teams.find((entry) => String(entry.id) === id);
    return team ? [{ team, side: index === 0 ? ('red' as const) : ('blue' as const) }] : [];
  });

  const inviteMember = async (userId: number) => {
    if (!session) return;
    await run(`invite-${userId}`, () =>
      window.osmaRef.sessions.invitePlayer({ sessionId: session.id, user: `#${userId}` }),
    );
  };

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
    busyRef.current = label;
    setBusy(label);
    try {
      await action();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = null;
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
    if (!session || (session.status !== 'active' && session.status !== 'finished')) return;
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

  const startMatch = async () => {
    if (!session) return;
    const countdown = startCountdown === 'none' ? null : Number(startCountdown);
    await run('start', () =>
      window.osmaRef.sessions.startMatch({ sessionId: session.id, countdown }),
    );
  };

  const resetStartConfirm = () => {
    if (startConfirmRef.current) {
      clearTimeout(startConfirmRef.current.timeout);
      startConfirmRef.current = null;
    }
    setStartConfirming(false);
  };

  const handleStartClick = () => {
    const now = Date.now();
    const pending = startConfirmRef.current;
    if (!pending) {
      const timeout = setTimeout(() => {
        startConfirmRef.current = null;
        setStartConfirming(false);
      }, 5000);
      startConfirmRef.current = { firstAt: now, timeout };
      setStartConfirming(true);
      return;
    }
    const elapsed = now - pending.firstAt;
    if (elapsed < 500) return;
    if (elapsed >= 5000) {
      resetStartConfirm();
      return;
    }
    resetStartConfirm();
    void startMatch();
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

  const isLobby = session?.matchKind === 'lobby';

  const applySlot = (slot: MappoolSlot) => {
    if (!session || busyRef.current !== null) return;
    if (isLobby || session.status === 'finished') {
      void run('select', () =>
        window.osmaRef.sessions.selectBeatmap({
          sessionId: session.id,
          slotLabel: slot.label,
        }),
      );
      return;
    }
    if (!isQuickRoom && !session.firstTeamsSet) {
      setFirstTeamsOpen(true);
      return;
    }
    if (session.phase === 'playing') {
      toast.error(t('Record the result before picking the next beatmap.'));
      return;
    }
    if (!pending) {
      toast.error(t('The flow is complete.'));
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

  /** Chat chip tooltip: slot label, beatmap, and the action a click would take. */
  const slotHint = (slot: MappoolSlot): string => {
    const lines = [slot.label];
    const beatmap = slot.beatmap;
    if (beatmap?.title) {
      lines.push(beatmap.difficultyName ? `${beatmap.title} [${beatmap.difficultyName}]` : beatmap.title);
    }
    if (pending) {
      const team = teamName(pending.side === 'team_one' ? session?.teamOneId : session?.teamTwoId);
      lines.push(`${t(pending.kind)} ${team}`);
    }
    return lines.join('\n');
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

  const resetRandomConfirm = () => {
    if (randomConfirmRef.current) {
      clearTimeout(randomConfirmRef.current.timeout);
      randomConfirmRef.current = null;
    }
    setRandomConfirming(false);
  };

  const scopeCandidates = (scope: RandomPickScope): MappoolSlot[] => {
    const all = pool?.slots ?? [];
    if (scope === 'all') return all;
    return all.filter((slot) => !usedBySlot.has(normalizeSlotLabel(slot.label)));
  };

  const abortRandomFlow = () => {
    randomFlowRef.current = null;
    resetRandomConfirm();
    setRandomOpen(false);
    setRollWait(null);
    setRollSlots([]);
    setRollResult(null);
  };

  const openRandomPick = () => {
    if (!pool || pool.slots.length === 0) return;
    abortRandomFlow();
    setRandomScope('remaining');
    setRandomSlots(shuffleSlots(scopeCandidates('remaining')));
    setRandomOpen(true);
  };

  const changeRandomScope = (scope: RandomPickScope) => {
    resetRandomConfirm();
    setRandomScope(scope);
    setRandomSlots(shuffleSlots(scopeCandidates(scope)));
  };

  const confirmRandomRoll = (slot: MappoolSlot) => {
    randomFlowRef.current = null;
    setRollWait(null);
    setRollResult(null);
    applySlot(slot);
  };

  const startRandomFlow = () => {
    if (!session || randomSlots.length === 0) return;
    const flowSlots = randomSlots;
    const flow = { id: (randomFlowRef.current?.id ?? 0) + 1, slots: flowSlots };
    randomFlowRef.current = flow;
    const cancelled = () => randomFlowRef.current !== flow;
    setRandomOpen(false);
    const target = session;
    void (async () => {
      try {
        const prompt = randomPrompt.trim();
        if (prompt) {
          await model.sendChat(target.id, prompt);
          if (cancelled()) return;
          await delay(RANDOM_PICK_SEND_INTERVAL_MS);
        }
        for (let index = 0; index < flowSlots.length; index += 1) {
          if (cancelled()) return;
          const slot = flowSlots[index];
          if (!slot) continue;
          await model.sendChat(
            target.id,
            formatRandomPickMessage(index + 1, slot, resolvedBeatmaps[slot.beatmapId]),
          );
          if (cancelled()) return;
          await delay(RANDOM_PICK_SEND_INTERVAL_MS);
        }
        if (cancelled()) return;
        setRollSlots(flowSlots);
        setRollWait({
          sessionId: target.id,
          platform,
          baseline: new Set(messagesRef.current.map((message) => message.id)),
        });
        await model.sendChat(
          target.id,
          `${platform === 'stable' ? '!roll' : '/roll'} ${flowSlots.length}`,
        );
      } catch (cause) {
        if (cancelled()) return;
        abortRandomFlow();
        toast.error(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  };

  const handleRandomConfirmClick = () => {
    const now = Date.now();
    const pending = randomConfirmRef.current;
    if (!pending) {
      const timeout = setTimeout(() => {
        randomConfirmRef.current = null;
        setRandomConfirming(false);
      }, 5000);
      randomConfirmRef.current = { firstAt: now, timeout };
      setRandomConfirming(true);
      return;
    }
    const elapsed = now - pending.firstAt;
    if (elapsed < 500) return;
    if (elapsed >= 5000) {
      resetRandomConfirm();
      return;
    }
    resetRandomConfirm();
    startRandomFlow();
  };

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
      setResizing(null);
    };
    setResizing(side === 'left' ? 'column-left' : 'column-right');
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
      setResizing(null);
    };
    setResizing('row-center');
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
      setResizing(null);
    };
    setResizing('row-left');
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
      setResizing(null);
    };
    setResizing('row-right');
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
      channel,
    });
  }, [leftWidth, rightWidth, chatPercent, roomsPercent, rightPercent, channel]);

  const filteredSlots = useMemo(() => {
    if (!pool) return [];
    const query = poolSearch.trim().toLowerCase();
    if (!query) return pool.slots;
    return pool.slots.filter((slot) => {
      const info = resolvedBeatmaps[slot.beatmapId];
      const haystack = [
        slot.label,
        String(slot.beatmapId),
        rulesetName(slot.rulesetId ?? 0),
        info?.title ?? '',
        info?.artist ?? '',
        info?.difficultyName ?? '',
        info?.mapper ?? '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [pool, poolSearch, resolvedBeatmaps]);

  const actionLabel = pending
    ? `${t(pending.kind)}`
    : session?.status === 'finished'
      ? t('match finished')
      : t('flow complete');
  const channelLabel = channel === 'irc' ? 'stable' : 'lazer';

  return (
    <div className="page workbench-page">
            {model.state?.connections.some((entry) => entry.status === 'error') ? (
        <div className="banner warn">
          {t(
            'A connection reported an error. Check Settings → Diagnostics; room control needs an active platform.',
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
                {t('Platform')}
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
                {t('Platform')}
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
                className={`row-resizer${resizing === 'row-left' ? ' active' : ''}`}
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startLeftRowResize}
              />
              <div className="wb-panel">
                <Section
                  title={t('Players')}
                  className="section-with-invite"
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
                                roomOpen ? (
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
                      <p className="muted small">{t('Waiting for the first snapshot from the platform.')}</p>
                    )}
                  </div>
                </Section>
              </div>
            </div>
          </aside>

          <div
            className={`column-resizer${resizing === 'column-left' ? ' active' : ''}`}
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
                  title={isLobby ? undefined : t('left click +1') + ' / ' + t('right click -1')}
                  onClick={() => { if (!isLobby) adjustScore('team_one', 1); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!isLobby) adjustScore('team_one', -1);
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
                  title={isLobby ? undefined : t('left click +1') + ' / ' + t('right click -1')}
                  onClick={() => { if (!isLobby) adjustScore('team_two', 1); }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    if (!isLobby) adjustScore('team_two', -1);
                  }}
                >
                  <span className="flat-score">{session.wins.team_two}</span>
                  <strong>{teamName(session.teamTwoId)}</strong>
                </div>
                {pending?.side === 'team_two' ? (
                  <span className="score-action right">{actionLabel}</span>
                ) : null}
                {!isLobby && session.phase === 'playing' && session.currentSlotLabel ? (
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
                <ChatPanel
                  sessionId={session.id}
                  transport={session.transport}
                  slots={pool?.slots}
                  onSelectSlot={applySlot}
                  slotHint={slotHint}
                />
              </div>

              <div
                className={`row-resizer${resizing === 'row-center' ? ' active' : ''}`}
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startRowResize}
              />

              <div className="card playlist-panel">
                <div className="playlist-scroll">
              {room ? (
                <div className="room-playlist">
                  {roomOpen ? (
                    <div className="playlist-head">
                      <div className="playlist-start">
                        <select
                          value={startCountdown}
                          onChange={(event) => setStartCountdown(event.target.value)}
                          aria-label={t('Countdown')}
                        >
                          <option value="none">{t('No countdown')}</option>
                          {[5, 10, 15, 30, 60].map((seconds) => (
                            <option key={seconds} value={seconds}>
                              {seconds}s
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={`primary small${startConfirming ? ' confirm-start' : ''}`}
                          disabled={busy !== null || !session.roomId}
                          onClick={handleStartClick}
                        >
                          {startConfirming ? t('Confirm?') : t('Start')}
                        </button>
                      </div>
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
                          {session.transport === 'referee_hub' ? t('Add') : t('Change')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {playlistViews.map((entry) => {
                    const info = resolvedBeatmaps[entry.beatmapId];
                    const failure = beatmapFailures[entry.beatmapId];
                    const slotLabel =
                      pool?.slots.find((slot) => slot.beatmapId === entry.beatmapId)?.label ?? '';
                    return (
                      <div
                        className={`playlist-row${entry.active ? ' active' : ''}${entry.played ? ' played' : ''}`}
                        key={entry.key}
                      >
                        <span className="playlist-remove">
                          {session.transport === 'referee_hub' &&
                          roomOpen &&
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
                            {!info && failure ? (
                              <span
                                className={`beatmap-state${failure.notFound ? ' missing' : ' failed'}`}
                                title={failure.message}
                              >
                                {failure.notFound ? t('not found') : t('lookup failed')}
                              </span>
                            ) : null}
                          </div>
                          <div className="beatmap-meta">
                            {entry.mode} #{entry.beatmapId}
                            {info?.difficultyName ? ` [${info.difficultyName}]` : ''} -{' '}
                            {info?.mapper || '—'}
                            {entry.played ? ` (${t('played')})` : entry.active ? ` (${t('next')})` : ''}
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
                          roomOpen ? (
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
                <p className="muted small">{t('Waiting for the first snapshot from the platform.')}</p>
              )}
                </div>
              </div>
            </div>
          </section>

          <div
            className={`column-resizer${resizing === 'column-right' ? ' active' : ''}`}
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
                <p className="muted small">{t('Waiting for the first snapshot from the platform.')}</p>
              )}
              <div className="room-status-actions">
                <button
                  type="button"
                  className="ghost small"
                  disabled={busy !== null || !roomOpen}
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
                ) : roomOpen ? (
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
                {session.chatOnly ? null : (
                  <button
                    type="button"
                    className="ghost small"
                    disabled={busy !== null}
                    onClick={() => setBindOpen(true)}
                  >
                    {t('Competition settings')}
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
                <Section
                  actions={
                    <div className="pool-head-actions">
                      <div className="pool-head-left">
                        <button
                          type="button"
                          className="ghost small"
                          onClick={openRandomPick}
                          disabled={isQuickRoom || !pool || pool.slots.length === 0}
                        >
                          {t('Random')}
                        </button>
                        {failedCount > 0 ? (
                          <button type="button" className="ghost small" onClick={retryBeatmapLookup}>
                            {t('Retry')}
                          </button>
                        ) : null}
                      </div>
                      <input
                        className="compact-input pool-search"
                        value={poolSearch}
                        onChange={(event) => setPoolSearch(event.target.value)}
                        placeholder={t('Search mappool')}
                      />
                    </div>
                  }
                >
                  {isQuickRoom ? (
                    <p className="muted small">{t('This match has no mappool.')}</p>
                  ) : (
                    <>
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
                        busy === null &&
                        roomOpen &&
                        (isLobby ||
                          session.status === 'finished' ||
                          (!used &&
                            session.phase !== 'playing' &&
                            Boolean(pending) &&
                            !blockedByProtection));
                      const isLast =
                        roomOpen &&
                        lastAction?.slotLabel !== null &&
                        lastAction?.slotLabel !== undefined &&
                        normalizeSlotLabel(lastAction.slotLabel) ===
                          normalizeSlotLabel(slot.label);
                      const info = resolvedBeatmaps[slot.beatmapId];
                      const failure = beatmapFailures[slot.beatmapId];
                      const action: { kind: string; teamId: string | null } | null = used
                        ? used
                        : protectedSlot
                          ? { kind: 'protect', teamId: protector ?? null }
                          : null;
                      return (
                        <MappoolSlotRow
                          key={slot.id}
                          slot={slot}
                          info={info}
                          failure={failure}
                                          action={action}
                          current={Boolean(current)}
                          actionable={actionable}
                          teamOneId={session.teamOneId}
                          teamTwoId={session.teamTwoId}
                          title={`beatmap ${slot.beatmapId}${
                            action ? `, ${action.kind} by ${teamName(action.teamId)}` : ''
                          }${failure ? `, ${failure.message}` : ''}`}
                          onActivate={() => applySlot(slot)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            if (!isLast || busy !== null) return;
                            void run('undo', () => window.osmaRef.sessions.undo(session.id));
                          }}
                        />
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
                className={`row-resizer${resizing === 'row-right' ? ' active' : ''}`}
                role="separator"
                aria-orientation="horizontal"
                onPointerDown={startRightRowResize}
              />

              <div className="wb-panel results-panel">
                <Section
                  actions={
                    <div className="result-tabs">
                      <button
                        type="button"
                        className={`tab small${resultTab === 'results' ? ' active' : ''}`}
                        onClick={() => setResultTab('results')}
                      >
                        {t('Results')}
                      </button>
                      <button
                        type="button"
                        className={`tab small${resultTab === 'teams' ? ' active' : ''}`}
                        onClick={() => setResultTab('teams')}
                      >
                        {t('Teams')}
                      </button>
                    </div>
                  }
                >
                  <div className="panel-scroll">
                    {resultTab === 'results' ? (
                      session.results.length === 0 ? (
                        <p className="muted small">{t('No results recorded yet.')}</p>
                      ) : (
                        <div className="result-history">
                          {[...session.results].reverse().map((result) => {
                            const info = resolvedBeatmaps[result.beatmapId];
                            const winner =
                              result.winner === 'team_one'
                                ? teamName(session.teamOneId)
                                : result.winner === 'team_two'
                                  ? teamName(session.teamTwoId)
                                  : null;
                            const scores = [...result.scores].sort((a, b) => b.score - a.score);
                            const grouped = {
                              red: scores.filter((score) => teamForUser(score.userId) === 'red'),
                              blue: scores.filter((score) => teamForUser(score.userId) === 'blue'),
                              neutral: scores.filter((score) => teamForUser(score.userId) === null),
                            };
                            const totals = {
                              red: grouped.red.reduce((sum, score) => sum + score.score, 0),
                              blue: grouped.blue.reduce((sum, score) => sum + score.score, 0),
                            };
                            const { team_one, team_two } = result.teamValues;
                            const diff =
                              team_one !== null && team_two !== null
                                ? Math.abs(team_one - team_two)
                                : grouped.red.length > 0 && grouped.blue.length > 0
                                  ? Math.abs(totals.red - totals.blue)
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
                                </div>
                                <div className="result-diff">
                                  <span className="result-diff-value">
                                    {diff === null ? '—' : diff.toLocaleString()}
                                  </span>
                                  <span className="muted small">-</span>
                                  <span
                                    className={`result-diff-winner${
                                      result.winner === 'team_one'
                                        ? ' red'
                                        : result.winner === 'team_two'
                                          ? ' blue'
                                          : ''
                                    }`}
                                  >
                                    {winner ?? (result.needsReview ? t('Needs review') : '—')}
                                  </span>
                                </div>
                                {(['red', 'blue', 'neutral'] as const).map((side) =>
                                  grouped[side].length === 0 && side === 'neutral' ? null : (
                                    <div className={`result-team-block ${side}`} key={side}>
                                      {grouped[side].length === 0 ? (
                                        <span className="muted small">—</span>
                                      ) : (
                                        grouped[side].map((score) => (
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
                                        ))
                                      )}
                                    </div>
                                  ),
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )
                    ) : (
                      <div className="team-list">
                        {matchTeams.length === 0 ? (
                          <p className="muted small">{t('No teams in this match.')}</p>
                        ) : (
                          matchTeams.map(({ team, side }) => (
                            <div className={`team-card ${side}`} key={team.id}>
                              <div className="team-card-head">
                                <span className="team-card-name">{team.name}</span>
                                <span className="muted small">{team.members.length}</span>
                              </div>
                              {team.members.length === 0 ? (
                                <span className="muted small">—</span>
                              ) : (
                                team.members.map((member) => (
                                  <button
                                    type="button"
                                    key={member.userId}
                                    className={`team-member${
                                      member.userId === team.captainUserId ? ' captain' : ''
                                    }`}
                                    disabled={busy !== null}
                                    onClick={() => void inviteMember(member.userId)}
                                  >
                                    <span className="team-member-name">
                                      {member.username || `#${member.userId}`}
                                    </span>
                                    <span className="team-member-id">#{member.userId}</span>
                                  </button>
                                ))
                              )}
                            </div>
                          ))
                        )}
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
      {bindOpen && session ? (
        <BindMatchDialog
          session={session}
          tournaments={model.tournaments}
          onClose={() => setBindOpen(false)}
          onSave={async (input) => {
            await window.osmaRef.sessions.bindMatch({ sessionId: session.id, ...input });
            setBindOpen(false);
            await model.refreshSessions();
            await model.refreshTournaments();
          }}
        />
      ) : null}
      {randomOpen && pool ? (
        <RandomPickDialog
          slots={randomSlots}
          scope={randomScope}
          prompt={randomPrompt}
          beatmaps={resolvedBeatmaps}
          failures={beatmapFailures}
          confirming={randomConfirming}
          onScopeChange={changeRandomScope}
          onPromptChange={setRandomPrompt}
          onConfirm={handleRandomConfirmClick}
          onClose={abortRandomFlow}
        />
      ) : null}
      {rollResult && session ? (
        <RandomRollDialog
          key={`${rollResult.username}:${rollResult.score}:${rollResult.index}`}
          result={rollResult}
          slots={rollSlots}
          beatmaps={resolvedBeatmaps}
          failures={beatmapFailures}
          onConfirm={confirmRandomRoll}
          onClose={abortRandomFlow}
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
  channel: 'irc' | 'referee_hub';
}

const WORKBENCH_LAYOUT_KEY = 'osmaRef.workbench.layout';

function loadWorkbenchLayout(): WorkbenchLayout {
  const fallback = {
    leftWidth: 260,
    rightWidth: 340,
    chatPercent: 55,
    roomsPercent: 45,
    rightPercent: 40,
    channel: 'referee_hub' as const,
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
      channel: parsed.channel === 'irc' || parsed.channel === 'referee_hub' ? parsed.channel : fallback.channel,
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

