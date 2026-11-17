import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Building2, Loader2, Search } from 'lucide-react';
import { lookupCompany, type CompanySuggestion } from '@/services/companyApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

/**
 * "Find your company": suggestions from the public LEI register as a name — or
 * a CIN — is typed. Picking one hands its LEI to the form, which reads the
 * full record and fills what the register holds.
 *
 * A company without an LEI is not in that register. The empty state says so
 * plainly, because "no results" alone reads as "your company does not exist".
 */
export function CompanySearch({ onPick, busy }: { onPick: (s: CompanySuggestion) => void; busy?: boolean }) {
  const tr = useT();
  const [q, setQ] = useState('');
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  // Wait for a pause in typing: every keystroke is otherwise a request to a
  // public service that rate-limits, for a list that is about to change.
  useEffect(() => {
    const t = setTimeout(() => setTyped(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const enabled = typed.length >= 3;
  const { data, isFetching, error } = useQuery({
    queryKey: ['company-lookup', typed],
    queryFn: () => lookupCompany(typed),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const results = enabled ? data ?? [] : [];

  const pick = (s: CompanySuggestion) => {
    setOpen(false);
    setQ(s.name);
    onPick(s);
  };

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-2" />
      <input
        role="combobox" aria-expanded={open && enabled} aria-controls="company-suggestions" aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `company-option-${active}` : undefined}
        className="input h-11 pl-11 pr-10 text-[14px]"
        placeholder={tr("Type your company's registered name or CIN — e.g. Premier Hospitals")}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || !results.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
          if (e.key === 'Escape') setOpen(false);
        }}
        name="company-lookup" autoComplete="off" spellCheck={false}
        data-lpignore="true" data-1p-ignore="true" data-form-type="other"
      />
      {(isFetching || busy) && (
        <Loader2 className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" />
      )}

      {open && enabled && (
        <ul id="company-suggestions" role="listbox"
          className="absolute z-30 mt-1.5 max-h-[340px] w-full overflow-auto rounded-xl border border-line bg-surface p-1 shadow-pop">
          {error ? (
            <li className="px-3 py-2.5 text-[12.5px] text-muted">
              {tr('The public register could not be reached just now. Fill in the form by hand — nothing else depends on it.')}
            </li>
          ) : !data && isFetching ? (
            <li className="px-3 py-2.5 text-[12.5px] text-muted">{tr('Searching the public register…')}</li>
          ) : results.length === 0 ? (
            <li className="px-3 py-2.5 text-[12.5px] leading-relaxed text-muted">
              {tr('No Indian company in the LEI register matches “{query}”. Try the name as it is registered, or the CIN. A company without an LEI is not in this register — fill in the form by hand.', { query: typed })}
            </li>
          ) : results.map((s, i) => (
            <li key={s.lei} id={`company-option-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); pick(s); }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2', i === active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600" aria-hidden="true">
                <Building2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{s.name}</span>
                  {s.status && s.status !== 'ACTIVE' && (
                    <span className="rounded bg-warning-50 px-1.5 text-[11px] font-semibold text-warning-600">
                      {s.status.toLowerCase()}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-muted">
                  {s.registrationNo && <span>{s.registrationKind ?? tr('Reg.')} <span className="font-mono text-ink-2">{s.registrationNo}</span></span>}
                  {(s.city || s.state) && <span>· {[s.city, s.state].filter(Boolean).join(', ')}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
