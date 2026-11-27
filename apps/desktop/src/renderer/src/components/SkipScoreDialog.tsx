import { useState } from 'react';
import { useI18n } from '../i18n';
import { Modal } from '../ui';

export function SkipScoreDialog({
  slotLabel,
  teamOneName,
  teamTwoName,
  onClose,
  onPick,
}: {
  slotLabel: string;
  teamOneName: string;
  teamTwoName: string;
  onClose: () => void;
  onPick: (winner: 'team_one' | 'team_two') => Promise<void>;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (winner: 'team_one' | 'team_two') => {
    setBusy(true);
    setError(null);
    try {
      await onPick(winner);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Skip score for {slot}', { slot: slotLabel })}
      onClose={onClose}
      footer={
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>
          {t('Cancel')}
        </button>
      }
    >
      {error ? <div className="banner error">{error}</div> : null}
      <div className="skip-options">
        <button
          type="button"
          className="flat-team red"
          onClick={() => void pick('team_one')}
          disabled={busy}
        >
          {teamOneName}
        </button>
        <button
          type="button"
          className="flat-team blue"
          onClick={() => void pick('team_two')}
          disabled={busy}
        >
          {teamTwoName}
        </button>
      </div>
    </Modal>
  );
}
