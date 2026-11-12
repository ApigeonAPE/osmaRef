export interface OsuApiClientOptions {
  getAccessToken: () => Promise<string>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Called for every failed request; used for connection diagnostics. */
  onRequestError?: (path: string, message: string) => void;
}

export interface OsuUserSummary {
  userId: number;
  username: string;
}

export interface OsuScorePage {
  scores: unknown[];
  complete: boolean;
}

export interface BeatmapDetails {
  id: number;
  title: string;
  artist: string;
  difficultyName: string;
  mapper: string;
  mode: string;
}

/**
 * Local osu!web API client.
 *
 * The desktop holds the OAuth access token and talks to osu!web directly; the
 * companion server is only used for the initial authorization and token
 * refresh, because refresh requires the OAuth client secret.
 */
export class OsuApiClient {
  private readonly options: OsuApiClientOptions;

  constructor(options: OsuApiClientOptions) {
    this.options = options;
  }

  async me(): Promise<OsuUserSummary> {
    const payload = await this.request<Record<string, unknown>>('/me');
    return {
      userId: Number(payload.id),
      username: String(payload.username ?? payload.id ?? 'unknown'),
    };
  }

  async getUser(userId: number): Promise<OsuUserSummary> {
    const payload = await this.request<Record<string, unknown>>(`/users/${userId}`);
    return {
      userId: Number(payload.id ?? userId),
      username: String(payload.username ?? ''),
    };
  }

  /** The `@` prefix forces a username lookup, so numeric names are not ids. */
  async getUserByName(username: string): Promise<OsuUserSummary> {
    const payload = await this.request<Record<string, unknown>>(
      `/users/@${encodeURIComponent(username)}/osu`,
    );
    return {
      userId: Number(payload.id),
      username: String(payload.username ?? username),
    };
  }

  async getBeatmap(beatmapId: number): Promise<BeatmapDetails> {
    const payload = await this.request<Record<string, unknown>>(`/beatmaps/${beatmapId}`);
    const set = typeof payload.beatmapset === 'object' && payload.beatmapset !== null
      ? (payload.beatmapset as Record<string, unknown>)
      : {};
    return {
      id: Number(payload.id ?? beatmapId),
      title: String(set.title ?? payload.title ?? ''),
      artist: String(set.artist ?? payload.artist ?? ''),
      difficultyName: String(payload.version ?? ''),
      mapper: String(set.creator ?? ''),
      mode: String(payload.mode ?? ''),
    };
  }

  async chatJoin(channelId: string, userId: number): Promise<void> {
    await this.request(
      `/chat/channels/${encodeURIComponent(channelId)}/users/${userId}`,
      { method: 'PUT', apiVersion: false },
    );
  }

  async chatLeave(channelId: string, userId: number): Promise<void> {
    await this.request(
      `/chat/channels/${encodeURIComponent(channelId)}/users/${userId}`,
      { method: 'DELETE', apiVersion: false },
    );
  }

  /** The notification websocket endpoint is issued by osu!web, not hardcoded. */
  async getNotificationsEndpoint(): Promise<string> {
    const payload = await this.request<Record<string, unknown>>('/notifications');
    return typeof payload.endpoint === 'string' ? payload.endpoint : '';
  }

  async chatSend(channelId: string, text: string): Promise<void> {
    await this.request(`/chat/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: { message: text, is_action: false },
      apiVersion: false,
    });
  }

  async chatHistory(channelId: string, limit: number): Promise<unknown> {
    return this.request(
      `/chat/channels/${encodeURIComponent(channelId)}/messages?limit=${Math.min(Math.max(limit, 1), 100)}`,
      { apiVersion: false },
    );
  }

  async chatKeepalive(): Promise<void> {
    await this.request('/chat/keepalive', { method: 'POST', apiVersion: false });
  }

  /** Reads every score page for one played playlist item. */
  async playlistScores(roomId: string, playlistItemId: string): Promise<OsuScorePage> {
    const collected: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const query = new URLSearchParams({ limit: '50' });
      if (cursor) query.set('cursor_string', cursor);
      const payload = await this.request<Record<string, unknown>>(
        `/rooms/${encodeURIComponent(roomId)}/playlist/${encodeURIComponent(playlistItemId)}/scores?${query.toString()}`,
      );
      const scores = Array.isArray(payload.scores) ? payload.scores : [];
      collected.push(...scores);
      const next = payload.cursor_string;
      cursor = typeof next === 'string' && next.length > 0 ? next : null;
      if (!cursor) break;
    }
    return { scores: collected, complete: cursor === null };
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; apiVersion?: boolean } = {},
  ): Promise<T> {
    try {
      return await this.performRequest<T>(path, options);
    } catch (error) {
      this.options.onRequestError?.(
        path,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  private async performRequest<T>(
    path: string,
    options: { method?: string; body?: unknown; apiVersion?: boolean } = {},
  ): Promise<T> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const token = await this.options.getAccessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    };
    if (options.apiVersion !== false) headers['x-api-version'] = '20220705';
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const baseUrl = (this.options.baseUrl ?? 'https://osu.ppy.sh/api/v2').replace(/\/$/, '');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`osu! API ${path} failed (${response.status}): ${text.slice(0, 200)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) {
      throw new Error('osu! API response is too large');
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}