import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SettingsPatchSchema } from '@osmaref/contracts';

describe('discord webhook presentation settings', () => {
  it('defaults every field to an empty string', () => {
    expect(DEFAULT_SETTINGS.discordAuthorImage).toBe('');
    expect(DEFAULT_SETTINGS.discordAuthorName).toBe('');
    expect(DEFAULT_SETTINGS.discordBottomImage).toBe('');
    expect(DEFAULT_SETTINGS.discordFooterIconUrl).toBe('');
    expect(DEFAULT_SETTINGS.discordFooterText).toBe('');
  });

  it('accepts empty and https image urls', () => {
    const parsed = SettingsPatchSchema.parse({
      discordAuthorImage: '',
      discordBottomImage: 'https://example.com/a.png',
    });

    expect(parsed.discordAuthorImage).toBe('');
    expect(parsed.discordBottomImage).toBe('https://example.com/a.png');
  });

  it('rejects image urls without https', () => {
    expect(
      SettingsPatchSchema.safeParse({ discordFooterIconUrl: 'http://example.com/a.png' })
        .success,
    ).toBe(false);
  });
});
