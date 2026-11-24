import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from 'react';
import type { LanguageSetting } from '@osmaref/contracts';
import { zhCN } from './messages';
import { useSettings } from '../settings';

export type ResolvedLanguage = 'en' | 'zh-CN';

type Params = Record<string, string | number>;

export interface I18n {
  language: ResolvedLanguage;
  setting: LanguageSetting;
  setLanguage: (setting: LanguageSetting) => Promise<void>;
  t: (source: string, params?: Params) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { settings, save } = useSettings();
  const setting = settings.language;

  const language = useMemo<ResolvedLanguage>(() => resolveLanguage(setting), [setting]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dataset.language = language;
  }, [language]);

  const setLanguage = useCallback(
    async (next: LanguageSetting) => {
      try {
        await save({ language: next });
      } catch {
        // Keep the in-memory choice even if the write fails.
      }
    },
    [save],
  );

  const t = useCallback(
    (source: string, params?: Params) => {
      const template = language === 'zh-CN' ? zhCN[source] ?? source : source;
      return interpolate(template, params);
    },
    [language],
  );

  const value = useMemo<I18n>(
    () => ({ language, setting, setLanguage, t }),
    [language, setting, setLanguage, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function resolveLanguage(setting: LanguageSetting): ResolvedLanguage {
  if (setting === 'zh-CN') return 'zh-CN';
  if (setting === 'en') return 'en';
  const candidates =
    typeof navigator === 'undefined'
      ? []
      : [...(navigator.languages ?? []), navigator.language ?? ''];
  return candidates.some((value) => value.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en';
}

export function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return match;
    return String(params[key]);
  });
}