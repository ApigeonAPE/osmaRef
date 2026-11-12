import type { HubTeam } from '../types';
import type { MpCommand, MpError, MpErrorCode, ParseResult } from './types';
import { MP_COMMAND_VERBS, type MpVerb } from './types';

const MP_PREFIX = /^!mp(?=\s|$)/i;

export function isMpCommand(input: string): boolean {
  return MP_PREFIX.test(input.trim());
}

/**
 * Parses a locally typed `!mp` command.
 *
 * Matching is ASCII case-insensitive for the prefix and the verb, so `!MP`,
 * `!Mp` and `!mp StArT 5` behave identically. Anything else is returned as
 * `not_mp` and continues to be ordinary chat.
 */
export function parseMpCommand(input: string): ParseResult {
  const raw = input;
  const trimmed = input.trim();
  if (!MP_PREFIX.test(trimmed)) {
    return { kind: 'not_mp' };
  }

  const body = trimmed.slice(3).trim();
  if (body.length === 0) {
    return { kind: 'parsed', command: { verb: 'help' }, raw };
  }

  const verbMatch = /^(\S+)\s*([\s\S]*)$/.exec(body);
  if (!verbMatch) {
    return { kind: 'parsed', command: { verb: 'help' }, raw };
  }

  const verbToken = verbMatch[1] ?? '';
  const rest = verbMatch[2] ?? '';
  const verb = verbToken.toLowerCase() as MpVerb;

  if (!MP_COMMAND_VERBS.includes(verb)) {
    return invalid('MP_UNKNOWN_COMMAND', `unknown command "!mp ${verbToken}". Try !mp help.`, raw);
  }

  const tokens = tokenize(rest);
  const arity = (min: number, max: number): MpError | null => {
    if (tokens.length < min || tokens.length > max) {
      const expected =
        min === max ? `${min} argument(s)` : max === Number.POSITIVE_INFINITY ? `at least ${min}` : `${min}-${max} argument(s)`;
      return {
        code: 'MP_BAD_ARGS',
        message: `!mp ${verb} expects ${expected}, received ${tokens.length}`,
      };
    }
    return null;
  };

  switch (verb) {
    case 'help':
      return { kind: 'parsed', command: { verb: 'help' }, raw };

    case 'lock':
    case 'unlock':
    case 'settings':
    case 'abort':
    case 'aborttimer':
    case 'listrefs':
    case 'clearhost':
    case 'close':
      return noArgs(verb, tokens, raw);

    case 'make': {
      const name = unquote(rest.trim());
      if (!name) return invalid('MP_BAD_ARGS', '!mp make requires a room name', raw);
      return { kind: 'parsed', command: { verb: 'make', name }, raw };
    }

    case 'makeprivate': {
      const name = unquote(rest.trim());
      if (!name) return invalid('MP_BAD_ARGS', '!mp makeprivate requires a room name', raw);
      return { kind: 'parsed', command: { verb: 'makeprivate', name }, raw };
    }

    case 'name': {
      const name = unquote(rest.trim());
      if (!name) return invalid('MP_BAD_ARGS', '!mp name requires a room name', raw);
      return { kind: 'parsed', command: { verb: 'name', name }, raw };
    }

    case 'invite': {
      const user = unquote(rest.trim());
      if (!user) return invalid('MP_BAD_ARGS', '!mp invite requires a username', raw);
      return { kind: 'parsed', command: { verb: 'invite', user }, raw };
    }

    case 'kick':
    case 'ban': {
      const user = unquote(rest.trim());
      if (!user) return invalid('MP_BAD_ARGS', `!mp ${verb} requires a username`, raw);
      return { kind: 'parsed', command: { verb, user }, raw };
    }

    case 'host': {
      const user = unquote(rest.trim());
      if (!user) return invalid('MP_BAD_ARGS', '!mp host requires a username', raw);
      return { kind: 'parsed', command: { verb: 'host', user }, raw };
    }

    case 'size': {
      const error = arity(1, 1);
      if (error) return { kind: 'invalid', error, raw };
      const size = parseInteger(tokens[0]!);
      if (size === null) return invalid('MP_BAD_ARGS', '!mp size expects an integer', raw);
      return { kind: 'parsed', command: { verb: 'size', size }, raw };
    }

    case 'set': {
      const error = arity(1, 2);
      if (error) return { kind: 'invalid', error, raw };
      const teamMode = parseInteger(tokens[0]!);
      if (teamMode === null) return invalid('MP_BAD_ARGS', '!mp set expects a numeric team mode', raw);
      let scoreMode: number | null = null;
      if (tokens.length === 2) {
        scoreMode = parseInteger(tokens[1]!);
        if (scoreMode === null) return invalid('MP_BAD_ARGS', '!mp set expects a numeric score mode', raw);
      }
      return { kind: 'parsed', command: { verb: 'set', teamMode, scoreMode }, raw };
    }

    case 'move': {
      const parts = splitTrailing(rest);
      if (!parts) return invalid('MP_BAD_ARGS', '!mp move expects a username and an integer slot', raw);
      const slot = parseInteger(parts.tail);
      if (slot === null) return invalid('MP_BAD_ARGS', '!mp move expects an integer slot', raw);
      return { kind: 'parsed', command: { verb: 'move', user: unquote(parts.head), slot }, raw };
    }

    case 'team': {
      const parts = splitTrailing(rest);
      if (!parts) return invalid('MP_BAD_ARGS', '!mp team expects a username and red or blue', raw);
      const colour = parts.tail.toLowerCase();
      if (colour !== 'red' && colour !== 'blue') {
        return invalid('MP_BAD_ARGS', '!mp team expects red or blue', raw);
      }
      return {
        kind: 'parsed',
        command: { verb: 'team', user: unquote(parts.head), team: colour as HubTeam },
        raw,
      };
    }

    case 'map': {
      const error = arity(1, 2);
      if (error) return { kind: 'invalid', error, raw };
      const beatmapId = parseInteger(tokens[0]!);
      if (beatmapId === null || beatmapId <= 0) {
        return invalid('MP_BAD_ARGS', '!mp map expects a positive beatmap id', raw);
      }
      let playmode: number | null = null;
      if (tokens.length === 2) {
        playmode = parseInteger(tokens[1]!);
        if (playmode === null || playmode < 0 || playmode > 3) {
          return invalid('MP_BAD_ARGS', '!mp map playmode must be 0-3', raw);
        }
      }
      return { kind: 'parsed', command: { verb: 'map', beatmapId, playmode }, raw };
    }

    case 'mods': {
      const error = arity(1, Number.POSITIVE_INFINITY);
      if (error) return { kind: 'invalid', error, raw };
      return { kind: 'parsed', command: { verb: 'mods', mods: tokens }, raw };
    }

    case 'timer': {
      const error = arity(0, 1);
      if (error) return { kind: 'invalid', error, raw };
      let seconds: number | null = null;
      if (tokens.length === 1) {
        seconds = parseInteger(tokens[0]!);
        if (seconds === null) return invalid('MP_BAD_ARGS', '!mp timer expects an integer', raw);
      }
      return { kind: 'parsed', command: { verb: 'timer', seconds }, raw };
    }

    case 'start': {
      const error = arity(0, 1);
      if (error) return { kind: 'invalid', error, raw };
      let seconds: number | null = null;
      if (tokens.length === 1) {
        seconds = parseInteger(tokens[0]!);
        if (seconds === null) return invalid('MP_BAD_ARGS', '!mp start expects an integer', raw);
      }
      return { kind: 'parsed', command: { verb: 'start', seconds }, raw };
    }

    case 'password': {
      const password = unquote(rest.trim());
      return { kind: 'parsed', command: { verb: 'password', password }, raw };
    }

    case 'addref':
    case 'removeref': {
      const users = parseUserList(rest);
      if (users.length === 0) {
        return invalid('MP_BAD_ARGS', `!mp ${verb} requires at least one username`, raw);
      }
      return { kind: 'parsed', command: { verb, users }, raw };
    }

    default:
      return invalid('MP_UNKNOWN_COMMAND', `unsupported command "!mp ${verb}"`, raw);
  }
}

function noArgs(verb: MpVerb, tokens: string[], raw: string): ParseResult {
  if (tokens.length > 0) {
    return invalid('MP_BAD_ARGS', `!mp ${verb} does not accept arguments`, raw);
  }
  return { kind: 'parsed', command: { verb } as unknown as MpCommand, raw };
}

function invalid(code: MpErrorCode, message: string, raw: string): ParseResult {
  return { kind: 'invalid', error: { code, message }, raw };
}

function parseInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    tokens.push(match[1] ?? match[2] ?? '');
  }
  return tokens;
}

/** Splits a trailing numeric/colour argument from a username that may contain spaces. */
function splitTrailing(rest: string): { head: string; tail: string } | null {
  const trimmed = rest.trim();
  const quoted = /^"([^"]*)"\s+(\S+)$/.exec(trimmed);
  if (quoted) return { head: quoted[1]!, tail: quoted[2]! };
  const match = /^(.*\S)\s+(\S+)$/.exec(trimmed);
  if (!match) return null;
  return { head: match[1]!, tail: match[2]! };
}

/**
 * A single username may contain spaces, hyphens, underscores and brackets.
 * Multiple referees are comma-separated so spaces stay unambiguous.
 */
function parseUserList(rest: string): string[] {
  const trimmed = rest.trim();
  if (!trimmed) return [];
  if (!trimmed.includes(',')) return [unquote(trimmed)].filter(Boolean);
  return trimmed
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter(Boolean);
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}