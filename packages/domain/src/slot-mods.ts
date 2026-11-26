import type { FreemodPool, MappoolSlot } from '@osmaref/contracts';

/**
 * Argument list for the stable client's `!mp mods` command.
 *
 * Freemod is appended next to the forced mods; Bancho drops the mods that
 * conflict with Freemod on its own, so `HD NF DT Freemod` becomes
 * `DT Freemod` in the room. An empty list means "no mods".
 */
export function stableModArguments(
  mods: Pick<MappoolSlot, 'requiredMods' | 'freemod'>,
): string[] {
  return [...mods.requiredMods, ...(mods.freemod ? ['Freemod'] : [])];
}

/**
 * Referee Hub playlist fields produced by `!mp mods Freemod` in lazer rooms.
 * The pool is split because the hub distinguishes forced mods from the mods
 * players may opt into.
 */
export function freemodPoolPlaylist(pool: FreemodPool): {
  requiredMods: string[];
  allowedMods: string[];
  freestyle: boolean;
} {
  return {
    requiredMods: [...pool.required],
    allowedMods: [...pool.allowed],
    freestyle: false,
  };
}
