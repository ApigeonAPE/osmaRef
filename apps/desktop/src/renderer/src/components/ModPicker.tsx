import { KNOWN_MODS } from '@osmaref/contracts';
import { useI18n } from '../i18n';

export const SELECTABLE_MODS = KNOWN_MODS.filter(
  (mod) => mod !== 'NM' && mod !== 'FREEMOD' && mod !== 'NONE' && mod !== 'V2',
);

export function ModPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const toggle = (mod: string) => {
    if (disabled) return;
    onChange(value.includes(mod) ? value.filter((item) => item !== mod) : [...value, mod]);
  };

  return (
    <div className={`mod-picker${disabled ? ' disabled' : ''}`}>
      <div className="mod-picker-head">
        <span className="muted small">
          {t('{count} selected', { count: value.length })}
        </span>
        <div className="mod-picker-actions">
          <button
            type="button"
            className="ghost small"
            disabled={disabled || value.length === SELECTABLE_MODS.length}
            onClick={() => onChange([...SELECTABLE_MODS])}
          >
            {t('Select all')}
          </button>
          <button
            type="button"
            className="ghost small"
            disabled={disabled || value.length === 0}
            onClick={() => onChange([])}
          >
            {t('Clear')}
          </button>
        </div>
      </div>
      <div className="mod-grid" role="group" aria-label={t('Mods')}>
        {SELECTABLE_MODS.map((mod) => {
          const selected = value.includes(mod);
          return (
            <button
              key={mod}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              className={`mod-pill${selected ? ' selected' : ''}`}
              onClick={() => toggle(mod)}
            >
              {mod}
            </button>
          );
        })}
      </div>
    </div>
  );
}