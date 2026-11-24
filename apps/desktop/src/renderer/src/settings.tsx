import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Settings } from '@osmaref/contracts';

interface SettingsContextValue {
  settings: Settings;
  save: (patch: Partial<Settings>) => Promise<Settings>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error('useSettings must be used inside SettingsProvider');
  return value;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void window.osmaRef.app.getSettings().then(setSettings);
  }, []);

  const save = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.osmaRef.app.saveSettings(patch);
    setSettings(next);
    return next;
  }, []);

  const value = useMemo<SettingsContextValue | null>(
    () => (settings ? { settings, save } : null),
    [settings, save],
  );

  if (!value) return null;

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
