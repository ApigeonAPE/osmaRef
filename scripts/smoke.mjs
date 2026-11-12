import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// In a plain Node process the electron package resolves to the executable path.
const electronBinary = require('electron');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [
  resolve(repoRoot, 'apps/desktop'),
  '--smoke-test',
  '--disable-gpu',
  // Restricted environments (VMs, service accounts) cannot initialise the
  // Chromium sandbox; the smoke check only verifies the renderer and preload.
  '--no-sandbox',
];

const child = spawn(electronBinary, args, { stdio: 'inherit', env });
child.on('exit', (code) => {
  process.exit(code ?? 1);
});
child.on('error', (error) => {
  console.error('[osmaRef] failed to start Electron:', error.message);
  process.exit(1);
});