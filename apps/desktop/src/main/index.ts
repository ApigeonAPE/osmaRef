import { app, BrowserWindow, dialog, protocol, session, shell } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { IPC } from '@osmaref/contracts';
import { createAppStore } from './store';
import { SettingsStore } from './settings';
import { WindowStateStore } from './window-state';
import { WinByStore } from './winby-store';
import { TokenVault } from './token-vault';
import { ServerClient } from './server-client';
import { ConnectionManager } from './connections';
import { TournamentImporter } from './importer';
import { MayumiClient } from './mayumi-client';
import { MayumiSession } from './mayumi-session';
import { AppLogger } from './logger';
import { registerIpc } from './ipc';
import { CoverCache, COVER_SCHEME } from './covers';
import { UpdateManager, updatesSupported } from './update';

let mainWindow: BrowserWindow | null = null;
let windowState: WindowStateStore | null = null;

// Keep all writable state under a stable, plain directory. Chromium caches do not
// belong in a roaming profile, and the scoped package name is a poor Windows path.
app.setName('osmaRef');
app.setPath('userData', join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'osmaRef'));

// The renderer loads saved covers through this scheme, so it has to be declared
// before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: COVER_SCHEME, privileges: { standard: true, secure: true } },
]);

const gotLock = app.requestSingleInstanceLock();
if (gotLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
} else {
  // The OS can refuse the singleton lock (for example, restricted profile
  // directories). Running is better than silently exiting; the connection layer
  // still prevents two rooms from sharing one account unintentionally.
  console.warn('[osmaRef] single-instance lock unavailable; continuing without it');
}

void bootstrap();

async function bootstrap(): Promise<void> {
  await app.whenReady();

  if (!gotLock) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: 'osmaRef',
      message: 'Another osmaRef instance may already be running.',
      detail:
        'The single-instance lock could not be created. Running two clients with the same osu! account can send conflicting room commands.',
      buttons: ['Continue anyway', 'Quit'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 1) {
      app.quit();
      return;
    }
  }

  const userData = app.getPath('userData');
  const store = await createAppStore(join(userData, 'data'));
  const settings = new SettingsStore(join(userData, 'config'));
  const windowStateStore = new WindowStateStore(join(userData, 'config'));
  windowState = windowStateStore;
  const winby = new WinByStore(join(userData, 'config'));
  const vault = new TokenVault(join(userData, 'credentials'));
  const mayumiSession = new MayumiSession(join(userData, 'credentials'));
  await settings.init();
  await vault.init();
  await mayumiSession.init();
  const logger = new AppLogger(store);

  const server = new ServerClient({
    getSettings: () => settings.get(),
    getTokens: () => vault.get(),
    setTokens: (tokens) => vault.set(tokens),
    onDiagnostic: (level, scope, message) => logger.diagnostic(level, scope, message),
  });

  const connections = new ConnectionManager({
    store,
    settings,
    winby,
    server,
    logger,
    // Replaced by registerIpc once the window exists.
    emit: () => undefined,
  });
  const mayumi = new MayumiClient({
    baseUrl: () => settings.get().mayumiBaseUrl,
    session: () => mayumiSession.get(),
  });
  const importer = new TournamentImporter(store, logger, mayumi);
  const covers = new CoverCache(join(userData, 'covers'));
  covers.register();

  const updates = new UpdateManager(logger, settings, (event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.event, event);
    }
  });

  registerIpc({
    store,
    settings,
    server,
    connections,
    importer,
    mayumi,
    mayumiSession,
    covers,
    updates,
    winby,
    logger,
    getWindow: () => mainWindow,
  });

  createWindow();

  if (updatesSupported) {
    setTimeout(() => {
      void updates.check().catch((error: unknown) => {
        logger.runtime(
          'warn',
          'update',
          `startup check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 5_000);
  }
  logger.runtime(
    'info',
    'app',
    `osmaRef ${app.getVersion()} started (${process.platform} ${process.arch})`,
  );

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    logger.runtime('info', 'app', 'osmaRef shutting down');
    void connections.shutdown();
    store.close();
  });
}

function createWindow(): void {
  const restored = windowState;
  const window = new BrowserWindow({
    ...(restored ? restored.options() : { width: 1440, height: 900 }),
    minWidth: 1280,
    minHeight: 720,
    show: false,
    backgroundColor: '#141013',
    title: 'osmaRef',
    // Packaged builds inherit the icon embedded in osmaRef.exe by electron-builder;
    // only an unpackaged run needs the file on disk.
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.ico') }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow = window;

  window.once('ready-to-show', () => {
    if (restored?.isMaximized()) window.maximize();
    window.show();
  });
  restored?.track(window);
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env['ELECTRON_RENDERER_URL'];
    if (!allowed || !url.startsWith(allowed)) {
      event.preventDefault();
    }
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void window.loadURL(devUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // DevTools are only useful against the vite dev server (`npm run dev`) for
  // checking the UI; a packaged or smoke-test launch must not open them.
  if (devUrl && !process.argv.includes('--smoke-test')) {
    window.webContents.openDevTools();
  }

  // `--smoke-test` renders the app once and exits, so CI can verify the preload
  // bridge and the renderer without a human looking at the window.
  if (process.argv.includes('--smoke-test')) {
    const timeout = setTimeout(() => {
      console.error('SMOKE_FAIL timeout');
      app.exit(3);
    }, 20_000);
    window.webContents.once('did-finish-load', () => {
      void (async () => {
        try {
          // The UI now performs an async settings read before it can render the
          // shell, so poll briefly instead of sampling once on load.
          const deadline = Date.now() + 8_000;
          let result = { app: false, api: false, nav: 0, first: '' };
          while (Date.now() < deadline) {
            result = (await window.webContents.executeJavaScript(
              "({ app: Boolean(document.querySelector('.app')), api: Boolean(window.osmaRef), nav: document.querySelectorAll('.nav-item').length, first: document.querySelector('.nav-item span')?.textContent ?? '' })",
            )) as { app: boolean; api: boolean; nav: number; first: string };
            if (result.app && result.api && result.nav >= 4) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          // Settings load asynchronously and can switch the language after the
          // first paint; re-read once it has settled.
          await new Promise((resolve) => setTimeout(resolve, 800));
          result = (await window.webContents.executeJavaScript(
            "({ app: Boolean(document.querySelector('.app')), api: Boolean(window.osmaRef), nav: document.querySelectorAll('.nav-item').length, first: document.querySelector('.nav-item span')?.textContent ?? '' })",
          )) as { app: boolean; api: boolean; nav: number; first: string };
          // Regression guard: the room mode must be user-switchable even when
          // there is no tournament configured.
          const switchable = (await window.webContents.executeJavaScript(
            `(async () => {
               const button = document.querySelector('[data-testid="mode-configured"]');
               if (!button) return false;
               button.click();
               for (let index = 0; index < 20; index += 1) {
                 if (document.querySelector('[data-testid="configured-form"]')) return true;
                 await new Promise((resolve) => setTimeout(resolve, 100));
               }
               return false;
             })()`,
          )) as boolean;

          // Regression guard for the tournament editor: rounds own pools/flows.
          const tournamentsReady = (await window.webContents.executeJavaScript(
            `(async () => {
               const items = [...document.querySelectorAll('.nav-item')];
               items[2]?.click();
               let ready = false;
               for (let index = 0; index < 20; index += 1) {
                 await new Promise((resolve) => setTimeout(resolve, 100));
                 const text = document.body.textContent || '';
                 if (text.includes('轮次') || text.includes('赛事') || text.includes('Rounds') || text.includes('Tournaments')) {
                   ready = true;
                   break;
                 }
               }
               items[0]?.click();
               return ready;
             })()`,
          )) as boolean;

          if (result.app && result.api && result.nav >= 4 && switchable && tournamentsReady) {
            const screenshot = process.env['OSMAREF_SCREENSHOT'];
            if (screenshot) {
              const image = await window.webContents.capturePage();
              writeFileSync(screenshot, image.toPNG());
              console.log(`SMOKE_SCREENSHOT ${screenshot}`);
            }
            console.log(`SMOKE_OK nav=${result.nav} first=${result.first} switch=${switchable ? 1 : 0} tournaments=${tournamentsReady ? 1 : 0}`);
            clearTimeout(timeout);
            app.exit(0);
          } else {
            console.error(
              `SMOKE_FAIL ${JSON.stringify({ ...result, switchable, tournamentsReady })}`,
            );
            clearTimeout(timeout);
            app.exit(2);
          }
        } catch (error) {
          console.error('SMOKE_FAIL', error);
          clearTimeout(timeout);
          app.exit(2);
        }
      })();
    });
  }
}