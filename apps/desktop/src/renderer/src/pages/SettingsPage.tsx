import { useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type LanguageSetting,
  type Settings,
  type WinByRule,
} from '@osmaref/contracts';
import harmonyLicense from '@assets/HarmonyOS_Sans/LICENSE.txt?raw';
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
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseTab, setLicenseTab] = useState<'harmony' | 'mit'>('harmony');
  const [logsOpen, setLogsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

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

  const changeLanguage = async (value: LanguageSetting) => {
    patch('language', value);
    await setLanguage(value);
  };

  const restoreHubDefaults = async () => {
    setError(null);
    setMessage(null);
    try {
      const next = await window.osmaRef.app.saveSettings({
        hubBaseUrl: DEFAULT_SETTINGS.hubBaseUrl,
        chatWebsocketUrl: DEFAULT_SETTINGS.chatWebsocketUrl,
      });
      setSettings(next);
      setMessage(t('Referee Hub settings restored'));
    } catch (cause) {
      setError(errorText(cause));
    }
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

      <div className="card">
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
      </div>

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
        actions={<span className="muted small">{t('Only applies on lazer')}</span>}
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
            {t('Edit')}
          </button>
        </div>
      </Section>

      <WinBySection />

        <Section
          title={t('Bancho IRC')}
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
              <Field label={t('Port')}>
                <input
                  type="number"
                  value={settings.ircPort}
                  onChange={(event) => patch('ircPort', Number(event.target.value))}
                />
              </Field>
              <Field label={t('Use TLS')}>
                <input
                  type="checkbox"
                  checked={settings.ircUseTls}
                  onChange={(event) => patch('ircUseTls', event.target.checked)}
                />
              </Field>
              <Field label={t('Connect on startup')}>
                <input
                  type="checkbox"
                  checked={settings.ircAutoConnect}
                  onChange={(event) => patch('ircAutoConnect', event.target.checked)}
                />
              </Field>
              <Field label={t('Default channels')}>
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

      <Section title={t('Referee Hub')}>
        <details className="advanced-settings">
          <summary>{t('Advanced Referee Hub settings')}</summary>
          <div className="form-grid">
            <Field label={t('Base URL')} wide>
              <input
                value={settings.hubBaseUrl}
                onChange={(event) => patch('hubBaseUrl', event.target.value)}
              />
            </Field>
            <Field label={t('Chat WebSocket URL')} wide>
              <input
                value={settings.chatWebsocketUrl}
                onChange={(event) => patch('chatWebsocketUrl', event.target.value)}
              />
            </Field>
          </div>
          <div className="row-actions">
            <button
              type="button"
              className="ghost small"
              onClick={() => void restoreHubDefaults()}
            >
              {t('Restore defaults')}
            </button>
          </div>
        </details>
      </Section>

      <Section
        title={t('Runtime logs')}
        actions={
          <>
            <button
              type="button"
              className="ghost small"
              onClick={() => setLogsOpen((open) => !open)}
            >
              {logsOpen ? t('Hide') : t('Show')}
            </button>
            <button
              type="button"
              className="ghost small"
              disabled={busy !== null || model.logs.length === 0}
              onClick={() => void exportRuntime()}
            >
              {t('Export runtime logs')}
            </button>
          </>
        }
      >
        {logsOpen ? (
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
        ) : null}
      </Section>

      <Section
        title={t('Connection diagnostics')}
        actions={
          <button
            type="button"
            className="ghost small"
            onClick={() => setDiagnosticsOpen((open) => !open)}
          >
            {diagnosticsOpen ? t('Hide') : t('Show')}
          </button>
        }
      >
        {diagnosticsOpen ? (
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
        ) : null}
      </Section>

      <Section title={t('About')}>
        <div className="row-actions">
          <button type="button" className="ghost small" onClick={() => setLicenseOpen(true)}>
            {t('View licenses')}
          </button>
        </div>
      </Section>

      {freemodOpen ? (
        <Modal
          title={t('Freemod mods')}
          onClose={() => setFreemodOpen(false)}
          footer={
            <button type="button" className="primary" onClick={() => setFreemodOpen(false)}>
              {t('Done')}
            </button>
          }
        >
          <ModSelector
            required={[]}
            allowed={settings.freemodMods}
            freestyle={false}
            allowedOnly
            onChange={(next) => patch('freemodMods', next.allowed)}
          />
        </Modal>
      ) : null}

      {licenseOpen ? (
        <Modal title={t('Licenses')} onClose={() => setLicenseOpen(false)}>
          <div className="license-tabs">
            <button
              type="button"
              className={`ghost small${licenseTab === 'harmony' ? ' active' : ''}`}
              onClick={() => setLicenseTab('harmony')}
            >
              HarmonyOS Sans
            </button>
            <button
              type="button"
              className={`ghost small${licenseTab === 'mit' ? ' active' : ''}`}
              onClick={() => setLicenseTab('mit')}
            >
              MIT
            </button>
          </div>
          <pre className="license-text">
            {licenseTab === 'harmony' ? harmonyLicense : MIT_LICENSE}
          </pre>
        </Modal>
      ) : null}
    </div>
  );
}

function WinBySection() {
  const { t } = useI18n();
  const [rules, setRules] = useState<WinByRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    setRules(await window.osmaRef.winby.list());
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => setError(errorText(cause)));
  }, []);

  const importRule = async () => {
    setBusy('import');
    setError(null);
    try {
      const rule = await window.osmaRef.winby.importFile();
      if (rule) await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const exportRule = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await window.osmaRef.winby.exportFile(id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const removeRule = async (rule: WinByRule) => {
    if (
      !window.confirm(
        t('Delete this rule? Matches using it fall back to the built-in rule.'),
      )
    ) {
      return;
    }
    setBusy(rule.id);
    setError(null);
    try {
      setRules(await window.osmaRef.winby.remove(rule.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section
      title={t('Win-by rules')}
      actions={
        <button
          type="button"
          className="ghost small"
          disabled={busy !== null}
          onClick={() => void importRule()}
        >
          {t('Import')}
        </button>
      }
    >
      <div className="win-by-rules">
        {rules.map((rule) => (
          <div className="settings-mod-row" key={rule.id}>
            <span>{rule.name}</span>
            <div className="row-actions">
              <button
                type="button"
                className="ghost small"
                disabled={busy !== null}
                onClick={() => void exportRule(rule.id)}
              >
                {t('Export')}
              </button>
              {rule.builtIn ? null : (
                <button
                  type="button"
                  className="ghost small danger"
                  disabled={busy !== null}
                  onClick={() => void removeRule(rule)}
                >
                  {t('Delete')}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error ? <p className="errorText">{error}</p> : null}
    </Section>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const MIT_LICENSE = `MIT License

Copyright (c) 2026 A-pigeon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
