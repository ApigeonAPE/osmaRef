import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Toast } from './components/Toast';

type ToastKind = 'error' | 'info' | 'success';

interface ToastChannel {
  show(message: string, kind?: ToastKind): void;
  error(message: string): void;
  info(message: string): void;
  success(message: string): void;
}

const ToastContext = createContext<ToastChannel | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{
    id: number;
    kind: ToastKind;
    message: string;
  } | null>(null);

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    setToast({ id: Date.now(), kind, message });
  }, []);

  useEffect(
    () =>
      window.osmaRef.app.onEvent((event) => {
        if (event.type === 'toast') show(event.message, event.kind);
      }),
    [show],
  );

  const value = useMemo<ToastChannel>(
    () => ({
      show,
      error: (message) => show(message, 'error'),
      info: (message) => show(message, 'info'),
      success: (message) => show(message, 'success'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <Toast
          key={toast.id}
          kind={toast.kind}
          message={toast.message}
          onClose={() => setToast(null)}
        />
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastChannel {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast must be used inside ToastProvider');
  return value;
}
