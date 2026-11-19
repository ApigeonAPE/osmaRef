import type {
  AutomationAction,
  AutomationMessages,
  AutomationTrigger,
  MatchSession,
  Tournament,
} from '@osmaref/contracts';
import { findStageForMatch } from '@osmaref/contracts';

export interface TemplateContext {
  tournament: string;
  stage: string;
  match: string;
  team_red: string;
  team_blue: string;
  score_red: number;
  score_blue: number;
  beatmap: string;
  beatmap_id: string;
  action_team: string;
  action: string;
  action_next: string;
  next_team: string;
  mapscore_red: number;
  mapscore_blue: number;
  slot: string;
  winner: string;
}

export function renderTemplate(template: string, context: Partial<TemplateContext>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    // Only own, top-level keys: inherited names like `constructor` must never
    // leak into a generated message.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return match;
    if (!Object.prototype.hasOwnProperty.call(context, key)) return match;
    const value = (context as Record<string, unknown>)[key];
    return value === undefined || value === null ? match : String(value);
  });
}

/** Actions configured for one trigger timing, in run order. */
export function automationActionsFor(
  automation: AutomationMessages,
  trigger: AutomationTrigger,
): AutomationAction[] {
  return automation[trigger];
}

export function buildTemplateContext(
  tournament: Tournament,
  session: MatchSession,
  teamRedName: string,
  teamBlueName: string,
  extra: Partial<TemplateContext> = {},
): TemplateContext {
  const current = session.actions.at(-1) ?? null;
  const next = session.queue[session.cursor] ?? null;
  const currentTeam = current
    ? current.teamId === session.teamOneId
      ? teamRedName
      : current.teamId === session.teamTwoId
        ? teamBlueName
        : ''
    : '';
  const nextTeam = next
    ? next.side === 'team_one'
      ? teamRedName
      : teamBlueName
    : '';
  return {
    tournament: tournament.name,
    stage: findStageForMatch(tournament, session.matchId)?.name ?? '',
    match: session.matchName,
    team_red: teamRedName,
    team_blue: teamBlueName,
    score_red: session.wins.team_one,
    score_blue: session.wins.team_two,
    beatmap: '',
    beatmap_id: String(session.currentBeatmapId ?? ''),
    action_team: currentTeam,
    action: current?.kind ?? '',
    action_next: next?.kind ?? '',
    next_team: nextTeam,
    mapscore_red: 0,
    mapscore_blue: 0,
    slot: session.currentSlotLabel ?? '',
    winner: '',
    ...extra,
  };
}

/**
 * Applies `{{variables}}` to every configured message and drops blank entries.
 * The returned order is the configured order.
 */
export function expandAutomationMessages(
  messages: string[],
  context: Partial<TemplateContext>,
): string[] {
  const rendered: string[] = [];
  for (const template of messages) {
    const message = renderTemplate(template, context).trim();
    if (message) rendered.push(message);
  }
  return rendered;
}
