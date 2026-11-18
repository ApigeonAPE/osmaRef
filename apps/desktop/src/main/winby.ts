import vm from 'node:vm';

/**
 * Executes an imported Win-by rule.
 *
 * Rule files are JavaScript with a single `export default function`. The
 * module is rewritten into a closure so helper declarations keep working, then
 * called inside a fresh vm context with a hard timeout. This is a guard against
 * accidental infinite loops, not a security boundary: only import rules from a
 * source you trust.
 */
const cache = new Map<string, vm.Script>();
const CACHE_LIMIT = 32;
const TIMEOUT_MS = 2_000;
const MAX_SOURCE_LENGTH = 200_000;

function transform(source: string): string {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new Error(`Win-by rule is larger than ${MAX_SOURCE_LENGTH} characters`);
  }
  if (/^\s*import\b/m.test(source)) {
    throw new Error('Win-by rules cannot use import statements');
  }
  if (/\brequire\s*\(/.test(source)) {
    throw new Error('Win-by rules cannot use require()');
  }
  if (!/^[ \t]*export[ \t]+default[ \t]+/m.test(source)) {
    throw new Error('Win-by rule needs a default export');
  }
  let body = source.replace(/^[ \t]*export[ \t]+default[ \t]+/m, 'return ');
  body = body.replace(/^[ \t]*export[ \t]+(?=(?:async[ \t]+)?(?:function|class|const|let|var)\b)/gm, '');
  if (/^[ \t]*export\b/m.test(body)) {
    throw new Error('Win-by rule may only use export default');
  }
  return body;
}

function scriptFor(source: string): vm.Script {
  const cached = cache.get(source);
  if (cached) return cached;
  const body = transform(source);
  const script = new vm.Script(
    `(function() {\nconst rule = (function() {\n${body}\n}).call(undefined);\nreturn rule(__winBySlots, __winByMap, __winByTeams);\n}).call(undefined)`,
    { filename: 'win-by-rule.js' },
  );
  cache.set(source, script);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return script;
}

/** Validates syntax and the default-export shape without calling the rule. */
export function compileWinBySource(source: string): void {
  const body = transform(source);
  const script = new vm.Script(`(function() {\n${body}\n})()`, {
    filename: 'win-by-rule.js',
  });
  const factory = script.runInNewContext(Object.create(null), { timeout: TIMEOUT_MS });
  if (typeof factory !== 'function') {
    throw new Error('Win-by rule must export a function');
  }
}

export function runWinBy(
  source: string,
  slots: unknown,
  map: unknown,
  teams: unknown,
): unknown {
  const script = scriptFor(source);
  const sandbox = {
    __winBySlots: structuredClone(slots),
    __winByMap: structuredClone(map),
    __winByTeams: structuredClone(teams),
  };
  const result = script.runInNewContext(sandbox, { timeout: TIMEOUT_MS });
  if (result !== null && typeof (result as { then?: unknown })?.then === 'function') {
    throw new Error('Win-by rules must return synchronously');
  }
  return result;
}
