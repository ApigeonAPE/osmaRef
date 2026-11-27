import type { MouseEvent, ReactNode } from 'react';
import type { BeatmapInfo, BeatmapLookupFailure } from '@osmaref/contracts';
import { useI18n } from '../i18n';

export interface BeatmapRowAction {
  kind: string;
  teamId: string | null;
}

/**
 * One beatmap row. The workbench pool, the playlist below the room and the
 * random-pick preview all render through this so their rows look identical.
 */
export function BeatmapRow({
  label,
  index,
  beatmapId,
  mode,
  rulesetId,
  requiredMods,
  allowedMods,
  freemod,
  freestyle,
  info,
  failure,
  action,
  current = false,
  played = false,
  actionable = false,
  teamOneId,
  teamTwoId,
  title,
  leading,
  trailing,
  onActivate,
  onContextMenu,
}: {
  label?: string;
  index?: number;
  beatmapId: number;
  mode?: string;
  rulesetId?: number | null;
  requiredMods: string[];
  allowedMods: string[];
  freemod?: boolean;
  freestyle?: boolean;
  info?: BeatmapInfo;
  failure?: BeatmapLookupFailure;
  action?: BeatmapRowAction | null;
  current?: boolean;
  played?: boolean;
  actionable?: boolean;
  teamOneId?: string;
  teamTwoId?: string;
  title?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onActivate?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const teamClass =
    action?.teamId && action.teamId === teamOneId
      ? ' team-one'
      : action?.teamId && action.teamId === teamTwoId
        ? ' team-two'
        : '';
  const actionClass = action ? ` action-${action.kind}` : '';
  const hasMods = requiredMods.length > 0 || allowedMods.length > 0 || freemod || freestyle;

  return (
    <div
      className={`pool-row${teamClass}${actionClass}${current ? ' current' : ''}${
        played ? ' played' : ''
      }${actionable ? ' actionable' : ''}`}
      role={actionable ? 'button' : undefined}
      tabIndex={actionable ? 0 : -1}
      onClick={() => {
        if (actionable) onActivate?.();
      }}
      onKeyDown={(event) => {
        if (actionable && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onActivate?.();
        }
      }}
      onContextMenu={onContextMenu}
      title={title ?? `beatmap ${beatmapId}${failure ? `, ${failure.message}` : ''}`}
    >
      {info?.coverUrl ? (
        <span
          className="pool-cover"
          aria-hidden="true"
          style={{ backgroundImage: `url("${info.coverUrl}")` }}
        />
      ) : null}
      <span className="playlist-slot">
        {leading ?? null}
        {index !== undefined ? <span className="slot-index">{index}</span> : null}
        {label ? <span className="slot-tag">{label}</span> : null}
      </span>
      <div className="playlist-main">
        <div className="beatmap-title">
          {info ? `${info.title} - ${info.artist}` : `Beatmap #${beatmapId}`}
          {!info && failure ? (
            <span className={`beatmap-state${failure.notFound ? ' missing' : ' failed'}`}>
              {failure.notFound ? t('not found') : t('lookup failed')}
            </span>
          ) : null}
        </div>
        <div className="beatmap-meta">
          {info ? modeLabel(info.mode, rulesetId ?? 0) : (mode ?? rulesetName(rulesetId ?? 0))}{' '}
          #{beatmapId}
          {info?.difficultyName ? ` [${info.difficultyName}]` : ''} - {info?.mapper || '—'}
        </div>
      </div>
      <div className="playlist-mods">
        {requiredMods.map((mod) => (
          <span className="mod-chip required" key={`req-${mod}`}>
            {mod}
          </span>
        ))}
        {allowedMods.map((mod) => (
          <span className="mod-chip allowed" key={`allow-${mod}`}>
            {mod}
          </span>
        ))}
        {freemod ? <span className="mod-chip allowed">Freemod</span> : null}
        {freestyle ? <span className="mod-chip allowed">Freestyle</span> : null}
        {hasMods ? null : <span className="mod-chip">NM</span>}
        {trailing ?? null}
      </div>
      {action && action.kind !== 'pick' ? (
        <span className="pool-overlay" aria-hidden="true">
          <span className="pool-overlay-icon" />
        </span>
      ) : null}
    </div>
  );
}

export function rulesetName(rulesetId: number): string {
  return (
    {
      0: 'osu!',
      1: 'osu!taiko',
      2: 'osu!catch',
      3: 'osu!mania',
    }[rulesetId] ?? `ruleset ${rulesetId}`
  );
}

export function modeLabel(mode: string, fallbackRulesetId: number): string {
  switch (mode.toLowerCase()) {
    case 'osu':
      return 'osu!';
    case 'taiko':
      return 'osu!taiko';
    case 'fruits':
    case 'catch':
      return 'osu!catch';
    case 'mania':
      return 'osu!mania';
    default:
      return rulesetName(fallbackRulesetId);
  }
}
