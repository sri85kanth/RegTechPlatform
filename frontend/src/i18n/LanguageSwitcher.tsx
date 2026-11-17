import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Languages, Loader2 } from 'lucide-react';
import { cn } from '@/utils/ui';
import { LANGUAGES, useI18n, useT } from './index';

/**
 * Language picker for the interface. Each language is listed in its own script
 * with the English name beside it, so anyone can find theirs.
 *
 * `compact` drops the language name from the button, for tight headers.
 */
export function LanguageSwitcher({ compact = false, className }: { compact?: boolean; className?: string }) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const loading = useI18n((s) => s.loading);
  const setLang = useI18n((s) => s.setLang);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = LANGUAGES.find((l) => l.code === lang) ?? LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${t('Language')}: ${current.native}`}
        title={t('Language')}
        className={cn(
          'flex h-10 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-all duration-300 ease-spring active:scale-95',
          open ? 'bg-brand-50 text-brand-700'
            : 'bg-black/[0.04] text-slate-600 hover:bg-black/[0.07] hover:text-ink',
        )}
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Languages className="h-4 w-4" aria-hidden="true" />}
        {!compact && <span className="hidden max-w-[110px] truncate sm:inline">{current.native}</span>}
        <ChevronDown className={cn('h-3.5 w-3.5 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label={t('Language')}
          className="absolute right-0 z-50 mt-2 max-h-[70vh] w-60 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-float"
        >
          {LANGUAGES.map((l) => {
            const selected = l.code === lang;
            return (
              <li key={l.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  lang={l.code}
                  onClick={() => { setOpen(false); void setLang(l.code); }}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition',
                    selected ? 'bg-blue-50' : 'hover:bg-slate-50',
                  )}
                >
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className={cn('block text-[14px]', selected ? 'font-semibold text-blue-700' : 'font-medium text-ink')}>{l.native}</span>
                    {l.code !== 'en' && <span className="block text-[11.5px] text-slate-500" lang="en">{l.name}</span>}
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-blue-600" aria-hidden="true" />}
                </button>
              </li>
            );
          })}
          <li className="mt-1 border-t border-slate-100 px-3 pb-1 pt-2 text-[11px] leading-snug text-slate-500">
            {t('Menus and labels are translated. Regulation text and your records stay in their original language.')}
          </li>
        </ul>
      )}
    </div>
  );
}
