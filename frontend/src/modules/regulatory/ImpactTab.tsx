/**
 * How this regulation reaches this company — the detail behind the band.
 *
 * "Critical" on its own is an assertion. The same word beside
 * `processes 10 × 5 = 50` is a calculation a compliance officer can check,
 * disagree with, and defend to an auditor. impact.py stores every factor next
 * to the score for exactly that reason, and this is where they are shown.
 *
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 * --------------------------------
 * · The cap is disclosed. When the terms sum past 100 the score stops there,
 *   so two regulations both reading 100 are not necessarily comparable, and
 *   the page says so rather than presenting a saturated number as a ranking.
 * · Matching is keyword-based. Every affected entity shows the clause that
 *   matched it and its confidence, so a wrong match is visible rather than
 *   hidden behind a total.
 * · This is a FOOTPRINT — which entities the regulation touches. It is not
 *   driven by a detected change, and the page does not imply otherwise.
 *
 * Sources: the impact graph (/api/regulations/:id/impact) for the score,
 * its terms and the matched records; /api/reg-overview for the stored impact
 * factors and departments; the gap assessment (/api/cascade/*) for the risk
 * bands of unmet requirements, the register risks and the cascade counts.
 */
import { useMemo, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUi } from '@/app/store/ui';
import { ChevronDown, Info, UserX, GitBranch } from 'lucide-react';
import { useImpactGraph, type ImpactApiNode } from '@/services/regImpactApi';
import { useRegulationApplicability } from '@/services/regulationsApi';
import { cn, readable } from '@/utils/ui';
import { useDateLocale, useT } from '@/i18n';
import { Avatar, EmptyState, Skeleton } from '@/components/ui/primitives';
import { ScoreRing, Progress } from '@/components/ui/charts';
import { CountUp } from '@/components/ui/motion';
import { Icon } from '@/config/icons';
import './regDetail.css';
import {
  useRegOverview, useGapAssessment, useCascadeGraph, useLinkResolver, flattenGap,
  UNMET, RISK_ORDER, riskKey, RiskPill, Tile, fmtDay, type GoTab, type GapRow,
} from './regShared';

/** First letter up, the rest as written — "most critical entity is high" → "Most critical entity is high". */
const sentence = (v: string) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);

const DOMAIN_UI: Record<string, { label: string; icon: string; cls: string }> = {
  policies: { label: 'Policies', icon: 'FileText', cls: 'bg-brand-50 text-brand-600' },
  processes: { label: 'Processes', icon: 'Workflow', cls: 'bg-violet-50 text-violet-600' },
  people: { label: 'People', icon: 'Users', cls: 'bg-teal-50 text-teal-600' },
  systems: { label: 'Systems', icon: 'Server', cls: 'bg-amber-50 text-amber-600' },
  data: { label: 'Data registers', icon: 'Database', cls: 'bg-pink-50 text-pink-600' },
  evidence: { label: 'Evidence', icon: 'Paperclip', cls: 'bg-emerald-50 text-emerald-600' },
  risks: { label: 'Risks', icon: 'AlertTriangle', cls: 'bg-indigo-50 text-indigo-600' },
  controls: { label: 'Controls', icon: 'ShieldCheck', cls: 'bg-sky-50 text-sky-600' },
  departments: { label: 'Departments', icon: 'Building2', cls: 'bg-slate-100 text-slate-600' },
};
const DOMAIN_ORDER = ['policies', 'processes', 'people', 'systems', 'data', 'evidence', 'risks', 'controls', 'departments'];
const domainUi = (d: string) => DOMAIN_UI[d] ?? { label: sentence(d), icon: 'LayoutGrid', cls: 'bg-slate-100 text-slate-600' };

const LEVEL_TONE: Record<string, { text: string; bar: string }> = {
  Critical: { text: 'text-critical-600', bar: 'bg-critical-500' },
  // Risk hues: High orange, Medium amber, Low slate — the same everywhere.
  High: { text: 'text-notcov-600', bar: 'bg-notcov-500' },
  Medium: { text: 'text-warning-600', bar: 'bg-warning-500' },
  Low: { text: 'text-slate-600', bar: 'bg-slate-400' },
};
/** The band the score sits in, filled in its risk colour. */
const BAND_ON: Record<string, string> = {
  Critical: 'bg-critical-500 text-white', High: 'bg-notcov-500 text-white', Medium: 'bg-warning-500 text-white', Low: 'bg-slate-500 text-white',
};
/** A factor (0–10) coloured by the band it would fall in — the same 80/55/30 edges as the score. */
const factorHex = (v: number) => (v >= 8 ? '#dc2626' : v >= 5.5 ? '#f97316' : v >= 3 ? '#f59e0b' : '#94a3b8');

export function ImpactTab({ id }: { id: string; go?: GoTab }) {
  const t = useT();
  const locale = useDateLocale();
  const navigate = useNavigate();
  const { data, isLoading } = useImpactGraph(id);
  const { data: ov } = useRegOverview(id);
  const { data: app } = useRegulationApplicability(id);
  const gap = useGapAssessment(id);
  const rows = useMemo(() => flattenGap(gap.data), [gap.data]);
  const graph = useCascadeGraph(rows.length > 0);
  const resolve = useLinkResolver(graph.data);
  const company = (app?.evaluation.company as { legalName?: string } | undefined)?.legalName ?? t('our hospital');

  const unmet = useMemo(() => rows.filter((r) => UNMET.has(r.st)), [rows]);

  if (isLoading || gap.isLoading) return <div className="card"><Skeleton rows={8} /></div>;

  const s = data?.score ?? null;
  const score100 = s?.score ?? ov?.impact.score ?? null;
  const level = s?.level ?? ov?.impact.level ?? null;
  const tone = LEVEL_TONE[level ?? ''] ?? LEVEL_TONE.Low;
  const factors = ov?.impact.factors ?? [];
  const byDomain = data?.byDomain ?? {};

  // risk bands — from the assessed rows when present, else the overview totals

  return (
    <div className="space-y-4">
      {/* ---------------- heading ---------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold tracking-tight text-ink">{t('Impact on {company}', { company })}</h2>
          <p className="mt-0.5 text-[13px] text-muted">{t('How hard this regulation lands, which records it touches, and where the unmet duties sit.')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-right text-xs leading-tight text-muted">{t('As per hospital profile')}<br />{s?.computedAt ? t('Scored {date}', { date: fmtDay(s.computedAt, locale) }) : t('Stored score')}</span>
          <button className="btn" onClick={() => navigate(`/cascade?reg=${encodeURIComponent(id)}`)}><GitBranch className="h-4 w-4" /> {t('Open impact cascade')}</button>
        </div>
      </div>

      {/* ---------------- row 1: score · key risks ---------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card rd-rise rd-card group p-5">
          <h3 className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
            <span className="rd-ic grid h-8 w-8 place-items-center rounded-xl bg-notcov-50 text-notcov-500"><Icon name="Gauge" className="h-4 w-4" /></span>{t('Impact score')}
          </h3>
          {score100 == null ? (
            <EmptyState title={t('This regulation has not been scored')} icon="Gauge"
                        hint={t('A score is computed only where obligations have been extracted and matched to company records. Nothing is estimated in its place.')} />
          ) : (<>
            <div className="mt-3 flex flex-wrap items-center gap-5">
              <ScoreRing value={score100} max={100} size={140} thickness={14} invert
                         label={String(Math.round(score100))} sub={<span className={tone.text}>{level ? t('{level} impact', { level: t(level) }) : t('Scored')}</span>} />
              <div className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink-2">
                <p>{s?.applicabilityMultiplier && s.applicabilityMultiplier !== 1
                  ? t('Scored {score}/100 from the records and duties this regulation touches, × {m} because it applies to us.', { score: score100, m: s.applicabilityMultiplier })
                  : t('Scored {score}/100 from the records and duties this regulation touches.', { score: score100 })}</p>
                {s?.bands && (
                  <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                    {s.bands.slice().reverse().map((b) => (
                      <span key={b.level} className={cn('pill', b.level === level ? BAND_ON[b.level] ?? 'bg-slate-500 text-white' : 'bg-slate-100 text-slate-600')}>{t(b.level)} {b.from}+</span>
                    ))}
                  </p>
                )}
              </div>
            </div>
            {factors.length > 0 && (
              <ul className="mt-5 space-y-2.5">
                {factors.map((f, i) => (
                  <li key={f.label} title={f.note ?? undefined} className="rd-rise grid grid-cols-[minmax(0,130px)_1fr_36px] items-center gap-3 text-[13px]" style={{ '--d': `${200 + i * 70}ms` } as CSSProperties}>
                    <span className="truncate text-ink-2">{f.label}</span>
                    <span className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <span className="rd-grow block h-full rounded-full" style={{ width: `${Math.max(2, f.score * 10)}%`, background: factorHex(f.score), '--d': `${260 + i * 70}ms` } as CSSProperties} />
                    </span>
                    <span className="text-right font-semibold tabular-nums text-ink">{f.score.toFixed(1)}</span>
                  </li>
                ))}
              </ul>
            )}
            {s?.cappedAt100 && (
              <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning-50 px-3 py-2 text-xs text-warning-700">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t('The factors total {n}, which the scale caps at 100 — read the breakdown below rather than the number.', { n: s.subtotal })}</span>
              </p>
            )}
          </>)}
        </div>

        <KeyRisks rows={unmet} graph={graph.data} resolve={resolve} penalties={data?.penalties} />
      </div>

      {/* ---------------- row 3: key records affected ---------------- */}
      {data && (
        <div className="card rd-rise p-5" style={{ '--d': '140ms' } as CSSProperties}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
              <span className="grid h-8 w-8 place-items-center rounded-xl bg-violet-50 text-violet-600"><Icon name="Network" className="h-4 w-4" /></span>{t('Key records affected')}
            </h3>
            <span className="text-xs text-muted">{t('{n} company records matched across {domains} domains · {direct} direct', {
              n: data.totals.entities.toLocaleString(), domains: Object.keys(byDomain).length.toLocaleString(), direct: data.totals.direct.toLocaleString(),
            })}</span>
          </div>
          {/* only the kinds of record that were matched; the line above already says how many kinds there are */}
          {Object.values(byDomain).every((n) => !n) && <p className="text-[13px] text-muted">{t('none matched')}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {DOMAIN_ORDER.filter((d) => (byDomain[d] ?? 0) > 0)
              .map((d, i) => {
                const u = domainUi(d);
                const nodes = (data.nodes ?? []).filter((n) => n.domain === d);
                const direct = nodes.filter((n) => n.impactType === 'Direct').length;
                return (
                  <div key={d} className="rd-rise rd-card group flex items-center gap-3 rounded-2xl border border-line bg-white p-3" style={{ '--d': `${200 + i * 70}ms` } as CSSProperties}>
                    <span className="rd-ic"><Tile icon={u.icon} cls={u.cls} /></span>
                    <div className="min-w-0">
                      <CountUp value={byDomain[d] ?? 0} className="num block text-xl font-bold leading-none tabular-nums text-ink" />
                      <div className="mt-1 truncate text-[12.5px] font-medium text-ink-2">{t(u.label)}</div>
                      <div className="truncate text-[11.5px] text-muted">{t('impacted · {n} direct', { n: direct.toLocaleString() })}</div>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ---------------- how the score was reached ---------------- */}
      {s && <ScoreBreakdown s={s} />}

      {/* ---------------- what is affected ---------------- */}
      {data && data.nodes.length > 0 && <AffectedRecords nodes={data.nodes} />}

      {data && (
        <p className="px-1 text-xs leading-relaxed text-muted">
          {data.note} {t('This is a footprint — which company records this regulation touches. It is not driven by a detected change; see the Updates tab for what actually moved.')}
        </p>
      )}
    </div>
  );
}

/* ---------------- key risks ---------------- */
type Resolver = ReturnType<typeof useLinkResolver>;
type Penalties = NonNullable<ReturnType<typeof useImpactGraph>['data']>['penalties'];
const RISK_ICONS = ['Siren', 'HeartPulse', 'ShieldAlert', 'Flame', 'AlertTriangle'];
const RISK_EDGE: Record<string, string> = { Critical: '#ff3b30', High: '#ff6a00', Medium: '#ff9f0a', Low: '#c7c7cc' };
const RISK_TILE: Record<string, string> = {
  Critical: 'bg-critical-50 text-critical-500', High: 'bg-notcov-50 text-notcov-500',
  Medium: 'bg-warning-50 text-warning-500', Low: 'bg-slate-100 text-slate-500', None: 'bg-slate-100 text-slate-500',
};

function KeyRisks({ rows, graph, resolve, penalties }: { rows: GapRow[]; graph?: ReturnType<typeof useCascadeGraph>['data']; resolve: Resolver; penalties?: Penalties }) {
  const t = useT();
  const items = useMemo(() => {
    const reg = graph?.risks ?? {};
    const m = new Map<string, { n: number; worst: string }>();
    rows.forEach((r) => resolve(r).risks.forEach((code) => {
      if (!reg[code]) return;
      const cur = m.get(code) ?? { n: 0, worst: 'None' };
      const k = riskKey(r.rk);
      m.set(code, { n: cur.n + 1, worst: RISK_ORDER[k] < RISK_ORDER[cur.worst] ? k : cur.worst });
    }));
    const fromRegister = [...m.entries()].sort((a, b) => RISK_ORDER[a[1].worst] - RISK_ORDER[b[1].worst] || b[1].n - a[1].n).slice(0, 5)
      .map(([code, v]) => ({ key: code, title: reg[code].t, sub: `${code} · ${v.n === 1 ? t('1 unmet requirement') : t('{n} unmet requirements', { n: v.n.toLocaleString() })}${reg[code].o ? ` · ${t('owner {name}', { name: reg[code].o })}` : ''}`, risk: v.worst }));
    if (fromRegister.length) return { kind: 'register' as const, list: fromRegister };
    // no register link: the consequences the assessment wrote for the worst unmet duties
    const seen = new Set<string>();
    const list = [...rows].filter((r) => r.why).sort((a, b) => RISK_ORDER[riskKey(a.rk)] - RISK_ORDER[riskKey(b.rk)])
      .filter((r) => (seen.has(r.why) ? false : (seen.add(r.why), true))).slice(0, 5)
      .map((r) => ({ key: r.key, title: r.ob || r.t, sub: r.why, risk: riskKey(r.rk) }));
    return { kind: 'consequence' as const, list };
  }, [rows, graph, resolve, t]);
  const p = penalties?.summary;
  const penaltyLine = p ? [p.maxFixedFmt && t('fine up to {amount}', { amount: p.maxFixedFmt }), p.maxPerDayFmt && t('{amount} per day', { amount: p.maxPerDayFmt }),
    p.maxImprisonmentMonths && t('imprisonment up to {n} months', { n: p.maxImprisonmentMonths }), p.suspension && t('suspension or cancellation')].filter(Boolean).join(' · ') : '';

  return (
    <div className="card rd-rise rd-card group p-5" style={{ '--d': '70ms' } as CSSProperties}>
      <h3 className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
        <span className="rd-ic grid h-8 w-8 place-items-center rounded-xl bg-critical-50 text-critical-500"><Icon name="ShieldAlert" className="h-4 w-4" /></span>{t('Key risks if not complied')}
      </h3>
      <p className="mt-0.5 text-xs text-muted">{items.kind === 'register' ? t('Register risks behind the unmet requirements, worst first.') : t('What the assessment says failure costs, worst first.')}</p>
      {items.list.length || penaltyLine ? (
        <ul className="mt-3 space-y-2.5">
          {penaltyLine && (
            <li className="flex items-start gap-3">
              <Tile icon="Gavel" cls="bg-critical-50 text-critical-500" />
              <span className="min-w-0 flex-1 leading-snug">
                <span className="block text-[13px] font-semibold text-ink">{t('Penalty exposure stated in the text')}</span>
                <span className="line-clamp-2 block text-xs text-muted">{sentence(penaltyLine)}</span>
              </span>
            </li>
          )}
          {items.list.map((x, i) => (
            <li key={x.key} className="rd-rise rd-row flex items-start gap-3 rounded-xl px-2 py-1.5"
                style={{ '--d': `${200 + i * 80}ms`, boxShadow: `inset 3px 0 0 ${RISK_EDGE[x.risk] ?? 'transparent'}` } as CSSProperties}>
              <Tile icon={RISK_ICONS[i % RISK_ICONS.length]} cls={RISK_TILE[x.risk]} />
              <span className="min-w-0 flex-1 leading-snug">
                <span className="line-clamp-1 block text-[13px] font-semibold text-ink" title={x.title}>{x.title}</span>
                <span className="line-clamp-2 block text-xs text-muted">{x.sub}</span>
              </span>
              <RiskPill risk={x.risk} />
            </li>
          ))}
        </ul>
      ) : <EmptyState title={t('No unmet requirement carries a risk')} icon="ShieldCheck" />}
    </div>
  );
}

/* ---------------- score breakdown ---------------- */
type Score = NonNullable<NonNullable<ReturnType<typeof useImpactGraph>['data']>['score']>;
function ScoreBreakdown({ s }: { s: Score }) {
  // `t` below is each score term, so the translate function is `tr` here
  const tr = useT();
  const tone = LEVEL_TONE[s.level] ?? LEVEL_TONE.Low;
  const maxPoints = Math.max(...s.terms.map((t) => t.points), 1);
  return (
    <details className="card group overflow-hidden">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 hover:bg-slate-50/60 group-open:border-b group-open:border-line [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            {tr('How this score was reached')}
            <ChevronDown className="h-4 w-4 text-muted transition-transform group-open:rotate-180" />
          </h3>
          <p className="mt-0.5 max-w-3xl text-xs text-muted">
            {tr('Every term is stored with the score. Counts are capped at 5 per domain and 15 for obligations, so one broad regulation cannot saturate the scale on volume alone.')}
          </p>
        </div>
        {/* Where the score sits on the scale, with the band edges at the real thresholds. */}
        <div className="w-full min-w-[220px] sm:w-72">
          <div className="relative h-2 overflow-hidden rounded-full bg-gradient-to-r from-slate-200 via-amber-200 to-red-200">
            <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${s.score}%` }} />
          </div>
          <div className="relative mt-1.5 h-4 text-[11px] text-muted">
            {s.bands.slice().reverse().map((b) => (
              <span key={b.level} className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0" style={{ left: `${Math.min(b.from, 96)}%` }}>
                <span className="mr-1 inline-block h-1.5 w-px bg-line-2 align-middle" />{tr(b.level)} {b.from}+
              </span>
            ))}
          </div>
        </div>
      </summary>
      {s.cappedAt100 && (
        <div className="flex items-start gap-2 border-b border-line bg-warning-50 px-5 py-2.5 text-[12px] text-warning-700">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {s.applicabilityMultiplier !== 1
              ? tr('The factors below total {n} × {m} for applicability, which the scale caps at 100. Two regulations both reading 100 are not necessarily comparable — read the breakdown rather than the number.', { n: s.subtotal, m: s.applicabilityMultiplier })
              : tr('The factors below total {n}, which the scale caps at 100. Two regulations both reading 100 are not necessarily comparable — read the breakdown rather than the number.', { n: s.subtotal })}
          </span>
        </div>
      )}
      <ul className="divide-y divide-line">
        {s.terms.map((t, i) => {
          const u = t.kind === 'domain' ? domainUi(t.label) : t.kind === 'obligations'
            ? { label: 'Obligations', icon: 'ClipboardList', cls: 'bg-violet-50 text-violet-600' }
            : { label: sentence(t.label), icon: 'Flame', cls: 'bg-critical-50 text-critical-500' };
          return (
            <li key={`${t.label}-${i}`} className="flex items-center gap-3 px-5 py-2">
              <Tile icon={u.icon} cls={u.cls} size="sm" />
              <span className="w-36 shrink-0 truncate text-[12.5px] text-ink-2" title={tr(u.label)}>{tr(u.label)}</span>
              <span className="w-40 shrink-0 text-xs tabular-nums text-muted">
                {t.kind === 'criticality' ? tr('Criticality bonus')
                  : <>{t.count}{t.capped && <span className="text-warning-600"> → {t.counted}</span>}{' × '}{t.weight}</>}
              </span>
              <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.max(2, (t.points / maxPoints) * 100)}%` }} />
              </span>
              <span className="w-10 shrink-0 text-right text-[13px] font-semibold tabular-nums text-ink">{t.points}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between border-t border-line bg-canvas px-5 py-2.5 text-[12.5px]">
        <span className="text-muted">
          {s.applicabilityMultiplier !== 1
            ? tr('Sum {n} × {m} (applies to this company)', { n: s.subtotal, m: s.applicabilityMultiplier })
            : tr('Sum {n}', { n: s.subtotal })}
          {s.cappedAt100 && ` · ${tr('capped')}`}
        </span>
        <span className={cn('font-semibold tabular-nums', tone.text)}>{s.score} · {tr(s.level)}</span>
      </div>
    </details>
  );
}

/* ---------------- matched records ---------------- */
function AffectedRecords({ nodes }: { nodes: ImpactApiNode[] }) {
  const t = useT();
  const openEntity = useUi((st) => st.openEntity);
  const [open, setOpen] = useState<string | null>(null);
  // keyword matches below 90% are mostly the same words turning up elsewhere — listed only on request
  const [all, setAll] = useState(false);
  const strong = nodes.filter((n) => n.confidence >= 0.9);
  const shown = all || strong.length === 0 ? nodes : strong;
  const byDomain = useMemo(() => {
    const m = new Map<string, ImpactApiNode[]>();
    shown.forEach((n) => { const list = m.get(n.domain) ?? []; list.push(n); m.set(n.domain, list); });
    // Most-affected domain first; within it, the strongest match first.
    return [...m.entries()].map(([d, list]) => [d, [...list].sort((a, b) => b.confidence - a.confidence)] as const)
      .sort((a, b) => b[1].length - a[1].length);
  }, [shown]);
  const unowned = nodes.filter((n) => !n.owner);

  return (
    <section className="card overflow-hidden">
      <header className="border-b border-line px-5 py-3">
        <h3 className="text-[15px] font-semibold text-ink">{t('What is affected')}</h3>
        <p className="mt-0.5 text-xs text-muted">
          {t("Company records this regulation's obligations matched, strongest match first. Open a record to see the clause that matched it — matching is keyword-based, so the evidence is shown rather than assumed.")}
        </p>
      </header>
      {unowned.length > 0 && (
        <div className="flex items-start gap-2 border-b border-line bg-warning-50 px-5 py-2.5 text-[12px] text-warning-700">
          <UserX className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <b>{unowned.length === 1 ? t('1 affected record has no owner') : t('{n} affected records have no owner', { n: unowned.length.toLocaleString() })}</b> —
            {' '}{unowned.length > 3
              ? t('{names} and {n} more', { names: unowned.slice(0, 3).map((n) => n.name).join(', '), n: (unowned.length - 3).toLocaleString() })
              : unowned.slice(0, 3).map((n) => n.name).join(', ')}. {t('There is nobody to route this to.')}
          </span>
        </div>
      )}
      <div className="divide-y divide-line">
        {byDomain.map(([domain, list]) => {
          const u = domainUi(domain);
          return (
            <div key={domain}>
              <div className="flex items-center gap-2 bg-canvas px-5 py-1.5">
                <Tile icon={u.icon} cls={u.cls} size="sm" />
                <span className="text-xs font-semibold text-ink-2">{t(u.label)}</span>
                <span className="pill bg-white px-2 py-0.5 text-[11px] tabular-nums text-muted">{list.length}</span>
              </div>
              <ul className="divide-y divide-line">
                {list.map((nd) => {
                  const isOpen = open === nd.id;
                  return (
                    <li key={nd.id}>
                      <button type="button" onClick={() => setOpen(isOpen ? null : nd.id)} aria-expanded={isOpen}
                              className="flex w-full items-center gap-3 px-5 py-2.5 text-left transition hover:bg-canvas">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{nd.name}</span>
                          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
                            <span>{nd.type || domain}</span>
                            {nd.criticality && <RiskPill risk={nd.criticality} />}
                            <span className={cn('pill px-2 py-0.5 text-[11px]', nd.impactType === 'Direct' ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-600')}>{nd.impactType}</span>
                            {nd.owner
                              ? <span className="inline-flex items-center gap-1"><Avatar name={nd.owner} size={18} /><b className="font-medium text-ink-2">{nd.owner}</b></span>
                              : <span className="text-warning-600">{t('No owner')}</span>}
                            <span>{nd.obligations.length === 1 ? t('1 matching clause') : t('{n} matching clauses', { n: nd.obligations.length.toLocaleString() })}</span>
                          </span>
                        </span>
                        <span className="hidden w-28 shrink-0 sm:block"><Progress value={Math.round(nd.confidence * 100)} total={100} color="#14b8a6" /></span>
                        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition', isOpen && 'rotate-180')} />
                      </button>
                      {isOpen && (
                        <div className="border-t border-line bg-canvas px-5 py-3">
                          <div className="sec-eyebrow mb-1.5">{t('Clauses that matched this record')}</div>
                          <ul className="space-y-1.5">
                            {nd.obligations.slice(0, 8).map((o) => (
                              <li key={o.id} className="text-[12.5px] leading-snug text-ink-2">
                                <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{readable(o.type || 'OBLIGATION')}</span>
                                {o.title || o.id}
                              </li>
                            ))}
                          </ul>
                          {nd.obligations.length > 8 && <p className="mt-1.5 text-xs text-muted">{t('And {n} more', { n: (nd.obligations.length - 8).toLocaleString() })}</p>}
                          {nd.reason && <p className="mt-1.5 text-xs text-muted">{t('Why')}: {nd.reason}</p>}
                          {nd.entityId && (
                            <button onClick={() => nd.entityId && openEntity(nd.entityId)} className="mt-2.5 text-xs font-medium text-brand-600 hover:underline">
                              {t('Open this record')} →
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {strong.length > 0 && strong.length < nodes.length && (
        <div className="border-t border-line px-5 py-3 text-center">
          <button type="button" className="btn btn-sm" onClick={() => setAll((v) => !v)}>
            {all ? t('Show only strong matches ({n})', { n: strong.length.toLocaleString() })
              : t('Show all {n} matches, including weaker keyword matches', { n: nodes.length.toLocaleString() })}
          </button>
        </div>
      )}
    </section>
  );
}

