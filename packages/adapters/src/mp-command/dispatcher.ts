import { routeMpCommand, type RouteResult } from './router';
import { executeHubActions } from './execute';
import type { HubAction, LocalEffect, MpContext } from './types';
import type { MatchTransport } from '../types';

export interface DispatchOutcome {
  handled: boolean;
  ok: boolean;
  command: string | null;
  message: string;
  actions: string[];
  effects: LocalEffect[];
  errorCode: string | null;
  at: string;
}

export interface DispatcherDeps {
  getContext: () => MpContext;
  sendChat: (text: string) => Promise<void>;
  /** Executes planned intents; only called for recognised commands with actions. */
  execute?: (actions: HubAction[]) => Promise<{ ok: boolean; message: string }>;
  transportProvider?: () => MatchTransport | null;
  onResult?: (outcome: DispatchOutcome) => void;
  now?: () => Date;
}

/**
 * Single entry point for every message a referee types in the room chat.
 *
 * Ordinary text is forwarded to chat. A recognised `!mp` command is executed
 * locally and is never forwarded, which prevents accidental execution by Bancho
 * and avoids leaking passwords into the channel.
 */
export class ChatDispatcher {
  private readonly deps: DispatcherDeps;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  async submit(text: string): Promise<DispatchOutcome> {
    const route = routeMpCommand(text, this.deps.getContext());
    if (!route.handled) {
      await this.deps.sendChat(text);
      return this.finish({
        handled: false,
        ok: true,
        command: null,
        message: 'sent',
        actions: [],
        effects: [],
        errorCode: null,
      });
    }

    if (!route.ok) {
      return this.finish(this.fromRoute(route, false, route.message));
    }

    if (route.actions.length === 0) {
      return this.finish(this.fromRoute(route, true, route.message));
    }

    const execute =
      this.deps.execute ??
      (this.deps.transportProvider
        ? async (actions: HubAction[]) => {
            const transport = this.deps.transportProvider?.();
            if (!transport) return { ok: false, message: 'no transport connected' };
            return executeHubActions(transport, actions);
          }
        : null);

    if (!execute) {
      return this.finish(this.fromRoute(route, false, 'no command executor is configured'));
    }

    const result = await execute(route.actions);
    return this.finish(
      this.fromRoute(
        route,
        result.ok,
        result.ok ? `${route.message} — ${result.message}` : result.message,
      ),
    );
  }

  private fromRoute(route: RouteResult, ok: boolean, message: string): Omit<DispatchOutcome, 'at'> {
    return {
      handled: route.handled,
      ok,
      command: route.command,
      message,
      actions: route.actions.map((action) => action.type),
      effects: route.effects,
      errorCode: route.errorCode,
    };
  }

  private finish(outcome: Omit<DispatchOutcome, 'at'>): DispatchOutcome {
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const result: DispatchOutcome = { ...outcome, at };
    this.deps.onResult?.(result);
    return result;
  }
}