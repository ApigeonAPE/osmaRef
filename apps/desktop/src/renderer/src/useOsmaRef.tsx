import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppState,
  ChatMessage,
  LobbyLogSummary,
  LogEntry,
  MatchSession,
  MpCommandResult,
  RoomSnapshot,
  ServerStatus,
  Tournament,
} from '@osmaref/contracts';

export interface Model {
  state: AppState | null;
  serverStatus: ServerStatus | null;
  tournaments: Tournament[];
  sessions: MatchSession[];
  lobbyLogs: LobbyLogSummary[];
  logs: LogEntry[];
  diagnostics: LogEntry[];
  messages: ChatMessage[];
  snapshots: Record<string, RoomSnapshot>;
  lastMpResult: MpCommandResult | null;
  refreshAll: () => Promise<void>;
  refreshTournaments: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshLobbyLogs: () => Promise<void>;
  saveTournament: (tournament: Tournament) => Promise<Tournament>;
  setActiveSession: (sessionId: string | null) => Promise<void>;
  sendChat: (sessionId: string, text: string) => Promise<MpCommandResult | null>;
}

const ModelContext = createContext<Model | null>(null);

export function useModel(): Model {
  const model = useContext(ModelContext);
  if (!model) throw new Error('useModel must be used inside ModelProvider');
  return model;
}

export function ModelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [sessions, setSessions] = useState<MatchSession[]>([]);
  const [lobbyLogs, setLobbyLogs] = useState<LobbyLogSummary[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [diagnostics, setDiagnostics] = useState<LogEntry[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, RoomSnapshot>>({});
  const [lastMpResult, setLastMpResult] = useState<MpCommandResult | null>(null);
  const bootstrapped = useRef(false);

  const refreshTournaments = useCallback(async () => {
    setTournaments(await window.osmaRef.tournaments.list());
  }, []);

  const refreshSessions = useCallback(async () => {
    const [nextSessions, nextLobbyLogs] = await Promise.all([
      window.osmaRef.sessions.list(),
      window.osmaRef.sessions.listLogs(),
    ]);
    setSessions(nextSessions);
    setLobbyLogs(nextLobbyLogs);
  }, []);

  const refreshLobbyLogs = useCallback(async () => {
    setLobbyLogs(await window.osmaRef.sessions.listLogs());
  }, []);

  const refreshAll = useCallback(async () => {
    const [nextState, nextStatus, nextTournaments, nextSessions, nextLogs, nextDiagnostics, nextLobbyLogs] =
      await Promise.all([
        window.osmaRef.app.getState(),
        window.osmaRef.auth.status(),
        window.osmaRef.tournaments.list(),
        window.osmaRef.sessions.list(),
        window.osmaRef.app.getLogs(200),
        window.osmaRef.app.getConnectionDiagnostics(200),
        window.osmaRef.sessions.listLogs(),
      ]);
    setState(nextState);
    setServerStatus(nextStatus);
    setTournaments(nextTournaments);
    setSessions(nextSessions);
    setLogs(nextLogs);
    setDiagnostics(nextDiagnostics);
    setLobbyLogs(nextLobbyLogs);
    const roomEntries = await Promise.all(
      nextSessions.map(async (session) => {
        const snapshot = await window.osmaRef.sessions.getRoom(session.id);
        return [session.id, snapshot] as const;
      }),
    );
    const nextSnapshots: Record<string, RoomSnapshot> = {};
    for (const [id, snapshot] of roomEntries) {
      if (snapshot) nextSnapshots[id] = snapshot;
    }
    setSnapshots(nextSnapshots);
  }, []);

  useEffect(() => {
    const off = window.osmaRef.app.onEvent((event) => {
      switch (event.type) {
        case 'app_state':
          setState(event.state);
          break;
        case 'session_updated':
          setSessions((previous) => {
            const index = previous.findIndex((session) => session.id === event.session.id);
            if (index === -1) return [event.session, ...previous];
            const next = [...previous];
            next[index] = event.session;
            return next;
          });
          break;
        case 'session_deleted':
          setSessions((previous) => previous.filter((session) => session.id !== event.sessionId));
          break;
        case 'room_snapshot':
          setSnapshots((previous) => ({ ...previous, [event.sessionId]: event.snapshot }));
          break;
        case 'chat_message':
          setMessages((previous) => [...previous.slice(-499), event.message]);
          break;
        case 'mp_result':
          setLastMpResult(event.result);
          break;
        case 'log':
          setLogs((previous) => [...previous.slice(-299), event.entry]);
          break;
        case 'connection_log':
          setDiagnostics((previous) => [...previous.slice(-299), event.entry]);
          break;
        default:
          break;
      }
    });

    if (!bootstrapped.current) {
      bootstrapped.current = true;
      void (async () => {
        try {
          await refreshAll();
        } catch {
          // One failing refresh (for example a locked local store) must not stop
          // the automatic IRC/Hub connection from being attempted.
        }
        try {
          await window.osmaRef.connection.autoConnect();
        } catch {
          // Auto-connect failures are surfaced through connection state/logs.
        }
      })();
    }
    return off;
  }, [refreshAll]);

  const saveTournament = useCallback(
    async (tournament: Tournament) => {
      const saved = await window.osmaRef.tournaments.save(tournament);
      setTournaments((previous) => {
        const index = previous.findIndex((entry) => entry.id === saved.id);
        if (index === -1) return [saved, ...previous];
        const next = [...previous];
        next[index] = saved;
        return next;
      });
      return saved;
    },
    [],
  );

  const setActiveSession = useCallback(async (sessionId: string | null) => {
    setState((previous) => (previous ? { ...previous, activeSessionId: sessionId } : previous));
  }, []);

  const sendChat = useCallback(async (sessionId: string, text: string) => {
    const result = await window.osmaRef.chat.send(sessionId, text);
    if (result) setLastMpResult(result);
    return result;
  }, []);

  const value = useMemo<Model>(
    () => ({
      state,
      serverStatus,
      tournaments,
      sessions,
      lobbyLogs,
      logs,
      diagnostics,
      messages,
      snapshots,
      lastMpResult,
      refreshAll,
      refreshTournaments,
      refreshSessions,
      refreshLobbyLogs,
      saveTournament,
      setActiveSession,
      sendChat,
    }),
    [
      state,
      serverStatus,
      tournaments,
      sessions,
      lobbyLogs,
      logs,
      diagnostics,
      messages,
      snapshots,
      lastMpResult,
      refreshAll,
      refreshTournaments,
      refreshSessions,
      refreshLobbyLogs,
      saveTournament,
      setActiveSession,
      sendChat,
    ],
  );

  return <ModelContext.Provider value={value}>{children}</ModelContext.Provider>;
}