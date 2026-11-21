import { useEffect, useState } from 'react';
import type { Settings } from '@osmaref/contracts';
import { useToast } from '../toast';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Section, Field } from '../ui';

/**
 * Account page: the osu! OAuth avatar and the Bancho IRC credential pair.
 *
 * Advanced IRC endpoints, the Referee Hub and everything else stay in Settings.
 */
export function LoginPage() {
  const model = useModel();
  const { t } = useI18n();
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState<
    'authorize' | 'logout' | 'irc' | 'irc-logout' | 'hub' | 'chat' | null
  >(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const user = model.state?.user ?? null;
  const userId = user?.userId ?? null;
  const ircConnected =
    model.state?.connections.find((entry) => entry.kind === 'irc')?.status === 'connected';
  const authorized = Boolean(model.serverStatus?.authenticated);

  useEffect(() => {
    void (async () => {
      const loaded = await window.osmaRef.app.getSettings();
      setSettings(loaded);
      setUsername(loaded.ircUsername);
      setHasPassword(await window.osmaRef.app.hasIrcPassword());
      await model.refreshAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setAvatarFailed(false);
  }, [userId]);

  const authorize = async () => {
    setBusy('authorize');
    try {
      await window.osmaRef.auth.login();
      await model.refreshAll();
      toast.success(t('login done'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy('logout');
    try {
      await window.osmaRef.auth.logout();
      await model.refreshAll();
      toast.success(t('logged out'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    const name = username.trim();
    if (!name || (!password && !hasPassword)) return;
    setBusy('irc');
    try {
      const saved = await window.osmaRef.app.saveSettings({ ircUsername: name });
      setSettings(saved);
      await window.osmaRef.connection.connectIrc({
        username: name,
        password: password || undefined,
      });
      setPassword('');
      setHasPassword(await window.osmaRef.app.hasIrcPassword());
      await model.refreshAll();
      toast.success(t('IRC connected'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const logoutIrc = async () => {
    setBusy('irc-logout');
    try {
      await window.osmaRef.connection.disconnect('irc');
      await window.osmaRef.app.clearIrcPassword();
      setPassword('');
      setHasPassword(false);
      await model.refreshAll();
      toast.success(t('IRC logged out'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const reconnectHub = async () => {
    setBusy('hub');
    try {
      await window.osmaRef.connection.disconnect('referee_hub');
      await window.osmaRef.connection.connectHub();
      await model.refreshAll();
      toast.success(t('Referee Hub reconnected'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const reconnectChat = async () => {
    setBusy('chat');
    try {
      await window.osmaRef.connection.disconnect('chat');
      const state = await window.osmaRef.connection.connectHub();
      await model.refreshAll();
      const chat = state.connections.find((entry) => entry.kind === 'chat');
      if (chat?.status !== 'connected') {
        throw new Error(chat?.detail ?? t('Chat did not reconnect'));
      }
      toast.success(t('Chat reconnected'));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <div className="page">{t('loading settings…')}</div>;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Login')}</h1>
        </div>
      </header>

            
      <Section title={t('OAuth')}>
        <div className="login-row login-oauth">
          <div className="login-identity">
            <div className="login-avatar" title={user?.username ?? undefined}>
              {user && userId !== null && !avatarFailed ? (
                <img
                  key={userId}
                  src={`https://a.ppy.sh/${userId}`}
                  alt={user.username}
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                <span className="login-avatar-fallback" aria-hidden="true" />
              )}
            </div>
            {user ? <span className="login-username">{user.username}</span> : null}
          </div>
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => void (user ? logout() : authorize())}
          >
            {busy === 'authorize'
              ? t('waiting for browser…')
              : busy === 'logout'
                ? '…'
                : user
                  ? t('Log out')
                  : t('Authorize with osu!')}
          </button>
        </div>
      </Section>

      <Section title={t('IRC')}>
        <form
          className="login-row login-irc"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <Field label={t('Username')}>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t('Your osu! username')}
              autoComplete="username"
              disabled={busy !== null}
            />
          </Field>
          <Field label={t('IRC password')}>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={hasPassword ? t('password saved') : undefined}
              autoComplete="current-password"
              disabled={busy !== null}
            />
          </Field>
          <div className="login-irc-actions">
            {ircConnected || hasPassword ? (
              <button
                type="button"
                className="ghost"
                disabled={busy !== null}
                onClick={() => void logoutIrc()}
              >
                {busy === 'irc-logout' ? '…' : t('Log out')}
              </button>
            ) : null}
            <button
              type="submit"
              className="primary"
              disabled={busy !== null || !username.trim() || (!password && !hasPassword)}
            >
              {busy === 'irc' ? t('connecting') : ircConnected ? t('Reconnect') : t('Connect')}
            </button>
          </div>
        </form>
      </Section>

      <Section title={t('API')}>
        <div className="login-row login-api">
          <span className="login-api-status">
            <span className={`dot${authorized ? ' connected' : ''}`} />
            {authorized ? t('authorized') : t('not authorized')}
          </span>
          <div className="login-api-actions">
            <button
              type="button"
              className="ghost small"
              disabled={!authorized || busy !== null}
              onClick={() => void reconnectHub()}
            >
              {busy === 'hub' ? '…' : t('Reconnect Referee Hub')}
            </button>
            <button
              type="button"
              className="ghost small"
              disabled={!authorized || busy !== null}
              onClick={() => void reconnectChat()}
            >
              {busy === 'chat' ? '…' : t('Reconnect Chat')}
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
