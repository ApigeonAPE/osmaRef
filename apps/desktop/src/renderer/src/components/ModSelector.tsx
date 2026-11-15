import { KNOWN_MODS, type Platform } from '@osmaref/contracts';
import { useI18n } from '../i18n';

export const SELECTABLE_MODS = KNOWN_MODS.filter(
  (mod) => mod !== 'NM' && mod !== 'FREEMOD' && mod !== 'NONE' && mod !== 'V2',
);

const STABLE_MODS = [
  'EZ',
  'NF',
  'HT',
  'HR',
  'SD',
  'PF',
  'DT',
  'NC',
  'HD',
  'FI',
  'FL',
  'SO',
  'RX',
  'AP',
  'AT',
  'MR',
];

export function ModSelector({
  required,
  allowed,
  freestyle,
  onChange,
  allowedOnly = false,
  platform = 'lazer',
}: {
  required: string[];
  allowed: string[];
  freestyle: boolean;
  onChange: (next: { required: string[]; allowed: string[]; freestyle: boolean }) => void;
  allowedOnly?: boolean;
  platform?: Platform;
}) {
  const { t } = useI18n();
  const stable = platform === 'stable';
  const forcedOnly = stable && !allowedOnly;
  const freestyleActive = freestyle && !stable;
  const mods = [...new Set([...(stable ? STABLE_MODS : SELECTABLE_MODS), ...required, ...allowed])];

  const toggleRequired = (mod: string) => {
    if (freestyleActive) return;
    if (required.includes(mod)) {
      onChange({
        required: required.filter((item) => item !== mod),
        allowed: forcedOnly ? [] : allowed,
        freestyle: forcedOnly ? false : freestyle,
      });
      return;
    }
    onChange({
      required: [...required, mod],
      allowed: forcedOnly ? [] : allowed.filter((item) => item !== mod),
      freestyle: forcedOnly ? false : freestyle,
    });
  };

  const toggleAllowed = (mod: string) => {
    if (freestyleActive) return;
    if (forcedOnly) {
      toggleRequired(mod);
      return;
    }
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
    <div className={`mod-selector${allowedOnly ? ' allowed-only' : ''}${stable ? ' stable' : ''}`}>
      {!allowedOnly && !stable ? (
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
      <div className={`mod-selector-grid${freestyleActive ? ' disabled' : ''}`}>
        {mods.map((mod) => {
          const forced = required.includes(mod) || (forcedOnly && allowed.includes(mod));
          const optional = allowed.includes(mod) && !forcedOnly;
          return (
            <button
              key={mod}
              type="button"
              disabled={freestyleActive}
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