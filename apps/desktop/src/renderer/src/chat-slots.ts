import { normalizeSlotLabel, type MappoolSlot } from '@osmaref/contracts';

export type ChatTextPart =
  | { type: 'text'; text: string }
  | { type: 'slot'; text: string; slot: MappoolSlot };

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** A label may be written with one space between letters and digits ("NM 1"). */
function labelPattern(label: string): string {
  return label
    .replace(REGEXP_SPECIALS, '\\$&')
    .replace(/([A-Za-z0-9])(?=[A-Za-z0-9])/g, '$1\\s?');
}

/**
 * Builds a splitter for the given mappool. Labels are matched longest first so
 * `NM10` is never cut into `NM1` + `0`, and both ends require a non-alphanumeric
 * neighbour so `XNM1Y` stays plain text.
 */
export function buildSlotMatcher(slots: MappoolSlot[]): (text: string) => ChatTextPart[] {
  const byLabel = new Map<string, MappoolSlot>();
  for (const slot of slots) {
    const label = normalizeSlotLabel(slot.label);
    if (label) byLabel.set(label, slot);
  }
  const labels = [...byLabel.keys()].sort((a, b) => b.length - a.length);
  if (labels.length === 0) return (text) => [{ type: 'text', text }];

  const pattern = new RegExp(
    `(?<![A-Za-z0-9])(?:${labels.map(labelPattern).join('|')})(?![A-Za-z0-9])`,
    'gi',
  );

  return (text) => {
    const parts: ChatTextPart[] = [];
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > cursor) parts.push({ type: 'text', text: text.slice(cursor, index) });
      const token = match[0];
      const slot = byLabel.get(normalizeSlotLabel(token.replace(/\s+/g, '')));
      parts.push(slot ? { type: 'slot', text: token, slot } : { type: 'text', text: token });
      cursor = index + token.length;
    }
    if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
    return parts.length === 0 ? [{ type: 'text', text }] : parts;
  };
}

export function splitChatSlots(text: string, slots: MappoolSlot[]): ChatTextPart[] {
  return buildSlotMatcher(slots)(text);
}
