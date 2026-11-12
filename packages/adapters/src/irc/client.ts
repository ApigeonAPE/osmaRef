import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { normalizeIrcEndpoint } from '@osmaref/contracts';
import {
  LineBuffer,
  parseIrcLine,
  toPrivmsg,
  type IrcMessage,
  type Privmsg,
} from './parser';

export interface IrcClientOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  useTls?: boolean;
  realname?: string;
  /** Milliseconds to wait for the welcome numeric. */
  connectTimeoutMs?: number;
  /** Milliseconds to wait when retrying an alternate endpoint. */
  fallbackTimeoutMs?: number;
}

export interface IrcEndpoint {
  port: number;
  useTls: boolean;
}

/**
 * Endpoints to try for one login, in order.
 *
 * The configured endpoint comes first (normalised to Bancho's plaintext 6667 /
 * TLS 6697 pair). The other standard IRC port follows so a stale TLS/port
 * combination or a blocked port cannot strand the client.
 */
export function ircConnectTargets(host: string, port: number, useTls: boolean): IrcEndpoint[] {
  const primary = normalizeIrcEndpoint(host, port, useTls);
  const targets: IrcEndpoint[] = [{ port: primary.port, useTls: primary.useTls }];
  for (const candidate of [
    { port: 6667, useTls: false },
    { port: 6697, useTls: true },
  ]) {
    if (!targets.some((target) => target.port === candidate.port && target.useTls === candidate.useTls)) {
      targets.push(candidate);
    }
  }
  return targets;
}

/**
 * Minimal IRC client tailored to Bancho.
 *
 * Bancho implements only a subset of IRC, so this client deliberately avoids
 * CAP negotiation, SASL and other extensions. The IRC password is the token from
 * the osu! account settings page, not the account password.
 */
export class IrcClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private readonly lines = new LineBuffer();
  private readonly options: IrcClientOptions;
  private connected = false;
  private lastServerError: string | null = null;
  private readonly serverMessages: string[] = [];
  private hadServerResponse = false;

  constructor(options: IrcClientOptions) {
    super();
    this.options = options;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error('IRC client is already connecting or connected');
    }
    this.serverMessages.length = 0;
    this.lastServerError = null;

    const targets = ircConnectTargets(
      this.options.host,
      this.options.port,
      this.options.useTls ?? false,
    );
    const failures: string[] = [];

    for (const [index, target] of targets.entries()) {
      try {
        await this.attempt({
          ...this.options,
          port: target.port,
          useTls: target.useTls,
          connectTimeoutMs:
            index === 0
              ? (this.options.connectTimeoutMs ?? 20_000)
              : (this.options.fallbackTimeoutMs ?? 8_000),
        });
        return;
      } catch (error) {
        failures.push(
          `${target.port}${target.useTls ? ' (TLS)' : ' (plaintext)'}: ${errorMessage(error)}`,
        );
        const replied = this.hadServerResponse;
        // Release anything the failed attempt left behind before retrying.
        this.destroy();
        // A server that answered (bad token, throttle, ban) answers the next
        // endpoint the same way; retrying only risks a throttle and hides the
        // real reason. Silent timeouts and refused/handshake failures retry.
        if (replied) throw error;
      }
    }

    throw new Error(
      `IRC connection to ${this.options.host} failed (${failures.join('; ')})`,
    );
  }

  private attempt(options: IrcClientOptions): Promise<void> {
    this.hadServerResponse = false;
    this.connected = false;
    this.lines.reset();
    this.serverMessages.length = 0;
    this.lastServerError = null;

    return new Promise<void>((resolve, reject) => {
      const timeoutMs = options.connectTimeoutMs ?? 20_000;
      let settled = false;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off('welcomed', onWelcome);
        this.off('error', onError);
        if (error) reject(error);
        else resolve();
      };

      const onWelcome = () => finish();
      const onError = (error: Error) => finish(error);

      const timer = setTimeout(() => {
        finish(new Error(`IRC connection to ${options.host}:${options.port} timed out`));
        this.destroy();
      }, timeoutMs);

      this.once('welcomed', onWelcome);
      this.once('error', onError);

      const socket = options.useTls
        ? tls.connect({ host: options.host, port: options.port, servername: options.host })
        : net.connect({ host: options.host, port: options.port });

      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      const readyEvent = options.useTls ? 'secureConnect' : 'connect';
      socket.once(readyEvent, () => {
        this.send(`PASS ${options.password}`);
        this.send(`NICK ${options.username}`);
        this.send(`USER ${options.username} 0 * :${options.realname ?? 'osmaRef referee client'}`);
      });

      socket.on('data', (chunk: string) => {
        if (chunk.length > 0) this.hadServerResponse = true;
        for (const line of this.lines.push(chunk)) {
          this.handleLine(line);
        }
      });

      socket.on('error', (error: Error) => {
        const tlsHint =
          options.useTls && /EPROTO|wrong version|handshake|ECONNRESET/i.test(error.message)
            ? ` TLS handshake failed on ${options.host}:${options.port}; Bancho uses 6667 without TLS, so only enable TLS with port 6697.`
            : '';
        this.emit('error', new Error(`${error.message}${tlsHint}`));
      });

      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        this.lines.reset();
        finish(new Error(formatIrcLoginFailure(this.serverMessages, this.lastServerError)));
        if (wasConnected) {
          this.emit('disconnected', 'socket closed');
        }
      });
    });
  }

  disconnect(reason = 'leaving'): void {
    if (!this.socket) return;
    try {
      this.send(`QUIT :${reason}`);
    } catch {
      // best effort
    }
    this.destroy();
  }

  join(channel: string): void {
    this.send(`JOIN ${channel}`);
  }

  part(channel: string, reason = 'leaving'): void {
    this.send(`PART ${channel} :${reason}`);
  }

  privmsg(target: string, text: string): void {
    for (const line of text.split(/\r?\n/)) {
      this.send(`PRIVMSG ${target} :${line}`);
    }
  }

  notice(target: string, text: string): void {
    this.send(`NOTICE ${target} :${text}`);
  }

  send(line: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error('IRC socket is not connected');
    }
    const safe = line.replace(/[\r\n]+/g, ' ');
    socket.write(`${safe}\r\n`);
  }

  private destroy(): void {
    this.connected = false;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  private handleLine(line: string): void {
    const message = parseIrcLine(line);
    if (!message) return;

    if (message.command === 'PING') {
      this.send(`PONG :${message.trailing ?? message.params[0] ?? ''}`);
      return;
    }

    if (message.command === '001') {
      this.connected = true;
      this.serverMessages.length = 0;
      this.lastServerError = null;
      this.emit('welcomed', this.options.username);
      this.emit('message', message);
      return;
    }

    if (message.command === 'ERROR') {
      this.lastServerError = message.trailing ?? 'IRC error';
      this.emit('error', new Error(this.lastServerError));
    }

    // Bancho answers a rejected login with plain MOTD numerics and then closes
    // the socket without a 001. Keep those lines so the UI can explain why.
    if (/^\d{3}$/.test(message.command)) {
      const text = (message.trailing ?? '').trim();
      if (text && /auth|password|login|banned|restrict|throttl|token|legacy-api/i.test(text)) {
        this.serverMessages.push(text);
        if (this.serverMessages.length > 8) this.serverMessages.shift();
      }
    } else if (message.command === 'NOTICE') {
      const text = (message.trailing ?? '').trim();
      if (text && /auth|password|login|banned|restrict|throttl|token/i.test(text)) {
        this.serverMessages.push(text);
      }
    }

    const privmsg = toPrivmsg(message);
    if (privmsg) {
      this.emit('privmsg', privmsg);
    }

    if (message.command === 'NOTICE' && message.nick) {
      this.emit('notice', {
        from: message.nick,
        target: message.params[0] ?? '',
        text: message.trailing ?? '',
      });
    }

    this.emit('message', message);
  }
}

export type { IrcMessage, Privmsg };

export interface IrcNotice {
  from: string;
  target: string;
  text: string;
}

/**
 * Builds a human explanation for a pre-login disconnect.
 *
 * Bancho never sends 001 when the token is wrong; it prints MOTD numerics such
 * as "You are required to authenticate" and closes. Surfacing that line is the
 * difference between "connection closed" and an actionable error.
 */
export function formatIrcLoginFailure(
  messages: string[],
  lastError: string | null,
  fallback = 'IRC connection closed before login',
): string {
  const cleaned = messages
    .map((line) => line.replace(/^\s*[-–]\s*/, '').trim())
    .filter(Boolean);
  const serverText =
    lastError ?? (cleaned.slice(0, 2).join(' ').trim() || '');
  const hint =
    'Use the IRC password from https://osu.ppy.sh/home/account/edit#legacy-api (not your osu! account password).';

  if (!serverText) {
    return `${fallback}. ${hint}`;
  }
  if (/banned|restrict/i.test(serverText)) {
    return `Bancho refused the IRC login: ${serverText}`;
  }
  if (/throttl|too many|rate/i.test(serverText)) {
    return `Bancho throttled the IRC login: ${serverText}. Wait a moment and try again.`;
  }
  return `Bancho closed the IRC connection: ${serverText} ${hint}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}