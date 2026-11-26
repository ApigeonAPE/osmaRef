import { describe, expect, it } from 'vitest';
import { freemodPoolPlaylist, stableModArguments } from '@osmaref/domain';

describe('stable mod arguments', () => {
  it('returns nothing for an empty slot', () => {
    expect(stableModArguments({ requiredMods: [], freemod: false })).toEqual([]);
  });

  it('keeps the forced mods', () => {
    expect(stableModArguments({ requiredMods: ['HD', 'NF'], freemod: false })).toEqual([
      'HD',
      'NF',
    ]);
  });

  it('appends Freemod after the forced mods', () => {
    expect(stableModArguments({ requiredMods: ['DT'], freemod: true })).toEqual([
      'DT',
      'Freemod',
    ]);
  });

  it('does not filter mods that Bancho drops on its own', () => {
    expect(stableModArguments({ requiredMods: ['HD', 'NF', 'DT'], freemod: true })).toEqual([
      'HD',
      'NF',
      'DT',
      'Freemod',
    ]);
  });
});

describe('freemod pool playlist', () => {
  it('splits forced and optional mods', () => {
    expect(freemodPoolPlaylist({ required: ['NF'], allowed: ['HD', 'DT'] })).toEqual({
      requiredMods: ['NF'],
      allowedMods: ['HD', 'DT'],
      freestyle: false,
    });
  });

  it('copies both arrays', () => {
    const pool = { required: ['NF'], allowed: ['HD'] };
    const playlist = freemodPoolPlaylist(pool);
    playlist.requiredMods.push('HD');
    playlist.allowedMods.push('DT');
    expect(pool).toEqual({ required: ['NF'], allowed: ['HD'] });
  });
});
