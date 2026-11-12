import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const desktopRoot = resolve(here, '..');
const require = createRequire(import.meta.url);

const alias = {
  '@osmaref/contracts': resolve(repoRoot, 'packages/contracts/src/index.ts'),
  '@osmaref/domain': resolve(repoRoot, 'packages/domain/src/index.ts'),
  '@osmaref/adapters': resolve(repoRoot, 'packages/adapters/src/index.ts'),
};

/**
 * Bundles the Electron main process and preload script into self-contained CJS.
 *
 * Vite leaves node dependencies external for SSR builds; the packaged app has no
 * `node_modules`, so this step guarantees the runtime only needs Electron and the
 * operating system.
 */
async function main() {
  const common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
    logLevel: 'info',
    alias,
    external: ['electron', 'bufferutil', 'utf-8-validate', 'ws'],
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  };

  await build({
    ...common,
    entryPoints: [resolve(desktopRoot, 'src/main/index.ts')],
    outfile: resolve(desktopRoot, 'out/main/index.js'),
  });

  await build({
    ...common,
    entryPoints: [resolve(desktopRoot, 'src/preload/index.ts')],
    outfile: resolve(desktopRoot, 'out/preload/index.js'),
  });

  // @microsoft/signalr loads `ws` and `eventsource` through computed requires,
  // which esbuild cannot follow. The packaged app has no node_modules, so ship
  // bundled copies at the paths Node resolves from the main bundle.
  for (const name of ['ws', 'eventsource']) {
    const outfile = resolve(desktopRoot, `out/main/node_modules/${name}/index.js`);
    await build({
      ...common,
      external: ['bufferutil', 'utf-8-validate'],
      entryPoints: [require.resolve(name)],
      outfile,
    });
    writeFileSync(
      resolve(dirname(outfile), 'package.json'),
      JSON.stringify({ name, private: true, main: 'index.js' }, null, 2),
      'utf8',
    );
  }
}

main().catch((error) => {
  console.error('[osmaRef] main bundle failed', error);
  process.exit(1);
});