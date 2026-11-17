import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Building2, Check, ChevronDown, Plus } from 'lucide-react';
import { getCompany, switchCompany } from '@/services/http';
import type { User } from '@/services/authApi';
import { cn } from '@/utils/ui';
import { CompanyLogo } from '@/components/CompanyLogo';
import { tx, useT } from '@/i18n';

const ROLE: Record<string, string> = {
  admin: tx('Admin'), compliance_manager: tx('Compliance manager'), reviewer: tx('Reviewer'), viewer: tx('Viewer'), auditor: tx('Auditor'),
};

/**
 * The company the app is working in, in the app bar. One address and one
 * sign-in serve every company; switching reloads the app so no screen keeps
 * the last company's data. Someone who works in one company only sees its
 * name; an admin of the main company also gets "Add new company".
 */
export function CompanySwitcher({ me }: { me: User }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const companies = me.companies ?? [];
  const current = companies.find((c) => c.slug === getCompany()) ?? companies[0];
  const canSwitch = companies.length > 1 || !!me.platformAdmin;
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  if (!current) return null;

  if (!canSwitch) {
    return (
      <div title={current.name} className="flex h-10 max-w-[260px] items-center gap-2 pl-1.5 pr-2.5">
        <CompanyLogo slug={current.slug} name={current.name} size={28} />
        <span className="min-w-0 truncate text-[13px] font-semibold capitalize text-ink">{current.name.toLowerCase()}</span>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)}
              aria-haspopup="listbox" aria-expanded={open} title={t('Switch company')}
              className={cn('flex h-10 max-w-[260px] items-center gap-2 rounded-xl border bg-white pl-1.5 pr-2.5 text-left transition',
                            open ? 'border-blue-200 bg-blue-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')}>
        <CompanyLogo slug={current.slug} name={current.name} size={28} />
        <span className="min-w-0 truncate text-[13px] font-semibold capitalize text-ink">{current.name.toLowerCase()}</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div role="listbox" aria-label={t('Switch company')}
             className="absolute right-0 top-12 z-50 w-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg">
          <div className="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{t('Switch company')}</div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            {companies.map((c) => {
              const active = c.slug === current.slug;
              return (
                <button key={c.slug || 'home'} type="button" role="option" aria-selected={active}
                        onClick={() => { setOpen(false); if (!active) switchCompany(c.slug); }}
                        className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition',
                                      active ? 'bg-brand-50' : 'hover:bg-slate-50')}>
                  <CompanyLogo slug={c.slug} name={c.name} size={28} />
                  <span className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-[13px] font-medium capitalize text-ink">{c.name.toLowerCase()}</span>
                    <span className="block truncate text-[11.5px] text-muted">{ROLE[c.role] ? t(ROLE[c.role]) : c.role}{c.slug ? '' : ` · ${t('main company')}`}</span>
                  </span>
                  {active && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                </button>
              );
            })}
          </div>
          {me.platformAdmin && (
            <div className="border-t border-slate-100">
              <NavLink to="/company-setup?new=1" onClick={() => setOpen(false)}
                       className="flex items-center gap-2 px-3.5 py-2.5 text-[13px] font-medium text-brand-600 hover:bg-slate-50">
                <Plus className="h-4 w-4" /> {t('Add new company')}
              </NavLink>
              <NavLink to="/workspaces" onClick={() => setOpen(false)}
                       className="flex items-center gap-2 px-3.5 pb-2.5 pt-0.5 text-[12.5px] text-muted hover:text-ink">
                <Building2 className="h-4 w-4" /> {t('All companies')}
              </NavLink>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
