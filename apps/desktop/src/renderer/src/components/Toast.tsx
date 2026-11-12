import { useEffect, useRef } from 'react';

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

  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), duration);
    return () => window.clearTimeout(timer);
  }, [message, duration]);

  return (
    <div className={`toast ${kind}`} role="alert" aria-live="assertive">
      <span className="toast-message">{message}</span>
      <button type="button" className="toast-close" onClick={onClose} aria-label="close">
        ×
      </button>
    </div>
  );
}