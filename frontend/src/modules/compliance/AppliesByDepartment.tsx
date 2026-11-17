/**
 * Regulations by department — the "By department" view of the Impact Cascade.
 *
 * The same applicable requirements as the rest of the page, filed under the
 * department that answers for them: the gap assessment names a responsible
 * role for every requirement ("Head - HR", "Laboratory Head"), and
 * GET /api/applies/by-department maps that role onto the hospital's departments
 * with the keyword sets the dashboard and the regulation page use. A
 * requirement whose role names two departments counts for both.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { api } from '@/services/http';
import { Icon } from '@/config/icons';
import { SkeletonCards } from '@/components/ui/skeletons';
import { StackedBar } from '@/components/ui/charts';
import { CountUp } from '@/components/ui/motion';
import { StatusChip } from './ui';
import { GAP_UI } from '@/modules/regulatory/regShared';
import { deptIcon, accentForName } from '@/modules/departments/accent';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

interface Counts { requirements: number; met: number; partial: number; gap: number; not_covered: number; open: number; critical_open: number }
interface RegRow extends Counts { id: string; title: string; regulator: string | null; verdict: string | null; roles: string[] }
interface Dept extends Counts { name: string; regulations: number; items: RegRow[] }
interface ByDept { departments: Dept[]; requirements: number; regulations: number }

const STATUSES = [['MET', 'met'], ['PARTIAL', 'partial'], ['GAP', 'gap'], ['NOT_COVERED', 'not_covered']] as const;
const slices = (c: Counts) => STATUSES.map(([s, k]) => ({ label: GAP_UI[s].label, value: c[k], color: GAP_UI[s].hex }));
const PAGE = 25;

/** `onOpen` opens a regulation where this view is hosted; without it a row links to the regulation page. */
export function AppliesByDepartment({ onOpen }: { onOpen?: (id: string) => void }) {
  const t = useT();
  const [sp, setSp] = useSearchParams();
  const { data, isLoading } = useQuery<ByDept>({
    queryKey: ['applies-by-department'],
    queryFn: () => api('/api/applies/by-department'),
    staleTime: 60_000,
  });

  if (isLoading) return <SkeletonCards count={3} lines={4} />;
  if (!data || !Array.isArray(data.departments) || data.departments.length === 0) {
    return (
      <div className="card px-6 py-12 text-center">
        <p className="text-[14px] font-semibold text-ink">{t('No department has a checked requirement yet')}</p>
        <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">
          {t('Departments appear once the regulations that reach us have been checked against the hospital’s documents — each checked requirement names the role responsible for it.')}
        </p>
      </div>
    );
  }

  const picked = data.departments.find((d) => d.name === sp.get('dept')) ?? data.departments[0];
  const pick = (name: string) => { const next = new URLSearchParams(sp); next.set('dept', name); setSp(next, { replace: true }); };

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* every department, most open first */}
      <nav aria-label={t('Departments')} className="card overflow-hidden lg:sticky lg:top-20">
        <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
          <span className="text-[13px] font-semibold text-ink">{t('Departments')}</span>
          <span className="text-[12px] tabular-nums text-muted">{data.departments.length}</span>
        </div>
        <ul className="pm-stagger max-h-[64vh] space-y-0.5 overflow-y-auto p-1.5">
          {data.departments.map((d) => {
            const on = d.name === picked.name;
            const accent = accentForName(d.name);
            return (
              <li key={d.name}>
                <button type="button" onClick={() => pick(d.name)} aria-current={on || undefined}
                        className={cn('flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
                          on ? 'bg-brand-50 ring-1 ring-inset ring-brand-200' : 'hover:bg-slate-50')}>
                  <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', accent.tile)}>
                    <Icon name={deptIcon(d.name)} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-[13px] font-semibold', on ? 'text-brand-700' : 'text-ink')}>{d.name}</span>
                    <span className="block truncate text-[11.5px] text-muted">
                      {t('{n} regulations', { n: d.regulations.toLocaleString() })}
                      {d.critical_open > 0 && <> · <span className="font-medium text-critical-600">{t('{n} critical', { n: d.critical_open.toLocaleString() })}</span></>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-[14px] font-bold tabular-nums leading-none text-ink">{d.open.toLocaleString()}</span>
                    <span className="text-[10.5px] text-muted">{t('open')}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {/* how the list is built, once, out of the way */}
        <p className="border-t border-line px-4 py-3 text-[11.5px] leading-relaxed text-muted">
          {t('{regs} checked regulations and {reqs} requirements, filed under the department whose role is named responsible.', {
            regs: data.regulations.toLocaleString(), reqs: data.requirements.toLocaleString(),
          })}{' '}
          {t('A requirement that names two departments counts in both.')}
        </p>
      </nav>

      <DeptPanel key={picked.name} d={picked} onOpen={onOpen} />
    </div>
  );
}

type Show = '' | 'critical' | (typeof STATUSES)[number][1];

/** a row's state as a thin coloured edge on its first cell (a table row cannot carry a ::before) */
const edge = (r: Counts) => ({
  boxShadow: `inset 3px 0 0 ${r.critical_open > 0 ? '#dc2626' : r.open > 0 ? '#f59e0b' : '#16a34a'}`,
});

const has = (r: RegRow, s: Show) => !s || (s === 'critical' ? r.critical_open > 0 : r[s] > 0);

function DeptPanel({ d, onOpen }: { d: Dept; onOpen?: (id: string) => void }) {
  // `t` is the search text in the filter below, so the translate function is `tr` here
  const tr = useT();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('');
  const [all, setAll] = useState(false);
  const accent = accentForName(d.name);
  // each chip counts the regulations it would show, so the number matches the rows
  const chips = useMemo(() => ([
    { key: 'critical' as const, label: 'Critical', dot: '#dc2626' },
    ...[...STATUSES].reverse().map(([s, k]) => ({ key: k, label: GAP_UI[s].label, dot: GAP_UI[s].hex })),
  ]).map((c) => ({ ...c, n: d.items.filter((r) => has(r, c.key)).length })).filter((c) => c.n > 0), [d.items]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return d.items.filter((r) => has(r, show)
      && (!t || `${r.title} ${r.regulator ?? ''} ${r.roles.join(' ')}`.toLowerCase().includes(t)));
  }, [d.items, q, show]);
  const shown = all ? rows : rows.slice(0, PAGE);
  const choose = (s: Show) => { setShow((v) => (v === s ? '' : s)); setAll(false); };

  return (
    <section className="card pm-fade overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pb-3 pt-5">
        <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-2xl', accent.tile)}>
          <Icon name={deptIcon(d.name)} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[17px] font-semibold tracking-tight text-ink">{d.name}</h2>
          <p className="text-[12.5px] text-muted">
            {tr('{regs} regulations apply · {reqs} requirements', { regs: d.regulations.toLocaleString(), reqs: d.requirements.toLocaleString() })}
          </p>
        </div>
        <div className="flex divide-x divide-line">
          <Figure n={d.open} label={tr('Open')} />
          <Figure n={d.critical_open} label={tr('Critical')} critical />
        </div>
      </header>
      <div className="px-5"><StackedBar height={6} legend={false} data={slices(d)} /></div>

      <div className="flex flex-wrap items-center gap-1.5 px-5 py-3">
        <StatusChip label={tr('All')} n={d.items.length} on={!show} onClick={() => choose('')} />
        {chips.map((c) => (
          <StatusChip key={c.key} label={tr(c.label)} n={c.n} dot={c.dot} on={show === c.key} onClick={() => choose(c.key)} />
        ))}
        <div className="relative ml-auto w-full sm:w-44">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
          <input className="input h-8 w-full rounded-full pl-8 text-[12.5px]" placeholder={tr('Search')} title={tr('Search regulations or roles in this department')}
                 aria-label={tr('Search regulations or roles in this department')}
                 value={q} onChange={(e) => { setQ(e.target.value); setAll(false); }} />
        </div>
      </div>

      <table className="w-full table-fixed text-[13px]">
        <thead>
          <tr className="border-y border-line bg-slate-50/70 text-left text-[11.5px] font-medium text-muted">
            <th className="px-5 py-2">{tr('Regulation')}</th>
            <th className="w-20 px-3 py-2 text-right sm:w-28">{tr('Open')}</th>
            <th className="w-20 py-2 pl-2 pr-4 text-right sm:w-28 sm:pr-5">{tr('Critical')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {shown.map((r) => {
            const sub = [r.regulator, r.roles[0] && (r.roles.length > 1 ? `${r.roles[0]} +${r.roles.length - 1}` : r.roles[0])].filter(Boolean).join(' · ');
            const title = (
              <>
                <span className="truncate" title={r.title}>{r.title}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
              </>
            );
            return (
              <tr key={r.id} className="group hover:bg-slate-50/60">
                <td className="px-5 py-2.5" style={edge(r)}>
                  {onOpen ? (
                    <button type="button" onClick={() => onOpen(r.id)} className="flex w-full items-center gap-1 text-left font-medium text-ink hover:text-brand-600">{title}</button>
                  ) : (
                    <Link to={`/regulation/${encodeURIComponent(r.id)}`} className="flex items-center gap-1 font-medium text-ink hover:text-brand-600">{title}</Link>
                  )}
                  {sub && <span className="mt-0.5 block truncate text-[11.5px] text-muted" title={r.roles.join(', ')}>{sub}</span>}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums">
                  <b className="font-semibold text-ink">{r.open.toLocaleString()}</b>
                  <span className="text-muted"> / {r.requirements.toLocaleString()}</span>
                </td>
                <td className="py-2.5 pl-2 pr-4 text-right sm:pr-5">
                  {r.critical_open > 0 ? (
                    <span className="rounded-full bg-critical-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-critical-600">
                      {r.critical_open.toLocaleString()}
                    </span>
                  ) : <span className="text-muted-2">—</span>}
                </td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr><td colSpan={3} className="px-5 py-8 text-center text-[12.5px] text-muted">{tr('No regulation in this department matches.')}</td></tr>
          )}
        </tbody>
      </table>
      {rows.length > PAGE && (
        <div className="border-t border-line px-5 py-2.5 text-[12.5px]">
          <button type="button" className="font-medium text-brand-600 hover:underline" onClick={() => setAll((v) => !v)}>
            {all ? tr('Show the first {n} only', { n: PAGE }) : tr('Show all {n} regulations', { n: rows.length.toLocaleString() })}
          </button>
        </div>
      )}
    </section>
  );
}

function Figure({ n, label, critical }: { n: number; label: string; critical?: boolean }) {
  return (
    <div className="px-4 text-right first:pl-0 last:pr-0">
      <div className={cn('text-[22px] font-bold leading-none tracking-tight tabular-nums', critical && n > 0 ? 'text-critical-600' : 'text-ink')}>
        <CountUp value={n} />
      </div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}
