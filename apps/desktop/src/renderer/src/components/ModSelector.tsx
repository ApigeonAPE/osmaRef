import { KNOWN_MODS } from '@osmaref/contracts';
import { useI18n } from '../i18n';

export const SELECTABLE_MODS = KNOWN_MODS.filter(
  (mod) => mod !== 'NM' && mod !== 'FREEMOD' && mod !== 'NONE' && mod !== 'V2',
);

export function ModSelector({
  required,
  allowed,
  freestyle,
  onChange,
  allowedOnly = false,
}: {
  required: string[];
  allowed: string[];
  freestyle: boolean;
  onChange: (next: { required: string[]; allowed: string[]; freestyle: boolean }) => void;
  allowedOnly?: boolean;
}) {
  const { t } = useI18n();

  const toggleRequired = (mod: string) => {
    if (freestyle) return;
    if (required.includes(mod)) {
      onChange({ required: required.filter((item) => item !== mod), allowed, freestyle });
      return;
    }
    onChange({
      required: [...required, mod],
      allowed: allowed.filter((item) => item !== mod),
      freestyle,
    });
  };

  const toggleAllowed = (mod: string) => {
    if (freestyle) return;
    if (allowed.includes(mod)) {
      onChange({ required, allowed: allowed.filter((item) => item !== mod), freestyle });
      return;
    }
    onChange({
      required: required.filter((item) => item !== mod),
      allowed: [...allowed, mod],
      freestyle,
    });
  };

  return (
    <div className={`mod-selector${allowedOnly ? ' allowed-only' : ''}`}>
      {!allowedOnly ? (
        <div className="mod-selector-side">
          <button
            type="button"
            className={`freestyle-toggle${freestyle ? ' active' : ''}`}
            onClick={() =>
              onChange({
                required: [],
                allowed: [],
                freestyle: !freestyle,
              })
            }
          >
            Freestyle
          </button>
          <span className="muted small">
            {freestyle ? t('difficulty settings unlocked') : t('left: forced · right: allowed')}
          </span>
        </div>
      ) : null}
      <div className={`mod-selector-grid${freestyle ? ' disabled' : ''}`}>
        {SELECTABLE_MODS.map((mod) => {
          const forced = !allowedOnly && required.includes(mod);
          const optional = allowed.includes(mod);
          return (
            <button
              key={mod}
              type="button"
              disabled={freestyle}
              aria-pressed={forced || optional}
              className={`mod-selector-button${forced ? ' forced' : ''}${optional ? ' allowed' : ''}`}
              onClick={() => (allowedOnly ? toggleAllowed(mod) : toggleRequired(mod))}
              onContextMenu={(event) => {
                event.preventDefault();
                toggleAllowed(mod);
              }}
            >
              {mod}
            </button>
          );
        })}
      </div>
    </div>
  );
}