import {
  findSlotByLabel,
  findStageForMatch,
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

interface BeatmapLabelFields {
  artist: string;
  title: string;
  mapper: string;
  difficultyName: string;
}

function beatmapLabel(info: BeatmapLabelFields): string {
  const mapper = info.mapper ? ` (${info.mapper})` : '';
  const difficulty = info.difficultyName ? ` [${info.difficultyName}]` : '';
  return `${info.artist} - ${info.title}${mapper}${difficulty}`;
}

type BeatmapLinkInfo = {
  artist: string;
  title: string;
  mapper: string;
  difficultyName: string;
  beatmapUrl: string;
};

function beatmapLink(beatmap: BeatmapLinkInfo | null): string {
  if (!beatmap) return '';
  const label = beatmapLabel(beatmap);
  return beatmap.beatmapUrl ? `[${label}](${beatmap.beatmapUrl})` : escapeDiscord(label);
}

function mappoolLink(
  session: MatchSession,
  tournament: Tournament,
  slotLabel: string | null,
  beatmapId: number | null,
): string {
  const label = slotLabel ?? '';
  for (const source of [session.configSnapshot, tournament]) {
    if (!source) continue;
    const stage = findStageForMatch(source, session.matchId);
    const info = stage ? findSlotByLabel(stage, label)?.beatmap : undefined;
    if (info && (info.title || info.artist)) return beatmapLink(info);
  }
  if (beatmapId === null) return label;
  return `[${label || `beatmap ${beatmapId}`} (${beatmapId})](https://osu.ppy.sh/b/${beatmapId})`;
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
  thumbnail = true,
): DiscordEmbed {
  return {
    url: matchUrl(input.session) || undefined,
    footer: footerText ? { text: footerText.slice(0, FIELD_LIMIT) } : undefined,
    thumbnail: thumbnail && input.beatmap?.coverUrl ? { url: input.beatmap.coverUrl } : undefined,
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
      const firstPickSide = session.queue.find((step) => step.kind === 'pick')?.side ?? '';
      const firstPick = sideName(tournament, session, firstPickSide);
      const bans = session.actions.filter((action) => action.kind === 'ban');
      const banLines: string[] = [];
      for (const [teamId, label] of [
        [session.teamOneId, left],
        [session.teamTwoId, right],
      ] as const) {
        const entries = bans
          .filter((action) => action.teamId === teamId)
          .map((action) => mappoolLink(session, tournament, action.slotLabel, action.beatmapId));
        if (entries.length === 0) continue;
        banLines.push(`**${escapeDiscord(label)} bans:**`, ...entries);
      }
      let description = `**Score:** ${leftDisplay} | ${session.wins.team_one} - ${session.wins.team_two} | ${rightDisplay}`;
      if (firstPick) description += `\n\n**First pick:** ${escapeDiscord(firstPick)}`;
      if (matchUrl(session)) description += `\n\n${matchUrl(session)}`;
      if (banLines.length > 0) description += `\n${banLines.join('\n')}`;
      return [
        {
          ...baseEmbed(input, footerText, false),
          title: (context.stage ? `${context.stage}: ${session.matchName}` : session.matchName).slice(
            0,
            TITLE_LIMIT,
          ),
          description: description.slice(0, DESCRIPTION_LIMIT),
          color: winner ? WIN_COLOR : DISCORD_EMBED_COLOR,
        },
      ];
    }
    case 'action_applied': {
      const styles: Record<string, { title: string; verb: string }> = {
        pick: { title: `📌 Pick - ${session.matchName}`, verb: 'picked' },
        ban: { title: `🔨 Ban - ${session.matchName}`, verb: 'banned' },
        protect: { title: `🛡 Protect - ${session.matchName}`, verb: 'protected' },
      };
      const style = styles[context.action] ?? {
        title: `Manual action - ${session.matchName}`,
        verb: 'applied',
      };
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
