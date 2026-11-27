import type { MouseEvent } from 'react';
import type { BeatmapInfo, BeatmapLookupFailure, MappoolSlot } from '@osmaref/contracts';
import { BeatmapRow, type BeatmapRowAction } from './BeatmapRow';

export type MappoolRowAction = BeatmapRowAction;

/**
 * Mappool slot rendered with the shared beatmap row so the workbench pool,
 * the playlist and the random-pick preview keep the same layout.
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
  return (
    <BeatmapRow
      label={slot.label || undefined}
      index={index}
      beatmapId={slot.beatmapId}
      rulesetId={slot.rulesetId}
      requiredMods={slot.requiredMods}
      allowedMods={slot.allowedMods}
      freemod={slot.freemod}
      freestyle={slot.freestyle}
      info={info}
      failure={failure}
      action={action}
      current={current}
      actionable={actionable}
      teamOneId={teamOneId}
      teamTwoId={teamTwoId}
      title={title}
      onActivate={onActivate}
      onContextMenu={onContextMenu}
    />
  );
}
