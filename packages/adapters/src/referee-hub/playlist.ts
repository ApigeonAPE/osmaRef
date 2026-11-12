const BEATMAP_MODE_RULESET: Record<string, number> = {
  osu: 0,
  taiko: 1,
  fruits: 2,
  mania: 3,
};

/**
 * Ruleset a Referee Hub playlist item should be submitted with.
 *
 * The Hub rejects a playlist entry whose ruleset disagrees with a non-osu!
 * beatmap's native mode, so those maps override the picker. osu! beatmaps keep
 * the selected ruleset, which allows converts.
 */
export function resolvePlaylistRuleset(beatmapMode: string, selectedRulesetId: number): number {
  const native = BEATMAP_MODE_RULESET[beatmapMode.toLowerCase()];
  return native !== undefined && native !== 0 ? native : selectedRulesetId;
}
