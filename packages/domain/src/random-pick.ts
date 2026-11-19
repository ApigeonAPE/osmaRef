import type { BeatmapInfo, MappoolSlot, Platform } from '@osmaref/contracts';

export interface RollReply {
  username: string;
  score: number;
}

/** BanchoBot on stable: `user rolls 42 point(s)`. */
const STABLE_ROLL = /^(.+?) rolls (\d+) point\(s\)$/i;
/** osu! system on lazer: `user rolled 42 point(s) out of 20.` */
const LAZER_ROLL = /^(.+?) rolled (\d+) point\(s\) out of \d+\.?$/i;

export function parseRollReply(text: string, platform: Platform): RollReply | null {
  const match = (platform === 'stable' ? STABLE_ROLL : LAZER_ROLL).exec(text.trim());
  if (!match) return null;
  const [, username, rawScore] = match;
  if (username === undefined || rawScore === undefined) return null;
  const score = Number(rawScore);
  if (!Number.isSafeInteger(score)) return null;
  return { username, score };
}

/** Fisher–Yates shuffle; the random source is injectable so tests stay deterministic. */
export function shuffleSlots(
  slots: readonly MappoolSlot[],
  random: () => number = Math.random,
): MappoolSlot[] {
  const shuffled = [...slots];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const other = shuffled[swap];
    if (current === undefined || other === undefined) continue;
    shuffled[index] = other;
    shuffled[swap] = current;
  }
  return shuffled;
}

/** One chat line per random-pool entry, numbered by its position in the shuffle. */
export function formatRandomPickMessage(
  position: number,
  slot: MappoolSlot,
  info?: BeatmapInfo | null,
): string {
  const title = info ? `${info.title} - ${info.artist}` : `Beatmap #${slot.beatmapId}`;
  return `${position}. ${slot.label} - ${title}`;
}
