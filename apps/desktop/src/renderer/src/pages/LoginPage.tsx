import { useEffect, useState } from 'react';
import type { Settings } from '@osmaref/contracts';
import { Toast } from '../components/Toast';
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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [busy, setBusy] = useState<'authorize' | 'logout' | 'irc' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const user = model.state?.user ?? null;
  const userId = user?.userId ?? null;
  const ircConnected =
    model.state?.connections.find((entry) => entry.kind === 'irc')?.status === 'connected';

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
    setError(null);
    setMessage(null);
    try {
      await window.osmaRef.auth.login();
      await model.refreshAll();
      setMessage(t('login done'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const logout = async () => {
    setBusy('logout');
    setError(null);
    setMessage(null);
    try {
      await window.osmaRef.auth.logout();
      await model.refreshAll();
      setMessage(t('logged out'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    const name = username.trim();
    if (!name || (!password && !hasPassword)) return;
    setBusy('irc');
    setError(null);
    setMessage(null);
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
      setMessage(t('IRC connected'));
    } catch (cause) {
      setError(errorText(cause));
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

      {message ? (
        <Toast kind="success" message={message} onClose={() => setMessage(null)} />
      ) : null}
      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}

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
              placeholder={hasPassword ? '••••••••' : undefined}
              autoComplete="current-password"
              disabled={busy !== null}
            />
          </Field>
          <button
            type="submit"
            className="primary"
            disabled={busy !== null || !username.trim() || (!password && !hasPassword)}
          >
            {busy === 'irc' ? t('connecting') : ircConnected ? t('Reconnect') : t('Connect')}
          </button>
        </form>
      </Section>
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
