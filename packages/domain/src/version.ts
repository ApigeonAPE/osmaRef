/** Compares dotted versions, ignoring a leading `v` and pre-release/build suffixes. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parts = (value: string): number[] => {
    const core = value.trim().replace(/^v/i, '').split(/[-+]/)[0] ?? '';
    return core.split('.').map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    });
  };

  const next = parts(latest);
  const now = parts(current);
  const length = Math.max(next.length, now.length);
  for (let index = 0; index < length; index += 1) {
    const left = next[index] ?? 0;
    const right = now[index] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
