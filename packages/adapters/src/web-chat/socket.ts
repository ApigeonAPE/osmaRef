import WebSocket from 'ws';

export interface OsuChatSocketOptions {
  url: string;
  getAccessToken: () => Promise<string>;
  onMessage: (payload: unknown) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error', detail?: string) => void;
  /** 30s per osu!web docs keeps public channels active. */
  keepaliveMs?: number;
  onKeepalive?: () => Promise<void>;
}

/**
 * osu!web notification websocket used for realtime chat.
 *
 * The access token stays in the main process; it is only placed in the
 * connection header and never forwarded to the renderer.
 */
export class OsuChatSocket {
  private readonly options: OsuChatSocketOptions;
  private socket: WebSocket | null = null;
  private keepalive: NodeJS.Timeout | null = null;
  private closedByUser = false;

  constructor(options: OsuChatSocketOptions) {
    this.options = options;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Ask the notification server to (re)subscribe to chat channels. */
  startChat(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event: 'chat.start' }));
    }
  }

  async connect(): Promise<void> {
    if (this.socket) return;
    this.closedByUser = false;
    this.options.onStatus?.('connecting');
    const token = await this.options.getAccessToken();

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.options.url, {
        headers: { authorization: `Bearer ${token}` },
      });
      this.socket = socket;

      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('osu! chat websocket connection timed out'));
      }, 15_000);

      socket.on('open', () => {
        clearTimeout(timer);
        this.options.onStatus?.('open');
        socket.send(JSON.stringify({ event: 'chat.start' }));
        this.startKeepalive();
        resolve();
      });

      socket.on('message', (data: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(data.toString()) as unknown;
          this.options.onMessage(payload);
        } catch {
          // ignore malformed frames
        }
      });

      socket.on('error', (error: Error) => {
        clearTimeout(timer);
        this.options.onStatus?.('error', error.message);
        reject(error);
      });

      socket.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timer);
        this.stopKeepalive();
        this.socket = null;
        const detail = reason.length > 0 ? `code ${code}: ${reason.toString()}` : `code ${code}`;
        this.options.onStatus?.('closed', detail);
      });
    });
  }

  close(): void {
    this.closedByUser = true;
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'chat.end' }));
        }
        socket.close();
      } catch {
        socket.terminate();
      }
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    const interval = this.options.keepaliveMs ?? 30_000;
    if (!this.options.onKeepalive) return;
    this.keepalive = setInterval(() => {
      void this.options.onKeepalive?.().catch(() => undefined);
    }, interval);
    this.keepalive.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }
}