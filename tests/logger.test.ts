import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../apps/desktop/src/main/store';
import { AppLogger } from '../apps/desktop/src/main/logger';

describe('AppLogger channels', () => {
  it('persists runtime logs and keeps diagnostics per process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'osmaref-logger-'));
    const store = await createAppStore(dir);
    const logger = new AppLogger(store);
    try {
      logger.runtime('info', 'app', 'started');
      logger.diagnostic('warn', 'server', 'companion server unreachable');
      logger.diagnostic('error', 'irc', 'connection error');

      expect(store.listRuntimeLogs()).toHaveLength(1);
      expect(logger.getDiagnostics()).toHaveLength(2);
    } finally {
      store.close();
    }

    const reopened = await createAppStore(dir);
    const restarted = new AppLogger(reopened);
    try {
      expect(restarted.getRuntimeLogs()).toHaveLength(1);
      expect(restarted.getDiagnostics()).toEqual([]);
      restarted.runtime('info', 'app', 'started again');
      expect(reopened.listRuntimeLogs()).toHaveLength(2);
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
