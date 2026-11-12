/**
 * Guards the automatic Hub result path: the completed playlist item must be the
 * beatmap the session is waiting for. A mismatch is a human-review case, never
 * an automatic score.
 */
export interface CompletedBeatmapCheck {
  playlistItemId: string;
  playlist: { id: string; beatmapId: number }[];
  slotBeatmapId: number;
  currentBeatmapId: number | null;
}

export function checkCompletedBeatmap(input: CompletedBeatmapCheck): string | null {
  const item = input.playlist.find((entry) => entry.id === input.playlistItemId);
  if (!item) {
    return 'the completed playlist item is not in the room snapshot; verify the result manually';
  }
  if (item.beatmapId !== input.slotBeatmapId) {
    return `the active slot is beatmap ${input.slotBeatmapId} but the room completed ${item.beatmapId}; result is not recorded automatically`;
  }
  if (input.currentBeatmapId !== null && item.beatmapId !== input.currentBeatmapId) {
    return 'the completed beatmap differs from the current pick; result is not recorded automatically';
  }
  return null;
}