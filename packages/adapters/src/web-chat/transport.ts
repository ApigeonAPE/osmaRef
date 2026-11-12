import type { ChatEnvelope, ChatTransport } from '../types';
import type { OsuApiClient } from '../osu/api';

export interface WebChatClientOptions {
  /** Local osu! API client; the access token never leaves the main process. */
  client: OsuApiClient;
  selfUserId?: number | null;
}

/**
 * osu!web chat API called directly with the desktop's OAuth access token.
 */
export class WebChatClient implements ChatTransport {
  readonly kind = 'web' as const;
  private readonly options: WebChatClientOptions;
  private readonly listeners = new Set<(message: ChatEnvelope) => void>();
  private readonly seen = new Set<string>();

  constructor(options: WebChatClientOptions) {
    this.options = options;
  }

  async join(channelId: string): Promise<void> {
    if (!this.options.selfUserId) throw new Error('cannot join a chat channel without a user id');
    await this.options.client.chatJoin(channelId, this.options.selfUserId);
  }

  async part(channelId: string): Promise<void> {
    if (!this.options.selfUserId) return;
    await this.options.client.chatLeave(channelId, this.options.selfUserId);
  }

  async send(channelId: string, text: string): Promise<void> {
    await this.options.client.chatSend(channelId, text);
  }

  async history(channelId: string, limit: number): Promise<ChatEnvelope[]> {
    const payload = await this.options.client.chatHistory(channelId, limit);
    const record = asRecord(payload);
    const users = userNames(record.users);
    return asArray(record.messages)
      .map((message) => this.toEnvelope(channelId, asRecord(message), users))
      .filter((message): message is ChatEnvelope => message !== null);
  }

  onMessage(listener: (message: ChatEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Feeds a `chat.message.new` websocket payload into the client. */
  ingest(payload: unknown): void {
    const data = asRecord(asRecord(payload).data);
    const users = userNames(data.users);
    for (const message of asArray(data.messages)) {
      const channelId = String(asRecord(message).channel_id ?? '');
      const envelope = this.toEnvelope(channelId, asRecord(message), users);
      if (!envelope) continue;
      if (this.seen.has(envelope.id)) continue;
      this.seen.add(envelope.id);
      if (this.seen.size > 5000) {
        const first = this.seen.values().next().value;
        if (first) this.seen.delete(first);
      }
      for (const listener of this.listeners) listener(envelope);
    }
  }

  private toEnvelope(
    channelId: string,
    raw: Record<string, unknown>,
    users: Map<number, string> = new Map(),
  ): ChatEnvelope | null {
    const id = raw.message_id === undefined ? null : String(raw.message_id);
    const sender = asRecord(raw.sender);
    const content = typeof raw.content === 'string' ? raw.content : '';
    if (!id || !content) return null;
    const senderId = typeof raw.sender_id === 'number' ? raw.sender_id : null;
    const username =
      typeof sender.username === 'string' && sender.username.length > 0
        ? sender.username
        : senderId !== null
          ? users.get(senderId) ?? `#${senderId}`
          : 'unknown';
    return {
      id,
      channelId,
      userId: senderId,
      username,
      text: content,
      at: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
      self: senderId !== null && this.options.selfUserId === senderId,
      system: senderId === null,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Resolves `sender_id` references from the `users` array in chat payloads. */
function userNames(value: unknown): Map<number, string> {
  const names = new Map<number, string>();
  for (const entry of asArray(value)) {
    const user = asRecord(entry);
    const id = Number(user.id ?? user.user_id);
    const username = typeof user.username === 'string' ? user.username : '';
    if (Number.isSafeInteger(id) && id > 0 && username) names.set(id, username);
  }
  return names;
}