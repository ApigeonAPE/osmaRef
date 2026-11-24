import { useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type LanguageSetting,
  type Settings,
  type UpdateChannel,
  type WinByRule,
} from '@osmaref/contracts';
import harmonyLicense from '@assets/HarmonyOS_Sans_SC/LICENSE.txt?raw';
import osmaRefLicense from '@assets/LICENSE?raw';
import { ModSelector } from '../components/ModSelector';
import { useToast } from '../toast';
import { useModel } from '../useOsmaRef';
import { useSettings } from '../settings';
import { useI18n } from '../i18n';
import { Field, Modal, Section, formatDateTime } from '../ui';

export function SettingsPage() {
  const model = useModel();
  const { t, setting, setLanguage } = useI18n();
  const toast = useToast();
  const { settings: savedSettings, save: saveSettings } = useSettings();
  const [settings, setSettings] = useState<Settings>(savedSettings);
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [freemodOpen, setFreemodOpen] = useState(false);
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseTab, setLicenseTab] = useState<'harmony' | 'osmaref'>('osmaref');
  const [logsOpen, setLogsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [updateSupported, setUpdateSupported] = useState(false);
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [update, setUpdate] = useState<{
    version: string;
    size: number;
    notes: string | null;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      setVersion(await window.osmaRef.app.getVersion());
      setUpdateSupported(await window.osmaRef.app.isUpdateSupported());
      await model.refreshAll();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () =>
      window.osmaRef.app.onEvent((event) => {
        if (event.type === 'update_available') {
          setUpdate({ version: event.version, size: event.size, notes: event.notes });
          setDownloaded(false);
          setProgress(null);
        } else if (event.type === 'update_progress') {
          setDownloading(true);
          setProgress(event.percent);
        } else if (event.type === 'update_downloaded') {
          setDownloading(false);
          setDownloaded(true);
          setProgress(100);
        } else if (event.type === 'update_error') {
          setDownloading(false);
          toast.error(event.message);
        }
      }),
    [toast],
  );

  const patch = (key: keyof Settings, value: unknown) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
  };

  const save = async () => {
    try {
      const next = await saveSettings(settings);
      setSettings(next);
      toast.success(t('settings saved'));
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  /** Puts the hidden IRC endpoint section back on Bancho's official defaults. */
  const restoreIrcDefaults = async () => {
    try {
      const next = await saveSettings({
        ircHost: DEFAULT_SETTINGS.ircHost,
        ircPort: DEFAULT_SETTINGS.ircPort,
        ircUseTls: DEFAULT_SETTINGS.ircUseTls,
      });
      setSettings(next);
      toast.success(t('IRC settings restored'));
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const changeLanguage = async (value: LanguageSetting) => {
    patch('language', value);
    await setLanguage(value);
  };

  const restoreHubDefaults = async () => {
    try {
      const next = await saveSettings({
        hubBaseUrl: DEFAULT_SETTINGS.hubBaseUrl,
        chatWebsocketUrl: DEFAULT_SETTINGS.chatWebsocketUrl,
      });
      setSettings(next);
      toast.success(t('Referee Hub settings restored'));
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const changeUpdateChannel = async (channel: UpdateChannel) => {
    patch('updateChannel', channel);
    try {
      setSettings(await saveSettings({ updateChannel: channel }));
    } catch (cause) {
      toast.error(errorText(cause));
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const result = await window.osmaRef.app.checkUpdate();
      if (result.status === 'none') {
        toast.info(t('osmaRef is up to date'));
      } else if (result.status === 'available') {
        setUpdate(result);
        setDownloaded(false);
        setProgress(null);
      } else {
        toast.info(t('This build does not support updates'));
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setChecking(false);
    }
  };

  const downloadUpdate = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      await window.osmaRef.app.downloadUpdate();
    } catch (cause) {
      setDownloading(false);
      toast.error(errorText(cause));
    }
  };

  const exportRuntime = async () => {
    setBusy('export-runtime');
    try {
      const path = await window.osmaRef.app.exportRuntimeLog();
      if (path) toast.success(t('exported logs to {path}', { path }));
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

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

      <Section title={t('Discord webhook')}>
        <div className="form-grid">
          <Field label={t('Author image')} wide>
            <input
              value={settings.discordAuthorImage}
              onChange={(event) => patch('discordAuthorImage', event.target.value)}
            />
          </Field>
          <Field label={t('Author name')}>
            <input
              value={settings.discordAuthorName}
              onChange={(event) => patch('discordAuthorName', event.target.value)}
            />
          </Field>
          <Field label={t('Bottom image')} wide>
            <input
              value={settings.discordBottomImage}
              onChange={(event) => patch('discordBottomImage', event.target.value)}
            />
          </Field>
          <Field label={t('Footer icon')} wide>
            <input
              value={settings.discordFooterIconUrl}
              onChange={(event) => patch('discordFooterIconUrl', event.target.value)}
            />
          </Field>
          <Field label={t('Footer text')} wide>
            <input
              value={settings.discordFooterText}
              onChange={(event) => patch('discordFooterText', event.target.value)}
            />
          </Field>
        </div>
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
        {version ? (
          <p className="about-version">
            <a href="https://github.com/ApigeonAPE/osmaRef" target="_blank" rel="noopener noreferrer">
              osmaRef
            </a> {`${version}`}
          </p>
        ) : null}
        <p className="about-version">
          by <a href="https://osu.ppy.sh/users/32541500" target="_blank" rel="noopener noreferrer">
            A-pigeon
          </a>
        </p>
        {update ? (
          <div className="update-status">
            <p className="about-version">
              {`v${update.version}`}
              {update.size ? ` · ${formatBytes(update.size)}` : ''}
            </p>
            {downloading ? (
              <div className="update-progress">
                <span>{`${Math.round(progress ?? 0)}%`}</span>
                <div className="update-progress-track">
                  <div
                    className="update-progress-fill"
                    style={{ width: `${progress ?? 0}%` }}
                  />
                </div>
              </div>
            ) : downloaded ? (
              <button
                type="button"
                className="primary small"
                onClick={() => void window.osmaRef.app.installUpdate()}
              >
                {t('Restart to install')}
              </button>
            ) : (
              <button type="button" className="primary small" onClick={() => void downloadUpdate()}>
                {t('Download')}
              </button>
            )}
          </div>
        ) : null}
        <div className="row-actions">
          {updateSupported ? (
            <select
              className="update-channel"
              value={settings.updateChannel}
              onChange={(event) => void changeUpdateChannel(event.target.value as UpdateChannel)}
            >
              <option value="release">{t('Release')}</option>
              <option value="preview">{t('Preview')}</option>
            </select>
          ) : null}
          {updateSupported ? (
            <button
              type="button"
              className="ghost small"
              disabled={checking}
              onClick={() => void checkUpdate()}
            >
              {checking ? t('Checking…') : t('Check for updates')}
            </button>
          ) : null}
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
              className={`ghost small${licenseTab === 'osmaref' ? ' active' : ''}`}
              onClick={() => setLicenseTab('osmaref')}
            >
              osmaRef
            </button>
            <button
              type="button"
              className={`ghost small${licenseTab === 'harmony' ? ' active' : ''}`}
              onClick={() => setLicenseTab('harmony')}
            >
              HarmonyOS Sans SC
            </button>
          </div>
          <pre className="license-text">
            {licenseTab === 'harmony' ? harmonyLicense : osmaRefLicense}
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
