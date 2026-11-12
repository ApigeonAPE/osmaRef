import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LobbyLogSession,
  LobbyLogSummary,
  LogEntry,
  MatchSession,
  SessionEvent,
  Tournament,
} from '@osmaref/contracts';
import {
  LobbyLogSessionSchema,
  LobbyLogSummarySchema,
  LogEntrySchema,
  MatchSessionSchema,
  parseTournament as parseTournamentInput,
  toLobbyLogSession,
} from '@osmaref/contracts';

export interface AppStore {
  listTournaments(): Tournament[];
  getTournament(id: string): Tournament | null;
  saveTournament(tournament: Tournament): Tournament;
  deleteTournament(id: string): void;
  listSessions(): MatchSession[];
  getSession(id: string): MatchSession | null;
  saveSession(session: MatchSession): void;
  /** Removes the session only; its lobby log is kept until deleted explicitly. */
  deleteSession(id: string): void;
  appendEvent(event: SessionEvent): void;
  listEvents(sessionId: string): SessionEvent[];
  appendRuntimeLog(entry: LogEntry): void;
  listRuntimeLogs(limit?: number): LogEntry[];
  upsertLobbyLogSession(session: LobbyLogSession): void;
  getLobbyLogSession(sessionId: string): LobbyLogSession | null;
  listLobbyLogs(): LobbyLogSummary[];
  deleteLobbyLog(sessionId: string): void;
  close(): void;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type SqliteConstructor = new (path: string) => SqliteDatabase;

/** Current persistent shape for tournaments and sessions. */
const STORE_DATA_VERSION = 3;

/**
 * SQLite-backed store with a JSON fallback.
 *
 * `node:sqlite` ships with modern Electron, so no native module rebuild is
 * needed. If it is unavailable (older runtime), behaviour degrades to an atomic
 * JSON snapshot without losing the API.
 */
export async function createAppStore(dataDir: string): Promise<AppStore> {
  mkdirSync(dataDir, { recursive: true });
  try {
    const module = (await import('node:sqlite')) as unknown as { DatabaseSync: SqliteConstructor };
    if (typeof module.DatabaseSync === 'function') {
      return new SqliteStore(join(dataDir, 'osmaRef.db'), module.DatabaseSync);
    }
  } catch {
    // fall through to JSON
  }
  return new JsonStore(join(dataDir, 'osmaRef-store.json'));
}

class SqliteStore implements AppStore {
  private readonly db: SqliteDatabase;

  constructor(path: string, ctor: SqliteConstructor) {
    this.db = new ctor(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tournaments (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, at);
      CREATE TABLE IF NOT EXISTS runtime_logs (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runtime_logs_at ON runtime_logs(at);
      CREATE TABLE IF NOT EXISTS lobby_log_sessions (
        session_id TEXT PRIMARY KEY,
        match_name TEXT NOT NULL,
        room_id TEXT,
        transport TEXT NOT NULL,
        best_of INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const row = this.db.prepare('PRAGMA user_version').get();
    const dataVersion = Number(row?.['user_version'] ?? 0);
    if (dataVersion < STORE_DATA_VERSION) {
      // The user explicitly chose to discard old tournament configs and
      // sessions on this development-only model break. Keep runtime logs and
      // lobby logs, which have independent retention policies.
      this.db.exec('DELETE FROM tournaments; DELETE FROM sessions;');
      this.db.exec(`PRAGMA user_version = ${STORE_DATA_VERSION};`);
    }
  }

  listTournaments(): Tournament[] {
    const rows = this.db.prepare('SELECT data FROM tournaments ORDER BY updated_at DESC').all();
    return rows.flatMap((row) => {
      const tournament = parseStoredTournament(row.data);
      return tournament ? [tournament] : [];
    });
  }

  getTournament(id: string): Tournament | null {
    const row = this.db.prepare('SELECT data FROM tournaments WHERE id = ?').get(id);
    return row ? parseStoredTournament(row.data) : null;
  }

  saveTournament(tournament: Tournament): Tournament {
    const next: Tournament = {
      ...tournament,
      revision: tournament.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const validated = parseTournamentInput(next);
    if (!validated.success) {
      throw new Error(
        `tournament is invalid: ${validated.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    this.db
      .prepare(
        'INSERT INTO tournaments (id, revision, updated_at, data) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, data = excluded.data',
      )
      .run(validated.data.id, validated.data.revision, validated.data.updatedAt, JSON.stringify(validated.data));
    return validated.data;
  }

  deleteTournament(id: string): void {
    this.db.prepare('DELETE FROM tournaments WHERE id = ?').run(id);
  }

  listSessions(): MatchSession[] {
    const rows = this.db.prepare('SELECT data FROM sessions ORDER BY updated_at DESC').all();
    return rows.flatMap((row) => {
      const session = parseSession(row.data);
      return session ? [session] : [];
    });
  }

  getSession(id: string): MatchSession | null {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id);
    return row ? parseSession(row.data) : null;
  }

  saveSession(session: MatchSession): void {
    this.db
      .prepare(
        'INSERT INTO sessions (id, updated_at, data) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, data = excluded.data',
      )
      .run(session.id, session.updatedAt, JSON.stringify(session));
  }

  deleteSession(id: string): void {
    // The lobby log is intentionally not deleted with the session; it is
    // removed only through deleteLobbyLog(). Keeping the metadata alive lets
    // the Logs page still list rooms removed from the workbench.
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  appendEvent(event: SessionEvent): void {
    this.db
      .prepare('INSERT OR IGNORE INTO events (id, session_id, at, type, data) VALUES (?, ?, ?, ?, ?)')
      .run(event.id, event.sessionId, event.at, event.type, JSON.stringify(event));
  }

  listEvents(sessionId: string): SessionEvent[] {
    const rows = this.db
      .prepare('SELECT data FROM events WHERE session_id = ? ORDER BY at ASC')
      .all(sessionId);
    return rows.flatMap((row) => {
      try {
        return [JSON.parse(String(row.data)) as SessionEvent];
      } catch {
        return [];
      }
    });
  }

  appendRuntimeLog(entry: LogEntry): void {
    this.db
      .prepare('INSERT OR IGNORE INTO runtime_logs (id, at, data) VALUES (?, ?, ?)')
      .run(entry.id, entry.at, JSON.stringify(entry));
  }

  listRuntimeLogs(limit = 0): LogEntry[] {
    const rows =
      limit > 0
        ? this.db
            .prepare('SELECT data FROM runtime_logs ORDER BY at DESC, id DESC LIMIT ?')
            .all(limit)
        : this.db.prepare('SELECT data FROM runtime_logs ORDER BY at ASC, id ASC').all();
    const entries = rows.flatMap((row) => {
      const entry = parseRuntimeLog(row.data);
      return entry ? [entry] : [];
    });
    return limit > 0 ? entries.reverse() : entries;
  }

  upsertLobbyLogSession(session: LobbyLogSession): void {
    this.db
      .prepare(
        'INSERT INTO lobby_log_sessions ' +
          '(session_id, match_name, room_id, transport, best_of, status, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(session_id) DO UPDATE SET ' +
          'match_name = excluded.match_name, ' +
          'room_id = COALESCE(excluded.room_id, lobby_log_sessions.room_id), ' +
          'transport = excluded.transport, best_of = excluded.best_of, ' +
          'status = excluded.status, updated_at = excluded.updated_at',
      )
      .run(
        session.sessionId,
        session.matchName,
        session.roomId,
        session.transport,
        session.bestOf,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
  }

  getLobbyLogSession(sessionId: string): LobbyLogSession | null {
    const row = this.db
      .prepare(
        'SELECT session_id, match_name, room_id, transport, best_of, status, created_at, updated_at ' +
          'FROM lobby_log_sessions WHERE session_id = ?',
      )
      .get(sessionId);
    return row ? parseLobbyLogSessionRow(row) : null;
  }

  listLobbyLogs(): LobbyLogSummary[] {
    this.backfillLobbyLogSessions();
    const rows = this.db
      .prepare(
        'SELECT s.session_id, s.match_name, s.room_id, s.transport, s.best_of, s.status, ' +
          's.created_at, s.updated_at, COUNT(e.id) AS entry_count, MAX(e.at) AS last_entry_at ' +
          'FROM lobby_log_sessions s JOIN events e ON e.session_id = s.session_id ' +
          'GROUP BY s.session_id ORDER BY last_entry_at DESC',
      )
      .all();
    return rows.flatMap((row) => {
      const parsed = LobbyLogSummarySchema.safeParse({
        sessionId: String(row['session_id']),
        matchName: String(row['match_name']),
        roomId: row['room_id'] === null || row['room_id'] === undefined ? null : String(row['room_id']),
        transport: row['transport'],
        bestOf: Number(row['best_of']),
        status: row['status'],
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at']),
        entryCount: Number(row['entry_count']),
        lastEntryAt: String(row['last_entry_at']),
      });
      return parsed.success ? [parsed.data] : [];
    });
  }

  deleteLobbyLog(sessionId: string): void {
    this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM lobby_log_sessions WHERE session_id = ?').run(sessionId);
  }

  private backfillLobbyLogSessions(): void {
    for (const session of this.listSessions()) {
      if (this.getLobbyLogSession(session.id)) continue;
      const hasEvents = this.db
        .prepare('SELECT 1 AS present FROM events WHERE session_id = ? LIMIT 1')
        .get(session.id);
      if (!hasEvents) continue;
      this.upsertLobbyLogSession(toLobbyLogSession(session));
    }
  }

  close(): void {
    this.db.close();
  }
}

interface JsonSnapshot {
  dataVersion: number;
  tournaments: Tournament[];
  sessions: MatchSession[];
  events: SessionEvent[];
  runtimeLogs: LogEntry[];
  lobbyLogSessions: LobbyLogSession[];
}

class JsonStore implements AppStore {
  private readonly file: string;
  private readonly state: JsonSnapshot;
  private timer: NodeJS.Timeout | null = null;

  constructor(file: string) {
    this.file = file;
    this.state = {
      dataVersion: STORE_DATA_VERSION,
      tournaments: [],
      sessions: [],
      events: [],
      runtimeLogs: [],
      lobbyLogSessions: [],
    };
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<JsonSnapshot>;
        this.state.events = parsed.events ?? [];
        this.state.runtimeLogs = parsed.runtimeLogs ?? [];
        this.state.lobbyLogSessions = parsed.lobbyLogSessions ?? [];
        if ((parsed.dataVersion ?? 0) < STORE_DATA_VERSION) {
          // Match the SQLite v3 upgrade: old tournament configs and sessions
          // are intentionally discarded, but both log collections survive.
          this.state.tournaments = [];
          this.state.sessions = [];
          this.scheduleSave();
        } else {
          this.state.tournaments = parsed.tournaments ?? [];
          this.state.sessions = parsed.sessions ?? [];
        }
        this.state.dataVersion = STORE_DATA_VERSION;
      } catch {
        // ignore corrupt snapshot
      }
    }
  }

  listTournaments(): Tournament[] {
    return [...this.state.tournaments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getTournament(id: string): Tournament | null {
    return this.state.tournaments.find((tournament) => tournament.id === id) ?? null;
  }

  saveTournament(tournament: Tournament): Tournament {
    const next: Tournament = {
      ...tournament,
      revision: tournament.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const validated = parseTournamentInput(next);
    if (!validated.success) {
      throw new Error('tournament is invalid');
    }
    const index = this.state.tournaments.findIndex((entry) => entry.id === validated.data.id);
    if (index === -1) this.state.tournaments.push(validated.data);
    else this.state.tournaments[index] = validated.data;
    this.scheduleSave();
    return validated.data;
  }

  deleteTournament(id: string): void {
    this.state.tournaments = this.state.tournaments.filter((tournament) => tournament.id !== id);
    this.state.sessions = this.state.sessions.filter((session) => session.tournamentId !== id);
    this.scheduleSave();
  }

  listSessions(): MatchSession[] {
    return [...this.state.sessions]
      .map((session) => MatchSessionSchema.safeParse(session))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(id: string): MatchSession | null {
    const session = this.state.sessions.find((entry) => entry.id === id);
    if (!session) return null;
    const parsed = MatchSessionSchema.safeParse(session);
    return parsed.success ? parsed.data : null;
  }

  saveSession(session: MatchSession): void {
    const parsed = MatchSessionSchema.safeParse(session);
    if (!parsed.success) {
      throw new Error('session is invalid');
    }
    const index = this.state.sessions.findIndex((entry) => entry.id === session.id);
    if (index === -1) this.state.sessions.push(parsed.data);
    else this.state.sessions[index] = parsed.data;
    this.scheduleSave();
  }

  deleteSession(id: string): void {
    // Keep events and lobby-log metadata; the room log is deleted explicitly
    // from the Logs page, not when the room is removed from the room list.
    this.state.sessions = this.state.sessions.filter((session) => session.id !== id);
    this.scheduleSave();
  }

  appendEvent(event: SessionEvent): void {
    if (this.state.events.some((entry) => entry.id === event.id)) return;
    this.state.events.push(event);
    this.scheduleSave();
  }

  listEvents(sessionId: string): SessionEvent[] {
    return this.state.events
      .filter((event) => event.sessionId === sessionId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  appendRuntimeLog(entry: LogEntry): void {
    if (this.state.runtimeLogs.some((existing) => existing.id === entry.id)) return;
    this.state.runtimeLogs.push(entry);
    this.scheduleSave();
  }

  listRuntimeLogs(limit = 0): LogEntry[] {
    const ordered = [...this.state.runtimeLogs].sort(
      (left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
    );
    return limit > 0 ? ordered.slice(-limit) : ordered;
  }

  upsertLobbyLogSession(session: LobbyLogSession): void {
    const index = this.state.lobbyLogSessions.findIndex(
      (entry) => entry.sessionId === session.sessionId,
    );
    if (index === -1) {
      this.state.lobbyLogSessions.push(session);
    } else {
      const existing = this.state.lobbyLogSessions[index]!;
      this.state.lobbyLogSessions[index] = {
        ...session,
        roomId: session.roomId ?? existing.roomId,
        createdAt: existing.createdAt,
      };
    }
    this.scheduleSave();
  }

  getLobbyLogSession(sessionId: string): LobbyLogSession | null {
    const session = this.state.lobbyLogSessions.find((entry) => entry.sessionId === sessionId);
    if (!session) return null;
    const parsed = LobbyLogSessionSchema.safeParse(session);
    return parsed.success ? parsed.data : null;
  }

  listLobbyLogs(): LobbyLogSummary[] {
    this.backfillLobbyLogSessions();
    const summaries: LobbyLogSummary[] = [];
    for (const session of this.state.lobbyLogSessions) {
      const events = this.state.events.filter((event) => event.sessionId === session.sessionId);
      if (events.length === 0) continue;
      const lastEntryAt = events.reduce(
        (latest, event) => (event.at > latest ? event.at : latest),
        events[0]!.at,
      );
      const parsed = LobbyLogSummarySchema.safeParse({
        ...session,
        entryCount: events.length,
        lastEntryAt,
      });
      if (parsed.success) summaries.push(parsed.data);
    }
    return summaries.sort((left, right) => right.lastEntryAt.localeCompare(left.lastEntryAt));
  }

  deleteLobbyLog(sessionId: string): void {
    this.state.events = this.state.events.filter((event) => event.sessionId !== sessionId);
    this.state.lobbyLogSessions = this.state.lobbyLogSessions.filter(
      (entry) => entry.sessionId !== sessionId,
    );
    this.scheduleSave();
  }

  private backfillLobbyLogSessions(): void {
    for (const session of this.listSessions()) {
      if (this.getLobbyLogSession(session.id)) continue;
      if (!this.state.events.some((event) => event.sessionId === session.id)) continue;
      this.upsertLobbyLogSession(toLobbyLogSession(session));
    }
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  private scheduleSave(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 100);
    this.timer.unref?.();
  }

  private flush(): void {
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), 'utf8');
    renameSync(temporary, this.file);
  }
}

function parseStoredTournament(data: unknown): Tournament | null {
  try {
    const parsed = parseTournamentInput(JSON.parse(String(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseSession(data: unknown): MatchSession | null {
  try {
    const parsed = MatchSessionSchema.safeParse(JSON.parse(String(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseRuntimeLog(data: unknown): LogEntry | null {
  try {
    const parsed = LogEntrySchema.safeParse(JSON.parse(String(data)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseLobbyLogSessionRow(row: Record<string, unknown>): LobbyLogSession | null {
  const parsed = LobbyLogSessionSchema.safeParse({
    sessionId: String(row['session_id']),
    matchName: String(row['match_name']),
    roomId: row['room_id'] === null || row['room_id'] === undefined ? null : String(row['room_id']),
    transport: row['transport'],
    bestOf: Number(row['best_of']),
    status: row['status'],
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  });
  return parsed.success ? parsed.data : null;
}