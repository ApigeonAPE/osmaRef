import { describe, expect, it } from 'vitest';
import { MappoolSlotSchema, type MappoolSlot } from '@osmaref/contracts';
import { splitChatSlots } from '../apps/desktop/src/renderer/src/chat-slots';

function slot(label: string): MappoolSlot {
  return MappoolSlotSchema.parse({ id: `slot-${label}`, label, category: 'NM', beatmapId: 1 });
}

const pool = [slot('NM1'), slot('HD2'), slot('DT3'), slot('TB'), slot('4K1')];

function shape(text: string, slots: MappoolSlot[] = pool) {
  return splitChatSlots(text, slots).map((part) =>
    part.type === 'slot' ? `[${part.slot.label}]` : part.text,
  );
}

describe('splitChatSlots', () => {
  it('matches a label exactly, case insensitive', () => {
    expect(shape('pick NM1 now')).toEqual(['pick ', '[NM1]', ' now']);
    expect(shape('pick nm1 now')).toEqual(['pick ', '[NM1]', ' now']);
  });

  it('accepts one space between letters and digits', () => {
    expect(shape('at  nm 1')).toEqual(['at  ', '[NM1]']);
    expect(shape('at 4 k 1')).toEqual(['at ', '[4K1]']);
  });

  it('requires non-alphanumeric neighbours', () => {
    expect(shape('XNM1Y')).toEqual(['XNM1Y']);
    expect(shape('NM10')).toEqual(['NM10']);
    expect(shape('slot-NM1.')).toEqual(['slot-', '[NM1]', '.']);
    expect(shape('[NM1]')).toEqual(['[', '[NM1]', ']']);
  });

  it('prefers the longest label when prefixes collide', () => {
    const withTen = [slot('NM1'), slot('NM10')];
    expect(shape('NM10 then NM1', withTen)).toEqual(['[NM10]', ' then ', '[NM1]']);
  });

  it('matches letter-only and digit-prefixed labels', () => {
    expect(shape('TB is the tiebreaker')).toEqual(['[TB]', ' is the tiebreaker']);
    expect(shape('4K1 4K1')).toEqual(['[4K1]', ' ', '[4K1]']);
  });

  it('keeps surrounding text in order', () => {
    expect(shape('NM1 vs HD2, then DT3')).toEqual([
      '[NM1]',
      ' vs ',
      '[HD2]',
      ', then ',
      '[DT3]',
    ]);
  });

  it('returns the original text when nothing matches', () => {
    expect(splitChatSlots('no labels here', pool)).toEqual([
      { type: 'text', text: 'no labels here' },
    ]);
  });

  it('passes text through for an empty pool', () => {
    expect(splitChatSlots('NM1', [])).toEqual([{ type: 'text', text: 'NM1' }]);
  });

  it('skips blank labels', () => {
    const blank = [{ ...slot('NM1'), id: 'blank', label: ' ' }];
    expect(splitChatSlots('NM1', blank)).toEqual([{ type: 'text', text: 'NM1' }]);
  });

  it('carries the slot on the part', () => {
    const parts = splitChatSlots('NM1', pool);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: 'slot', text: 'NM1', slot: { label: 'NM1' } });
  });
});
