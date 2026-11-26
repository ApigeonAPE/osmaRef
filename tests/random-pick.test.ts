import { describe, expect, it } from 'vitest';
import {
  formatRandomPickMessage,
  parseRollReply,
  shuffleSlots,
} from '@osmaref/domain';
import type { BeatmapInfo, MappoolSlot } from '@osmaref/contracts';

function slot(label: string, beatmapId: number): MappoolSlot {
  return {
    id: `slot-${label}`,
    label,
    category: 'NM',
    beatmapId,
    beatmap: null,
    rulesetId: 0,
    requiredMods: [],
    allowedMods: [],
    freestyle: false,
    freemod: false,
  };
}

describe('roll reply parsing', () => {
  it('parses the BanchoBot reply on stable', () => {
    expect(parseRollReply('Alice rolls 42 point(s)', 'stable')).toEqual({
      username: 'Alice',
      score: 42,
    });
    expect(parseRollReply('  Bob rolls 1 point(s)  ', 'stable')).toEqual({
      username: 'Bob',
      score: 1,
    });
  });

  it('parses the system reply on lazer', () => {
    expect(parseRollReply('Alice rolled 7 point(s) out of 20.', 'lazer')).toEqual({
      username: 'Alice',
      score: 7,
    });
    expect(parseRollReply('Bob rolled 20 point(s) out of 20.', 'lazer')).toEqual({
      username: 'Bob',
      score: 20,
    });
  });

  it('rejects replies from the wrong platform or unrelated chat', () => {
    expect(parseRollReply('Alice rolls 42 point(s)', 'lazer')).toBeNull();
    expect(parseRollReply('Alice rolled 7 point(s) out of 20.', 'stable')).toBeNull();
    expect(parseRollReply('Alice: hello', 'stable')).toBeNull();
    expect(parseRollReply('Alice rolls many point(s)', 'stable')).toBeNull();
  });
});

describe('random pick ordering', () => {
  const slots = [slot('NM1', 1), slot('NM2', 2), slot('HD1', 3), slot('HR1', 4)];

  it('keeps every slot exactly once', () => {
    const shuffled = shuffleSlots(slots, () => 0.5);
    expect(shuffled).toHaveLength(slots.length);
    expect(new Set(shuffled.map((entry) => entry.id))).toEqual(
      new Set(slots.map((entry) => entry.id)),
    );
  });

  it('is deterministic for an injected random source', () => {
    const sequence = [0.1, 0.9, 0.4, 0.7];
    const source = () => {
      let cursor = 0;
      return () => sequence[cursor++ % sequence.length] ?? 0;
    };
    expect(shuffleSlots(slots, source()).map((entry) => entry.label)).toEqual(
      shuffleSlots(slots, source()).map((entry) => entry.label),
    );
  });

  it('does not modify the input array', () => {
    const before = slots.map((entry) => entry.label);
    shuffleSlots(slots, () => 0.25);
    expect(slots.map((entry) => entry.label)).toEqual(before);
  });

  it('handles empty and single-entry pools', () => {
    expect(shuffleSlots([], () => 0.5)).toEqual([]);
    expect(shuffleSlots([slots[0]!], () => 0.5)).toEqual([slots[0]]);
  });
});

describe('random pick message', () => {
  it('numbers the pool entry and uses the beatmap title when known', () => {
    const info = {
      id: 101,
      title: 'Flower Dance',
      artist: 'DJ Okawari',
      difficultyName: 'Hard',
      mapper: 'Someone',
      mode: 'osu',
    } as BeatmapInfo;
    expect(formatRandomPickMessage(3, slot('HD2', 101), info)).toBe(
      '3. HD2 - Flower Dance - DJ Okawari',
    );
  });

  it('falls back to the beatmap id when lookup failed', () => {
    expect(formatRandomPickMessage(1, slot('NM1', 55))).toBe('1. NM1 - Beatmap #55');
  });
});
