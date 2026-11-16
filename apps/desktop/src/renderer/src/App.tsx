import { useEffect, useState } from 'react';
import { ModelProvider, useModel } from './useOsmaRef';
import { I18nProvider, useI18n } from './i18n';
import { TournamentsPage } from './pages/TournamentsPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { CreateRoomPage } from './pages/CreateRoomPage';
import { LogsPage } from './pages/LogsPage';
import { LoginPage } from './pages/LoginPage';
import { SettingsPage } from './pages/SettingsPage';
import type { ConnectionKind } from '@osmaref/contracts';

type Page = 'create' | 'workbench' | 'tournaments' | 'logs' | 'login' | 'settings';

const NAV: { id: Page; label: string }[] = [
  { id: 'create', label: 'Create room' },
  { id: 'workbench', label: 'Workbench' },
  { id: 'tournaments', label: 'Tournaments' },
  { id: 'logs', label: 'Lobby logs' },
  { id: 'settings', label: 'Settings' },
];

export function App() {
  return (
    <I18nProvider>
      <ModelProvider>
        <Shell />
      </ModelProvider>
    </I18nProvider>
  );
}

function Shell() {
  const { t } = useI18n();
  const [page, setPage] = useState<Page>('create');
  const [sessionId, setSessionId] = useState<string | null>(null);

  return (
    <div className={`app${page === 'workbench' ? ' workbench-mode' : ''}`}>
      {page !== 'workbench' ? (
        <aside className="sidebar">
          <div className="brand">osmaRef</div>

          <nav className="nav">
            {NAV.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item${page === item.id ? ' active' : ''}`}
                onClick={() => setPage(item.id)}
              >
                {t(item.label)}
              </button>
            ))}
          </nav>

          <div className="sidebar-status">
            <StatusRow kind="irc" label="IRC (stable)" />
            <StatusRow kind="referee_hub" label="Referee Hub (lazer)" />
            <StatusRow kind="chat" label="Chat (osu!web)" />
          </div>

          <SidebarUser onOpen={() => setPage('login')} />
        </aside>
      ) : null}

      <main className="main">
        {page === 'create' ? (
          <CreateRoomPage
            onCreated={(created) => {
              setSessionId(created);
              setPage('workbench');
            }}
          />
        ) : null}
        {page === 'workbench' ? (
          <WorkbenchPage
            sessionId={sessionId}
            onSessionChange={setSessionId}
            onBack={() => setPage('create')}
          />
        ) : null}
        {page === 'tournaments' ? <TournamentsPage /> : null}
        {page === 'logs' ? <LogsPage /> : null}
        {page === 'login' ? <LoginPage /> : null}
        {page === 'settings' ? <SettingsPage /> : null}
      </main>
    </div>
  );
}

function SidebarUser({ onOpen }: { onOpen: () => void }) {
  const model = useModel();
  const { t } = useI18n();
  const user = model.state?.user ?? null;
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    setAvatarFailed(false);
  }, [user?.userId]);

  return (
    <button
      type="button"
      className="sidebar-user"
      onClick={onOpen}
      title={user?.username ?? t('Login')}
    >
      {user ? (
        <>
          {avatarFailed ? (
            <span className="sidebar-avatar sidebar-avatar-fallback" aria-hidden="true" />
          ) : (
            <img
              className="sidebar-avatar"
              src={`https://a.ppy.sh/${user.userId}`}
              alt=""
              onError={() => setAvatarFailed(true)}
            />
          )}
          <strong>{user.username}</strong>
        </>
      ) : (
        <span className="sidebar-login">{t('Login')}</span>
      )}
    </button>
  );
}

function StatusRow({ kind, label }: { kind: ConnectionKind; label: string }) {
  const model = useModel();
  const { t } = useI18n();
  const status = model.state?.connections.find((entry) => entry.kind === kind);
  const state = status?.status ?? 'disconnected';
  return (
    <div className="status-row" title={status?.detail ?? undefined}>
      <span className={`dot ${state}`} />
      <span>{t(label)}</span>
      <span className="muted small status-text">{t(state)}</span>
    </div>
  );
}