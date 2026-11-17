import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Loader2, MapPin, Plus, Trash2 } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useMe } from '@/services/authApi';
import { api, getCompany, switchCompany } from '@/services/http';
import { useCompanies, useDeleteCompany, type CompanyRow, type CompanyStatus } from '@/services/workspacesApi';
import { cn, toneClass, type Tone } from '@/utils/ui';
import { Callout, EmptyState, MetricCard } from '@/components/ui/primitives';
import { CompanyLogo } from '@/components/CompanyLogo';
import { tx, useDateLocale, useT } from '@/i18n';

const STATUS: Record<CompanyStatus, [string, Tone]> = {
  PENDING: [tx('Not added'), 'gray'], APPROVED: [tx('Setting up…'), 'blue'], CREATING: [tx('Setting up…'), 'blue'],
  READY: [tx('Ready'), 'green'], FAILED: [tx('Failed'), 'red'], DELETING: [tx('Deleting…'), 'red'], REMOVING: [tx('Deleting…'), 'red'],
};
/** the status colours used everywhere: Met green, Partial amber, Gap red, Not covered orange */
const RESULT = [
  { key: 'met', label: 'Met', tile: 'bg-success-50', label_: 'text-success-600', value: 'text-success-700' },
  { key: 'partial', label: 'Partial', tile: 'bg-warning-50', label_: 'text-warning-600', value: 'text-warning-700' },
  { key: 'gap', label: 'Gap', tile: 'bg-critical-50', label_: 'text-critical-600', value: 'text-critical-700' },
  { key: 'not_covered', label: 'Not covered', tile: 'bg-notcov-50', label_: 'text-notcov-600', value: 'text-notcov-700' },
] as const;

/** The same summary each company's dashboard reads (/api/home), asked of that company. */
interface Summary {
  company: { name: string | null; city: string | null; state: string | null };
  applicable: number; documents: number; open_findings?: number;
  totals?: { met?: number; partial?: number; gap?: number; not_covered?: number; checked?: number };
  pipeline?: { label: string; detail: string; done: boolean }[];
}
interface Card {
  id?: number; slug: string; name: string; sector: string | null; status: CompanyStatus; message: string | null;
  team: number; created_at?: string; home?: boolean;
}

/**
 * Companies: every company on this installation, each as a card with its own
 * compliance picture. "Add new company" opens Company Setup for it
 * (/company-setup?new=1); the server's workspace timer creates the company
 * within a minute and it then appears in the company menu. Who works in a
 * company is managed on its Users screen, after switching to it.
 */
export function WorkspacesPage() {
  const t = useT();
  const { data: me } = useMe();
  const admin = !!me?.platformAdmin;
  const { data, error, isLoading } = useCompanies(admin);
  const navigate = useNavigate();
  const current = getCompany();
  // a company that has just become ready belongs in the company menu straight away
  const qc = useQueryClient();
  const readyCount = data?.items.filter((r) => r.status === 'READY').length;
  useEffect(() => { if (readyCount !== undefined) qc.invalidateQueries({ queryKey: ['me'] }); }, [readyCount, qc]);
  const [deleting, setDeleting] = useState<Card | null>(null);

  const cards: Card[] = data ? [
    { slug: '', name: data.home, sector: null, status: 'READY', message: null, team: data.home_team, home: true },
    ...data.items.map((r: CompanyRow) => ({
      id: r.id, slug: r.slug, name: r.company_name, sector: r.sector, status: r.status, message: r.message,
      team: r.members + data.admins, created_at: r.created_at,
    })),
  ] : [];
  // each ready company's summary, asked of that company ('' = the main one)
  const summaries = useQueries({
    queries: cards.map((c) => ({
      queryKey: ['company-summary', c.slug],
      queryFn: () => api<Summary>('/api/home', { headers: { 'X-Company': c.slug } }),
      enabled: admin && c.status === 'READY',
      staleTime: 120_000,
    })),
  });

  if (!admin) {
    return (
      <>
        <Topbar title="Companies" icon="Building2" />
        <div className="p-6"><Callout tone="amber" title={t('Administrator access required')}>{t('Only an administrator of the main company can add companies.')}</Callout></div>
      </>
    );
  }

  const loaded = summaries.map((q) => q.data).filter(Boolean) as Summary[];
  const sum = (f: (s: Summary) => number) => loaded.reduce((a, s) => a + f(s), 0);
  const openGaps = sum((s) => (s.totals?.gap ?? 0) + (s.totals?.partial ?? 0) + (s.totals?.not_covered ?? 0));

  return (
    <div>
      <Topbar title="Companies" icon="Building2"
              subtitle="Every company you manage, each with its own data, team and gaps. Open one to work in it."
              actions={<button type="button" className="btn btn-primary" onClick={() => navigate('/company-setup?new=1')}><Plus className="h-4 w-4" /> {t('Add new company')}</button>} />
      <div className="space-y-5 p-4 sm:p-6">
        {error && <Callout tone="red" title={t('Could not load companies')}>{(error as Error).message}</Callout>}

        {data && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label={t('Companies')} value={cards.length} tone="brand" icon="Building2"
                        foot={t('{n} setting up', { n: cards.filter((c) => c.status !== 'READY').length })} />
            <MetricCard label={t('People')} value={data.home_team + data.items.reduce((a, r) => a + r.members, 0)} tone="purple" icon="Users"
                        foot={data.admins === 1 ? t('incl. 1 admin') : t('incl. {n} admins', { n: data.admins })} />
            <MetricCard label={t('Applicable regulations')} value={sum((s) => s.applicable).toLocaleString()} tone="teal" icon="ScrollText"
                        foot={t('all companies')} />
            <MetricCard label={t('Open requirements')} value={openGaps.toLocaleString()} tone="red" icon="AlertTriangle"
                        foot={t('not fully met')} />
          </div>
        )}

        {isLoading && (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{[0, 1].map((i) => <div key={i} className="card h-64 animate-pulse bg-slate-50" />)}</div>
        )}
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {cards.map((c, i) => (
            <CompanyCard key={c.slug || 'home'} c={c} active={(current || '') === c.slug}
                         summary={summaries[i]?.data} loading={summaries[i]?.isLoading && c.status === 'READY'}
                         onOpen={() => switchCompany(c.slug)} onDelete={() => setDeleting(c)} />
          ))}
          <button type="button" onClick={() => navigate('/company-setup?new=1')}
                  className="flex min-h-[260px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-white/50 text-center transition hover:border-brand-300 hover:bg-brand-50/40">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-brand-50 text-brand-600"><Plus className="h-5 w-5" /></span>
            <span className="text-[15px] font-semibold text-ink">{t('Add new company')}</span>
            <span className="max-w-xs text-[12.5px] text-muted">{t('Fill in its Company Setup; it is ready in about a minute.')}</span>
          </button>
        </div>
        {deleting && <DeleteCompany c={deleting} onClose={() => setDeleting(null)} />}
        {!isLoading && data && !data.items.length && (
          <EmptyState icon="Building2" title={t('Only the main company so far')} hint={t('Add a company to manage its compliance separately.')} />
        )}
      </div>
    </div>
  );
}

/**
 * One company: who it is, then its requirements as four count tiles in the
 * status colours (Met, Partial, Gap, Not covered), then a one-line footing.
 */
function CompanyCard({ c, active, summary, loading, onOpen, onDelete }: {
  c: Card; active: boolean; summary?: Summary; loading?: boolean; onOpen: () => void; onDelete: () => void;
}) {
  const tr = useT();
  const locale = useDateLocale('en-IN');
  const [label, tone] = STATUS[c.status];
  const t = summary?.totals ?? {};
  const checked = RESULT.reduce((a, r) => a + (t[r.key] ?? 0), 0);
  const metPct = checked ? Math.round(((t.met ?? 0) / checked) * 100) : null;
  const place = [summary?.company.city, summary?.company.state].filter(Boolean).join(', ');
  const setting = ['APPROVED', 'CREATING', 'DELETING', 'REMOVING'].includes(c.status);
  const sub = [c.home ? tr('Main company') : c.sector, place].filter(Boolean).join(' · ');

  return (
    <article className={cn('card flex flex-col p-5 transition-shadow hover:shadow-md', active && 'ring-2 ring-brand-500/30')}>
      <header className="flex items-start gap-3">
        <CompanyLogo slug={c.slug} name={c.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h2 className="truncate text-[15px] font-semibold capitalize leading-tight text-ink" title={c.name}>{c.name.toLowerCase()}</h2>
            <span className={cn('pill shrink-0', active ? 'bg-brand-50 text-brand-700' : toneClass(tone))}>
              {setting && <Loader2 className="h-3 w-3 animate-spin" />}{active ? tr('Open now') : tr(label)}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] text-muted">
            {place && <MapPin className="h-3 w-3 shrink-0" />}<span className="truncate">{sub || '—'}</span>
          </p>
        </div>
      </header>

      {c.status === 'READY' ? (
        loading || !summary ? (
          <div className="grid flex-1 place-items-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {RESULT.map((r) => (
                <div key={r.key} className={cn('rounded-lg px-3 py-2.5', r.tile)}>
                  <div className={cn('text-[12px] font-medium', r.label_)}>{tr(r.label)}</div>
                  <div className={cn('text-[20px] font-bold leading-tight tabular-nums', r.value)}>{(t[r.key] ?? 0).toLocaleString()}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[12.5px] text-muted">
              {tr('{n} regulations', { n: summary.applicable.toLocaleString() })} · {c.team === 1 ? tr('1 person') : tr('{n} people', { n: c.team.toLocaleString() })}
              {metPct !== null ? <> · <b className="font-semibold text-ink-2">{tr('{pct}% met', { pct: metPct })}</b></> : <> · {tr('not checked yet')}</>}
            </p>
          </>
        )
      ) : (
        <div className="flex flex-1 items-center gap-2.5 py-10 text-[13px]">
          {c.status === 'FAILED'
            ? <><AlertTriangle className="h-5 w-5 shrink-0 text-critical-600" /><span className="text-critical-600">{c.message ?? tr('Could not be created.')}</span></>
            : <><Loader2 className="h-5 w-5 shrink-0 animate-spin text-brand-600" /><span className="text-muted">{c.message ?? tr('Setting up — about a minute.')}</span></>}
        </div>
      )}

      <footer className="mt-auto flex items-center justify-between gap-3 border-t border-slate-100 pt-3 mt-4">
        <span className="text-[11.5px] text-muted">{c.home ? tr('Admins work here and in every company') : c.created_at ? tr('Added {date}', { date: new Date(c.created_at).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) }) : ''}</span>
        <div className="flex items-center gap-1.5">
          {!c.home && (c.status === 'READY' || c.status === 'FAILED') && (
            <button type="button" onClick={onDelete} aria-label={tr('Delete {name}', { name: c.name })} title={tr('Delete company')}
                    className="btn btn-sm btn-ghost px-2 hover:bg-critical-50 hover:text-critical-600">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          {c.status === 'READY' && !active && (
            <button type="button" className="btn btn-sm btn-outline" onClick={onOpen}>{tr('Open')} <ArrowRight className="h-3.5 w-3.5" /></button>
          )}
        </div>
      </footer>
    </article>
  );
}

/**
 * "Delete this company?" — says exactly what goes, and asks for the company's
 * name before the button works. The server checks the name again.
 */
function DeleteCompany({ c, onClose }: { c: Card; onClose: () => void }) {
  const t = useT();
  const del = useDeleteCompany();
  const [typed, setTyped] = useState('');
  const norm = (v: string) => v.split(/\s+/).filter(Boolean).join(' ').toLowerCase();
  const matches = norm(typed) === norm(c.name);
  // one sentence around the company name, split where the name is drawn in bold
  const confirmLabel = t('Type {name} to confirm').split('{name}');
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !del.isPending) onClose(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose, del.isPending]);

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-slate-900/40 p-4" role="presentation"
         onMouseDown={(e) => { if (e.target === e.currentTarget && !del.isPending) onClose(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="del-title" aria-describedby="del-body"
           className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-critical-50 text-critical-600"><Trash2 className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h2 id="del-title" className="text-[17px] font-semibold text-ink">{t('Delete {name}?', { name: c.name })}</h2>
            <div id="del-body" className="mt-1.5 space-y-2 text-[13px] leading-relaxed text-ink-2">
              <p>{t("This permanently deletes the company and all its data: profile, records, documents, controls, gaps, assessments and its team's access to it.")}</p>
              <p>{t('The shared regulation library and your other companies are not affected.')} <b>{t('This cannot be undone.')}</b></p>
            </div>
          </div>
        </div>
        <form className="mt-5" onSubmit={(e) => {
          e.preventDefault();
          if (!matches || !c.id) return;
          del.mutate({ id: c.id, confirm_name: typed }, {
            onSuccess: () => { if (getCompany() === c.slug) switchCompany('', '/workspaces'); else onClose(); },
          });
        }}>
          <label className="block">
            <span className="mb-1.5 block text-[13px] text-ink-2">{confirmLabel[0]}<b className="font-semibold text-ink">{c.name}</b>{confirmLabel[1]}</span>
            <input className="input h-10 w-full" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
                   autoComplete="off" spellCheck={false} placeholder={c.name} />
          </label>
          {del.error && <p className="mt-2 text-[12.5px] text-critical-600">{del.error.message}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn" onClick={onClose} disabled={del.isPending}>{t('Cancel')}</button>
            <button type="submit" className="btn btn-danger" disabled={!matches || del.isPending}>
              {del.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} {t('Delete company')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
