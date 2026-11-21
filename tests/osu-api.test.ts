import { describe, expect, it } from 'vitest';
import { mapScore, OsuApiClient } from '@osmaref/adapters';

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
              id: 123456,
              title: 'Illusional Flashback',
              artist: 'Yunosuke',
              creator: 'SomeMapper',
              covers: {
                cover: 'https://assets.ppy.sh/beatmaps/123456/covers/cover.jpg',
              },
            },
            url: 'https://osu.ppy.sh/beatmaps/3958820',
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
      beatmapsetId: 123456,
      beatmapUrl: 'https://osu.ppy.sh/beatmaps/3958820',
      coverUrl: 'https://assets.ppy.sh/beatmaps/123456/covers/cover.jpg',
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

it('fetches a legacy multiplayer match by id', async () => {
  let requestedUrl = '';
  let requestedAgent = '';
  const client = new OsuApiClient({
    getAccessToken: async () => 'token',
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requestedUrl = String(input);
      requestedAgent = String(
        (init?.headers as Record<string, string> | undefined)?.['user-agent'] ?? '',
      );
      return new Response(
        JSON.stringify({
          id: 122026887,
          name: 'NOC26FALL: (A) vs (B)',
          users: [{ id: 30174043, username: 'player' }],
          events: [
            {
              id: 1,
              game: {
                id: 643094484,
                beatmap_id: 4954309,
                end_time: '2026-10-17T13:17:43Z',
                scores: [{ user_id: 30174043, total_score: 963967 }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });

  const match = await client.getMatch('122026887');
  expect(requestedUrl).toContain('/matches/122026887');
  expect(requestedAgent).toBe('osu!');
  expect(match.users?.[0]?.username).toBe('player');
  expect(match.events?.[0]?.game?.beatmap_id).toBe(4954309);
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

describe('multiplayer score mapping', () => {
  it('reads misses from the 20220705 statistics format', () => {
    const score = mapScore({
      user_id: 42,
      total_score: 1_000_000,
      accuracy: 0.98,
      max_combo: 500,
      statistics: { great: 211, ok: 3, meh: 1, miss: 2 },
      mods: [{ acronym: 'HD' }],
      passed: true,
    });
    expect(score.misses).toBe(2);
  });

  it('still reads the legacy count_miss key', () => {
    const score = mapScore({
      user_id: 42,
      total_score: 1_000_000,
      accuracy: 98,
      max_combo: 500,
      statistics: { count_miss: 4 },
      mods: ['HD'],
      passed: true,
    });
    expect(score.misses).toBe(4);
    expect(score.accuracy).toBeCloseTo(0.98);
  });
});
