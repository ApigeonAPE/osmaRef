import { useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  normalizeIrcEndpoint,
  type LanguageSetting,
  type Settings,
} from '@osmaref/contracts';
import { ModSelector } from '../components/ModSelector';
import { Toast } from '../components/Toast';
import { useModel } from '../useOsmaRef';
import { useI18n } from '../i18n';
import { Field, Modal, Section, formatDateTime } from '../ui';

export function SettingsPage() {
  const model = useModel();
  const { t, setting, setLanguage } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [freemodOpen, setFreemodOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setSettings(await window.osmaRef.app.getSettings());
      await model.refreshAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (key: keyof Settings, value: unknown) => {
    setSettings((previous) => (previous ? { ...previous, [key]: value } : previous));
  };

  /** Keeps Bancho's port/TLS pair consistent while the user edits either one. */
  const patchIrcEndpoint = (change: { ircPort?: number; ircUseTls?: boolean }) => {
    setSettings((previous) => {
      if (!previous) return previous;
      const next = { ...previous, ...change };
      const endpoint = normalizeIrcEndpoint(next.ircHost, next.ircPort, next.ircUseTls);
      return { ...next, ircPort: endpoint.port, ircUseTls: endpoint.useTls };
    });
  };

  const save = async () => {
    if (!settings) return;
    setError(null);
    setMessage(null);
    try {
      const next = await window.osmaRef.app.saveSettings(settings);
      setSettings(next);
      setMessage(t('settings saved'));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  /** Puts the hidden IRC endpoint section back on Bancho's official defaults. */
  const restoreIrcDefaults = async () => {
    setError(null);
    setMessage(null);
    try {
      const next = await window.osmaRef.app.saveSettings({
        ircHost: DEFAULT_SETTINGS.ircHost,
        ircPort: DEFAULT_SETTINGS.ircPort,
        ircUseTls: DEFAULT_SETTINGS.ircUseTls,
      });
      setSettings(next);
      setMessage(t('IRC settings restored'));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(t('Done'));
      await model.refreshAll();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const changeLanguage = async (value: LanguageSetting) => {
    patch('language', value);
    await setLanguage(value);
  };

  const exportRuntime = async () => {
    setBusy('export-runtime');
    setError(null);
    setMessage(null);
    try {
      const path = await window.osmaRef.app.exportRuntimeLog();
      if (path) setMessage(t('exported logs to {path}', { path }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <div className="page">{t('loading settings…')}</div>;

  const status = model.serverStatus;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{t('Settings')}</h1>
        </div>
        <button type="button" className="primary" onClick={() => void save()}>
          {t('Save settings')}
        </button>
      </header>

      {message ? (
        <Toast kind="success" message={message} onClose={() => setMessage(null)} />
      ) : null}
      {error ? <Toast message={error} onClose={() => setError(null)} /> : null}

      <Section title={t('Language')} subtitle={t('Follow the operating system language when set to automatic.')}>
        <div className="form-grid">
          <Field label={t('Language')}>
            <select
              value={settings.language ?? setting}
              onChange={(event) => void changeLanguage(event.target.value as LanguageSetting)}
            >
              <option value="auto">{t('Auto')}</option>
              <option value="en">{t('English')}</option>
              <option value="zh-CN">{t('Simplified Chinese')}</option>
            </select>
          </Field>
        </div>
      </Section>

      <Section title={t('Chat appearance')}>
        <div className="form-grid">
          <Field label={t('Font family')}>
            <input
              value={settings.chatFontFamily}
              onChange={(event) => patch('chatFontFamily', event.target.value)}
            />
          </Field>
          <Field label={t('Font size')}>
            <input
              type="number"
              min={9}
              max={28}
              step={1}
              value={settings.chatFontSize}
              onChange={(event) =>
                patch('chatFontSize', Number(event.target.value) || 13)
              }
            />
          </Field>
          <Field label={t('Line height')}>
            <input
              type="number"
              min={1}
              max={2.4}
              step={0.05}
              value={settings.chatLineHeight}
              onChange={(event) =>
                patch('chatLineHeight', Number(event.target.value) || 1.35)
              }
            />
          </Field>
        </div>
      </Section>

      <Section
        title={t('Freemod mods')}
        subtitle={t('Mods allowed by !mp mods freemod in Referee Hub rooms.')}
      >
        <div className="settings-mod-row">
          <div className="mod-chips">
            {settings.freemodMods.length === 0 ? (
              <span className="mod-chip">NM</span>
            ) : (
              settings.freemodMods.map((mod) => (
                <span className="mod-chip allowed" key={mod}>
                  {mod}
                </span>
              ))
            )}
          </div>
          <button
            type="button"
            className="ghost small"
            onClick={() => setFreemodOpen(true)}
          >
            {t('Settings')}
          </button>
        </div>
      </Section>

        <Section
          title={t('Bancho IRC')}
          subtitle={t('Connection details; the account and password are on the login page.')}
          actions={
            <button type="button" className="ghost small" onClick={() => void restoreIrcDefaults()}>
              {t('Restore defaults')}
            </button>
          }
        >
          <details className="advanced-settings">
            <summary>{t('Advanced IRC settings')}</summary>
            <div className="form-grid">
              <Field label={t('Host')}>
                <input value={settings.ircHost} onChange={(event) => patch('ircHost', event.target.value)} />
              </Field>
              <Field label={t('Port')} hint={t('6667 is plaintext; 6697 uses TLS.')}>
                <input
                  type="number"
                  value={settings.ircPort}
                  onChange={(event) => patchIrcEndpoint({ ircPort: Number(event.target.value) })}
                />
              </Field>
              <Field label={t('Use TLS')} hint={t('Official Bancho uses 6667 without TLS.')}>
                <input
                  type="checkbox"
                  checked={settings.ircUseTls}
                  onChange={(event) => patchIrcEndpoint({ ircUseTls: event.target.checked })}
                />
              </Field>
              <Field label={t('Remember password')}>
                <input
                  type="checkbox"
                  checked={settings.storeIrcPassword}
                  onChange={(event) => patch('storeIrcPassword', event.target.checked)}
                />
              </Field>
              <Field
                label={t('Connect on startup')}
                hint={t('Uses the saved IRC password; requires “Remember password”.')}
              >
                <input
                  type="checkbox"
                  checked={settings.ircAutoConnect}
                  onChange={(event) => patch('ircAutoConnect', event.target.checked)}
                />
              </Field>
              <Field
                label={t('Default channels')}
                hint={t('Comma separated, e.g. #osu, #tournament.')}
              >
                <input
                  value={settings.ircDefaultChannels.join(', ')}
                  onChange={(event) =>
                    patch(
                      'ircDefaultChannels',
                      event.target.value
                        .split(',')
                        .map((channel) => channel.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </Field>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="ghost small"
                onClick={() =>
                  void window.osmaRef.app.openExternal('https://osu.ppy.sh/home/account/edit#legacy-api')
                }
              >
                {t('Open IRC password page')}
              </button>
            </div>
          </details>
        </Section>

      <Section
        title={t('Referee Hub')}
        subtitle={t('osu! spectator server used by lazer multiplayer rooms.')}
      >
        <div className="form-grid">
          <Field label={t('Base URL')} wide>
            <input value={settings.hubBaseUrl} onChange={(event) => patch('hubBaseUrl', event.target.value)} />
          </Field>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="primary"
            disabled={busy !== null || !status?.authenticated}
            onClick={() => void run('Hub connect', () => window.osmaRef.connection.connectHub())}
          >
            {t('Connect Referee Hub')}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy !== null}
            onClick={() => void run('Hub disconnect', () => window.osmaRef.connection.disconnect('referee_hub'))}
          >
            {t('Disconnect')}
          </button>
        </div>
      </Section>

      <Section
        title={t('Runtime logs')}
        subtitle={t('Application activity such as rooms, tournament edits and errors. Kept across restarts.')}
        actions={
          <button
            type="button"
            className="ghost small"
            disabled={busy !== null || model.logs.length === 0}
            onClick={() => void exportRuntime()}
          >
            {t('Export runtime logs')}
          </button>
        }
      >
        <div className="log-list">
          {model.logs.length === 0 ? <p className="muted">{t('No runtime logs yet.')}</p> : null}
          {model.logs
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.id} className={`log-line ${entry.level}`}>
                <span className="muted small">{formatDateTime(entry.at)}</span>
                <span className="log-scope">{entry.scope}</span>
                <div>
                  {entry.message}
                  {entry.details ? (
                    <details className="log-details">
                      <summary>{t('details')}</summary>
                      <pre>{entry.details}</pre>
                    </details>
                  ) : null}
                </div>
              </div>
            ))}
        </div>
      </Section>

      <Section
        title={t('Connection diagnostics')}
        subtitle={t('Only the current run is shown; this list is cleared when osmaRef restarts.')}
      >
        <div className="log-list">
          {model.diagnostics.length === 0 ? (
            <p className="muted">{t('No connection diagnostics yet.')}</p>
          ) : null}
          {model.diagnostics
            .slice()
            .reverse()
            .map((entry) => (
              <div key={entry.id} className={`log-line ${entry.level}`}>
                <span className="muted small">{formatDateTime(entry.at)}</span>
                <span className="log-scope">{entry.scope}</span>
                <span>{entry.message}</span>
              </div>
            ))}
        </div>
      </Section>

      <Section title={t('About')} subtitle={t('Fonts and third-party licenses')}>
        <p className="muted small">
          {t(
            'The interface uses HarmonyOS Sans, © 2021 Huawei Device Co., Ltd., under the HarmonyOS Sans Fonts License Agreement.',
          )}
        </p>
        <p className="muted small">
          {t(
            'The complete font license ships with the app at resources/licenses/HarmonyOS_Sans_LICENSE.txt.',
          )}
        </p>
      </Section>

      {freemodOpen ? (
        <Modal title={t('Freemod mods')} onClose={() => setFreemodOpen(false)}>
          <ModSelector
            required={[]}
            allowed={settings.freemodMods}
            freestyle={false}
            allowedOnly
            onChange={(next) => patch('freemodMods', next.allowed)}
          />
          <div className="row-actions">
            <button
              type="button"
              className="primary"
              onClick={() => setFreemodOpen(false)}
            >
              {t('Done')}
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}