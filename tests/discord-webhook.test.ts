import { describe, expect, it, vi } from 'vitest';
import {
  DISCORD_EMBED_COLOR,
  DISCORD_MAX_EMBEDS,
  buildDiscordWebhookPayload,
  payloadFromEmbeds,
  sendDiscordWebhook,
} from '@osmaref/adapters';

const URL = 'https://discord.com/api/webhooks/1/token';

describe('discord webhook payload', () => {
  it('turns messages into embeds and drops empty ones', () => {
    expect(buildDiscordWebhookPayload(['one', '  ', '', 'two'])).toEqual({
      embeds: [
        { description: 'one', color: DISCORD_EMBED_COLOR },
        { description: 'two', color: DISCORD_EMBED_COLOR },
      ],
    });
  });

  it('caps embeds at the discord limit', () => {
    const messages = Array.from({ length: DISCORD_MAX_EMBEDS + 5 }, (_, i) => `m${i}`);
    expect(buildDiscordWebhookPayload(messages).embeds).toHaveLength(DISCORD_MAX_EMBEDS);
  });
});

describe('discord webhook style', () => {
  it('applies the shared presentation settings', () => {
    const payload = buildDiscordWebhookPayload(['hi'], {
      authorName: 'osu! referee',
      authorImage: 'https://example.com/a.png',
      bottomImage: 'https://example.com/b.png',
      footerIconUrl: 'https://example.com/i.png',
      footerText: 'Cup 2026',
    });

    expect(payload).toEqual({
      username: 'osu! referee',
      avatar_url: 'https://example.com/a.png',
      embeds: [
        {
          description: 'hi',
          color: DISCORD_EMBED_COLOR,
          image: { url: 'https://example.com/b.png' },
          footer: { text: 'Cup 2026', icon_url: 'https://example.com/i.png' },
        },
      ],
    });
  });

  it('keeps an embed footer when only the icon is configured', () => {
    const payload = payloadFromEmbeds([{ description: 'hi', footer: { text: 'Cup' } }], {
      footerIconUrl: 'https://example.com/i.png',
    });

    expect(payload.embeds[0]?.footer).toEqual({
      text: 'Cup',
      icon_url: 'https://example.com/i.png',
    });
  });

  it('omits blank settings', () => {
    expect(
      payloadFromEmbeds([{ description: 'hi' }], { authorName: ' ', footerText: '' }),
    ).toEqual({ embeds: [{ description: 'hi' }] });
  });
});

describe('sendDiscordWebhook', () => {
  it('posts json and reports success', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await sendDiscordWebhook(URL, buildDiscordWebhookPayload(['hi']), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 204 });
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe(URL);
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(String(call[1].body))).toEqual({
      embeds: [{ description: 'hi', color: DISCORD_EMBED_COLOR }],
    });
  });

  it('reports non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await sendDiscordWebhook(URL, buildDiscordWebhookPayload(['hi']), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: false, status: 404 });
  });

  it('reports network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('boom');
    });
    const result = await sendDiscordWebhook(URL, buildDiscordWebhookPayload(['hi']), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('does nothing without messages', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await sendDiscordWebhook(URL, buildDiscordWebhookPayload([' ']), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ ok: true, status: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
