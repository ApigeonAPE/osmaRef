import { useMemo, useState } from 'react';
import type { MatchSession, Tournament } from '@osmaref/contracts';
import { Modal } from '../ui';
import { useI18n } from '../i18n';

export interface ResultRow {
  userId: number;
  username: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  misses: number;
  passed: boolean;
}

export function ResultDialog({
  session,
  tournament,
  slotLabel,
  onClose,
  onSubmit,
}: {
  session: MatchSession;
  tournament: Tournament;
  slotLabel: string;
  onClose: () => void;
  onSubmit: (rows: ResultRow[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const rows = useMemo<ResultRow[]>(() => {
    const teamOne = tournament.teams.find((team) => String(team.id) === session.teamOneId);
    const teamTwo = tournament.teams.find((team) => String(team.id) === session.teamTwoId);
    return [...(teamOne?.members ?? []), ...(teamTwo?.members ?? [])].map((member) => ({
      userId: member.userId,
      username: member.username,
      score: 0,
      accuracy: 98,
      maxCombo: 0,
      misses: 0,
      passed: true,
    }));
  }, [session.teamOneId, session.teamTwoId, tournament.teams]);

  const [values, setValues] = useState<ResultRow[]>(rows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<ResultRow>) => {
    setValues((previous) =>
      previous.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(
        values.map((row) => ({
          ...row,
          accuracy: Math.min(1, Math.max(0, row.accuracy / 100)),
        })),
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Result for {slot}', { slot: slotLabel })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="primary" disabled={busy || values.length === 0} onClick={() => void submit()}>
            {busy ? t('saving…') : t('Record result')}
          </button>
        </>
      }
    >
      {error ? <div className="banner error">{error}</div> : null}
      {values.length === 0 ? (
        <div className="banner warn">
          {t(
            'This room has no roster, so there are no players to score. Invite players and add them to a team in the tournament editor, or record the result after the roster exists.',
          )}
        </div>
      ) : null}
      <div className="result-table">
        <div className="result-row result-head">
          <span>{t('player')}</span>
          <span>{t('score')}</span>
          <span>{t('acc %')}</span>
          <span>{t('combo')}</span>
          <span>{t('miss')}</span>
          <span>{t('passed')}</span>
        </div>
        {values.map((row, index) => (
          <div className="result-row" key={row.userId}>
            <span title={`#${row.userId}`}>{row.username}</span>
            <input
              type="number"
              value={row.score}
              onChange={(event) => update(index, { score: Number(event.target.value) || 0 })}
            />
            <input
              type="number"
              step="0.01"
              value={row.accuracy}
              onChange={(event) => update(index, { accuracy: Number(event.target.value) || 0 })}
            />
            <input
              type="number"
              value={row.maxCombo}
              onChange={(event) => update(index, { maxCombo: Number(event.target.value) || 0 })}
            />
            <input
              type="number"
              value={row.misses}
              onChange={(event) => update(index, { misses: Number(event.target.value) || 0 })}
            />
            <input
              type="checkbox"
              checked={row.passed}
              onChange={(event) => update(index, { passed: event.target.checked })}
            />
          </div>
        ))}
      </div>
    </Modal>
  );
}