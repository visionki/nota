import { useSyncExternalStore } from 'react';
import { english } from './messages.en';

export type Locale = 'en' | 'zh-CN';
export type LanguagePreference = Locale | 'auto';

const storageKey = 'nota:language';
const chineseRegions = new Set(['CN', 'HK', 'MO', 'TW']);

export function detectLocale(preferences: readonly string[]): Locale {
  for (const preference of preferences) {
    try {
      const locale = new Intl.Locale(preference);
      if (locale.language === 'zh') return 'zh-CN';
      if (locale.language === 'en') return 'en';
      if (locale.region && chineseRegions.has(locale.region)) return 'zh-CN';
    } catch {
      // An invalid browser locale should not prevent the app from opening.
    }
  }
  return 'en';
}

function savedPreference(): LanguagePreference {
  try {
    const value = globalThis.localStorage?.getItem(storageKey);
    if (value === 'en' || value === 'zh-CN') return value;
  } catch {
    // The current tab still works when its storage is unavailable.
  }
  return 'auto';
}

function resolveLocale(preference: LanguagePreference): Locale {
  if (preference !== 'auto') return preference;
  const device = globalThis.navigator;
  return detectLocale(device?.languages?.length ? device.languages : [device?.language ?? 'en']);
}

let preference = savedPreference();
let current = { preference, locale: resolveLocale(preference) };
const listeners = new Set<() => void>();

function updateLanguage(value: LanguagePreference) {
  const locale = resolveLocale(value);
  if (value === current.preference && locale === current.locale) return;
  current = { preference: value, locale };
  for (const listener of listeners) listener();
}

export function setLanguage(value: LanguagePreference) {
  try {
    if (value === 'auto') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, value);
  } catch {
    // A manual choice remains active for this tab.
  }
  preference = value;
  updateLanguage(value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => updateLanguage(preference));
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = savedPreference();
    updateLanguage(preference);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanguage() {
  return useSyncExternalStore(subscribe, () => current);
}

export function interfaceLocale(): Locale {
  return current.locale;
}

export function translate(source: string | TemplateStringsArray, ...values: unknown[]): string {
  const key =
    typeof source === 'string'
      ? source
      : source.map((part, index) => (index ? `{${index - 1}}${part}` : part)).join('');
  const message = current.locale === 'en' ? (english[key] ?? key) : key;
  if (typeof source === 'string') return message;
  return message.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ''));
}
