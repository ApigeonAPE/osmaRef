import { describe, expect, it } from 'vitest';
import { OsuApiClient } from '@osmaref/adapters';

describe('osu! API client beatmap metadata', () => {
  it('extracts title, artist, difficulty and mapper', async () => {
    const client = new OsuApiClient({
      getAccessToken: async () => 'token',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 3958820,
            version: '[4K] Stage 3: Phantasm',
            mode: 'mania',
            beatmapset: {
              title: 'Illusional Flashback',
              artist: 'Yunosuke',
              creator: 'SomeMapper',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )) as typeof fetch,
    });

    await expect(client.getBeatmap(3958820)).resolves.toEqual({
      id: 3958820,
      title: 'Illusional Flashback',
      artist: 'Yunosuke',
      difficultyName: '[4K] Stage 3: Phantasm',
      mapper: 'SomeMapper',
      mode: 'mania',
    });
  });
});
it('looks up a user by username', async () => {
  let requested = '';
  const client = new OsuApiClient({
    getAccessToken: async () => 'token',
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      requested = String(input);
      return new Response(JSON.stringify({ id: 17069002, username: 'Natsume Umi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  await expect(client.getUserByName('Natsume Umi')).resolves.toEqual({
    userId: 17069002,
    username: 'Natsume Umi',
  });
  expect(requested).toContain('/users/@Natsume%20Umi/osu');
  await client.getUserByName('123');
  expect(requested).toContain('/users/@123/osu');
});

it('joins a chat channel through the user-scoped endpoint', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  const client = new OsuApiClient({
    getAccessToken: async () => 'token',
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestedUrl = String(input);
      requestedMethod = String(init?.method ?? 'GET');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  await client.chatJoin('65576800', 42);
  expect(requestedMethod).toBe('PUT');
  expect(requestedUrl).toContain('/chat/channels/65576800/users/42');
});
