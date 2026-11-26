import { useState } from 'react';
import type { BeatmapInfo, BeatmapLookupFailure, MappoolSlot, Platform } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';
import { MappoolSlotRow } from './MappoolSlotRow';

export function RandomRollDialog({
  result,
  slots,
  beatmaps,
  failures,
  onConfirm,
  onClose,
}: {
  result: { username: string; score: string; index: string };
  slots: MappoolSlot[];
  beatmaps: Record<number, BeatmapInfo>;
  failures: Record<number, BeatmapLookupFailure>;
  onConfirm: (slot: MappoolSlot) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState(result.username);
  const [score, setScore] = useState(result.score);
  const [index, setIndex] = useState(result.index);
  const position = Number(index);
  const slot =
    Number.isSafeInteger(position) && position >= 1 && position <= slots.length
      ? slots[position - 1]
      : null;

  return (
    <Modal
      title={t('Roll result')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              if (slot) onConfirm(slot);
            }}
            disabled={!slot}
          >
            {t('Confirm')}
          </button>
        </>
      }
    >
      <div className="random-roll-fields">
        <label className="field">
          <span className="field-label">{t('User')}</span>
          <input value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t('Score')}</span>
          <input value={score} onChange={(event) => setScore(event.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">{t('Index')}</span>
          <input
            value={index}
            inputMode="numeric"
            onChange={(event) => setIndex(event.target.value.replace(/\D/g, ''))}
          />
        </label>
      </div>
      {slot ? (
        <MappoolSlotRow
          slot={slot}
          info={beatmaps[slot.beatmapId]}
          failure={failures[slot.beatmapId]}
        />
      ) : null}
    </Modal>
  );
}
