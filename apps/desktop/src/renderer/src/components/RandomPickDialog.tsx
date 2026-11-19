import type { BeatmapInfo, BeatmapLookupFailure, MappoolSlot } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';
import { MappoolSlotRow } from './MappoolSlotRow';

export type RandomPickScope = 'remaining' | 'all';

export function RandomPickDialog({
  scope,
  slots,
  prompt,
  beatmaps,
  failures,
  confirming,
  onScopeChange,
  onPromptChange,
  onConfirm,
  onClose,
}: {
  scope: RandomPickScope;
  slots: MappoolSlot[];
  prompt: string;
  beatmaps: Record<number, BeatmapInfo>;
  failures: Record<number, BeatmapLookupFailure>;
  confirming: boolean;
  onScopeChange: (scope: RandomPickScope) => void;
  onPromptChange: (prompt: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  return (
    <Modal title={t('Random pick')} onClose={onClose}>
      <div className="random-pick-head">
        <label className="field random-scope-field">
          <span className="field-label">{t('Pick from')}</span>
          <select
            value={scope}
            onChange={(event) => onScopeChange(event.target.value as RandomPickScope)}
          >
            <option value="remaining">{t('Remaining maps')}</option>
            <option value="all">{t('All maps')}</option>
          </select>
        </label>
        <button
          type="button"
          className={`primary${confirming ? ' confirm-start' : ''}`}
          onClick={onConfirm}
          disabled={slots.length === 0}
        >
          {confirming ? t('Confirm?') : t('Confirm')}
        </button>
      </div>
      <label className="field">
        <span className="field-label">{t('Prompt')}</span>
        <input value={prompt} onChange={(event) => onPromptChange(event.target.value)} />
      </label>
      <div className="pool-list random-pick-list">
        {slots.map((slot, index) => (
          <MappoolSlotRow
            key={slot.id}
            slot={slot}
            info={beatmaps[slot.beatmapId]}
            failure={failures[slot.beatmapId]}
            index={index + 1}
          />
        ))}
      </div>
    </Modal>
  );
}
