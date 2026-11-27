import { useState } from 'react';
import type { MatchSession } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';

export function MatchResultDialog({
  session,
  teamOneName,
  teamTwoName,
  onClose,
  onSync,
}: {
  session: MatchSession;
  teamOneName: string;
  teamTwoName: string;
  onClose: () => void;
  onSync: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sync = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSync();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Match finished')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            {t('Close')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void sync()}
            disabled={busy}
          >
            {t('Sync to tournament')}
          </button>
        </>
      }
    >
      {error ? <div className="banner error">{error}</div> : null}
      <div className="match-result-score">
        <span className="match-result-team red">{teamOneName}</span>
        <strong>
          {session.wins.team_one} : {session.wins.team_two}
        </strong>
        <span className="match-result-team blue">{teamTwoName}</span>
      </div>
      <ul className="match-result-maps">
        {session.results.map((result) => (
          <li key={result.id}>
            <span>{result.slotLabel}</span>
            <span>
              {result.winner === 'team_one'
                ? teamOneName
                : result.winner === 'team_two'
                  ? teamTwoName
                  : '—'}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
