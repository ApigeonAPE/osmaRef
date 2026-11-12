import type { InputHTMLAttributes } from 'react';
import { extractOsuId, type OsuIdKind } from '@osmaref/contracts';

interface IdInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> {
  value: string;
  onChange: (value: string) => void;
  kind: OsuIdKind;
  /** Accept arbitrary usernames; only `#123` and user links are treated as ids. */
  allowUsername?: boolean;
}

/**
 * osu! id/user input. In numeric mode it accepts digits or a pasted osu! link
 * and ignores anything else. In username mode (`allowUsername`) arbitrary names
 * are kept, `#123` means a user id, and user links are normalised to `#123`.
 */
export function IdInput({
  value,
  onChange,
  kind,
  allowUsername = false,
  ...rest
}: IdInputProps) {
  const normalize = (text: string): string | null => {
    if (text === '') return '';
    if (allowUsername) {
      const trimmed = text.trim();
      if (/^#\d+$/.test(trimmed)) return trimmed;
      if (/osu\.ppy\.sh|^https?:\/\//i.test(trimmed)) {
        const id = extractOsuId(trimmed, kind);
        if (id) return `#${id}`;
      }
      return text;
    }
    if (/^\d+$/.test(text)) return text;
    const id = extractOsuId(text, kind);
    return id ? String(id) : null;
  };

  return (
    <input
      {...rest}
      type="text"
      inputMode={allowUsername ? 'text' : 'numeric'}
      value={value}
      onChange={(event) => {
        const next = normalize(event.target.value);
        if (next !== null) onChange(next);
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData('text');
        const next = normalize(text);
        event.preventDefault();
        if (next !== null) onChange(next);
      }}
    />
  );
}
