import { agentModeTranslations } from './locales/agent-modes';
import { appTranslations } from './locales/app';
import { modelTranslations } from './locales/models';
import { auxiliaryTranslations } from './locales/auxiliary';
import { backendTranslations } from './locales/backend';
import { taskTranslations } from './locales/tasks';

export const APP_LOCALES = ['zh-CN', 'en', 'ja', 'ko'] as const;
export type AppLocale = typeof APP_LOCALES[number];
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';
export const LOCALE_NAMES: Record<AppLocale, string> = { 'zh-CN': '简体中文', en: 'English', ja: '日本語', ko: '한국어' };
export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}
export const translations: Record<string, readonly [string, string, string]> = {
  ...agentModeTranslations, ...appTranslations, ...modelTranslations, ...auxiliaryTranslations, ...backendTranslations, ...taskTranslations,
};
export type TranslationValues = Record<string, string | number>;

/** Only translate application-owned messages. User content and tool output stay intact. */
export function translate(locale: AppLocale, source: string, values: TranslationValues = {}): string {
  const index = locale === 'en' ? 0 : locale === 'ja' ? 1 : locale === 'ko' ? 2 : -1;
  const template = index === -1 ? source : translations[source]?.[index] ?? source;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
