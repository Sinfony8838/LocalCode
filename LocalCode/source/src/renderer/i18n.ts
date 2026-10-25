import { useSyncExternalStore } from 'react';
import { DEFAULT_LOCALE, isAppLocale, translate, type AppLocale, type TranslationValues } from '../shared/i18n';

let locale: AppLocale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();
export function setLocale(value: AppLocale) {
  const next = isAppLocale(value) ? value : DEFAULT_LOCALE;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === locale) return;
  locale = next;
  for (const listener of listeners) listener();
}
export function useLocale(): AppLocale {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => locale, () => locale);
}
export function t(source: string, values?: TranslationValues): string { return translate(locale, source, values); }
/** Electron wraps IPC failures before sending them to a renderer. */
export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?/, '');
}
