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

export type ModSelection = {
  required: string[];
  allowed: string[];
  freemod: boolean;
  freestyle: boolean;
};

export function ModSelector({
  required,
  allowed,
  freemod,
  freestyle,
  onChange,
  platform = 'lazer',
  showFreeToggle = true,
}: {
  required: string[];
  allowed: string[];
  freemod: boolean;
  freestyle: boolean;
  onChange: (next: ModSelection) => void;
  platform?: Platform;
  /** Hides the Freemod/Freestyle toggle for callers that only edit mods. */
  showFreeToggle?: boolean;
}) {
  const { t } = useI18n();
  const stable = platform === 'stable';
  const mods = [...new Set([...(stable ? STABLE_MODS : SELECTABLE_MODS), ...required, ...allowed])];
  const locked = !stable && freestyle;
  const isForced = (mod: string) => required.includes(mod) || (stable && allowed.includes(mod));

  const toggleRequired = (mod: string) => {
    if (locked) return;
    onChange({
      required: required.includes(mod)
        ? required.filter((item) => item !== mod)
        : [...required, mod],
      allowed: stable ? [] : allowed.filter((item) => item !== mod),
      freemod: stable ? freemod : false,
      freestyle: stable ? false : freestyle,
    });
  };

  const toggleAllowed = (mod: string) => {
    if (locked) return;
    if (stable) {
      toggleRequired(mod);
      return;
    }
    onChange({
      required: required.filter((item) => item !== mod),
      allowed: allowed.includes(mod)
        ? allowed.filter((item) => item !== mod)
        : [...allowed, mod],
      freemod: false,
      freestyle,
    });
  };

  return (
    <div className={`mod-selector${stable ? ' stable' : ''}`}>
      {showFreeToggle ? (
        <div className="mod-selector-side">
          <button
            type="button"
            className={`freestyle-toggle${(stable ? freemod : freestyle) ? ' active' : ''}`}
            onClick={() =>
              stable
                ? onChange({ required, allowed: [], freemod: !freemod, freestyle: false })
                : onChange({ required: [], allowed: [], freemod: false, freestyle: !freestyle })
            }
          >
            {stable ? 'Freemod' : 'Freestyle'}
          </button>
        </div>
      ) : null}
      <div className={`mod-selector-grid${locked ? ' disabled' : ''}`}>
        {mods.map((mod) => {
          const forced = isForced(mod);
          const optional = !stable && allowed.includes(mod);
          return (
            <button
              key={mod}
              type="button"
              disabled={locked}
              aria-pressed={forced || optional}
              className={`mod-selector-button${forced ? ' forced' : ''}${optional ? ' allowed' : ''}`}
              onClick={() => toggleRequired(mod)}
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
