/**
 * The compliance calendar.
 *
 * THE DESIGN PRINCIPLE: FUTURE IS WORK, PAST IS CONTEXT
 * -----------------------------------------------------
 * Everything ahead of today is saturated and legible from across the room;
 * everything behind it is dimmed. A compliance officer opens this to plan, not
 * to browse history, so the 294 regulations that already came into force must
 * not compete visually with the one report due at the end of the month.
 *
 * THREE KINDS OF DATE, NEVER MERGED
 * ---------------------------------
 * REPORTING   a recurring obligation — "quarterly", "monthly" — read out of the
 *             text. The frequency is a fact; the exact day is an inference from
 *             Indian period-end convention, and every row says so.
 * EFFECTIVE   the date an instrument starts binding, from its own commencement
 *             clause. Either stated in the text, or derived from the issue date
 *             when the clause says "with immediate effect" — the chip on each
 *             row says which, because a derived date must never read like a
 *             quoted one.
 * REWORDED    the date our watcher noticed the text move. A fact about our
 *             pipeline, not about the law, and it is labelled that way.
 *
 * WHY EVENT BARS AND NOT A HEAT FILL
 * ----------------------------------
 * A flat fill per day can only encode one thing, so a day carrying a report
 * deadline plus a detected change looked identical to a day carrying two
 * detected changes. Stacked bars let a day show its actual mix, which is the
 * thing being planned around.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft, ChevronRight, ExternalLink, CalendarClock, AlertCircle,
} from 'lucide-react';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useDateLocale, useT } from '@/i18n';

/* ------------------------------------------------------------------- types */

interface EffectiveItem {
  id: string; title: string; regulator: string;
  basis: 'STATED_DATE' | 'IMMEDIATE_ON_ISSUE'; evidence: string | null;
  applicability: string | null; applies: boolean;
}
interface ChangeItem {
  id: string; title: string; regulator: string;
  sections: number; applicability: string | null; applies: boolean;
}
interface RecurringItem {
  id: string; title: string; regulator: string;
  expression: string; sourceText: string; basis: string; applies: boolean;
}
interface Day {
  date: string;
  effective: EffectiveItem[]; changes: ChangeItem[]; recurring: RecurringItem[];
  effectiveCount: number; changeCount: number; recurringCount: number;
  appliesCount: number; sections: number;
}
interface CalendarData {
  days: Day[]; today: string;
  upcoming: { id: string; title: string; effective_from: string;
              effective_basis: string; applicability: string | null }[];
  coverage: { statedDate: number; immediateOnIssue: number;
              notStated: number; noSections: number };
}

/* -------------------------------------------------------------- event kinds */

type Kind = 'reporting' | 'effective' | 'reworded';

const KIND: Record<Kind, {
  label: string; short: string; count: string; future: string; past: string; dot: string;
}> = {
  reporting: {
    label: 'Reporting due', short: tx('due'), count: tx('{n} reporting due'),
    future: 'bg-brand-600 text-white', past: 'bg-brand-50 text-brand-600',
    dot: 'bg-brand-600',
  },
  effective: {
    label: 'Comes into force', short: tx('in force'), count: tx('{n} comes into force'),
    future: 'bg-warning-500 text-white', past: 'bg-slate-100 text-slate-500',
    dot: 'bg-warning-500',
  },
  reworded: {
    label: 'Text reworded', short: tx('reworded'), count: tx('{n} text reworded'),
    future: 'bg-slate-200 text-slate-700', past: 'bg-slate-100 text-slate-500',
    dot: 'bg-slate-400',
  },
};

const DAY_MS = 86_400_000;

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const longDate = (d: string, locale: string) =>
  new Date(d + 'T00:00:00').toLocaleDateString(locale,
    { day: 'numeric', month: 'long', year: 'numeric' });

/** The bars a day renders, most actionable first. */
function barsFor(d: Day): { kind: Kind; n: number }[] {
  return ([
    { kind: 'reporting' as Kind, n: d.recurringCount },
    { kind: 'effective' as Kind, n: d.effectiveCount },
    { kind: 'reworded' as Kind, n: d.changeCount },
  ]).filter((b) => b.n > 0);
}

/* ==========================================================================
   Calendar
   ========================================================================== */

export function ChangeCalendar() {
  const navigate = useNavigate();
  const t = useT();
  const locale = useDateLocale('en-IN');
  // weekday initials, Monday first, in the chosen language (1 Jan 2024 was a Monday)
  const DOW = useMemo(() => Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 1 + i).toLocaleDateString(locale, { weekday: 'short' })), [locale]);
  const { data, isLoading, error } = useQuery<CalendarData>({
    queryKey: ['change-calendar'],
    queryFn: () => api('/api/dashboard/calendar'),
    staleTime: 60_000,
  });

  const byDate = useMemo(
    () => new Map((data?.days ?? []).map((d) => [d.date, d])), [data]);

  const todayIso = data?.today ?? new Date().toISOString().slice(0, 10);
  const todayMs = useMemo(
    () => new Date(todayIso + 'T00:00:00').getTime(), [todayIso]);

  /** The next dated obligation ahead of today. */
  const next = useMemo(() => {
    const ahead = (data?.days ?? [])
      .filter((d) => d.date >= todayIso && (d.recurringCount > 0 || d.effectiveCount > 0))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!ahead.length) return null;
    const d = ahead[0];
    return {
      day: d,
      inDays: Math.round((new Date(d.date + 'T00:00:00').getTime() - todayMs) / DAY_MS),
    };
  }, [data, todayIso, todayMs]);

  // Land on the current month. A planning tool that opens two years out because
  // that is where the furthest record sits is disorienting.
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);
  const view = useMemo(() => cursor ?? {
    y: Number(todayIso.slice(0, 4)), m: Number(todayIso.slice(5, 7)) - 1,
  }, [cursor, todayIso]);

  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? next?.day.date ?? null;
  const day = selected ? byDate.get(selected) : undefined;

  const cells = useMemo(() => {
    const lead = (new Date(view.y, view.m, 1).getDay() + 6) % 7;
    const len = new Date(view.y, view.m + 1, 0).getDate();
    return [...Array(lead).fill(null), ...Array.from({ length: len }, (_, i) => i + 1)];
  }, [view]);

  /** What this month holds, so an empty-looking grid still states its content. */
  const monthTotals = useMemo(() => {
    const prefix = `${view.y}-${String(view.m + 1).padStart(2, '0')}`;
    const inMonth = (data?.days ?? []).filter((d) => d.date.startsWith(prefix));
    return {
      reporting: inMonth.reduce((a, d) => a + d.recurringCount, 0),
      effective: inMonth.reduce((a, d) => a + d.effectiveCount, 0),
      reworded: inMonth.reduce((a, d) => a + d.changeCount, 0),
    };
  }, [data, view]);

  const step = (n: number) => {
    const d = new Date(view.y, view.m + n, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() });
  };
  const goNext = () => {
    if (!next) return;
    setPicked(next.day.date);
    setCursor({ y: Number(next.day.date.slice(0, 4)), m: Number(next.day.date.slice(5, 7)) - 1 });
  };
  const goToday = () =>
    setCursor({ y: Number(todayIso.slice(0, 4)), m: Number(todayIso.slice(5, 7)) - 1 });

  if (isLoading) {
    return <div className="card py-16 text-center text-[13px] text-muted">{t('Loading from the database…')}</div>;
  }
  if (error) {
    return (
      <div className="card py-12 text-center">
        <div className="text-sm font-semibold text-ink">{t('Cannot reach the API')}</div>
        <p className="mt-1 text-[13px] text-muted">{String((error as Error).message)}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ---------- the one answer this page owes: what is next ------------- */}
      {next && (
        <button
          type="button"
          onClick={goNext}
          className="flex w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-card border border-brand-600/25 bg-brand-50/60 px-4 py-3 text-left transition hover:border-brand-600/50"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[8px] bg-brand-600 text-white">
            <CalendarClock className="h-[18px] w-[18px]" />
          </span>
          <span>
            <span className="block text-[11px] font-semibold tracking-normal text-brand-700/70">
              {t('Next obligation')}
            </span>
            <span className="block text-[15px] font-semibold text-ink">
              {longDate(next.day.date, locale)}
              <span className="ml-2 font-normal text-muted">
                {next.inDays === 0 ? t('today')
                  : next.inDays === 1 ? t('tomorrow')
                  : t('in {n} days', { n: next.inDays.toLocaleString() })}
              </span>
            </span>
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {barsFor(next.day).map((b) => (
              <span key={b.kind}
                className={cn('rounded-[5px] px-2 py-1 text-[11.5px] font-semibold', KIND[b.kind].future)}>
                {t(KIND[b.kind].count, { n: b.n.toLocaleString() })}
              </span>
            ))}
          </span>
        </button>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">

        {/* ---------------- month grid ------------------------------------- */}
        <section className="rounded-card border border-line bg-surface">
          <header className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight text-ink">
                {new Date(view.y, view.m, 1).toLocaleDateString(locale, { month: 'long', year: 'numeric' })}
              </h2>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
                {monthTotals.reporting + monthTotals.effective + monthTotals.reworded === 0
                  ? <span>{t('Nothing scheduled this month')}</span>
                  : (['reporting', 'effective', 'reworded'] as Kind[]).map((k) => {
                      const n = monthTotals[k === 'reporting' ? 'reporting'
                        : k === 'effective' ? 'effective' : 'reworded'];
                      return n === 0 ? null : (
                        <span key={k} className="flex items-center gap-1.5">
                          <i className={cn('h-2 w-2 rounded-full', KIND[k].dot)} />
                          <b className="tabular-nums text-ink-2">{n}</b> {t(KIND[k].label).toLowerCase()}
                        </span>
                      );
                    })}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={goToday}
                className="rounded-[6px] border border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition hover:border-line-2">
                {t('Today')}
              </button>
              <button type="button" onClick={() => step(-1)} aria-label={t('Previous month')}
                className="grid h-7 w-7 place-items-center rounded-[6px] border border-line text-muted transition hover:border-line-2 hover:text-ink">
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => step(1)} aria-label={t('Next month')}
                className="grid h-7 w-7 place-items-center rounded-[6px] border border-line text-muted transition hover:border-line-2 hover:text-ink">
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>

          <div className="px-3 pb-3 pt-2">
            <div className="grid grid-cols-7">
              {DOW.map((d, i) => (
                <div key={i} className={cn(
                  'pb-2 text-center text-[11px] font-semibold uppercase tracking-[.08em]',
                  i > 4 ? 'text-muted-2/55' : 'text-muted-2')}>
                  {d}
                </div>
              ))}
            </div>

            {/* One continuous grid with hairline rules. Only days that carry
                something become objects; the rest are quiet ground, so three
                events in a 30-day month read as three events and not as
                twenty-seven broken cards. */}
            <div className="grid grid-cols-7 overflow-hidden rounded-[10px] border-l border-t border-line">
              {cells.map((n, i) => {
                if (n === null) {
                  return <div key={`b${i}`} className={cn(
                    'h-[78px] border-b border-r border-line',
                    (i % 7) > 4 ? 'bg-canvas/50' : 'bg-canvas/25')} />;
                }
                const date = iso(view.y, view.m, n);
                const hit = byDate.get(date);
                const on = selected === date;
                const isToday = date === todayIso;
                const future = date >= todayIso;
                const weekend = (i % 7) > 4;
                const bars = hit ? barsFor(hit) : [];
                const dayName = new Date(view.y, view.m, n).toLocaleDateString(locale, { day: 'numeric', month: 'long' });

                return (
                  <button
                    key={date}
                    type="button"
                    disabled={!hit}
                    onClick={() => setPicked(date)}
                    aria-pressed={on}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={hit
                      ? `${dayName} — ${bars.map((b) => t(KIND[b.kind].count, { n: b.n.toLocaleString() })).join(', ')}`
                      : t('{date} — nothing scheduled', { date: dayName })}
                    className={cn(
                      'group relative flex h-[78px] flex-col gap-1 border-b border-r border-line',
                      'px-1.5 pb-1.5 pt-1 text-left transition',
                      on ? 'bg-brand-50'
                         : hit ? 'bg-surface hover:bg-canvas'
                               : weekend ? 'bg-canvas/50' : 'bg-canvas/25',
                      !hit && 'cursor-default',
                    )}
                  >
                    {/* selection reads as a filled cell with a spine, not a
                        ring that fights the grid's own rules */}
                    {on && <span className="absolute inset-y-0 left-0 w-[3px] bg-brand-600" />}

                    <span className="flex items-center justify-between">
                      <span className={cn(
                        'grid h-[19px] min-w-[19px] place-items-center rounded-full px-1 text-[11.5px] tabular-nums',
                        isToday ? 'bg-ink font-bold text-white'
                                : hit ? 'font-semibold text-ink'
                                      : weekend ? 'text-muted-2/70' : 'text-muted-2')}>
                        {n}
                      </span>
                      {!!hit?.appliesCount && (
                        <span title={t('{n} reach this company', { n: hit.appliesCount.toLocaleString() })}
                          className="mr-0.5 h-[5px] w-[5px] rounded-full bg-critical-500" />
                      )}
                    </span>

                    <span className="flex flex-col gap-[3px]">
                      {bars.slice(0, 2).map((b) => (
                        <span key={b.kind}
                          className={cn(
                            'flex items-baseline gap-1 truncate rounded-[4px] px-1.5 py-[3px]',
                            'text-[11px] font-medium leading-none',
                            future ? KIND[b.kind].future : KIND[b.kind].past)}>
                          <b className="text-[11px] tabular-nums">{b.n}</b>
                          <span className="truncate opacity-85">{t(KIND[b.kind].short)}</span>
                        </span>
                      ))}
                      {bars.length > 2 && (
                        <span className="px-1.5 text-[11px] font-medium text-muted">
                          {t('+{n} more', { n: bars.length - 2 })}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5 text-[11px] text-muted">
            {(Object.keys(KIND) as Kind[]).map((k) => (
              <span key={k} className="flex items-center gap-1.5">
                <i className={cn('h-2.5 w-2.5 rounded-[3px]', KIND[k].dot)} />
                {t(KIND[k].label)}
              </span>
            ))}
            <span className="flex items-center gap-1.5">
              <i className="h-1.5 w-1.5 rounded-full bg-critical-500" />
              {t('Reaches this company')}
            </span>
            <span className="ml-auto text-muted-2">{t('Past dates are dimmed')}</span>
          </div>
        </section>

        {/* ---------------- selected day ------------------------------------ */}
        <section className="rounded-card border border-line bg-surface xl:sticky xl:top-4">
          {day ? (
            <>
              <header className="border-b border-line px-4 py-3">
                <h2 className="text-[14px] font-semibold text-ink">{longDate(day.date, locale)}</h2>
                <p className="mt-1.5 flex flex-wrap gap-1.5">
                  {barsFor(day).map((b) => (
                    <span key={b.kind} className={cn(
                      'rounded-[4px] px-1.5 py-0.5 text-[11px] font-medium',
                      day.date >= todayIso ? KIND[b.kind].future : KIND[b.kind].past)}>
                      {t(KIND[b.kind].count, { n: b.n.toLocaleString() })}
                    </span>
                  ))}
                </p>
              </header>

              <div className="max-h-[440px] overflow-y-auto">
                <Group title="Reporting due"
                  note={t('Frequency quoted from the text; the exact day follows period-end convention.')}
                  items={day.recurring.map((it, i) => (
                    <Row key={`r${it.id}${i}`} title={it.title} applies={it.applies}
                      hint={it.sourceText}
                      onOpen={() => navigate(`/regulation/${it.id}`)}
                      chips={[{ text: t('“{expression}” · day assumed', { expression: it.expression }), tone: 'derived' }]} />
                  ))} />

                <Group title="Comes into force"
                  items={day.effective.map((it) => (
                    <Row key={`e${it.id}`} title={it.title} applies={it.applies}
                      hint={it.evidence ?? undefined}
                      onOpen={() => navigate(`/regulation/${it.id}`)}
                      chips={[it.basis === 'STATED_DATE'
                        ? { text: t('Date stated in the text'), tone: 'stated' }
                        : { text: t('Derived — “immediate effect”'), tone: 'derived' }]} />
                  ))} />

                <Group title="Text reworded" note={t('Detected by our watcher. Not a legal date.')}
                  items={day.changes.map((it) => (
                    <Row key={`c${it.id}`} title={it.title} applies={it.applies}
                      onOpen={() => navigate(`/regulation/${it.id}`)}
                      chips={[{ text: t('{n} sections', { n: it.sections.toLocaleString() }), tone: 'plain' }]} />
                  ))} />
              </div>

              <footer className="border-t border-line px-4 py-2.5">
                <button type="button"
                  onClick={() => navigate('/reg-regulations?applicability=APPLICABLE,CONDITIONAL')}
                  className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 hover:underline">
                  {t('All regulations that apply')} <ExternalLink className="h-3 w-3" />
                </button>
              </footer>
            </>
          ) : (
            <div className="px-4 py-12 text-center">
              <AlertCircle className="mx-auto h-5 w-5 text-muted-2" />
              <div className="mt-2 text-[13px] font-semibold text-ink">{t('Nothing on this date')}</div>
              <p className="mx-auto mt-1 max-w-[26ch] text-[12.5px] text-muted">
                {t('Pick a date carrying a coloured bar.')}
              </p>
            </div>
          )}
        </section>
      </div>

      {data && (
        <p className="px-1 text-[11.5px] leading-relaxed text-muted">
          {t('Commencement dates are read from each instrument’s own text: {stated} state a date, {immediate} say “immediate effect” so the date is derived from the issue date, {notStated} do not say and appear nowhere here, and {noText} have no extracted text yet. Only {ahead} commencement dates in the corpus are still ahead — the forward entries on this calendar are recurring reporting obligations, whose frequency is quoted from the text but whose exact day is an assumption.', {
            stated: data.coverage.statedDate.toLocaleString(),
            immediate: data.coverage.immediateOnIssue.toLocaleString(),
            notStated: data.coverage.notStated.toLocaleString(),
            noText: data.coverage.noSections.toLocaleString(),
            ahead: data.upcoming.length.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Group({ title, note, items }: {
  title: string; note?: string; items: React.ReactNode[];
}) {
  const t = useT();
  if (!items.length) return null;
  return (
    <>
      <div className="sticky top-0 z-10 border-b border-line bg-slate-50/95 px-4 py-1.5 backdrop-blur">
        <h3 className="text-[11px] font-semibold tracking-normal text-muted">{t(title)}</h3>
        {note && <p className="mt-0.5 text-[11px] leading-snug text-muted-2">{note}</p>}
      </div>
      <ul>{items}</ul>
    </>
  );
}

const TONE: Record<string, string> = {
  stated: 'bg-brand-50 text-brand-600 px-1.5 py-0.5',
  derived: 'bg-slate-100 text-slate-600 px-1.5 py-0.5',
  plain: 'text-muted',
};

function Row({ title, applies, chips, hint, onOpen }: {
  title: string; applies: boolean; hint?: string;
  chips: { text: string; tone: keyof typeof TONE }[];
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <li className="border-b border-line last:border-b-0">
      <button type="button" onClick={onOpen} title={hint ?? title}
        className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition hover:bg-canvas">
        <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
          applies ? 'bg-critical-500' : 'bg-line-2')} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 block text-[12.5px] leading-snug text-ink">{title}</span>
          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            {chips.map((c) => (
              <span key={c.text} className={cn('rounded-[4px] font-medium', TONE[c.tone])}>
                {c.text}
              </span>
            ))}
            {applies && (
              <span className="rounded-[4px] bg-critical-50 px-1.5 py-0.5 font-medium text-critical-600">
                {t('Applies to us')}
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}
