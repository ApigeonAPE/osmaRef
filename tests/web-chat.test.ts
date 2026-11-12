import { describe, expect, it } from 'vitest';
import { WebChatClient } from '@osmaref/adapters';
import type { OsuApiClient } from '@osmaref/adapters';

function clientWith(payload: unknown): OsuApiClient {
  return {
    chatHistory: async () => payload,
    chatJoin: async () => undefined,
    chatLeave: async () => undefined,
    chatSend: async () => undefined,
  } as unknown as OsuApiClient;
}

describe('osu!web chat payloads', () => {
  it('resolves sender names from the users array', async () => {
    const chat = new WebChatClient({
      client: clientWith({
        messages: [
          {
            message_id: 7,
            channel_id: 65576800,
            sender_id: 42,
            content: 'hello',
            timestamp: '2026-11-10T12:00:00Z',
          },
        ],
        users: [{ id: 42, username: 'Kamiina Botan' }],
      }),
      selfUserId: 42,
    });

    const [message] = await chat.history('65576800', 20);
    expect(message?.username).toBe('Kamiina Botan');
    expect(message?.self).toBe(true);
  });

  it('resolves websocket sender names from data.users', () => {
    const chat = new WebChatClient({ client: clientWith({}), selfUserId: 1 });
    const received: string[] = [];
    chat.onMessage((message) => received.push(message.username));
    chat.ingest({
      event: 'chat.message.new',
      data: {
        messages: [
          {
            message_id: 8,
            channel_id: 5,
            sender_id: 2,
            content: 'hi',
            timestamp: '2026-11-10T12:00:01Z',
          },
        ],
        users: [{ id: 2, username: 'Player Two' }],
      },
    });
    expect(received).toEqual(['Player Two']);
  });
});