import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = __dirname;
const alias = {
  '@osmaref/contracts': resolve(root, '../../packages/contracts/src/index.ts'),
  '@osmaref/domain': resolve(root, '../../packages/domain/src/index.ts'),
  '@osmaref/adapters': resolve(root, '../../packages/adapters/src/index.ts'),
  '@assets': resolve(root, '../../assets'),
  '@renderer': resolve(root, 'src/renderer/src'),
};

/**
 * Dev/build for the renderer and preload; the production main/preload bundles
 * are produced by scripts/bundle-electron.mjs so they are fully self-contained.
 */
export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        external: ['electron', 'bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: { alias },
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: { input: resolve(root, 'src/renderer/index.html') },
    },
    plugins: [react()],
    server: { port: 5273 },
  },
});