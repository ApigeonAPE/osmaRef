import { useState, type KeyboardEvent } from 'react';
import type { MatchSession } from '@osmaref/contracts';
import { useI18n } from '../i18n';
import { Modal } from '../ui';

export function JoinRoomDialog({
  onClose,
  onJoined,
  initialTransport = 'referee_hub',
}: {
  onClose: () => void;
  onJoined: (session: MatchSession) => void;
  initialTransport?: 'irc' | 'referee_hub';
}) {
  const { t } = useI18n();
  const [transport, setTransport] = useState<'irc' | 'referee_hub'>(initialTransport);
  const [channel, setChannel] = useState('');
  const [roomId, setRoomId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canJoin =
    transport === 'irc' ? channel.trim().length > 0 : /^\d+$/.test(roomId.trim());

  const submit = async () => {
    if (!canJoin || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await window.osmaRef.sessions.join(
        transport === 'irc'
          ? { transport, channel: channel.trim() }
          : { transport, roomId: roomId.trim() },
      );
      onJoined(session);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const joinButton = (
    <button type="button" className="primary" disabled={busy || !canJoin} onClick={() => void submit()}>
      {busy ? t('joining…') : t('Join')}
    </button>
  );

  return (
    <Modal title={t('Join room')} onClose={onClose}>
      <div className="form-grid">
        <div className="wide quick-mode">
          <button
            type="button"
            className={transport === 'irc' ? 'active' : ''}
            onClick={() => setTransport('irc')}
          >
            stable
          </button>
          <button
            type="button"
            className={transport === 'referee_hub' ? 'active' : ''}
            onClick={() => setTransport('referee_hub')}
          >
            lazer
          </button>
        </div>

        {transport === 'irc' ? (
          <div className="field field-wide">
            <span className="field-label">{t('Channel')}</span>
            <div className="join-row">
              <input
                value={channel}
                onChange={(event) => setChannel(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="#mp_xxx / #osu / username"
                autoFocus
              />
              {joinButton}
            </div>
          </div>
        ) : (
          <div className="field field-wide">
            <span className="field-label">{t('Room ID')}</span>
            <div className="join-row">
              <input
                value={roomId}
                onChange={(event) => setRoomId(event.target.value.replace(/[^\d]/g, ''))}
                onKeyDown={onKeyDown}
                inputMode="numeric"
                placeholder="123456"
                autoFocus
              />
              {joinButton}
            </div>
          </div>
        )}
      </div>
      {error ? <div className="banner error">{error}</div> : null}
    </Modal>
  );
}