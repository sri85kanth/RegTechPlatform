import type { ReactNode } from 'react';
import type { FiledRecord } from '@/services/structureApi';
import { IconTile, type MetricTone } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import {
  demoOrigin, humanise, isDetailKey, showValue, toneOf, TONE_BAR, TONE_CLASS, formatWhen, type FieldInfo, type Tone,
} from './model';

/** A value's tone as a KPI / icon-tile tone. */
const METRIC_TONE: Record<Tone, MetricTone> = {
  danger: 'red', high: 'orange', warn: 'amber', ok: 'green', neutral: 'brand', muted: 'gray',
};
const TONE_ICON: Record<Tone, string> = {
  danger: 'AlertTriangle', high: 'Flame', warn: 'Clock', ok: 'CheckCircle2', neutral: 'BarChart3', muted: 'MinusCircle',
};
const TONE_TEXT: Record<Tone, string> = {
  danger: 'text-critical-600', high: 'text-notcov-600', warn: 'text-warning-600', ok: 'text-success-600', neutral: 'text-brand-700', muted: 'text-slate-500',
};

export function ValueBadge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title}
      className={cn('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', TONE_CLASS[tone])}>
      {children}
    </span>
  );
}

/** A status or criticality value, coloured by what it says. */
export function CodeBadge({ field, value }: { field: string; value?: string | null }) {
  if (!value) return <span className="text-muted-2">—</span>;
  return <ValueBadge tone={toneOf(value)} title={value}>{showValue(field, value)}</ValueBadge>;
}

export function Panel({ title, subtitle, action, children, className, icon, tone = 'brand' }: {
  title: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string;
  /** icon-registry name drawn as a tinted tile beside the title */
  icon?: string; tone?: MetricTone;
}) {
  return (
    <section className={cn('card p-4', className)}>
      <div className="mb-3 flex items-start gap-2.5">
        {icon && <IconTile icon={icon} tone={tone} size="sm" />}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-muted">{subtitle}</p>}
        </div>
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {children}
    </section>
  );
}

export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="whitespace-nowrap text-[12px] font-medium text-brand-600 hover:underline">
      {children}
    </button>
  );
}

export function BarRow({ label, n, of, tone = 'neutral', onClick, hint, color }: {
  label: ReactNode; n: number; of: number; tone?: Tone; onClick?: () => void; hint?: string;
  /** a categorical colour (hex) in place of the tone's — for groups that carry no verdict */
  color?: string;
}) {
  const pct = of ? Math.round((n / of) * 100) : 0;
  const body = (
    <>
      <div className="flex items-baseline gap-2 text-[12.5px]">
        {color && <span className="h-2 w-2 shrink-0 self-center rounded-full" style={{ background: color }} />}
        <span className="min-w-0 truncate text-ink-2" title={hint}>{label}</span>
        <span className="ml-auto shrink-0 font-semibold text-ink">{n.toLocaleString()}</span>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted">{pct}%</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
        <div className={cn('h-full rounded-full transition-[width] duration-700', !color && TONE_BAR[tone])}
          style={{ width: `${Math.max(pct, n ? 2 : 0)}%`, background: color }} />
      </div>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className="block w-full rounded-md px-1.5 py-1 text-left transition hover:bg-slate-50">{body}</button>
  ) : <div className="px-1.5 py-1">{body}</div>;
}

/** A KPI tile: tinted icon by tone, the figure, its label, and its share of `of`. */
export function StatTile({ label, n, tone = 'neutral', onClick, hint, of, icon }: {
  label: string; n: number; tone?: Tone; onClick?: () => void; hint?: string;
  /** the whole this is a share of — shows a coloured percentage */
  of?: number; icon?: string;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} title={hint}
      className={cn('card flex min-h-[88px] items-center gap-3 px-4 py-3 text-left', onClick && 'card-int')}>
      <IconTile icon={icon ?? TONE_ICON[tone]} tone={METRIC_TONE[tone]} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block text-[22px] font-bold leading-tight tracking-tight tabular-nums text-ink">{n.toLocaleString()}</span>
        <span className="line-clamp-2 block text-[12.5px] leading-4 text-ink-2">{label}</span>
        {of !== undefined && of > 0 && (
          <span className={cn('mt-0.5 block text-xs font-semibold tabular-nums', TONE_TEXT[tone])}>{Math.round((n / of) * 100)}%</span>
        )}
      </span>
    </Tag>
  );
}

/** "Created by a demo loader", beside a record the source itself marked so. */
export function DemoBadge({ r }: { r: FiledRecord }) {
  const t = useT();
  const origin = demoOrigin(r);
  if (!origin) return null;
  return (
    <span title={t('The source marks this record: “{origin}” — not imported from its register', { origin })}
      className="rounded bg-warning-50 px-1.5 py-px text-[11px] font-semibold text-warning-600">
      {t('Demo-loaded')}
    </span>
  );
}

/**
 * Everything the source sent about one record, readable, and where it came from.
 * The raw value stays one hover away wherever it was reworded.
 *
 * Given its register's fields, it lists them in the source's order under the
 * source's names; otherwise alphabetically.
 */
export function Details({ r, caveats = {}, fields }: {
  r: FiledRecord; caveats?: Record<string, string>; fields?: FieldInfo[];
}) {
  const t = useT();
  const attrs = r.attrs ?? {};
  const rows: [string, string, unknown][] = [];
  if (fields) {
    for (const f of fields) {
      const v = f.key === 'name' ? undefined : f.get(r);
      if (v !== undefined) rows.push([f.key.replace(/^attr\./, ''), f.label, v]);
    }
  } else {
    if (r.status) rows.push(['status', tx('Status'), r.status]);
    if (r.criticality) rows.push(['criticality', tx('Criticality'), r.criticality]);
    if (r.description) rows.push(['description', tx('Description'), r.description]);
    for (const [k, v] of Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b))) {
      if (isDetailKey(k) && v !== '' && v != null) rows.push([k, humanise(k), v]);
    }
  }
  const evidence = Array.isArray(attrs.evidence) ? (attrs.evidence as { file?: string; phrase?: string }[]) : [];

  const origin = demoOrigin(r);
  const notes = Object.entries(caveats).filter(([k]) => attrs[k.replace(/^attr\./, '')] != null);
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      {origin && (
        <p className="mb-2.5 rounded-md bg-warning-50 px-2.5 py-1.5 text-[12px] text-warning-600">
          {t('The source marks this record as “{origin}” — created by its demo loader, not imported from its register.', { origin })}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">{t('The source sent nothing about this record beyond its name.')}</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(130px,max-content)_1fr]">
          {rows.map(([k, label, v]) => {
            const shown = showValue(k, v);
            const raw = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return (
              <div key={k} className="contents">
                <dt className="text-[11.5px] font-medium text-muted">{t(label)}</dt>
                <dd className="min-w-0 break-words text-[12.5px] text-ink" title={shown !== raw ? t('As sent: {raw}', { raw }) : undefined}>
                  {k === 'status' || k === 'criticality' ? <CodeBadge field={k} value={String(v)} /> : shown}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      <div className="mt-3 border-t border-line pt-2 text-[11.5px] leading-relaxed text-muted">
        <span className="font-semibold text-ink-2">{t('Where this came from')}</span>
        {' · '}{r.source === 'integration:http_csv' ? t('API endpoint') : r.source === 'integration:folder' ? t('Folder') : r.source ?? t('unknown')}
        {r.source_reference ? <> · {t('reference')} <span className="text-ink-2">{r.source_reference}</span></> : null}
        {r.updated_at ? <> · {t('last collected {when}', { when: formatWhen(r.updated_at) })}</> : null}
        {r.verification === 'Pending' && <> · <span className="text-warning-600">{t('not confirmed by anyone yet')}</span></>}
        {notes.map(([k, v]) => (
          <p key={k} className="mt-1 text-warning-600"><b>{t(humanise(k.replace(/^attr\./, '')))}:</b> {v}</p>
        ))}
        {evidence.slice(0, 3).map((e, i) => (
          <p key={i} className="mt-1 truncate">
            <span className="text-ink-2">{e.file}</span>{e.phrase ? <> — “{e.phrase}”</> : null}
          </p>
        ))}
      </div>
    </div>
  );
}
