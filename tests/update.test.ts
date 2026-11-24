import { describe, expect, it } from 'vitest';
import { UpdateChannelSchema, DEFAULT_SETTINGS } from '@osmaref/contracts';
import { isNewerVersion } from '@osmaref/domain';

describe('isNewerVersion', () => {
  it('compares dotted versions by numeric segment', () => {
    expect(isNewerVersion('0.1.7', '0.1.6')).toBe(true);
    expect(isNewerVersion('0.1.6', '0.1.7')).toBe(false);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.6', '0.1.6')).toBe(false);
  });

  it('ignores the v prefix and pre-release or build suffixes', () => {
    expect(isNewerVersion('v0.1.7', '0.1.6')).toBe(true);
    expect(isNewerVersion('0.1.8-preview', '0.1.7')).toBe(true);
    expect(isNewerVersion('0.1.7+build.3', '0.1.7')).toBe(false);
    expect(isNewerVersion('v1.2.3-preview.4', '1.2.2')).toBe(true);
  });

  it('pads missing segments with zero', () => {
    expect(isNewerVersion('1.2', '1.1.9')).toBe(true);
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false);
  });

  it('treats unparsable segments as zero', () => {
    expect(isNewerVersion('1.x.0', '1.0.0')).toBe(false);
  });
});

describe('update channel', () => {
  it('accepts release and preview only', () => {
    expect(UpdateChannelSchema.safeParse('release').success).toBe(true);
    expect(UpdateChannelSchema.safeParse('preview').success).toBe(true);
    expect(UpdateChannelSchema.safeParse('beta').success).toBe(false);
    expect(UpdateChannelSchema.safeParse('').success).toBe(false);
  });

  it('defaults to the release channel', () => {
    expect(DEFAULT_SETTINGS.updateChannel).toBe('release');
  });
});
