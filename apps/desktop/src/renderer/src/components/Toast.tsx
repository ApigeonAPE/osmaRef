import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n';

export function Toast({
  message,
  kind = 'error',
  onClose,
  duration = 6000,
}: {
  message: string;
  kind?: 'error' | 'info' | 'success';
  onClose: () => void;
  duration?: number;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const { t } = useI18n();

  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);

  return (
    <div className={`toast ${kind}`} role="alert" aria-live="assertive">
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label={t('Close')}>
        ×
      </button>
    </div>
  );
}