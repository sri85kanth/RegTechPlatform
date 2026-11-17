import { useCallback } from 'react';
import { create } from 'zustand';

/**
 * Interface translation.
 *
 * The English text is the key: `t('Sign in')`. Each language file maps English
 * text to that language, and anything not yet translated falls back to English,
 * so a missing entry shows the original wording instead of a blank or a key.
 *
 * Only the interface is translated. Regulation text, company records and other
 * data from the API stay in their original language: a translated statute is not
 * the statute, and nothing on screen is sent to an outside translation service.
 *
 * Language files are loaded on demand, so English users download none of them.
 */

export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', font: null },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', font: 'Noto Sans Devanagari' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', font: 'Noto Sans Bengali' },
  { code: 'mr', name: 'Marathi', native: 'मराठी', font: 'Noto Sans Devanagari' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', font: 'Noto Sans Telugu' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', font: 'Noto Sans Tamil' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', font: 'Noto Sans Gujarati' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', font: 'Noto Sans Kannada' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം', font: 'Noto Sans Malayalam' },
] as const;

export type LangCode = (typeof LANGUAGES)[number]['code'];
type Dict = Record<string, string>;
type Vars = Record<string, string | number>;

const loaders = import.meta.glob<Dict>('./locales/*.json', { import: 'default' });
const STORAGE_KEY = 'cb.lang';

function isLang(v: unknown): v is LangCode {
  return typeof v === 'string' && LANGUAGES.some((l) => l.code === v);
}

function savedLang(): LangCode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isLang(v)) return v;
  } catch { /* private mode */ }
  return 'en';
}

/** Set <html lang> for screen readers and line breaking, and fetch the script's font once. */
function applyToDocument(lang: LangCode) {
  document.documentElement.lang = lang;
  const font = LANGUAGES.find((l) => l.code === lang)?.font;
  if (!font) return;
  const id = `cb-font-${font.replace(/\s+/g, '-').toLowerCase()}`;
  if (document.getElementById(id)) return;
  const link = document.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${font.replace(/\s+/g, '+')}:wght@400;500;600;700&display=swap`;
  document.head.appendChild(link);
}

interface I18nState {
  lang: LangCode;
  dict: Dict;
  loading: boolean;
  setLang: (lang: LangCode) => Promise<void>;
}

let request = 0;

export const useI18n = create<I18nState>((set) => ({
  lang: 'en',
  dict: {},
  loading: false,
  setLang: async (lang) => {
    const mine = ++request;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* private mode */ }
    applyToDocument(lang);
    if (lang === 'en') {
      set({ lang, dict: {}, loading: false });
      return;
    }
    set({ loading: true });
    let dict: Dict = {};
    try {
      const load = loaders[`./locales/${lang}.json`];
      if (load) dict = await load();
    } catch {
      // a failed download leaves the interface in English rather than broken
      dict = {};
    }
    // a slow earlier choice must not overwrite a later one
    if (mine !== request) return;
    set({ lang, dict, loading: false });
  },
}));

/** Restore the language chosen last time in this browser. Called once at start-up. */
export function initI18n() {
  const lang = savedLang();
  if (lang !== 'en') void useI18n.getState().setLang(lang);
}

export function translate(dict: Dict, text: string, vars?: Vars): string {
  let out = dict[text] || text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return out;
}

export type TFunction = (text: string, vars?: Vars) => string;

/**
 * The translate function for a component. It re-renders the component when the
 * language changes. `{name}` placeholders are filled from `vars`.
 */
export function useT(): TFunction {
  const dict = useI18n((s) => s.dict);
  return useCallback((text: string, vars?: Vars) => translate(dict, text, vars), [dict]);
}

function dateLocaleFor(lang: LangCode, english: string): string {
  return lang === 'en' ? english : `${lang}-IN-u-nu-latn`;
}

/**
 * The locale for dates in the chosen language (month and weekday names), with
 * Latin digits kept so figures read the same on every screen. `english` is the
 * format a screen used before translation existed ('en-GB' or 'en-IN'), so the
 * English interface reads exactly as it did.
 */
export function useDateLocale(english = 'en-GB'): string {
  const lang = useI18n((s) => s.lang);
  return dateLocaleFor(lang, english);
}

/** The same, read once outside React (plain formatting helpers). */
export function currentDateLocale(english = 'en-GB'): string {
  return dateLocaleFor(useI18n.getState().lang, english);
}

/** The current language code; use it as an effect dependency to redraw non-React output. */
export function useLang(): LangCode {
  return useI18n((s) => s.lang);
}

/**
 * Mark English text for translation without translating it here — for
 * constants outside components (status labels, option lists). The extractor
 * collects it; translate it where it is drawn: `t(STATUS_LABEL[s])`.
 */
export const tx = <S extends string>(s: S): S => s;

/** `tx` for a whole list of English options: `txList(['Policy', 'SOP'] as const)`. */
export const txList = <T extends readonly string[]>(xs: T): T => xs;

/**
 * Translate outside React (HTML built as strings). It reads the current
 * language once, so the caller must redraw when `useLang()` changes.
 */
export function tNow(text: string, vars?: Vars): string {
  return translate(useI18n.getState().dict, text, vars);
}

/** Translate a value that may be absent or not a string (e.g. a ReactNode prop). */
export function tMaybe<T>(t: TFunction, value: T): T | string {
  return typeof value === 'string' ? t(value) : value;
}
