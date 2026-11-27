import { useMemo, useState } from 'react';
import type { MatchSession, Tournament } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Field, Modal } from '../ui';

export function BindMatchDialog({
  session,
  tournaments,
  onClose,
  onSave,
}: {
  session: MatchSession;
  tournaments: Tournament[];
  onClose: () => void;
  onSave: (input: { tournamentId: string; matchId: string }) => Promise<void>;
}) {
  const { t } = useI18n();

  const alreadyBound = useMemo(
    () =>
      tournaments.some(
        (tournament) =>
          tournament.id === session.tournamentId &&
          tournament.stages.some((stage) =>
            stage.matches.some((match) => match.id === session.matchId),
          ),
      ),
    [tournaments, session.tournamentId, session.matchId],
  );

  const initial = useMemo(() => {
    const current = tournaments.find((tournament) => tournament.id === session.tournamentId);
    const currentStage = current?.stages.find((stage) =>
      stage.matches.some((match) => match.id === session.matchId),
    );
    if (current && currentStage) {
      return { tournamentId: current.id, stageId: currentStage.id, matchId: session.matchId };
    }
    const first = tournaments.find((tournament) =>
      tournament.stages.some((stage) => stage.matches.length > 0),
    );
    const firstStage = first?.stages.find((stage) => stage.matches.length > 0);
    return {
      tournamentId: first?.id ?? '',
      stageId: firstStage?.id ?? '',
      matchId: firstStage?.matches[0]?.id ?? '',
    };
  }, [tournaments, session.tournamentId, session.matchId]);

  const [tournamentId, setTournamentId] = useState(initial.tournamentId);
  const [stageId, setStageId] = useState(initial.stageId);
  const [matchId, setMatchId] = useState(initial.matchId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tournament = tournaments.find((entry) => entry.id === tournamentId);
  const stage = tournament?.stages.find((entry) => entry.id === stageId);
  const selected = stage?.matches.find((entry) => entry.id === matchId);
  const hasMplink = selected ? selected.result.roomId !== null : false;

  const teamName = (teamId: number) =>
    tournament?.teams.find((team) => team.id === teamId)?.name ?? `Team ${teamId}`;

  const matchLabel = (index: number) => {
    const entry = stage?.matches[index];
    if (!entry) return '';
    const head = `${t('Match')} ${index + 1}`;
    if (entry.type === 'match') {
      return `${head} / ${teamName(entry.teamRedId)} vs ${teamName(entry.teamBlueId)}`;
    }
    return `${head} / ${entry.teamIds.length} teams`;
  };

  const save = async () => {
    if (!tournamentId || !matchId || alreadyBound || hasMplink) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ tournamentId, matchId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Competition settings')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={busy || alreadyBound || !selected || hasMplink}
          >
            {busy ? t('saving…') : t('Save')}
          </button>
        </>
      }
    >
      {alreadyBound ? (
        <div className="banner error">{t('This room is already bound to a match.')}</div>
      ) : null}
      {error ? <div className="banner error">{error}</div> : null}
      {hasMplink ? (
        <div className="banner error">{t('That match already has an MP link.')}</div>
      ) : null}
      <div className="form-grid">
        <Field label={t('Tournament')}>
          <select
            value={tournamentId}
            disabled={alreadyBound || busy}
            onChange={(event) => {
              const next = tournaments.find((entry) => entry.id === event.target.value);
              const nextStage = next?.stages.find((entry) => entry.matches.length > 0);
              setTournamentId(event.target.value);
              setStageId(nextStage?.id ?? '');
              setMatchId(nextStage?.matches[0]?.id ?? '');
              setError(null);
            }}
          >
            {tournaments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Stage')}>
          <select
            value={stageId}
            disabled={alreadyBound || busy || !tournament}
            onChange={(event) => {
              const next = tournament?.stages.find((entry) => entry.id === event.target.value);
              setStageId(event.target.value);
              setMatchId(next?.matches[0]?.id ?? '');
              setError(null);
            }}
          >
            {(tournament?.stages ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('Match')}>
          <select
            value={matchId}
            disabled={alreadyBound || busy || !stage}
            onChange={(event) => {
              setMatchId(event.target.value);
              setError(null);
            }}
          >
            {(stage?.matches ?? []).map((entry, index) => (
              <option key={entry.id} value={entry.id}>
                {matchLabel(index)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
