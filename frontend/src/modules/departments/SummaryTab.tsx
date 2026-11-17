import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { FiledRecord, NodeSource, SourceHead } from '@/services/structureApi';
import { MetricCard } from '@/components/ui/primitives';
import { Donut, StackedBar } from '@/components/ui/charts';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';
import {
  amountFieldOf, countOf, dateFieldOf, demoOrigin, formatWhen, listText, rupees, valueKey, TONE_CLASS,
  type Described, type Facet, type KindGroup,
} from './model';
import { tx, useT } from '@/i18n';
import { accentAt, TONE_HEX } from './accent';
import { CodeBadge, Panel } from './ui';
import type { Go } from './Breakdown';

const ATTENTION_PER_REGISTER = 5;

/** An icon for a register, read from its own name. */
function registerIcon(label: string, domain: string): string {
  const s = `${label} ${domain}`.toLowerCase();
  if (/people|person|staff|employee|org/.test(s)) return 'Users';
  if (/invoice|bill|payment|purchase|po\b/.test(s)) return 'Briefcase';
  if (/complaint|incident|breakdown|ticket/.test(s)) return 'Siren';
  if (/equipment|asset|device|machine/.test(s)) return 'Wrench';
  if (/polic|sop|procedure|manual|document/.test(s)) return 'FileText';
  if (/calibrat|maintenance|service|pm\b/.test(s)) return 'Timer';
  if (/risk/.test(s)) return 'AlertTriangle';
  if (/control/.test(s)) return 'ShieldCheck';
  if (/evidence|record|log|form/.test(s)) return 'ClipboardList';
  if (/training/.test(s)) return 'BookOpen';
  return 'Layers';
}

interface RegisterStats {
  kind: KindGroup;
  title: string;
  /** what says how each record stands: its status, or a verdict such as a walk-through's finding */
  signal?: Facet;
  amount?: number;
  span?: string;
  demo: number;
  /** records whose own status is unsettled (open, pending) — never guessed from any other field */
  attention: FiledRecord[];
}

/**
 * The department at a glance: every register it holds, what each one says in
 * a line, and what is still open across all of them — with the same counts
 * as KPIs and charts above.
 *
 * Each register's rows live in its own tab, laid out like the source's own
 * page. This page says which tab to open.
 */
export function SummaryTab({ title, kinds, described, titles, sources, go, heads, manualHead }: {
  title: string; kinds: KindGroup[]; described: Map<string, Described>; titles: Map<string, string>;
  sources: NodeSource[]; go: Go; heads: SourceHead[]; manualHead?: { name: string; role?: string | null };
}) {
  const t = useT();
  const total = kinds.reduce((n, k) => n + k.rows.length, 0);
  const pending = kinds.reduce((n, k) => n + k.rows.filter((r) => r.verification === 'Pending').length, 0);

  const stats: RegisterStats[] = useMemo(() => kinds.map((kind) => {
    const d = described.get(kind.id)!;
    const amountField = amountFieldOf(d.fields);
    const dateField = dateFieldOf(d.fields, kind.rows);
    const dates = dateField ? (kind.rows.map((r) => dateField.get(r)).filter(Boolean) as string[]).sort() : [];
    const [from, to] = [dates[0], dates[dates.length - 1]].map((x) => (x ? formatWhen(x.slice(0, 10)) : ''));
    const status = d.status;
    const attention = status ? kind.rows.filter((r) => {
      const v = status.values.find((x) => x.key === valueKey(status, r));
      return v && (v.tone === 'danger' || v.tone === 'warn');
    }) : [];
    return {
      kind, title: titles.get(kind.id) ?? kind.label,
      signal: d.status ?? d.signals.find((f) => f !== d.criticality) ?? d.criticality,
      amount: amountField ? kind.rows.reduce((n, r) => n + (Number(amountField.get(r)) || 0), 0) : undefined,
      span: from ? (from === to ? from : `${from} – ${to}`) : undefined,
      demo: kind.rows.filter((r) => demoOrigin(r)).length, attention,
    };
    // `t`: the dates are worded in the chosen language
  }), [kinds, described, titles, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const demoTotal = stats.reduce((n, s) => n + s.demo, 0);
  const open = stats.reduce((n, s) => n + s.attention.length, 0);
  const lead = sources[0];
  const money = (n: number) => rupees(Math.round(n * 100) / 100);
  const headCount = manualHead ? 1 : heads.length;
  const pctOf = (a: number) => (total ? Math.round((a / total) * 100) : undefined);
  const holds = t('{title} holds {n} {records} in {k} {registers}', {
    title, n: total.toLocaleString(), records: total === 1 ? t('record') : t('records'),
    k: kinds.length, registers: kinds.length === 1 ? t('register') : t('registers'),
  });
  const person = (h: { name: string; role?: string | null }) => (h.role ? `${h.name} (${h.role})` : h.name);

  return (
    <div className="space-y-3">
      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard label={total === 1 ? t('Record') : t('Records')} value={total.toLocaleString()} tone="brand" icon="FileText" />
        <MetricCard label={kinds.length === 1 ? t('Register') : t('Registers')} value={kinds.length} tone="purple" icon="Layers" />
        <MetricCard label="Still open" value={open.toLocaleString()} tone="amber" icon="Clock" pct={pctOf(open)}
          foot={open ? t('open or pending, as the source reports it') : undefined} />
        <MetricCard label="Not confirmed yet" value={pending.toLocaleString()} tone="orange" icon="ShieldAlert" pct={pctOf(pending)} />
        {demoTotal > 0
          ? <MetricCard label="Demo-loaded" value={demoTotal.toLocaleString()} tone="gray" icon="Sparkles" pct={pctOf(demoTotal)} />
          : <MetricCard label={headCount === 1 ? t('Head named') : t('Heads named')} value={headCount} tone="green" icon="UserCheck" />}
      </div>

      {/* charts — what the department holds, and how each register stands */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Panel title={t('Records by register')} icon="PieChart" tone="purple">
          <Donut size={140} thickness={18} center={total.toLocaleString()} sub={total === 1 ? t('record') : t('records')}
            data={stats.map((s, i) => ({ label: t(s.title), value: s.kind.rows.length, color: accentAt(i).hex, onClick: () => go(s.kind.id) }))} />
        </Panel>
        <Panel title={t('How each register stands')} icon="Activity" tone="teal"
          subtitle={t('Each register’s own status or verdict values, as its source reports them.')}>
          <ul className="space-y-3">
            {stats.map((s, i) => (
              <li key={s.kind.id}>
                <div className="mb-1 flex items-center gap-2 text-[12.5px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accentAt(i).hex }} />
                  <button onClick={() => go(s.kind.id)} className="min-w-0 truncate font-semibold text-ink hover:text-brand-600">{t(s.title)}</button>
                  <span className="ml-auto shrink-0 tabular-nums text-muted">{s.kind.rows.length.toLocaleString()}</span>
                </div>
                {s.signal && s.signal.values.length > 0 ? (
                  <StackedBar height={10} legend={false}
                    data={s.signal.values.map((v) => ({ label: v.label, value: v.n, color: TONE_HEX[v.tone] }))} />
                ) : (
                  <p className="text-[11.5px] text-muted-2">{t('No status sent for this register.')}</p>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-2.5 text-[11px] text-muted">
            {(([['danger', tx('Needs attention')], ['high', tx('High')], ['warn', tx('Open or due')], ['ok', tx('Settled or in service')], ['neutral', tx('Other values')], ['muted', tx('Inactive or low')]] as const)
              .filter(([tone]) => stats.some((s) => s.signal?.values.some((v) => v.tone === tone)))
              .map(([tone, l]) => [l, TONE_HEX[tone]] as const)).map(([l, c]) => (
              <span key={l} className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c }} />{t(l)}</span>
            ))}
          </div>
        </Panel>
      </div>

      <section className="card space-y-2.5 p-4 text-[13.5px] leading-relaxed text-ink-2">
        <p>
          {manualHead ? t('{holds}, headed by {head}', { holds, head: person(manualHead) })
            : heads.length > 0 ? (
              <>{t('{holds}, headed by {head}', { holds, head: listText(t, heads.map(person)) })}
                {' '}<span className="text-muted">{t('— as the organisation chart names')}</span></>
            ) : holds}.
        </p>
        <ul className="space-y-1.5">
          {stats.map((s, i) => (
            <li key={s.kind.id} className="flex items-baseline gap-2">
              <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: accentAt(i).hex }} />
              <span>
                <button onClick={() => go(s.kind.id)} className="font-semibold text-brand-600 hover:underline">{t(s.title)}</button>
                {' — '}<b className="text-ink">{countOf(s.kind.label, s.kind.rows.length)}</b>
                {s.amount !== undefined && <> {t('worth {amount}', { amount: money(s.amount) })}</>}
                {s.signal && s.signal.values.length > 0 && (
                  <>: {listText(t, s.signal.values.slice(0, 5).map((v) => `${v.n.toLocaleString()} ${v.label.toLowerCase()}`))}</>
                )}
                {s.span && <span className="text-muted"> · {s.span}</span>}
                {s.demo > 0 && <span className="text-warning-600"> · {t('{n} demo-loaded', { n: s.demo })}</span>}
              </span>
            </li>
          ))}
        </ul>
        {lead && (
          <p className="text-[12.5px] text-muted">
            {lead.lastSyncAt
              ? t('Collected from {sources}, last on {when}', { sources: lead.label, when: formatWhen(lead.lastSyncAt) })
              : t('Collected from {sources}', { sources: lead.label })}
            {pending > 0 && <>. {pending === total
              ? t('None of it has been confirmed by anyone here yet')
              : t('{n} records have not been confirmed by anyone here yet', { n: pending.toLocaleString() })}</>}.
          </p>
        )}
      </section>

      <div className="grid gap-2.5 sm:grid-cols-[repeat(auto-fit,minmax(176px,1fr))]">
        {stats.map((s, i) => {
          const a = accentAt(i);
          return (
            <button key={s.kind.id} onClick={() => go(s.kind.id)} className={cn('card card-int flex flex-col overflow-hidden border-t-4 p-3.5 text-left', a.edge)}>
              <div className="flex items-start gap-2.5">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', a.tile)}>
                  <Icon name={registerIcon(s.kind.label, s.kind.domain)} className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1 text-[13px] font-semibold text-ink">{t(s.title)}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-2" />
              </div>
              <span className="mt-2 text-[24px] font-bold leading-none tabular-nums text-ink">{s.kind.rows.length.toLocaleString()}</span>
              {s.amount !== undefined && <span className="mt-1 text-[12.5px] font-semibold text-ink-2">{money(s.amount)}</span>}
              {s.signal && s.signal.values.length > 0 && (
                <StackedBar className="mt-2.5" height={6} legend={false}
                  data={s.signal.values.map((v) => ({ label: v.label, value: v.n, color: TONE_HEX[v.tone] }))} />
              )}
              {s.signal && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.signal.values.slice(0, 4).map((v) => (
                    <span key={v.key} className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE_CLASS[v.tone])}>
                      {v.label} {v.n.toLocaleString()}
                    </span>
                  ))}
                </div>
              )}
              <span className="mt-auto pt-2 text-[11.5px] text-muted">
                {s.span}
                {s.demo > 0 && <span className="text-warning-600">{s.span && ' · '}{t('{n} demo-loaded', { n: s.demo })}</span>}
              </span>
            </button>
          );
        })}
      </div>

      {open > 0 && (
        <Panel title={t('Still open · {n}', { n: open.toLocaleString() })} icon="Clock" tone="amber"
          subtitle={t('Records whose own status, as the source reports it, is open or pending.')} className="border-warning-500/40">
          <div className="space-y-3">
            {stats.filter((s) => s.attention.length).map((s) => (
              <div key={s.kind.id}>
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[12.5px] font-semibold text-ink">{t(s.title)}</span>
                  <span className="rounded-full bg-warning-50 px-2 py-0.5 text-[11px] font-semibold text-warning-600">{s.attention.length.toLocaleString()}</span>
                  <button onClick={() => go(s.kind.id)} className="ml-auto text-[12px] font-medium text-brand-600 hover:underline">
                    {t('Open the register')}
                  </button>
                </div>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {s.attention.slice(0, ATTENTION_PER_REGISTER).map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[12.5px]">
                      <span className="font-medium text-ink">{r.name}</span>
                      {typeof r.attrs?.department === 'string' && <span className="text-muted">{r.attrs.department}</span>}
                      <span className="ml-auto flex gap-1">
                        {r.criticality && <CodeBadge field="criticality" value={r.criticality} />}
                        <CodeBadge field="status" value={r.status} />
                      </span>
                    </li>
                  ))}
                  {s.attention.length > ATTENTION_PER_REGISTER && (
                    <li className="px-3 py-1.5 text-[12px] text-muted">
                      {t('and {n} more in the register', { n: (s.attention.length - ATTENTION_PER_REGISTER).toLocaleString() })}
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {demoTotal > 0 && (
        <section className="card flex flex-wrap items-center gap-x-4 gap-y-2 border-warning-500/40 bg-warning-50 p-3.5 text-[12.5px] text-warning-600">
          <span className="min-w-0 flex-1 basis-[420px]">
            {t('{n} of these records are samples the source’s own demo loader wrote, not entries from its registers. They are kept, and labelled Demo-loaded wherever they appear.', { n: demoTotal.toLocaleString() })}
          </span>
          {stats.filter((s) => s.demo).map((s) => (
            <button key={s.kind.id} onClick={() => go(s.kind.id, { origin: 'demo' })} className="font-medium underline">
              {t(s.title)}: {s.demo}
            </button>
          ))}
        </section>
      )}
    </div>
  );
}
