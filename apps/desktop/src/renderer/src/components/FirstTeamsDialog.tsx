import { useMemo, useState } from 'react';
import type { MatchSession } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';

export function FirstTeamsDialog({
  session,
  onClose,
  onSave,
}: {
  session: MatchSession;
  onClose: () => void;
  onSave: (assignments: { stepId: string; teamId: string }[]) => Promise<void>;
}) {
  const { t } = useI18n();
  const steps = useMemo(() => {
    const rows: { stepId: string; kind: string; firstTeamId: string }[] = [];
    for (const action of session.queue) {
      if (rows.some((row) => row.stepId === action.stepId)) continue;
      rows.push({
        stepId: action.stepId,
        kind: action.kind,
        firstTeamId:
          action.side === 'team_two' ? session.teamTwoId : session.teamOneId,
      });
    }
    return rows;
  }, [session.queue, session.teamOneId, session.teamTwoId]);

  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(steps.map((step) => [step.stepId, step.firstTeamId])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(
        steps.map((step) => ({
          stepId: step.stepId,
          teamId: selection[step.stepId] ?? session.teamOneId,
        })),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('First teams')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? t('saving…') : t('Save')}
          </button>
        </>
      }
    >
      {error ? <div className="banner error">{error}</div> : null}
      <div className="first-team-list">
        <div className="first-team-head">
          <span>#</span>
          <span>{t('step')}</span>
          <span>{t('first team')}</span>
        </div>
        {steps.map((step, index) => (
          <div className="first-team-row" key={step.stepId}>
            <span className="muted">{index + 1}</span>
            <span>{t(step.kind)}</span>
            <select
              value={selection[step.stepId] ?? session.teamOneId}
              onChange={(event) =>
                setSelection((previous) => ({
                  ...previous,
                  [step.stepId]: event.target.value,
                }))
              }
            >
              <option value={session.teamOneId}>{t('red team')}</option>
              <option value={session.teamTwoId}>{t('blue team')}</option>
            </select>
          </div>
        ))}
        {steps.length === 0 ? <p className="muted small">{t('No flow steps.')}</p> : null}
      </div>
    </Modal>
  );
}