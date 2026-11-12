/**
 * BanchoBot message parsing.
 *
 * Every pattern in this file is taken from a real multiplayer log
 * (`#mp_122128684.messages.ndjson`). Unrecognised lines return null instead of
 * being guessed at.
 */

export type BanchoTeam = 'red' | 'blue';

export interface ModClause {
  action: 'enable' | 'disable' | 'clear';
  mod?: string;
}

export interface BanchoPlayer {
  userId: number | null;
  username: string;
  slot: number | null;
  team: BanchoTeam | null;
  mods: string[];
  ready: boolean;
}

export type BanchoEvent =
  | { kind: 'match_created'; roomId: string }
  | { kind: 'roll'; username: string; value: number }
  | { kind: 'beatmap'; beatmapId: number; title: string }
  | {
      kind: 'countdown';
      seconds: number;
      label: 'match_start' | 'timer';
    }
  | { kind: 'countdown_stopped'; reason: 'finished' | 'aborted' }
  | { kind: 'match_starting'; seconds: number }
  | { kind: 'match_started' }
  | { kind: 'match_finished' }
  | { kind: 'match_aborted' }
  | { kind: 'match_closed' }
  | { kind: 'roster'; player: BanchoPlayer }
  | { kind: 'player_joined'; username: string; slot: number; team: BanchoTeam }
  | { kind: 'player_left'; username: string }
  | { kind: 'player_moved'; username: string; slot: number }
  | { kind: 'player_team'; username: string; team: BanchoTeam }
  | { kind: 'room_name'; name: string }
  | {
      kind: 'room_settings';
      matchType?: 'head_to_head' | 'team_versus' | null;
      winCondition?: string;
      slots?: number;
      players?: number;
    }
  | { kind: 'lock_state'; locked: boolean }
  | { kind: 'mods'; mods: string[] }
  | { kind: 'mod_toggle'; clauses: ModClause[] }
  | { kind: 'ruleset'; ruleset: string }
  | { kind: 'player_finished'; username: string; score: number; passed: boolean };

// Observed: "Created the tournament match https://osu.ppy.sh/mp/122142417 Quick room"
const MATCH_CREATED = /^Created the tournament match\b[^\n]*?osu\.ppy\.sh\/mp\/(\d+)/i;
export const MATCH_URL = /osu\.ppy\.sh\/mp\/(\d+)/i;

// Observed: "Player_One rolls 73 point(s)"
const ROLL = /^(.+?) rolls (\d+) point\(s\)$/i;

// Observed: "Beatmap: https://osu.ppy.sh/b/5977747 grechka - ty kak vsegda"
// Observed: "Changed beatmap to https://osu.ppy.sh/b/... Artist - Title"
const BEATMAP_INFO = /^Beatmap: https?:\/\/osu\.ppy\.sh\/b\/(\d+)\s+(.+)$/i;
const BEATMAP_CHANGED = /^Changed beatmap to https?:\/\/osu\.ppy\.sh\/b\/(\d+)\s+(.+)$/i;

// Observed countdown variants.
const COUNTDOWN_ENDS =
  /^Countdown ends in (\d+) (seconds?|minutes?|hours?)$/i;
const COUNTDOWN_FINISHED = /^Countdown finished$/i;
const COUNTDOWN_ABORTED = /^Countdown aborted$/i;
const QUEUED_MATCH = /^Queued the match to start in (\d+) seconds?$/i;
const MATCH_STARTS_IN = /^Match starts in (\d+) seconds?$/i;

// Observed lifecycle lines.
const MATCH_STARTED = /^The match has started!$/i;
const MATCH_FINISHED = /^The match has finished!$/i;
const MATCH_ABORTED = /^Aborted the match$/i;
const MATCH_CLOSED = /^Closed the match$/i;

// Observed: "Slot 2  Ready     https://osu.ppy.sh/u/3407743 Miyaguni Akari  [Team Red  / NoFail, HardRock]"
// A trailing "Incorrect slot..." warning may follow the bracket, so this is not anchored at the end.
const SLOT_LINE =
  /^Slot (\d+)\s+(Ready|Not Ready)\s+https?:\/\/osu\.ppy\.sh\/u\/(\d+)\s+(.+?)\s+\[Team (Red|Blue)\s*(?:\/\s*(.+?))?\s*\]/i;

// Observed: "Murasaki Shion joined in slot 1 for team blue."
const JOINED_SLOT = /^(.+?) joined in slot (\d+) for team (red|blue)\.$/i;
// Observed: "Murasaki Shion left the game."
const LEFT_GAME = /^(.+?) left the game\.$/i;
// Observed: "Nagato moved to slot 8"
const MOVED_SLOT = /^(.+?) moved to slot (\d+)$/i;
// Observed: "AkiYukie changed to Blue"
const CHANGED_TEAM = /^(.+?) changed to (Red|Blue)$/i;

// Observed: 'Room name: 4DCI26: China vs Taiwan, History: https://osu.ppy.sh/mp/122128684'
const ROOM_NAME = /^Room name:\s*(.+?)(?:,\s*History:.*)?$/i;
// Observed: 'Room name updated to "Test"'
const ROOM_NAME_UPDATED = /^Room name updated to "(.+)"$/i;
// Observed: "Team mode: TeamVs, Win condition: ScoreV2"
const TEAM_MODE = /^Team mode:\s*([^,]+?)(?:,\s*Win condition:\s*(.+))?$/i;
// Observed: "Changed match settings to 12 slots, TeamVs, ScoreV2"
// and the older observed "Changed match settings to TeamVs, ScoreV2".
const CHANGED_MATCH_SETTINGS =
  /^Changed match settings to (?:(?:(\d+) slots?), )?(.+?)(?:,\s*(.+))?$/i;
// Observed: "Changed match to size 10"
const CHANGED_ROOM_SIZE = /^Changed match to size\s*(\d+)$/i;
// Observed in !mp settings: "Room size: 8"
const ROOM_SIZE = /^Room size:\s*(\d+)/i;
// Observed: "Players: 0"
const PLAYERS_COUNT = /^Players:\s*(\d+)$/i;
// Observed: "Locked the match" / "Unlocked the match"
const LOCKED = /^Locked the match$/i;
const UNLOCKED = /^Unlocked the match$/i;
// Observed: "Active mods: NoFail, Hidden"
const ACTIVE_MODS = /^Active mods:\s*(.+)$/i;
// Observed: "Disabled all mods, enabled FreeMod" / "Enabled NoFail, Hidden, disabled FreeMod"
const MOD_TOGGLE = /^(?:Enabled|Disabled)\s+.+$/i;
// Observed: "Changed match mode to CatchTheBeat"
const CHANGED_MODE = /^Changed match mode to (\w+)$/i;

// Observed: "Player finished playing (Score: 1234567, PASSED)."
const PLAYER_FINISHED =
  /^(.+?) finished playing \(Score:\s*([\d,]+),\s*(PASSED|FAILED)\)\.?$/i;

export function parseBanchoLine(text: string): BanchoEvent | null {
  const line = text.trim();

  const created = MATCH_CREATED.exec(line);
  if (created) return { kind: 'match_created', roomId: created[1]! };

  const roll = ROLL.exec(line);
  if (roll) {
    return { kind: 'roll', username: roll[1]!.trim(), value: Number(roll[2]!.replace(/,/g, '')) };
  }

  const beatmapInfo = BEATMAP_INFO.exec(line);
  if (beatmapInfo) {
    return {
      kind: 'beatmap',
      beatmapId: Number(beatmapInfo[1]),
      title: beatmapInfo[2]!.trim(),
    };
  }

  const beatmapChanged = BEATMAP_CHANGED.exec(line);
  if (beatmapChanged) {
    return {
      kind: 'beatmap',
      beatmapId: Number(beatmapChanged[1]),
      title: beatmapChanged[2]!.trim(),
    };
  }

  const countdown = COUNTDOWN_ENDS.exec(line);
  if (countdown) {
    const unit = countdown[2]!.toLowerCase();
    const factor = unit.startsWith('hour') ? 3600 : unit.startsWith('minute') ? 60 : 1;
    return {
      kind: 'countdown',
      seconds: Number(countdown[1]) * factor,
      label: 'timer',
    };
  }

  if (COUNTDOWN_FINISHED.test(line)) return { kind: 'countdown_stopped', reason: 'finished' };
  if (COUNTDOWN_ABORTED.test(line)) return { kind: 'countdown_stopped', reason: 'aborted' };

  const queued = QUEUED_MATCH.exec(line);
  if (queued) {
    return { kind: 'match_starting', seconds: Number(queued[1]) };
  }

  const startsIn = MATCH_STARTS_IN.exec(line);
  if (startsIn) {
    return {
      kind: 'countdown',
      seconds: Number(startsIn[1]),
      label: 'match_start',
    };
  }

  if (MATCH_STARTED.test(line)) return { kind: 'match_started' };
  if (MATCH_FINISHED.test(line)) return { kind: 'match_finished' };
  if (MATCH_ABORTED.test(line)) return { kind: 'match_aborted' };
  if (MATCH_CLOSED.test(line)) return { kind: 'match_closed' };

  const slot = SLOT_LINE.exec(line);
  if (slot) {
    const mods = (slot[6] ?? '')
      .split(',')
      .map((mod) => mod.trim())
      .filter(Boolean);
    return {
      kind: 'roster',
      player: {
        userId: Number(slot[3]),
        username: slot[4]!.trim(),
        slot: Number(slot[1]),
        team: slot[5]!.toLowerCase() as BanchoTeam,
        mods,
        ready: slot[2]!.toLowerCase() === 'ready',
      },
    };
  }

  const joined = JOINED_SLOT.exec(line);
  if (joined) {
    return {
      kind: 'player_joined',
      username: joined[1]!.trim(),
      slot: Number(joined[2]),
      team: joined[3]!.toLowerCase() as BanchoTeam,
    };
  }

  const left = LEFT_GAME.exec(line);
  if (left) return { kind: 'player_left', username: left[1]!.trim() };

  const moved = MOVED_SLOT.exec(line);
  if (moved) {
    return {
      kind: 'player_moved',
      username: moved[1]!.trim(),
      slot: Number(moved[2]),
    };
  }

  const changedTeam = CHANGED_TEAM.exec(line);
  if (changedTeam) {
    return {
      kind: 'player_team',
      username: changedTeam[1]!.trim(),
      team: changedTeam[2]!.toLowerCase() as BanchoTeam,
    };
  }

  const name = ROOM_NAME.exec(line);
  if (name) return { kind: 'room_name', name: name[1]!.trim() };

  const nameUpdated = ROOM_NAME_UPDATED.exec(line);
  if (nameUpdated) return { kind: 'room_name', name: nameUpdated[1]!.trim() };

  const changedSettings = CHANGED_MATCH_SETTINGS.exec(line);
  if (changedSettings) {
    return {
      kind: 'room_settings',
      matchType: normalizeMatchType(changedSettings[2]!),
      ...(changedSettings[3] ? { winCondition: changedSettings[3].trim() } : {}),
      ...(changedSettings[1] ? { slots: Number(changedSettings[1]) } : {}),
    };
  }

  const changedSize = CHANGED_ROOM_SIZE.exec(line);
  if (changedSize) return { kind: 'room_settings', slots: Number(changedSize[1]) };

  const roomSize = ROOM_SIZE.exec(line);
  if (roomSize) return { kind: 'room_settings', slots: Number(roomSize[1]) };

  if (LOCKED.test(line)) return { kind: 'lock_state', locked: true };
  if (UNLOCKED.test(line)) return { kind: 'lock_state', locked: false };

  const teamMode = TEAM_MODE.exec(line);
  if (teamMode) {
    return {
      kind: 'room_settings',
      matchType: normalizeMatchType(teamMode[1]!),
      ...(teamMode[2] ? { winCondition: teamMode[2].trim() } : {}),
    };
  }

  const players = PLAYERS_COUNT.exec(line);
  if (players) return { kind: 'room_settings', players: Number(players[1]) };

  const mods = ACTIVE_MODS.exec(line);
  if (mods) {
    return {
      kind: 'mods',
      mods: mods[1]!.split(',').map((mod) => canonicalMod(mod)).filter(Boolean),
    };
  }

  if (MOD_TOGGLE.test(line)) {
    const clauses = parseModClauses(line);
    if (clauses) return { kind: 'mod_toggle', clauses };
  }

  const mode = CHANGED_MODE.exec(line);
  if (mode) return { kind: 'ruleset', ruleset: mode[1]! };

  const finished = PLAYER_FINISHED.exec(line);
  if (finished) {
    return {
      kind: 'player_finished',
      username: finished[1]!.trim(),
      score: Number(finished[2]!.replace(/,/g, '')),
      passed: finished[3]!.toUpperCase() === 'PASSED',
    };
  }

  return null;
}

export interface BanchoRoomState {
  roomId: string;
  name: string | null;
  size: number | null;
  matchType: 'head_to_head' | 'team_versus' | null;
  winCondition: string | null;
  playerCount: number | null;
  locked: boolean;
  mods: string[];
  ruleset: string | null;
  beatmapId: number | null;
  beatmapTitle: string | null;
  /** Keyed by lower-cased username. */
  players: Map<string, BanchoPlayer>;
  lastRoll: { username: string; value: number } | null;
  startedAt: string | null;
}

export function createBanchoRoomState(roomId: string): BanchoRoomState {
  return {
    roomId,
    name: null,
    size: null,
    matchType: null,
    winCondition: null,
    playerCount: null,
    locked: false,
    mods: [],
    ruleset: null,
    beatmapId: null,
    beatmapTitle: null,
    players: new Map(),
    lastRoll: null,
    startedAt: null,
  };
}

export function applyBanchoEvent(state: BanchoRoomState, event: BanchoEvent): void {
  switch (event.kind) {
    case 'room_name':
      state.name = event.name;
      return;
    case 'room_settings':
      if (event.matchType) state.matchType = event.matchType;
      if (event.winCondition) state.winCondition = event.winCondition;
      if (event.slots !== undefined) state.size = event.slots;
      if (event.players !== undefined) state.playerCount = event.players;
      return;
    case 'lock_state':
      state.locked = event.locked;
      return;
    case 'mods':
      state.mods = event.mods;
      return;
    case 'mod_toggle': {
      // A line with any "Enabled ..." clause describes the room's new mod set;
      // BanchoBot omits the mods it replaced. Lines that only disable mods are
      // applied to the current set.
      const replaces = event.clauses.some((clause) => clause.action === 'enable');
      let mods = replaces ? [] : [...state.mods];
      for (const clause of event.clauses) {
        if (clause.action === 'clear') {
          mods = [];
          continue;
        }
        if (!clause.mod) continue;
        const canonical = canonicalMod(clause.mod);
        if (clause.action === 'enable') {
          if (!mods.some((mod) => mod.toLowerCase() === canonical.toLowerCase())) {
            mods.push(canonical);
          }
        } else {
          mods = mods.filter((mod) => mod.toLowerCase() !== canonical.toLowerCase());
        }
      }
      state.mods = mods;
      return;
    }
    case 'ruleset':
      state.ruleset = event.ruleset;
      return;
    case 'beatmap':
      state.beatmapId = event.beatmapId;
      state.beatmapTitle = event.title;
      return;
    case 'roster':
      state.players.set(event.player.username.toLowerCase(), event.player);
      return;
    case 'player_joined': {
      const key = event.username.toLowerCase();
      const existing = state.players.get(key);
      state.players.set(key, {
        userId: existing?.userId ?? null,
        username: existing?.username ?? event.username,
        slot: event.slot,
        team: event.team,
        mods: existing?.mods ?? [],
        ready: existing?.ready ?? false,
      });
      return;
    }
    case 'player_left':
      state.players.delete(event.username.toLowerCase());
      return;
    case 'player_moved': {
      const player = state.players.get(event.username.toLowerCase());
      if (player) player.slot = event.slot;
      return;
    }
    case 'player_team': {
      const player = state.players.get(event.username.toLowerCase());
      if (player) player.team = event.team;
      return;
    }
    case 'roll':
      state.lastRoll = { username: event.username, value: event.value };
      return;
    case 'match_started':
      state.startedAt = new Date().toISOString();
      return;
    default:
      return;
  }
}

export function canonicalMod(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase() === 'freemod' ? 'Freemod' : trimmed;
}

/**
 * Parses observed toggle lines such as:
 *   "Disabled all mods, enabled FreeMod"
 *   "Enabled NoFail, Hidden, disabled FreeMod"
 */
export function parseModClauses(line: string): ModClause[] | null {
  const clauses: ModClause[] = [];
  let action: 'enable' | 'disable' | null = null;

  for (const rawPart of line.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    if (/^disabled all mods$/i.test(part)) {
      clauses.push({ action: 'clear' });
      action = null;
      continue;
    }
    const directed = /^(enabled|disabled)\s+(.+)$/i.exec(part);
    if (directed) {
      action = directed[1]!.toLowerCase() === 'enabled' ? 'enable' : 'disable';
      clauses.push({ action, mod: directed[2]!.trim() });
      continue;
    }
    if (!action) return null;
    clauses.push({ action, mod: part });
  }

  return clauses.length > 0 ? clauses : null;
}

export function normalizeMatchType(value: string): 'head_to_head' | 'team_versus' | null {
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  if (normalized === 'headtohead') return 'head_to_head';
  if (normalized === 'teamvs') return 'team_versus';
  return null;
}

/** Extracts a human username from a Bancho IRC nick (underscores -> spaces). */
export function displayNameFromNick(nick: string): string {
  return nick.replace(/_/g, ' ');
}