import { useState } from 'react';
import type { Platform, PlaylistEntry } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';
import { ModSelector } from './ModSelector';

export function PlaylistModsDialog({
  entry,
  platform,
  onClose,
  onSave,
}: {
  entry: PlaylistEntry;
  platform: Platform;
  onClose: () => void;
  onSave: (input: {
    requiredMods: string[];
    allowedMods: string[];
    freestyle: boolean;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const stable = platform === 'stable';
  const [mods, setMods] = useState({
    required: stable
      ? [...new Set([...entry.requiredMods, ...entry.allowedMods])]
      : entry.requiredMods,
    allowed: stable ? [] : entry.allowedMods,
    freestyle: stable ? false : entry.freestyle,
  });
  const freestyle = platform === 'stable' ? false : mods.freestyle;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({
        requiredMods: mods.required,
        allowedMods: mods.freestyle ? [] : mods.allowed,
        freestyle: mods.freestyle,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t('Playlist mods')} onClose={onClose}>
      <ModSelector
        required={mods.required}
        allowed={mods.allowed}
        freestyle={freestyle}
        platform={platform}
        onChange={setMods}
      />
      {error ? <div className="banner error">{error}</div> : null}
      <div className="row-actions">
        <button type="button" className="ghost" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? t('saving…') : t('Save')}
        </button>
      </div>
    </Modal>
  );
}