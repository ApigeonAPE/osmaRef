import { randomBytes } from 'node:crypto';
import { shell } from 'electron';
import type { LogLevel, ServerStatus, Settings } from '@osmaref/contracts';
import { OsuApiClient } from '@osmaref/adapters';
import type { OAuthTokenSet } from './token-vault';

export interface ServerClientDeps {
  getSettings: () => Settings;
  getTokens: () => OAuthTokenSet | null;
  setTokens: (tokens: OAuthTokenSet | null) => Promise<void> | void;
  /** Connection-only diagnostics; never persisted. */
  onDiagnostic?: (level: LogLevel, scope: string, message: string) => void;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

/**
 * Client for the companion server.
 *
 * The server only performs the OAuth code exchange and token refreshes (both
 * need the client secret). It returns the token set once; afterwards all
 * osu!web calls happen locally through {@link OsuApiClient}.
 */
export class ServerClient {
  private readonly deps: ServerClientDeps;
  private loginAbort: AbortController | null = null;
  private loginTask: Promise<ServerStatus> | null = null;
  private refreshTask: Promise<string> | null = null;
  readonly osu: OsuApiClient;

  constructor(deps: ServerClientDeps) {
    this.deps = deps;
    this.osu = new OsuApiClient({
      getAccessToken: () => this.accessToken(),
      onRequestError: (path, message) => this.diag('warn', 'osu', `${path}: ${message}`),
    });
  }

  get baseUrl(): string {
    return this.deps.getSettings().serverBaseUrl;
  }

  /** Concurrent clicks share one browser login instead of polling twice. */
  login(): Promise<ServerStatus> {
    if (this.loginTask) return this.loginTask;
    this.loginTask = this.runLogin()
      .then((status) => {
        this.diag('info', 'auth', `signed in as ${status.username ?? 'unknown'}`);
        return status;
      })
      .catch((error: unknown) => {
        this.diag('warn', 'auth', `login failed: ${errorMessage(error)}`);
        throw error;
      })
      .finally(() => {
        this.loginTask = null;
      });
    return this.loginTask;
  }

  private async runLogin(): Promise<ServerStatus> {
    const attemptId = randomBytes(18).toString('base64url');
    const attemptSecret = randomBytes(48).toString('base64url');
    this.diag('info', 'auth', `login started at ${this.baseUrl}`);

    const started = await this.request<{ authorizeUrl: string; expiresAt: string }>(
      '/auth/osu/start',
      { method: 'POST', body: { attemptId, attemptSecret } },
    );

    await shell.openExternal(started.authorizeUrl);

    const controller = new AbortController();
    this.loginAbort = controller;
    const deadline = Date.now() + 10 * 60 * 1000;

    while (Date.now() < deadline) {
      if (controller.signal.aborted) throw new Error('login cancelled');
      const poll = await this.request<
        | { status: 'pending' }
        | {
            status: 'complete';
            accessToken: string;
            refreshToken: string;
            expiresAt: string;
            user: { userId: number; username: string };
          }
        | { status: 'expired' | 'unknown' }
        | { status: 'error'; message: string }
      >('/auth/desktop/poll', {
        method: 'POST',
        body: { attemptId, attemptSecret },
        signal: controller.signal,
      });

      if (poll.status === 'complete') {
        const tokens: OAuthTokenSet = {
          accessToken: poll.accessToken,
          refreshToken: poll.refreshToken,
          expiresAt: Date.parse(poll.expiresAt),
          userId: poll.user.userId,
          username: poll.user.username,
        };
        await this.deps.setTokens(tokens);
        return this.toStatus(tokens);
      }
      if (poll.status === 'expired' || poll.status === 'unknown') {
        throw new Error('the login attempt expired; try again');
      }
      if (poll.status === 'error') {
        throw new Error(poll.message);
      }
      await delay(1500);
    }
    throw new Error('login timed out');
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
    this.loginAbort = null;
  }

  async status(): Promise<ServerStatus> {
    let tokens = this.deps.getTokens();
    if (!tokens) return this.anonymous();
    if (tokens.expiresAt - Date.now() <= 60_000) {
      try {
        await this.refresh();
        tokens = this.deps.getTokens();
      } catch (error) {
        this.diag('warn', 'auth', `token refresh failed: ${errorMessage(error)}`);
        return this.anonymous();
      }
    }
    return tokens ? this.toStatus(tokens) : this.anonymous();
  }

  async logout(): Promise<ServerStatus> {
    await this.deps.setTokens(null);
    return this.anonymous();
  }

  /** Returns a valid access token, refreshing it through the server if needed. */
  async accessToken(): Promise<string> {
    const tokens = this.deps.getTokens();
    if (!tokens) throw new Error('sign in with osu! first');
    if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
    return this.refresh();
  }

  async lookupUser(userId: number): Promise<{ userId: number; username: string }> {
    return this.osu.getUser(userId);
  }

  async listTournaments(): Promise<{ id: string; name: string; revision: number; updatedAt: string }[]> {
    const payload = await this.request<{
      tournaments: { id: string; name: string; revision: number; updatedAt: string }[];
    }>('/api/v1/tournaments');
    return payload.tournaments;
  }

  async getTournament(id: string): Promise<unknown> {
    const payload = await this.request<{ tournament: unknown }>(
      `/api/v1/tournaments/${encodeURIComponent(id)}`,
    );
    return payload.tournament;
  }

  private refresh(): Promise<string> {
    if (this.refreshTask) return this.refreshTask;
    const tokens = this.deps.getTokens();
    if (!tokens) return Promise.reject(new Error('sign in with osu! first'));

    this.refreshTask = (async () => {
      const payload = await this.request<TokenResponse>('/auth/osu/refresh', {
        method: 'POST',
        body: { refreshToken: tokens.refreshToken },
      });
      const next: OAuthTokenSet = {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: Date.parse(payload.expiresAt),
        userId: tokens.userId,
        username: tokens.username,
      };
      await this.deps.setTokens(next);
      return next.accessToken;
    })();

    return this.refreshTask.finally(() => {
      this.refreshTask = null;
    });
  }

  private toStatus(tokens: OAuthTokenSet): ServerStatus {
    return {
      baseUrl: this.baseUrl,
      authenticated: true,
      username: tokens.username,
      userId: tokens.userId,
      expiresAt: new Date(tokens.expiresAt).toISOString(),
    };
  }

  private anonymous(): ServerStatus {
    return {
      baseUrl: this.baseUrl,
      authenticated: false,
      username: null,
      userId: null,
      expiresAt: null,
    };
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal ?? AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      this.diag('warn', 'server', `${options.method ?? 'GET'} ${path}: ${errorMessage(error)}`);
      throw error;
    });

    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) {
      throw new Error('server response is too large');
    }
    const payload = text ? (JSON.parse(text) as unknown) : null;
    if (!response.ok) {
      const error = (payload as { error?: { message?: string; code?: string } } | null)?.error;
      const message = error?.message ?? `server request failed (${response.status})`;
      this.diag('warn', 'server', `${options.method ?? 'GET'} ${path}: ${response.status} ${message}`);
      throw new Error(message);
    }
    return payload as T;
  }

  private diag(level: LogLevel, scope: string, message: string): void {
    this.deps.onDiagnostic?.(level, scope, message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}