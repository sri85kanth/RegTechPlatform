/**
 * The landing dashboard: what changed, who it reaches, and what is missing.
 *
 * Every figure is a COUNT over rows in company_brain, served by
 * GET /api/dashboard. Nothing here is seeded, defaulted or illustrative — if a
 * number is zero it is because the database holds zero.
 *
 * THREE THINGS THIS REFUSES TO BLUR
 * ---------------------------------
 * 1. A change DETECTED by comparing two captured versions is not an amendment
 *    MENTIONED in a document's own footnotes. Both are shown, never summed.
 * 2. A person NAMED in a clause is not the same as a person ACCOUNTABLE for
 *    something a regulation touches. The second is larger and is what a
 *    compliance lead acts on, but it is an ownership link, not the clause.
 * 3. What is missing is given the same weight as what is present. A dashboard
 *    that shows only what exists implies the rest is fine.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  FileDiff, Users, UserCheck, AlertTriangle, Brain, ChevronRight, ChevronDown, Database,
} from 'lucide-react';
import { api } from '@/services/http';
import { useRegulationChanges } from '@/services/regulationsApi';
import { cn } from '@/utils/ui';
import { useT, type TFunction } from '@/i18n';

/* ------------------------------------------------------------------- types */

interface ChangedReg {
  regulation_id: string; title: string | null; regulator_short: string | null;
  wording: number; renumbered: number; detected_at: string | null;
  words_added: number | null; words_removed: number | null;
}
interface PersonRow {
  id: string; name: string; type: string | null;
  regulations: number; obligations?: number; entities_owned?: number;
}
interface Gap {
  key: string; label: string; count: number; of: number | null;
  why: string; link: string;
}
interface ActionItem {
  key: string; count: number; label: string; detail: string;
  link: string; urgency: 'high' | 'medium';
}
interface Dash {
  dates: {
    lastChangeDetected: string | null; lastSourceCheck: string | null;
    lastImpactRun: string | null; sourceChecksLast7d: number; changesLast30d: number;
  };
  actions: ActionItem[];
  library: { discovered: number; documentsExtracted: number; structured: number; obligations: number };
  change: {
    regulationsChanged: number; wordingChanges: number; renumberedOnly: number;
    amendmentsMentionedInSource: number; recent: ChangedReg[];
  };
  people: { namedInClauses: number; accountable: number; named: PersonRow[]; owners: PersonRow[] };
  owners: {
    entities: number; withOwner: number; distinctOwners: number;
    unownedButAffected: { id: string; name: string; domain: string; regulations: number }[];
  };
  gaps: Gap[];
  engine: {
    runs: number; byRoute: { route: string; count: number }[];
    modelAvailable: boolean; modelNote: string | null;
    relationships: number; entitiesTouched: number; regulationsScored: number;
    bands: { value: string; count: number }[];
    proposedMappings: number; approvedMappings: number;
    lastRun: { regulation_id: string; route: string; ran_at: string } | null;
  };
}

/**
 * Titles in this corpus repeat their issuer and a revision stamp, so a list of
 * twelve reads as twelve copies of "Reserve Bank of India (Commercial Banks …".
 * The distinguishing phrase is pulled forward; the rest becomes the caption and
 * the untouched original stays in the tooltip.
 */
function shortTitle(raw: string): { head: string; tail: string } {
  let t = raw.trim();
  let tail = '';
  const upd = t.match(/\(\s*(?:updated|as amended)[^)]*\)\s*$/i);
  if (upd) { tail = upd[0].replace(/[()]/g, '').trim(); t = t.slice(0, upd.index).trim(); }

  // "Reserve Bank of India (X) Directions, 2025" -> "X", caption "Directions, 2025"
  const wrapped = t.match(/^[A-Za-z .]+\((.+?)\)\s*(.*)$/);
  if (wrapped && wrapped[1].length > 8) {
    return { head: wrapped[1], tail: [wrapped[2], tail].filter(Boolean).join(' · ') };
  }
  // "Master Direction – X"
  const dashed = t.match(/^(Master Direction[s]?|Master Circular)\s*[–-]\s*(.+)$/i);
  if (dashed) return { head: dashed[2], tail: [dashed[1], tail].filter(Boolean).join(' · ') };
  return { head: t, tail };
}

/** A proportion, drawn. A number alone does not show 63% at a glance. */
function Bar({ value, of, tone = 'bg-brand-500', className }: {
  value: number; of: number; tone?: string; className?: string;
}) {
  const pct = of > 0 ? Math.min(100, Math.round((value / of) * 100)) : 0;
  return (
    <span className={cn('block h-1 w-full overflow-hidden rounded-full bg-slate-200', className)}
          role="img" aria-label={`${pct}%`}>
      <span className={cn('block h-full rounded-full transition-[width] duration-500', tone)}
            style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%` }} />
    </span>
  );
}

/** "2 days ago" beats a timestamp for judging whether a figure is still current. */
function ago(iso: string | null, t: TFunction): string {
  if (!iso) return t('never');
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return t('unknown');
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  if (days < 30) return t('{n} days ago', { n: days });
  const months = Math.floor(days / 30);
  return months === 1 ? t('a month ago') : t('{n} months ago', { n: months });
}

/**
 * The list scrolls rather than truncating. Capping it hid changed regulations
 * behind a link; a fixed-height scroller keeps the column the same height as
 * the summaries beside it while still reaching every one of them.
 */
const CHANGE_LIST_MAX = 'max-h-[38rem]';

const useDashboard = () =>
  useQuery<Dash>({
    queryKey: ['dashboard'],
    queryFn: () => api('/api/dashboard'),
    staleTime: 60_000,
  });

/* ---------------------------------------------------------------- fragments */

function Kpi({ icon: I, label, value, foot, tone = 'neutral', progress, onClick }: {
  icon: typeof Users; label: string; value: string | number; foot?: string;
  tone?: 'neutral' | 'red' | 'amber' | 'green';
  progress?: { value: number; of: number };
  onClick?: () => void;
}) {
  const t = useT();
  // Semantic, not decorative: red means something moved, amber means something
  // is unfinished. Neither is the product accent.
  const tones = {
    neutral: { fg: 'text-ink', chip: 'bg-slate-100 text-slate-500', bar: 'bg-slate-400' },
    red: { fg: 'text-critical-600', chip: 'bg-critical-50 text-critical-600', bar: 'bg-critical-500' },
    amber: { fg: 'text-warning-600', chip: 'bg-warning-50 text-warning-600', bar: 'bg-warning-500' },
    green: { fg: 'text-success-600', chip: 'bg-success-50 text-success-600', bar: 'bg-success-500' },
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'card flex flex-col gap-2.5 p-4 text-left transition',
        onClick && 'hover:-translate-y-px hover:border-brand-300 hover:shadow-md',
      )}
    >
      <span className="flex items-center gap-2">
        <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md', tones.chip)}>
          <I className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 truncate text-[11.5px] font-medium text-muted">{t(label)}</span>
      </span>
      <span className={cn('text-[30px] font-bold leading-none tracking-tight tabular-nums', tones.fg)}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
      {progress && <Bar value={progress.value} of={progress.of} tone={tones.bar} />}
      {foot && <span className="text-[11.5px] leading-snug text-muted-2">{foot}</span>}
    </button>
  );
}

function Panel({ title, note, action, className, children }: {
  title: string; note?: string; action?: React.ReactNode;
  className?: string; children: React.ReactNode;
}) {
  const t = useT();
  return (
    <section className={cn('card flex flex-col overflow-hidden', className)}>
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-ink">{t(title)}</h3>
          {note && <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{note}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-8 text-center text-[12.5px] text-muted">{children}</div>;
}

/**
 * One changed regulation, expandable to the clauses that actually moved.
 *
 * The summary row answers "how much"; the question straight after it is "what",
 * and that used to mean leaving the dashboard. The sections are fetched only
 * when a row is opened, so the page does not pull twelve documents' worth of
 * diffs to render a list.
 */
function ChangedRegulationRow({ r, scale, open, onToggle, onOpen }: {
  r: ChangedReg; scale: number; open: boolean; onToggle: () => void; onOpen: () => void;
}) {
  const t = useT();
  const { head, tail } = shortTitle(r.title ?? r.regulation_id);
  const { data, isLoading } = useRegulationChanges(open ? r.regulation_id : undefined);
  const wording = (data?.items ?? []).filter((i) => i.change_class === 'WORDING');

  return (
    <li>
      <button
        onClick={onToggle}
        aria-expanded={open}
        title={r.title ?? undefined}
        className="group flex w-full items-center gap-3.5 px-4 py-3 text-left transition hover:bg-canvas"
      >
        <span className="flex w-16 shrink-0 flex-col items-end gap-1">
          <span className="text-[17px] font-bold leading-none tabular-nums text-critical-600">
            {r.wording}
          </span>
          <Bar value={r.wording} of={scale} tone="bg-critical-500" className="w-full" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium leading-snug text-ink">{head}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted">
            <span className="font-medium text-ink-2">{r.regulator_short}</span>
            {tail && <span className="truncate text-muted-2">{tail}</span>}
            {r.detected_at && (
              <span className="text-muted-2" title={r.detected_at}>{t('detected {when}', { when: ago(r.detected_at, t) })}</span>
            )}
            {r.words_added ? (
              <span className="text-success-600">{t('+{n} words', { n: r.words_added.toLocaleString() })}</span>
            ) : null}
            {r.renumbered > 0 && (
              <span className="text-muted-2">{t('{n} renumbered only', { n: r.renumbered.toLocaleString() })}</span>
            )}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-2 transition', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="border-t border-line bg-canvas px-4 py-3">
          {isLoading && <p className="text-[12px] text-muted">{t('Loading the changed clauses…')}</p>}
          {!isLoading && wording.length === 0 && (
            <p className="text-[12px] text-muted">
              {t('No section-level detail is stored for this comparison.')}
            </p>
          )}
          {wording.length > 0 && (
            <>
              <div className="sec-eyebrow mb-2">
                {t('Clauses that changed ({n})', { n: wording.length.toLocaleString() })}
              </div>
              <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {wording.slice(0, 20).map((c, i) => (
                  <li key={i} className="rounded-lg border border-line bg-surface p-2.5">
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
                        {t('Section {n}', { n: c.section_number })}
                      </span>
                      <span className="text-muted-2">{c.change_type}</span>
                      <span className="ml-auto tabular-nums">
                        <span className="text-success-600">+{c.words_added}</span>{' '}
                        <span className="text-critical-600">−{c.words_removed}</span>
                      </span>
                    </div>
                    {c.new_text && (
                      <p className="mt-1.5 line-clamp-3 text-[12px] leading-relaxed text-ink-2">
                        {c.new_text.replace(/\s+/g, ' ').trim().slice(0, 260)}
                        {c.new_text.length > 260 ? '…' : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              {wording.length > 20 && (
                <p className="mt-1.5 text-[11.5px] text-muted-2">
                  {t('and {n} more clauses', { n: (wording.length - 20).toLocaleString() })}
                </p>
              )}
            </>
          )}
          <button onClick={onOpen}
                  className="mt-2.5 text-[11.5px] font-medium text-brand-600 hover:underline">
            {t('Open the full comparison →')}
          </button>
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------- the screen */

export function ImpactDashboard() {
  const navigate = useNavigate();
  const t = useT();
  const { data: d, isLoading, error } = useDashboard();
  const [openChange, setOpenChange] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="card h-[104px] animate-pulse bg-slate-100" />
        ))}
      </div>
    );
  }
  if (error || !d) {
    return (
      <div className="card flex flex-col items-center gap-2 py-10 text-center">
        <AlertTriangle className="h-5 w-5 text-critical-600" />
        <div className="text-sm font-semibold text-ink">{t('Cannot reach the regulatory API')}</div>
        <p className="text-[12.5px] text-muted">
          {t('No cached or sample figures are shown — this dashboard has no fallback data.')}
        </p>
      </div>
    );
  }

  const ownerPct = Math.round(100 * d.owners.withOwner / Math.max(d.owners.entities, 1));
  // Bars are scaled to the biggest row, so the column reads as a distribution.
  const topChange = Math.max(1, ...d.change.recent.map((r) => r.wording));
  const bandTotal = Math.max(1, d.engine.bands.reduce((a, b) => a + b.count, 0));
  // Severity order, not count order. The API returns these sorted by size, which
  // put Medium between Critical and High and made the bar unreadable as a scale.
  const SEVERITY = ['Critical', 'High', 'Medium', 'Low'];
  const bands = [...d.engine.bands].sort(
    (a, b) => SEVERITY.indexOf(a.value) - SEVERITY.indexOf(b.value));

  return (
    <div className="space-y-4">
      {/* ---- headline: the four questions ---- */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi icon={FileDiff} label="Regulations changed" value={d.change.regulationsChanged}
             tone={d.change.regulationsChanged ? 'red' : 'neutral'}
             foot={t('{n} sections reworded', { n: d.change.wordingChanges.toLocaleString() })}
             onClick={() => navigate('/reg-regulations')} />
        <Kpi icon={Users} label="People named in clauses" value={d.people.namedInClauses}
             foot={t('{n} more accountable through ownership', { n: d.people.accountable.toLocaleString() })}
             onClick={() => navigate('/people')} />
        <Kpi icon={UserCheck} label="Ownership coverage" value={`${ownerPct}%`}
             tone={ownerPct >= 85 ? 'green' : 'amber'}
             progress={{ value: d.owners.withOwner, of: d.owners.entities }}
             foot={t('{n} of {total} entities · {owners} owners', {
               n: d.owners.withOwner.toLocaleString(), total: d.owners.entities.toLocaleString(), owners: d.owners.distinctOwners.toLocaleString(),
             })}
             onClick={() => navigate('/people')} />
        <Kpi icon={Database} label="Library extracted"
             value={`${Math.round(100 * d.library.documentsExtracted / Math.max(d.library.discovered, 1))}%`}
             tone="amber"
             progress={{ value: d.library.documentsExtracted, of: d.library.discovered }}
             foot={t('{n} of {total} records have a document', { n: d.library.documentsExtracted.toLocaleString(), total: d.library.discovered.toLocaleString() })}
             onClick={() => navigate('/reg-regulations')} />
      </div>

      {/* ---- what to do next ---- */}
      {d.actions.length > 0 && (
        <section className="card overflow-hidden">
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-2.5">
            <h3 className="text-[13.5px] font-semibold text-ink">{t('What needs you')}</h3>
            <span className="text-[11.5px] text-muted">
              {t('Each is a real queue — nothing is listed that has nothing behind it.')}
            </span>
          </header>
          <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-x lg:grid-cols-4 lg:divide-y-0">
            {d.actions.map((a) => (
              <button
                key={a.key}
                onClick={() => navigate(a.link)}
                className="group flex flex-col items-start gap-1 px-4 py-3 text-left transition hover:bg-canvas"
              >
                <span className="flex items-center gap-2">
                  <span className={cn('text-[24px] font-bold leading-none tabular-nums',
                    a.urgency === 'high' ? 'text-critical-600' : 'text-warning-600')}>
                    {a.count.toLocaleString()}
                  </span>
                  {a.urgency === 'high' && (
                    <span className="rounded-full bg-critical-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-critical-600">
                      {t('act now')}
                    </span>
                  )}
                </span>
                <span className="text-[12.5px] font-semibold text-ink">{a.label}</span>
                <span className="text-[11.5px] leading-snug text-muted">{a.detail}</span>
                <span className="mt-0.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-600 group-hover:underline">
                  {t('Open')} <ChevronRight className="h-3 w-3" />
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/*
        Two columns. The change list is long and its rows are wide, so it takes
        the larger column; the summary panels stack beside it rather than below,
        which kept them off the first screen entirely.

        The change list is capped to keep the two sides close in height, and
        "What is missing" sits full width beneath rather than in a column — it
        is about the whole library, not about what changed.
      */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.4fr_1fr]">
      {/* ---- what changed ---- */}
      <Panel
        title="What changed"
        note={t('{reworded} sections reworded across {regulations} regulations. {renumbered} further sections differ by numbering only and are excluded. Separately, {mentioned} amendments are mentioned in source footnotes — a statement by the regulator, not a comparison performed here.', {
          reworded: d.change.wordingChanges.toLocaleString(),
          regulations: d.change.regulationsChanged.toLocaleString(),
          renumbered: d.change.renumberedOnly.toLocaleString(),
          mentioned: d.change.amendmentsMentionedInSource.toLocaleString(),
        })}
        action={
          <button onClick={() => navigate('/reg-regulations')}
                  className="btn btn-ghost btn-sm shrink-0 gap-1">
            {t('All regulations')} <ChevronRight className="h-3.5 w-3.5" />
          </button>
        }
      >
        {d.change.recent.length === 0 ? (
          <Empty>
            {t('No regulation has been observed to change. Detection needs two captures of the same document; until a second crawl exists there is nothing to compare.')}
          </Empty>
        ) : (
          <ul className={cn('divide-y divide-line overflow-y-auto', CHANGE_LIST_MAX)}>
            {d.change.recent.map((r) => (
              <ChangedRegulationRow
                key={r.regulation_id}
                r={r}
                scale={topChange}
                open={openChange === r.regulation_id}
                onToggle={() => setOpenChange(openChange === r.regulation_id ? null : r.regulation_id)}
                onOpen={() => navigate(`/regulation/${r.regulation_id}`)}
              />
            ))}
          </ul>
        )}
      </Panel>

      {/* right column: the summaries, stacked */}
      <div className="space-y-4">
        {/* ---- who it reaches ---- */}
        <Panel
          title="Who this reaches"
          note={t("Named means a clause matched this person's record. Accountable means they own something a regulation touches — the larger group, and the one to route work to.")}
        >
          <div className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                {t('Named in a clause')}
              </div>
              {d.people.named.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-muted">{t('No person entity is named by any clause.')}</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {d.people.named.slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate text-ink-2">{p.name}</span>
                      <span className="shrink-0 tabular-nums text-muted">{p.regulations}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="p-4">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
                {t('Accountable as owner')}
              </div>
              {d.people.owners.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-muted">{t('No owner links reach an affected entity.')}</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {d.people.owners.slice(0, 6).map((p) => (
                    <li key={p.id} className="flex items-baseline gap-2 text-[12.5px]">
                      <span className="min-w-0 flex-1 truncate text-ink-2">{p.name}</span>
                      <span className="shrink-0 tabular-nums text-muted">{p.regulations}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {d.owners.unownedButAffected.length > 0 && (
            <div className="mt-auto border-t border-line bg-warning-50 px-4 py-3">
              <div className="text-[12px] font-semibold text-warning-700">
                {d.owners.unownedButAffected.length === 1
                  ? t('1 affected entity has no owner')
                  : t('{n} affected entities have no owner', { n: d.owners.unownedButAffected.length.toLocaleString() })}
              </div>
              <p className="mt-0.5 text-[11.5px] leading-snug text-warning-700/85">
                {t(d.owners.unownedButAffected.length > 3
                  ? 'A change landing on {names} and others has nobody to route to.'
                  : 'A change landing on {names} has nobody to route to.', { names: d.owners.unownedButAffected.slice(0, 3).map((e) => e.name).join(', ') })}
              </p>
            </div>
          )}
        </Panel>

        {/* ---- the engine ---- */}
        <Panel
          title="Impact engine"
          note={d.engine.modelAvailable
            ? undefined
            : t('No model key is configured, so the four language-model stages have never run. Results come from the deterministic rule path and are labelled as such.')}
        >
          <div className="grid grid-cols-2 gap-px bg-line">
            <div className="bg-surface p-4">
              <div className="text-[11px] font-medium text-muted">{t('Relationships')}</div>
              <div className="text-[22px] font-bold tabular-nums text-ink">
                {d.engine.relationships.toLocaleString()}
              </div>
              <div className="text-[11.5px] text-muted-2">
                {t('across {n} entities', { n: d.engine.entitiesTouched.toLocaleString() })}
              </div>
            </div>
            <div className="bg-surface p-4">
              <div className="text-[11px] font-medium text-muted">{t('Awaiting a human')}</div>
              <div className="text-[22px] font-bold tabular-nums text-warning-600">
                {d.engine.proposedMappings.toLocaleString()}
              </div>
              <div className="text-[11.5px] text-muted-2">
                {t('{n} approved', { n: d.engine.approvedMappings.toLocaleString() })}
              </div>
            </div>
          </div>
          <div className="border-t border-line px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">
              {t('Risk bands · {n} scored', { n: d.engine.regulationsScored.toLocaleString() })}
            </div>
            {/* A stacked proportion: four separate pills hid that Critical is
                half the corpus, which is the whole point of the figure. */}
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-slate-200">
              {bands.map((b) => (
                <span key={b.value}
                      title={`${t(b.value)}: ${b.count}`}
                      style={{ width: `${(100 * b.count) / bandTotal}%` }}
                      className={cn(
                        b.value === 'Critical' ? 'bg-critical-500'
                        : b.value === 'High' ? 'bg-warning-500'
                        : b.value === 'Medium' ? 'bg-brand-400' : 'bg-slate-300')} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {bands.map((b) => (
                <span key={b.value} className="flex items-center gap-1.5 text-[11.5px] text-muted">
                  <span className={cn('h-2 w-2 rounded-full',
                    b.value === 'Critical' ? 'bg-critical-500'
                    : b.value === 'High' ? 'bg-warning-500'
                    : b.value === 'Medium' ? 'bg-brand-400' : 'bg-slate-300')} />
                  {t(b.value)}
                  <b className="tabular-nums text-ink-2">{b.count}</b>
                  <span className="text-muted-2">{Math.round((100 * b.count) / bandTotal)}%</span>
                </span>
              ))}
            </div>
          </div>
          <div className="mt-auto flex items-center gap-2 border-t border-line px-4 py-2.5 text-[11.5px] text-muted">
            <Brain className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {d.engine.runs === 1 ? t('1 run') : t('{n} runs', { n: d.engine.runs.toLocaleString() })} ·{' '}
              {d.engine.byRoute.map((r) => `${r.count} ${r.route}`).join(', ') || t('none yet')}
            </span>
            <button onClick={() => navigate('/impact-engine')}
                    className="ml-auto shrink-0 font-medium text-brand-600 hover:underline">
              {t('Open')}
            </button>
          </div>
        </Panel>

      </div>
      </div>

      {/* ---- what is missing ---- */}
      <Panel
        title="What is missing"
        note={t('Counted so the figures above can be read in context. These are records the pipeline has not finished with, not errors.')}
      >
        <ul className="divide-y divide-line">
          {d.gaps.map((g) => {
            const pct = g.of ? Math.round(100 * g.count / Math.max(g.of, 1)) : null;
            const isEmptyLayer = g.count === 0 && g.key === 'no_evidence';
            return (
              <li key={g.key}>
                <button
                  onClick={() => navigate(g.link)}
                  className="flex w-full items-start gap-3 px-4 py-2.5 text-left transition hover:bg-canvas"
                >
                  <span className="flex w-20 shrink-0 flex-col items-end gap-1">
                    <span className={cn('text-[17px] font-bold leading-none tabular-nums',
                      isEmptyLayer ? 'text-critical-600' : g.count > 0 ? 'text-warning-600' : 'text-success-600')}>
                      {g.count.toLocaleString()}
                    </span>
                    {g.of !== null && (
                      <Bar value={g.count} of={g.of}
                           tone={isEmptyLayer ? 'bg-critical-500' : 'bg-warning-500'}
                           className="w-full" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium leading-snug text-ink">
                      {g.label}
                      {pct !== null && (
                        <span className="ml-1.5 font-normal text-muted-2">
                          {t('{pct}% of {n}', { pct, n: g.of?.toLocaleString() ?? '' })}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{g.why}</span>
                  </span>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-2" />
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11.5px] text-muted-2">
        <span title={d.dates.lastChangeDetected ?? undefined}>
          {t('Last change detected')} <b className="font-medium text-muted">{ago(d.dates.lastChangeDetected, t)}</b>
        </span>
        <span title={d.dates.lastSourceCheck ?? undefined}>
          {t('Sources last checked')} <b className="font-medium text-muted">{ago(d.dates.lastSourceCheck, t)}</b>
          {' '}({t('{n} in the last 7 days', { n: d.dates.sourceChecksLast7d.toLocaleString() })})
        </span>
        <span title={d.dates.lastImpactRun ?? undefined}>
          {t('Impact last run')} <b className="font-medium text-muted">{ago(d.dates.lastImpactRun, t)}</b>
        </span>
      </div>
      <p className="px-1 text-[11.5px] text-muted-2">
        {t('Every figure on this page is a count of rows in {table}, served by {endpoint}. Nothing is seeded or estimated.', {
          table: 'company_brain', endpoint: 'GET /api/dashboard',
        })}
      </p>
    </div>
  );
}
