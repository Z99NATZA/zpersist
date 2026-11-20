import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Problem, MessageValues } from './api';
import en from './locales/en.json';
import th from './locales/th.json';

type Language = 'en' | 'th';
type MessageKey = keyof typeof en.messages;

const dictionaries = { en, th } satisfies Record<Language, typeof en>;
const STORAGE_KEY = 'zpersist.language';

interface I18n {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: MessageKey, values?: MessageValues) => string;
  errorText: (problem: Problem) => string;
  number: (value: number) => string;
}

const I18nContext = createContext<I18n | null>(null);

function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'th') return saved;
  } catch {
    // The language switch also works without browser storage.
  }
  return navigator.language.toLowerCase().startsWith('th') ? 'th' : 'en';
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState(initialLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Keep the current language for this page.
    }
  }, [language]);

  const value = useMemo<I18n>(() => {
    const dictionary = dictionaries[language];
    const number = new Intl.NumberFormat(language).format;

    function format(template: string, values?: MessageValues) {
      return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
        const value = values?.[name];
        if (typeof value === 'number') return number(value);
        return value ?? placeholder;
      });
    }

    return {
      language,
      setLanguage,
      number,
      t: (key, values) => format(dictionary.messages[key], values),
      errorText: ({ code, params }) => {
        const message = Object.hasOwn(dictionary.errors, code)
          ? dictionary.errors[code as keyof typeof en.errors]
          : dictionary.errors.internal;
        return format(message, params);
      },
    };
  }, [language]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error('LanguageProvider is missing.');
  return context;
}
