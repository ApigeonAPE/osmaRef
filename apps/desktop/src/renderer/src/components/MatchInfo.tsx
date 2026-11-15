import type { Match, MatchType, RoomWinCondition, Stage, Tournament } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Section } from '../ui';

export function MatchInfo({
  tournament,
  stage,
  match,
}: {
  tournament: Tournament;
  stage: Stage;
  match: Match;
}) {
  const { t } = useI18n();

  const teamName = (teamId: number) =>
    tournament.teams.find((team) => team.id === teamId)?.name ?? `Team ${teamId}`;

  const teamModeLabel = (mode: MatchType) => {
    switch (mode) {
      case 'head_to_head':
        return t('Head to Head');
      case 'tag_coop':
        return t('Tag Coop');
      case 'team_versus':
        return t('Team VS');
      case 'tag_team_versus':
        return t('Tag Team VS');
    }
  };

  const winConditionLabel = (condition: RoomWinCondition) => {
    switch (condition) {
      case 'score':
        return t('Score');
      case 'score_v2':
        return t('Score V2');
      case 'accuracy':
        return t('Accuracy');
      case 'combo':
        return t('Combo');
    }
  };

  const group =
    match.groupId === null
      ? null
      : (stage.groups.find((entry) => entry.id === match.groupId) ?? null);

  return (
    <Section title={t('Match')}>
      <div className="match-info">
        <div className="match-info-teams">
          {match.type === 'match' ? (
            <>
              <span className="match-info-team red">{teamName(match.teamRedId)}</span>
              <span className="match-info-vs">vs</span>
              <span className="match-info-team blue">{teamName(match.teamBlueId)}</span>
            </>
          ) : (
            match.teamIds.map((teamId) => (
              <span className="match-info-team" key={teamId}>
                {teamName(teamId)}
              </span>
            ))
          )}
        </div>

        <dl className="match-info-grid">
          <div>
            <dt>{t('Match type')}</dt>
            <dd>{match.type === 'match' ? t('{count} team(s)', { count: 2 }) : t('Lobby')}</dd>
          </div>
          <div>
            <dt>{t('Stage')}</dt>
            <dd>{stage.name}</dd>
          </div>
          <div>
            <dt>{t('Time (UTC)')}</dt>
            <dd>{formatUtc(match.scheduledAt)}</dd>
          </div>
          <div>
            <dt>{t('Best of')}</dt>
            <dd>BO{stage.bestOf}</dd>
          </div>
          <div>
            <dt>{t('Room mode')}</dt>
            <dd>{teamModeLabel(match.roomMode)}</dd>
          </div>
          <div>
            <dt>{t('Win condition')}</dt>
            <dd>{winConditionLabel(match.winCondition)}</dd>
          </div>
          {group ? (
            <div>
              <dt>{t('Group')}</dt>
              <dd>{group.name}</dd>
            </div>
          ) : null}
        </dl>
      </div>
    </Section>
  );
}

function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
