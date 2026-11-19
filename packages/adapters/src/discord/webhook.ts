/** Discord embed color used by the reference client. */
export const DISCORD_EMBED_COLOR = 15258703;

/** Discord rejects payloads with more than 10 embeds. */
export const DISCORD_MAX_EMBEDS = 10;

export const DISCORD_WEBHOOK_TIMEOUT_MS = 5000;

export interface DiscordWebhookPayload {
  embeds: { description: string; color: number }[];
}

/** One embed per rendered automation message, empty messages dropped. */
export function buildDiscordWebhookPayload(messages: string[]): DiscordWebhookPayload {
  return {
    embeds: messages
      .map((message) => message.trim())
      .filter((message) => message.length > 0)
      .slice(0, DISCORD_MAX_EMBEDS)
      .map((description) => ({ description, color: DISCORD_EMBED_COLOR })),
  };
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
