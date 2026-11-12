import { isMpCommand, parseMpCommand } from './parse';
import { buildMpPlan } from './plan';
import type { HubAction, LocalEffect, MpContext } from './types';

export interface RouteResult {
  handled: boolean;
  ok: boolean;
  command: string | null;
  message: string;
  actions: HubAction[];
  effects: LocalEffect[];
  errorCode: string | null;
}

/**
 * Routes one outgoing message.
 *
 * A message that starts with `!mp` is always handled locally: it never falls
 * back to chat, even when the command is unsupported or malformed.
 */
export function routeMpCommand(input: string, ctx: MpContext): RouteResult {
  if (!isMpCommand(input)) {
    return {
      handled: false,
      ok: true,
      command: null,
      message: '',
      actions: [],
      effects: [],
      errorCode: null,
    };
  }

  const commandLabel = `!mp ${input.trim().slice(3).trim().split(/\s+/)[0]?.toLowerCase() ?? 'help'}`;
  const parsed = parseMpCommand(input);
  if (parsed.kind === 'not_mp') {
    return {
      handled: false,
      ok: true,
      command: null,
      message: '',
      actions: [],
      effects: [],
      errorCode: null,
    };
  }
  if (parsed.kind === 'invalid') {
    return {
      handled: true,
      ok: false,
      command: commandLabel,
      message: parsed.error.message,
      actions: [],
      effects: [],
      errorCode: parsed.error.code,
    };
  }

  const plan = buildMpPlan(parsed.command, ctx);
  if (!plan.ok) {
    return {
      handled: true,
      ok: false,
      command: commandLabel,
      message: plan.error.message,
      actions: [],
      effects: [],
      errorCode: plan.error.code,
    };
  }

  return {
    handled: true,
    ok: true,
    command: commandLabel,
    message: plan.plan.summary,
    actions: plan.plan.actions,
    effects: plan.plan.effects,
    errorCode: null,
  };
}