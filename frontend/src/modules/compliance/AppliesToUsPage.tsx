/**
 * What applies to us, and why.
 *
 * Every other screen starts from the regulation. This one starts from the
 * company: each fact we hold — the entity type on the profile, a licence in the
 * certificate register, the number of people on the payroll — and the
 * regulations that reach us BECAUSE of it.
 *
 * The grouping is the engine's own: applicability.evaluate() records which
 * family it matched and which fact established it, and GET /api/compliance/by-fact
 * groups the stored verdicts by that. Nothing is recomputed here, so a count on
 * this page and the reasoning on a regulation page can never disagree.
 */
import { useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { api } from '@/services/http';
import { SkeletonCards } from '@/components/ui/skeletons';
import { Tag } from '@/components/ui/primitives';
import { Fill } from '@/components/ui/premium';
import { cn, toneClass } from '@/utils/ui';
import { HueTile } from './ui';
import { HUES, hueFor, type Hue } from './uiKit';
import { tx, useT, type TFunction } from '@/i18n';

const duties = (t: TFunction, n: number) => (n === 1 ? t('1 duty') : t('{n} duties', { n: n.toLocaleString() }));

interface Example {
  id: string; title: string; regulator: string | null;
  verdict: string; requirements: number; impact: number | null;
}
interface Fact {
  fact: string; family: string | null;
  regulations: number; requirements: number; examples: Example[];
}
interface ByFact {
  company: string; regulations: number; requirements: number;
  facts: Fact[];
}

/** "licence \"Drug licence\"" reads better as a label than as a sentence fragment. */
function label(fact: string): { kind: string; value: string } {
  const m = /^([a-z ]+)\s+"(.+)"$/.exec(fact);
  if (m) return { kind: m[1], value: m[2] };
  return { kind: tx('from the company record'), value: fact };
}

/** What each kind of fact looks like: an icon and one hue, used on its card and in the charts. */
const FAMILY: Record<string, { icon: string; hue: Hue }> = {
  hospital: { icon: 'Hospital', hue: 'blue' },
  laboratory: { icon: 'Microscope', hue: 'teal' },
  pharmacy: { icon: 'Pill', hue: 'emerald' },
  'genetic clinic': { icon: 'Activity', hue: 'pink' },
  'waste generator': { icon: 'Recycle', hue: 'amber' },
  employer: { icon: 'Users', hue: 'violet' },
  'principal employer': { icon: 'Briefcase', hue: 'indigo' },
  'food business operator': { icon: 'Package', hue: 'orange' },
  'data fiduciary': { icon: 'Database', hue: 'indigo' },
  'building occupier': { icon: 'Building2', hue: 'sky' },
  occupier: { icon: 'Home', hue: 'sky' },
  'approved place': { icon: 'HeartPulse', hue: 'pink' },
  'blood centre': { icon: 'Droplets', hue: 'red' },
  practitioner: { icon: 'Stethoscope', hue: 'sky' },
  licensee: { icon: 'FileCheck', hue: 'amber' },
  radiation: { icon: 'Radar', hue: 'orange' },
};
function look(f: Fact): { icon: string; hue: Hue } {
  const fam = FAMILY[(f.family ?? '').toLowerCase()];
  if (fam) return fam;
  const { kind } = label(f.fact);
  if (/licen[cs]e|certificate|registration/i.test(kind)) return { icon: 'FileCheck', hue: hueFor(f.fact) };
  if (/head ?count|employ|staff|people/i.test(kind)) return { icon: 'Users', hue: hueFor(f.fact) };
  return { icon: 'BadgeCheck', hue: hueFor(f.fact) };
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function AppliesToUsPage() {
  const t = useT();
  const { data, isLoading } = useQuery<ByFact>({
    queryKey: ['applies-by-fact'],
    queryFn: () => api('/api/compliance/by-fact'),
    staleTime: 60_000,
  });
  // Facts start closed: open, this page runs to about 15,000 px.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (fact: string) => setOpen((o) => {
    const next = new Set(o);
    if (!next.delete(fact)) next.add(fact);
    return next;
  });
  const top = Math.max(1, ...(data?.facts ?? []).map((f) => f.regulations));

  return (
    <>
      <Topbar
        title="What applies to us"
        subtitle="Each fact about this company, and the regulations it brings on us"
        icon="BadgeCheck"
        tone={toneFor('reg-regulations')}
        hideSearch
      />

      <div className="w-full space-y-4 p-4 sm:p-6">
        {isLoading ? (
          <SkeletonCards count={4} lines={4} />
        ) : !data || data.facts.length === 0 ? (
          <div className="card px-6 py-12 text-center">
            <div className="mx-auto mb-3 w-fit"><HueTile icon="BadgeCheck" hue="blue" size="lg" /></div>
            <p className="text-[14px] font-semibold text-ink">{t('Nothing reaches this company yet')}</p>
            <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">
              {t('A regulation reaches us when what it addresses matches something we hold — an entity type, a licence, a headcount. Complete Company Setup and connect the certificate register, then run the applicability engine.')}
            </p>
            <Link className="btn btn-primary mt-4" to="/company-setup">{t('Company Setup')}</Link>
          </div>
        ) : (
          <>
            <p className="pm-insight text-[14px] leading-relaxed text-ink-2">
              <Fill text={t('{regs} regulations reach this hospital, with {duties} duties inside them. Each line below is one fact about us and the regulations it brings.')}
                vars={{ regs: <b className="tabular-nums text-ink">{data.regulations.toLocaleString()}</b>,
                        duties: <b className="tabular-nums text-ink">{data.requirements.toLocaleString()}</b> }} />
            </p>
            <div className="pm-stagger card divide-y divide-line overflow-hidden">
              {data.facts.map((f) => <FactRow key={f.fact} f={f} top={top} open={open.has(f.fact)} onToggle={() => toggle(f.fact)} />)}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** One line per fact; opened, the regulations it brings. */
function FactRow({ f, top, open, onToggle }: { f: Fact; top: number; open: boolean; onToggle: () => void }) {
  const t = useT();
  const { value } = label(f.fact);
  const { icon, hue } = look(f);
  const id = `fact-${slug(f.fact)}`;
  return (
    <div id={id} className="pm-row" style={{ '--pm-accent': HUES[hue].hex } as CSSProperties}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`${id}-details`}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50/70 sm:px-5">
        <HueTile icon={icon} hue={hue} size="sm" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink" title={value}>{value}</span>
        <span className="hidden h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-slate-100 md:block">
          <span className="pm-grow block h-full rounded-full" style={{ width: `${Math.max(3, (f.regulations / top) * 100)}%`, background: HUES[hue].hex }} />
        </span>
        <span className="w-28 shrink-0 text-right text-[12.5px] text-muted sm:w-48">
          <b className="tabular-nums text-ink">{f.regulations.toLocaleString()}</b> {t(f.regulations === 1 ? 'regulation' : 'regulations')}
          <span className="hidden sm:inline"> · {duties(t, f.requirements)}</span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div id={`${id}-details`} className="pm-open border-t border-line bg-slate-50/40">
          <ul className="pm-stagger divide-y divide-line">
            {f.examples.map((e) => (
              <li key={e.id}>
                <Link to={`/regulation/${e.id}`} className="flex items-center gap-3 py-2.5 pl-[60px] pr-4 hover:bg-brand-50/40 focus-visible:bg-brand-50/40 sm:pr-5">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink" title={e.title}>{e.title}</span>
                  {e.regulator && <span className="hidden shrink-0 sm:inline"><Tag tone="auto">{e.regulator}</Tag></span>}
                  {e.verdict === 'CONDITIONAL' && <span className={cn('pill shrink-0', toneClass('amber'))}>{t('Conditional')}</span>}
                  <span className="hidden w-20 shrink-0 text-right text-[12px] tabular-nums text-muted md:inline">{duties(t, e.requirements)}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
          {f.regulations > f.examples.length && (
            <div className="border-t border-line py-2.5 pl-[60px] pr-4 text-xs text-muted">
              {t('and {n} more —', { n: (f.regulations - f.examples.length).toLocaleString() })}{' '}
              <Link to="/reg-regulations?applicability=APPLICABLE%2CCONDITIONAL" className="font-medium text-brand-600 hover:underline">
                {t('see them on the Regulations screen')}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
