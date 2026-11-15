import WebSocket from 'ws';

export interface OsuChatSocketOptions {
  url: string;
  getAccessToken: () => Promise<string>;
  onMessage: (payload: unknown) => void;
  onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error', detail?: string) => void;
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
        this.socket = null;
        const detail = reason.length > 0 ? `code ${code}: ${reason.toString()}` : `code ${code}`;
        this.options.onStatus?.('closed', detail);
      });
    });
  }

  close(): void {
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
}
