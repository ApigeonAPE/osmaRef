export interface IrcMessage {
  raw: string;
  tags: Record<string, string>;
  prefix: string | null;
  nick: string | null;
  command: string;
  params: string[];
  trailing: string | null;
}

/**
 * Parses one IRC protocol line.
 * Bancho is a partial implementation, so the parser stays permissive.
 */
export function parseIrcLine(line: string): IrcMessage | null {
  const raw = line.replace(/\r?\n$/, '');
  if (!raw) return null;

  let rest = raw;
  const tags: Record<string, string> = {};

  if (rest.startsWith('@')) {
    const space = rest.indexOf(' ');
    if (space === -1) return null;
    const tagPart = rest.slice(1, space);
    rest = rest.slice(space + 1);
    for (const pair of tagPart.split(';')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) {
        tags[pair] = '';
      } else {
        tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
      }
    }
  }

  let prefix: string | null = null;
  if (rest.startsWith(':')) {
    const space = rest.indexOf(' ');
    if (space === -1) return null;
    prefix = rest.slice(1, space);
    rest = rest.slice(space + 1);
  }

  const params: string[] = [];
  let trailing: string | null = null;

  while (rest.length > 0) {
    if (rest.startsWith(':')) {
      trailing = rest.slice(1);
      rest = '';
      break;
    }
    const space = rest.indexOf(' ');
    if (space === -1) {
      params.push(rest);
      rest = '';
      break;
    }
    const token = rest.slice(0, space);
    if (token) params.push(token);
    rest = rest.slice(space + 1).replace(/^ +/, '');
  }

  const command = (params.shift() ?? '').toUpperCase();
  if (!command) return null;

  const nick = prefix ? prefix.split('!')[0]?.split('@')[0] ?? null : null;

  return { raw, tags, prefix, nick, command, params, trailing };
}

function unescapeTag(value: string): string {
  return value
    .replace(/\\:/g, ';')
    .replace(/\\s/g, ' ')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

export interface Privmsg {
  from: string;
  target: string;
  text: string;
}

export function toPrivmsg(message: IrcMessage): Privmsg | null {
  if (message.command !== 'PRIVMSG' || !message.nick) return null;
  const target = message.params[0] ?? '';
  const text = message.trailing ?? '';
  if (!target) return null;
  return { from: message.nick, target, text };
}

export function isChannel(target: string): boolean {
  return target.startsWith('#');
}

export function roomIdFromChannel(channel: string): string | null {
  const match = /^#mp_(\d+)$/i.exec(channel);
  return match?.[1] ?? null;
}

export function channelForRoom(roomId: string): string {
  return `#mp_${roomId}`;
}

/**
 * Splits a raw stream into complete IRC lines.
 * Bancho can coalesce or split TCP segments arbitrarily.
 */
export class LineBuffer {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return lines.filter((line) => line.length > 0);
  }

  reset(): void {
    this.buffer = '';
  }
}