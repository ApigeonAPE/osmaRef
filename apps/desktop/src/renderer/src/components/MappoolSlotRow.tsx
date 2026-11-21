import type { MouseEvent } from 'react';
import type { BeatmapInfo, BeatmapLookupFailure, MappoolSlot } from '@osmaref/contracts';
import { useI18n } from '../i18n';

export interface MappoolRowAction {
  kind: string;
  teamId: string | null;
}

/**
 * Shared mappool row used by the workbench pool, the random-pick preview and
 * the roll result so all three keep the same layout.
 */
export function MappoolSlotRow({
  slot,
  info,
  failure,
  index,
  action,
  current = false,
  actionable = false,
  teamOneId,
  teamTwoId,
  title,
  onActivate,
  onContextMenu,
}: {
  slot: MappoolSlot;
  info?: BeatmapInfo;
  failure?: BeatmapLookupFailure;
  index?: number;
  action?: MappoolRowAction | null;
  current?: boolean;
  actionable?: boolean;
  teamOneId?: string;
  teamTwoId?: string;
  title?: string;
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

  return (
    <div
      className={`pool-row${teamClass}${actionClass}${current ? ' current' : ''}${
        actionable ? ' actionable' : ''
      }`}
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
      title={
        title ??
        `beatmap ${slot.beatmapId}${failure ? `, ${failure.message}` : ''}`
      }
    >
      {info?.coverUrl ? (
        <span
          className="pool-cover"
          aria-hidden="true"
          style={{ backgroundImage: `url("${info.coverUrl}")` }}
        />
      ) : null}
      <span className="playlist-slot">
        {index !== undefined ? <span className="slot-index">{index}</span> : null}
        <span className="slot-tag">{slot.label}</span>
      </span>
      <div className="playlist-main">
        <div className="beatmap-title">
          {info ? `${info.title} - ${info.artist}` : `Beatmap #${slot.beatmapId}`}
          {!info && failure ? (
            <span className={`beatmap-state${failure.notFound ? ' missing' : ' failed'}`}>
              {failure.notFound ? t('not found') : t('lookup failed')}
            </span>
          ) : null}
        </div>
        <div className="beatmap-meta">
          {info ? modeLabel(info.mode, slot.rulesetId ?? 0) : rulesetName(slot.rulesetId ?? 0)} #
          {slot.beatmapId}
          {info?.difficultyName ? ` [${info.difficultyName}]` : ''} - {info?.mapper || '—'}
        </div>
      </div>
      <div className="playlist-mods">
        {slot.requiredMods.map((mod) => (
          <span className="mod-chip required" key={`req-${mod}`}>
            {mod}
          </span>
        ))}
        {slot.allowedMods.map((mod) => (
          <span className="mod-chip allowed" key={`allow-${mod}`}>
            {mod}
          </span>
        ))}
        {slot.freestyle ? <span className="mod-chip allowed">Freestyle</span> : null}
        {slot.requiredMods.length === 0 && slot.allowedMods.length === 0 && !slot.freestyle ? (
          <span className="mod-chip">NM</span>
        ) : null}
      </div>
      {action && action.kind !== 'pick' ? (
        <span className="pool-overlay" aria-hidden="true">
          <span className="pool-overlay-icon" />
        </span>
      ) : null}
    </div>
  );
}

function rulesetName(rulesetId: number): string {
  return (
    {
      0: 'osu!',
      1: 'osu!taiko',
      2: 'osu!catch',
      3: 'osu!mania',
    }[rulesetId] ?? `ruleset ${rulesetId}`
  );
}

function modeLabel(mode: string, fallbackRulesetId: number): string {
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
