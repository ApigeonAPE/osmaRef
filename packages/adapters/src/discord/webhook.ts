/** Discord embed color used by the reference client. */
export const DISCORD_EMBED_COLOR = 15258703;

/** Discord rejects payloads with more than 10 embeds. */
export const DISCORD_MAX_EMBEDS = 10;

export const DISCORD_WEBHOOK_TIMEOUT_MS = 5000;

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbedImage {
  url: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  footer?: DiscordEmbedFooter;
  thumbnail?: DiscordEmbedImage;
  image?: DiscordEmbedImage;
  fields?: DiscordEmbedField[];
  timestamp?: string;
}

/** Presentation settings shared by every outgoing webhook. */
export interface DiscordWebhookStyle {
  authorImage?: string;
  authorName?: string;
  bottomImage?: string;
  footerIconUrl?: string;
  footerText?: string;
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  embeds: DiscordEmbed[];
}

/** One plain-text embed per rendered message, empty messages dropped. */
export function buildDiscordWebhookPayload(
  messages: string[],
  style: DiscordWebhookStyle = {},
): DiscordWebhookPayload {
  const embeds: DiscordEmbed[] = messages
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .slice(0, DISCORD_MAX_EMBEDS)
    .map((description) => ({ description, color: DISCORD_EMBED_COLOR }));
  return payloadFromEmbeds(embeds, style);
}

/**
 * Applies the shared presentation settings to prepared embeds. Blank settings
 * leave the corresponding field out, so an unconfigured webhook stays plain.
 */
export function payloadFromEmbeds(
  embeds: DiscordEmbed[],
  style: DiscordWebhookStyle = {},
): DiscordWebhookPayload {
  const authorName = style.authorName?.trim();
  const authorImage = style.authorImage?.trim();
  const bottomImage = style.bottomImage?.trim();
  const footerIconUrl = style.footerIconUrl?.trim();
  const footerText = style.footerText?.trim();

  const payload: DiscordWebhookPayload = {
    embeds: embeds.slice(0, DISCORD_MAX_EMBEDS).map((embed) => {
      const next: DiscordEmbed = { ...embed };
      if (bottomImage) next.image = { url: bottomImage };
      const text = footerText || next.footer?.text;
      if (text) {
        const icon = footerIconUrl || next.footer?.icon_url;
        next.footer = icon ? { text, icon_url: icon } : { text };
      } else {
        delete next.footer;
      }
      return next;
    }),
  };
  if (authorName) payload.username = authorName;
  if (authorImage) payload.avatar_url = authorImage;
  return payload;
}

export interface DiscordWebhookResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface DiscordWebhookOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function sendDiscordWebhook(
  url: string,
  payload: DiscordWebhookPayload,
  options: DiscordWebhookOptions = {},
): Promise<DiscordWebhookResult> {
  if (payload.embeds.length === 0) return { ok: true, status: 0 };

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DISCORD_WEBHOOK_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
