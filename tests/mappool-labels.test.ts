import { describe, expect, it } from 'vitest';
import { MappoolSlotSchema, assignSlotLabels, type MappoolSlot } from '@osmaref/contracts';

function slot(category: string, label = ''): MappoolSlot {
  return MappoolSlotSchema.parse({
    id: `slot-${category}-${label}`,
    label: label || 'x',
    category,
    beatmapId: 1,
  });
}

function labels(slots: MappoolSlot[]) {
  return slots.map((entry) => entry.label);
}

describe('assignSlotLabels', () => {
  it('drops the number when a category holds one beatmap', () => {
    const slots = [slot('TB')];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['TB']);
  });

  it('numbers categories with several beatmaps from one', () => {
    const slots = [slot('NM'), slot('TB'), slot('NM')];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['NM1', 'TB', 'NM2']);
  });

  it('renumbers after a beatmap is removed', () => {
    const slots = [slot('NM'), slot('NM')];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['NM1', 'NM2']);
    slots.splice(0, 1);
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['NM']);
  });

  it('uses the trimmed upper-case category', () => {
    const slots = [slot(' hd '), slot('HD')];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['HD1', 'HD2']);
    expect(slots[0]?.category).toBe('hd');
  });

  it('blanks the label while the category is empty', () => {
    const slots = [{ id: 'a', label: 'NM1', category: '', beatmapId: 1 } as MappoolSlot];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['']);
  });

  it('keeps key-count categories intact', () => {
    const slots = [slot('4K'), slot('4K'), slot('7K')];
    assignSlotLabels(slots);
    expect(labels(slots)).toEqual(['4K1', '4K2', '7K']);
  });

  it('leaves ids untouched', () => {
    const slots = [slot('TB')];
    const id = slots[0]!.id;
    assignSlotLabels(slots);
    expect(slots[0]?.id).toBe(id);
  });
});
