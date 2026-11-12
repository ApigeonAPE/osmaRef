import type {
  AutomationRule,
  AutomationTrigger,
  MatchSession,
  Tournament,
} from '@osmaref/contracts';

export interface TemplateContext {
  tournament: string;
  match: string;
  team_one: string;
  team_two: string;
  score_one: number;
  score_two: number;
  slot: string;
  beatmap: string;
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

export function selectAutomationRules(
  rules: AutomationRule[],
  trigger: AutomationTrigger,
  slotLabel: string | null,
): AutomationRule[] {
  return rules.filter((rule) => {
    if (!rule.enabled || rule.trigger !== trigger) return false;
    if (rule.slotLabel && slotLabel) {
      return rule.slotLabel.toUpperCase() === slotLabel.toUpperCase();
    }
    return rule.slotLabel === null;
  });
}

export function buildTemplateContext(
  tournament: Tournament,
  session: MatchSession,
  teamOneName: string,
  teamTwoName: string,
  extra: Partial<TemplateContext> = {},
): TemplateContext {
  return {
    tournament: tournament.name,
    match: session.matchName,
    team_one: teamOneName,
    team_two: teamTwoName,
    score_one: session.wins.team_one,
    score_two: session.wins.team_two,
    slot: session.currentSlotLabel ?? '',
    beatmap: String(session.currentBeatmapId ?? ''),
    winner: '',
    ...extra,
  };
}

/** Applies `{{variables}}` in automation messages; never evaluates code. */
export function expandAutomationMessages(
  rules: AutomationRule[],
  context: Partial<TemplateContext>,
): string[] {
  const messages: string[] = [];
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.type === 'chat') {
        messages.push(renderTemplate(action.template, context));
      }
    }
  }
  return messages;
}