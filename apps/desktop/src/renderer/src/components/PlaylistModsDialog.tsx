import { useState } from 'react';
import type { PlaylistEntry } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';
import { ModSelector } from './ModSelector';

export function PlaylistModsDialog({
  entry,
  onClose,
  onSave,
}: {
  entry: PlaylistEntry;
  onClose: () => void;
  onSave: (input: {
    requiredMods: string[];
    allowedMods: string[];
    freestyle: boolean;
  }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [mods, setMods] = useState({
    required: entry.requiredMods,
    allowed: entry.allowedMods,
    freemod: false,
    freestyle: entry.freestyle,
  });
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
        freemod={mods.freemod}
        freestyle={mods.freestyle}
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