export type OsuIdKind = 'beatmap' | 'user';

/**
 * Extracts a numeric osu! id from a pasted link or plain digits.
 *
 * Beatmap links must identify a difficulty: `/beatmapsets/2224674#fruits/4718189`
 * or `/beatmaps/4718189`. A set link without a `#<mode>/<id>` fragment is not
 * enough to choose a difficulty and is rejected.
 */
export function extractOsuId(value: string, kind: OsuIdKind): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return positive(Number(trimmed));

  let raw = trimmed;
  if (/^(www\.)?osu\.ppy\.sh\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!/^(www\.)?osu\.ppy\.sh$/i.test(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (kind === 'user') {
    const index = parts.findIndex((part) => part === 'users' || part === 'u');
    if (index === -1) return null;
    return positive(Number(parts[index + 1]));
  }

  const hashParts = url.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (hashParts.length > 0) {
    const fromHash = positive(Number(hashParts[hashParts.length - 1]));
    if (fromHash) return fromHash;
  }
  if (parts[0] === 'beatmaps' || parts[0] === 'b') {
    return positive(Number(parts[1]));
  }
  return null;
}

function positive(value: number): number | null {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}