import {
  findTeam,
  type AutomationTrigger,
  type BeatmapInfo,
  type MatchSession,
  type Tournament,
} from '@osmaref/contracts';
import type { TemplateContext } from '@osmaref/domain';
import {
  DISCORD_EMBED_COLOR,
  type DiscordEmbed,
  type DiscordEmbedField,
} from './webhook';

const WIN_COLOR = 0x32a852;
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
const FIELD_LIMIT = 1024;

export interface AutomationEmbedInput {
  trigger: AutomationTrigger;
  tournament: Tournament;
  session: MatchSession;
  context: TemplateContext;
  beatmap: BeatmapInfo | null;
  refereeName?: string | null;
  now?: Date;
}

/** Escapes Discord markdown so names and beatmap titles cannot restyle the embed. */
function escapeDiscord(value: string): string {
  return value.replace(/([\\*_~`|>])/g, '\\$1');
}

function linkLabel(value: string): string {
  return escapeDiscord(value).replace(/[[\]]/g, '\\$&');
}

function teamName(tournament: Tournament, teamId: string | null): string {
  return teamId ? (findTeam(tournament, teamId)?.name ?? teamId) : '';
}

function sideName(tournament: Tournament, session: MatchSession, side: string): string {
  if (side === 'team_one') return teamName(tournament, session.teamOneId);
  if (side === 'team_two') return teamName(tournament, session.teamTwoId);
  return '';
}

function matchOutcome(
  tournament: Tournament,
  session: MatchSession,
): { winner: string; loser: string } {
  if (session.wins.team_one === session.wins.team_two) return { winner: '', loser: '' };
  const one = teamName(tournament, session.teamOneId);
  const two = teamName(tournament, session.teamTwoId);
  return session.wins.team_one > session.wins.team_two
    ? { winner: one, loser: two }
    : { winner: two, loser: one };
}

function matchUrl(session: MatchSession): string {
  return session.roomId ? `https://osu.ppy.sh/community/matches/${session.roomId}` : '';
}

function beatmapLink(beatmap: BeatmapInfo | null): string {
  if (!beatmap) return '';
  const label = linkLabel(
    `${beatmap.artist} - ${beatmap.title} [${beatmap.difficultyName}]`.trim(),
  );
  return beatmap.beatmapUrl ? `[${label}](${beatmap.beatmapUrl})` : label;
}

function field(name: string, value: string, inline = true): DiscordEmbedField | null {
  const text = value.trim().slice(0, FIELD_LIMIT);
  return text ? { name, value: text, inline } : null;
}

function compact(values: (DiscordEmbedField | null)[]): DiscordEmbedField[] {
  return values.filter((value): value is DiscordEmbedField => value !== null);
}

function baseEmbed(
  input: AutomationEmbedInput,
  footerText: string | undefined,
): DiscordEmbed {
  return {
    url: matchUrl(input.session) || undefined,
    footer: footerText ? { text: footerText.slice(0, FIELD_LIMIT) } : undefined,
    thumbnail: input.beatmap?.coverUrl ? { url: input.beatmap.coverUrl } : undefined,
    timestamp: (input.now ?? new Date()).toISOString(),
  };
}

/** Builds the single embed sent for one automation trigger. */
export function buildAutomationEmbeds(input: AutomationEmbedInput): DiscordEmbed[] {
  const { session, tournament, context } = input;
  const footerText = input.refereeName ? `Match referee was ${input.refereeName}` : undefined;

  switch (input.trigger) {
    case 'match_created': {
      return [
        {
          ...baseEmbed(input, footerText),
          title: `${session.matchName} created`.slice(0, TITLE_LIMIT),
          description: [
            escapeDiscord(session.matchName),
            matchUrl(session) ? `MP link: ${matchUrl(session)}` : '',
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, DESCRIPTION_LIMIT),
          color: DISCORD_EMBED_COLOR,
          fields: compact([
            field('Stage', context.stage),
            field('Best of', String(session.bestOf)),
          ]),
        },
      ];
    }
    case 'beatmap_started': {
      const link = beatmapLink(input.beatmap);
      return [
        {
          ...baseEmbed(input, footerText),
          title: context.slot
            ? `🎵 ${context.slot} started - ${session.matchName}`.slice(0, TITLE_LIMIT)
            : `🎵 Beatmap started - ${session.matchName}`,
          description: (link || escapeDiscord(context.beatmap)).slice(0, DESCRIPTION_LIMIT),
          color: DISCORD_EMBED_COLOR,
          fields: compact([
            field('Slot', context.slot),
            field('Score', `${session.wins.team_one} - ${session.wins.team_two}`),
          ]),
        },
      ];
    }
    case 'beatmap_completed': {
      const winner = sideName(tournament, session, context.winner);
      const left = teamName(tournament, session.teamOneId);
      const right = teamName(tournament, session.teamTwoId);
      const outcome = winner
        ? `__${escapeDiscord(winner)}__ | ${session.wins.team_one} - ${session.wins.team_two} | ${escapeDiscord(winner === left ? right : left)}`
        : `${escapeDiscord(left)} | ${session.wins.team_one} - ${session.wins.team_two} | ${escapeDiscord(right)}`;
      return [
        {
          ...baseEmbed(input, footerText),
          title: winner
            ? `🏁 ${winner} won ${context.slot || 'the map'}`.slice(0, TITLE_LIMIT)
            : `🏁 ${context.slot || 'Beatmap'} completed`.slice(0, TITLE_LIMIT),
          description: [
            outcome,
            `Map score: ${context.mapscore_red} - ${context.mapscore_blue}`,
          ]
            .join('\n')
            .slice(0, DESCRIPTION_LIMIT),
          color: winner ? WIN_COLOR : DISCORD_EMBED_COLOR,
          fields: compact([
            field('Slot', context.slot),
            field('Beatmap', beatmapLink(input.beatmap)),
          ]),
        },
      ];
    }
    case 'score_updated': {
      const winner = sideName(tournament, session, context.winner);
      return [
        {
          ...baseEmbed(input, footerText),
          title: `📊 Score update - ${session.matchName}`,
          description: [
            `__${escapeDiscord(teamName(tournament, session.teamOneId))}__ | ${session.wins.team_one} - ${session.wins.team_two} | ${escapeDiscord(teamName(tournament, session.teamTwoId))}`,
            winner ? `Winner: ${escapeDiscord(winner)}` : '',
          ]
            .filter(Boolean)
            .join('\n')
            .slice(0, DESCRIPTION_LIMIT),
          color: DISCORD_EMBED_COLOR,
          fields: compact([
            field('Slot', context.slot),
            field('Winner', winner),
          ]),
        },
      ];
    }
    case 'match_finished': {
      const { winner } = matchOutcome(tournament, session);
      const left = teamName(tournament, session.teamOneId);
      const right = teamName(tournament, session.teamTwoId);
      const leftDisplay = session.wins.team_one > session.wins.team_two
        ? `__${escapeDiscord(left)}__`
        : escapeDiscord(left);
      const rightDisplay = session.wins.team_two > session.wins.team_one
        ? `__${escapeDiscord(right)}__`
        : escapeDiscord(right);
      return [
        {
          ...baseEmbed(input, footerText),
          title: session.matchName.slice(0, TITLE_LIMIT),
          description: [
            leftDisplay,
            `${session.wins.team_one} - ${session.wins.team_two}`,
            rightDisplay,
          ]
            .filter(Boolean)
            .join(' | ')
            .slice(0, DESCRIPTION_LIMIT),
          color: winner ? WIN_COLOR : DISCORD_EMBED_COLOR,
          fields: compact([
            field('Best of', String(session.bestOf)),
            field('Room', matchUrl(session)),
          ]),
        },
      ];
    }
    case 'action_applied': {
      const styles: Record<string, { title: string; verb: string }> = {
        pick: { title: `📌 Pick - ${session.matchName}`, verb: 'picked' },
        ban: { title: `🔨 Ban - ${session.matchName}`, verb: 'banned' },
        protect: { title: `🛡 Protect - ${session.matchName}`, verb: 'protected' },
      };
      const style = styles[context.action] ?? { title: `${context.action} - ${session.matchName}`, verb: 'applied' };
      const team = context.action_team;
      const description =
        team && context.slot
          ? `${escapeDiscord(team)} ${style.verb} ${escapeDiscord(context.slot)}`
          : escapeDiscord(session.matchName);
      return [
        {
          ...baseEmbed(input, footerText),
          title: style.title,
          description: description.slice(0, DESCRIPTION_LIMIT),
          color: DISCORD_EMBED_COLOR,
          fields: compact([
            field('Team', team),
            field('Slot', context.slot),
            field('Beatmap', beatmapLink(input.beatmap)),
          ]),
        },
      ];
    }
  }
  // Unreachable for the current trigger union; keeps the return type explicit.
  return [];
}
