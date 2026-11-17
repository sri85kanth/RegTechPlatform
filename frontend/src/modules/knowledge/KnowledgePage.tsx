import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Sparkles, ExternalLink,
  AlertTriangle, ChevronRight, Image as ImageIcon, X,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useRagSearch, useRagStatus, useVisualSearch, type RagHit, type VisualHit } from '@/services/ragApi';
import { Skeleton } from '@/components/ui/primitives';
import '@/components/ui/premium.css';
import { cn, readable } from '@/utils/ui';
import { HueChip, HueTile } from '@/modules/compliance/ui';
import { HUES, hueFor, type Hue } from '@/modules/compliance/uiKit';
import { tx, useT } from '@/i18n';

/**
 * Ask across the regulation library and the Company Brain at once.
 *
 * This screen shows RETRIEVED PASSAGES, never a generated answer. Each result
 * is the actual text from a record, with a link to the record and to the
 * official source. Nothing here paraphrases a regulation — a summary that
 * reads as official is precisely the failure mode to avoid.
 *
 * The facet bars count the passages actually returned, and filter them on
 * screen; they never re-query or invent a total.
 */
const EXAMPLES: { q: string; icon: string; hue: Hue }[] = [
  { q: tx('what records must be kept and for how long'), icon: 'Files', hue: 'blue' },
  { q: tx('biomedical waste segregation and storage'), icon: 'Recycle', hue: 'emerald' },
  { q: tx('pre-employment medical examination of staff'), icon: 'Stethoscope', hue: 'violet' },
  { q: tx('fire safety requirements for hospitals'), icon: 'Flame', hue: 'orange' },
];

/** What each kind of indexed record looks like — one icon and one hue per source table. */
const SOURCE: Record<string, { label: string; icon: string; hue: Hue }> = {
  sections: { label: 'Section', icon: 'BookOpen', hue: 'blue' },
  requirements: { label: 'Requirement', icon: 'ListChecks', hue: 'teal' },
  obligations: { label: 'Obligation', icon: 'ClipboardList', hue: 'amber' },
  regulation_amendments: { label: 'Amendment', icon: 'GitCompare', hue: 'pink' },
  company_entities: { label: 'Company record', icon: 'Building2', hue: 'violet' },
  definitions: { label: 'Definition', icon: 'BookMarked', hue: 'indigo' },
  penalty_provisions: { label: 'Penalty', icon: 'Gavel', hue: 'red' },
  thresholds: { label: 'Threshold', icon: 'Gauge', hue: 'sky' },
  timing_rules: { label: 'Timing rule', icon: 'CalendarClock', hue: 'emerald' },
  cross_references: { label: 'Cross-reference', icon: 'Link2', hue: 'slate' },
  regulation_tables: { label: 'Table', icon: 'LayoutGrid', hue: 'teal' },
  guidebook: { label: 'Guidebook', icon: 'BookOpen', hue: 'violet' },
  upload: { label: 'Uploaded document', icon: 'UploadCloud', hue: 'sky' },
};
const sourceOf = (t: string) => SOURCE[t] ?? { label: readable(t || 'record'), icon: 'FileText', hue: hueFor(t) };
const CORPUS: Record<string, { label: string; icon: string; hue: Hue }> = {
  regulatory: { label: 'Regulations', icon: 'Scale', hue: 'blue' },
  company: { label: 'Company', icon: 'Building2', hue: 'violet' },
};
const corpusOf = (c: string) => CORPUS[c] ?? { label: readable(c), icon: 'Database', hue: hueFor(c) };

type Facet = 'corpus' | 'source' | 'domain';

export function KnowledgePage() {
  const t = useT();
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [corpus, setCorpus] = useState<'' | 'regulatory' | 'company'>('');
  const [facet, setFacet] = useState<{ kind: Facet; value: string } | null>(null);
  const { data: status } = useRagStatus();
  const { data, isLoading, error } = useRagSearch(q, { corpus: corpus || undefined, k: 12 });
  // Visual route runs alongside, not instead: it finds pages in SCANNED
  // documents the text index has nothing to match on.
  const visualOn = !!status?.visual?.available && corpus !== 'company';
  const { data: visual } = useVisualSearch(q, visualOn, 5);

  const run = (text: string) => { setInput(text); setQ(text); setFacet(null); };

  const items = useMemo(() => data?.items ?? [], [data]);
  const facets = useMemo(() => {
    const count = (f: (h: RagHit) => string | null) => {
      const m = new Map<string, number>();
      items.forEach((h) => { const k = f(h); if (k) m.set(k, (m.get(k) ?? 0) + 1); });
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    return {
      corpus: count((h) => h.corpus),
      source: count((h) => h.source_table),
      domain: count((h) => h.domain),
    };
  }, [items]);
  const shown = facet
    ? items.filter((h) => (facet.kind === 'corpus' ? h.corpus : facet.kind === 'source' ? h.source_table : h.domain) === facet.value)
    : items;
  const pick = (kind: Facet, value: string) => setFacet((f) => (f && f.kind === kind && f.value === value ? null : { kind, value }));
  const facetLabel = facet ? (facet.kind === 'corpus' ? corpusOf(facet.value).label : facet.kind === 'source' ? sourceOf(facet.value).label : facet.value) : '';

  const byCorpus = Object.entries(status?.byCorpus ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <Topbar
        title="Knowledge Search"
        subtitle="Ask across every ingested regulation and your Company Brain at once"
        icon="Sparkles"
        tone="#7c3aed"
        hideSearch
      />

      <div className="space-y-4 p-4 sm:p-6">
        <form
          onSubmit={(e) => { e.preventDefault(); setQ(input); setFacet(null); }}
          className={cn('pm-tile', q ? 'card flex flex-wrap items-center gap-3 p-3' : 'mx-auto max-w-3xl pt-6 text-center sm:pt-10')}
        >
          {!q && (
            <>
              <span className="pm-pop mx-auto grid h-14 w-14 place-items-center rounded-[18px] bg-gradient-to-br from-[#a78bfa] via-[#7c3aed] to-[#5b21b6] text-white shadow-[0_12px_28px_-12px_rgba(124,58,237,0.7)]">
                <Sparkles className="h-7 w-7" />
              </span>
              <h2 className="mt-4 text-[26px] font-semibold tracking-tight text-ink">{t('Ask the library, get the passage')}</h2>
              <p className="mx-auto mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-muted">
                {t("Every answer here is the regulator's or the company's own text, with the record it came from and a link to the official source. Nothing is paraphrased and nothing is generated.")}
              </p>
            </>
          )}
          <div className={cn('relative min-w-64 flex-1', !q && 'mt-6')}>
            <Search className={cn('pointer-events-none absolute text-violet-600', q ? 'left-3.5 top-3 h-4 w-4' : 'left-5 top-[18px] h-5 w-5')} />
            <input
              aria-label={t('Search question')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={t('Ask a question, or paste a circular reference…')}
              className={cn('w-full border border-transparent bg-white text-ink outline-none transition-all duration-200 placeholder:text-muted-2 focus:border-violet-400/60 focus:shadow-[0_0_0_4px_rgba(124,58,237,0.15)]',
                q ? 'h-10 rounded-full bg-black/[0.04] pl-10 pr-28 text-[14px]' : 'h-14 rounded-full pl-14 pr-32 text-[16px] shadow-[0_10px_30px_-14px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.08)]')}
            />
            <button type="submit" disabled={input.trim().length < 2}
                    className={cn('absolute inline-flex items-center gap-1.5 rounded-full bg-[#7c3aed] font-semibold text-white transition-all duration-300 hover:bg-[#6d28d9] active:scale-95 disabled:opacity-40',
                      q ? 'right-1 top-1 h-8 px-3.5 text-[13px]' : 'right-2 top-2 h-10 px-5 text-[14px]')}>
              <Sparkles className="h-4 w-4" /> {t('Search')}
            </button>
          </div>
          {/* what to search, as one segmented switch instead of a dropdown */}
          <div role="radiogroup" aria-label={t('What to search')}
               className={cn('inline-flex rounded-full bg-black/[0.05] p-1', !q && 'mt-4')}>
            {([['', 'Everything'], ['regulatory', 'Regulations only'], ['company', 'Company only']] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={corpus === v}
                      onClick={() => { setCorpus(v); setFacet(null); }}
                      className={cn('rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all duration-300 active:scale-95',
                        corpus === v ? 'bg-white text-ink shadow-[0_1px_3px_rgba(0,0,0,0.12)]' : 'text-muted hover:text-ink')}>
                {t(l)}
              </button>
            ))}
          </div>
          {!q && (
            <>
              <div className="pm-stagger mt-6 flex flex-wrap justify-center gap-2">
                {EXAMPLES.map((e) => (
                  <button key={e.q} type="button" onClick={() => run(e.q)}
                          className="pm-press group inline-flex items-center gap-2 rounded-full border border-line-2 bg-white py-1.5 pl-1.5 pr-3.5 text-[13px] text-ink-2 hover:border-violet-300 hover:text-ink">
                    <HueTile icon={e.icon} hue={e.hue} size="xs" />
                    {/* shown in the chosen language; the library is searched with the English wording */}
                    {t(e.q)}
                  </button>
                ))}
              </div>
              {status?.available && (
                <p className="mt-6 text-[12px] text-muted">
                  {t('Searching {n} passages', { n: (status.chunks ?? 0).toLocaleString() })}
                  {byCorpus.length > 0 && <> · {byCorpus.map(([k, v]) => `${v.toLocaleString()} ${t(corpusOf(k).label).toLowerCase()}`).join(' · ')}</>}
                  {status.visual?.available && <> · {t('{n} scanned pages via {model}', { n: (status.visual.pages ?? 0).toLocaleString(), model: status.visual.model?.split('/').pop() ?? '' })}</>}
                </p>
              )}
            </>
          )}
        </form>

        {status && !status.available && (
          <div className="flex items-start gap-2 rounded-lg border border-critical-100 bg-critical-50 px-3 py-2 text-[12.5px] text-critical-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('Index unavailable')}{status.reason ? ` — ${status.reason}` : ''}. {status.hint}</span>
          </div>
        )}

        {isLoading && <div className="card"><Skeleton rows={5} /></div>}

        {error && (
          <div className="card flex flex-col items-center gap-2 py-12 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-critical-50 text-critical-600"><AlertTriangle className="h-5 w-5" /></span>
            <div className="text-sm font-semibold text-ink">{t('Retrieval failed')}</div>
            <p className="max-w-lg text-[12.5px] text-muted">{(error as Error).message}</p>
          </div>
        )}

        {data && data.count === 0 && (
          <div className="card flex flex-col items-center gap-2 py-14 text-center">
            <HueTile icon="FileSearch" hue="slate" size="md" />
            <div className="text-sm font-semibold text-ink">{t('Nothing matched')}</div>
            <p className="text-[12.5px] text-muted">
              {t('No passage in the index matches that. Nothing is invented to fill the gap.')}
            </p>
          </div>
        )}

        {visual && visual.count > 0 && (
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <HueTile icon="FileSearch" hue="teal" size="xs" />
              <h2 className="text-sm font-semibold text-ink">{t('Scanned pages')}</h2>
              <span className="text-[12px] text-muted">
                {t('matched from the page image — {note}', { note: visual.provenance.note })}
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {visual.items.map((v) => <VisualCard key={v.page_id} v={v} />)}
            </div>
          </section>
        )}

        {data && data.count > 0 && (
          <div className="grid items-start gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <aside className="card space-y-5 p-4 lg:sticky lg:top-[80px]">
              <div>
                <div className="text-[13px] font-semibold text-ink">{t('Refine these {n} passages', { n: data.count.toLocaleString() })}</div>
                <p className="text-[11.5px] text-muted">{t('Counts are of the results below. Click to filter.')}</p>
              </div>
              <FacetGroup title="Source" rows={facets.corpus.map(([k, v]) => ({ key: k, label: corpusOf(k).label, value: v, hue: corpusOf(k).hue }))}
                          active={facet?.kind === 'corpus' ? facet.value : ''} onPick={(k) => pick('corpus', k)} />
              <FacetGroup title="Record type" rows={facets.source.map(([k, v]) => ({ key: k, label: sourceOf(k).label, value: v, hue: sourceOf(k).hue }))}
                          active={facet?.kind === 'source' ? facet.value : ''} onPick={(k) => pick('source', k)} />
              {facets.domain.length > 0 && (
                <FacetGroup title="Domain" rows={facets.domain.map(([k, v]) => ({ key: k, label: k, value: v, hue: hueFor(k) }))}
                            active={facet?.kind === 'domain' ? facet.value : ''} onPick={(k) => pick('domain', k)} />
              )}
            </aside>

            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                <span>{facet
                  ? (shown.length === 1
                    ? t('1 passage of {total} for “{q}”', { total: data.count.toLocaleString(), q })
                    : t('{n} passages of {total} for “{q}”', { n: shown.length.toLocaleString(), total: data.count.toLocaleString(), q }))
                  : (shown.length === 1
                    ? t('1 passage for “{q}”', { q })
                    : t('{n} passages for “{q}”', { n: shown.length.toLocaleString(), q }))}</span>
                {facet && (
                  <span className="pill bg-brand-50 text-brand-700">
                    {t(facetLabel)}
                    <button type="button" onClick={() => setFacet(null)} aria-label={t('Remove filter')} className="-mr-1 grid h-4 w-4 place-items-center rounded hover:bg-brand-100">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
              {shown.map((h) => <Hit key={h.id} h={h} q={q} />)}
              {data.provenance.retrieval && <p className="text-2xs text-muted">{t('Retrieval: {method}', { method: data.provenance.retrieval })}</p>}
            </div>
          </div>
        )}

        {/* what is actually being searched — never leave the corpus implicit */}
        {status?.available && q && (
          <p className="pt-1 text-2xs text-muted">
            {t('Searching {n} passages', { n: (status.chunks ?? 0).toLocaleString() })}
            {status.byCorpus && <> · {Object.entries(status.byCorpus).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(' · ')}</>}
            {' '}· {t('index derived from PostgreSQL')}
            {status.visual?.available && (
              <> · {t('{n} scanned pages via {model}', { n: (status.visual.pages ?? 0).toLocaleString(), model: status.visual.model?.split('/').pop() ?? '' })}</>
            )}
          </p>
        )}
      </div>
    </>
  );
}

function FacetGroup({ title, rows, active, onPick }: {
  title: string; rows: { key: string; label: string; value: number; hue: Hue }[]; active: string; onPick: (k: string) => void;
}) {
  const t = useT();
  if (!rows.length) return null;
  const top = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      <div className="sec-eyebrow mb-2">{t(title)}</div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.key}>
            <button type="button" onClick={() => onPick(r.key)} aria-pressed={active === r.key}
                    className={cn('w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-slate-50', active === r.key && 'bg-brand-50 ring-1 ring-brand-200')}>
              <span className="flex items-center gap-2 text-[12.5px]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: HUES[r.hue].hex }} />
                <span className="min-w-0 flex-1 truncate text-ink-2">{t(r.label)}</span>
                <span className="font-semibold tabular-nums text-ink">{r.value}</span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-slate-100">
                <span className="block h-full rounded-full" style={{ width: `${(r.value / top) * 100}%`, background: HUES[r.hue].hex }} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function VisualCard({ v }: { v: VisualHit }) {
  const navigate = useNavigate();
  const t = useT();
  return (
    <div className="card flex items-start gap-3 p-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg" style={{ background: `${HUES.teal.hex}17`, color: HUES.teal.hex }}>
        <ImageIcon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <button
          onClick={() => v.app_path && navigate(v.app_path)}
          className="block w-full truncate text-left text-[13px] font-semibold text-ink hover:text-brand-600"
        >
          {v.title || v.regulation_id}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <span>{t('page')} <b className="text-ink-2">{v.page_no}</b></span>
          <HueChip hue="teal" icon="FileSearch">{t('Visual match')}</HueChip>
        </div>
        {/* Say plainly that there is no text here — the reader must open the source */}
        <p className="mt-1 text-[11.5px] text-muted">
          {t('Page match only; no text was extracted.')}{' '}
          {v.url && (
            <a href={v.url} target="_blank" rel="noreferrer" className="font-medium text-brand-600 hover:underline">
              {t('Open the source to read it →')}
            </a>
          )}
        </p>
      </div>
    </div>
  );
}

function Hit({ h, q }: { h: RagHit; q: string }) {
  const navigate = useNavigate();
  const t = useT();
  const src = sourceOf(h.source_table);
  const corp = corpusOf(h.corpus);
  return (
    <div className="card overflow-hidden transition hover:border-slate-300">
      <div className="flex items-start gap-3 px-5 pt-4">
        <HueTile icon={src.icon} hue={src.hue} size="md" />
        <div className="min-w-0 flex-1">
          <button
            onClick={() => h.app_path && navigate(h.app_path)}
            className="block w-full truncate text-left text-[14px] font-semibold text-ink hover:text-brand-600"
          >
            {h.title || h.source_id}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <HueChip hue={corp.hue} icon={corp.icon}>{t(corp.label)}</HueChip>
            <HueChip hue={src.hue}>{t(src.label)}{h.section_number ? ` · §${h.section_number}` : ''}</HueChip>
            {h.domain && <span className="pill bg-slate-100 text-slate-600">{h.domain}</span>}
            {h.matched_by.split('+').includes('reference') && (
              <HueChip hue="blue" icon="Hash">{t('Reference match')}</HueChip>
            )}
          </div>
        </div>
      </div>

      <p className="max-w-[80ch] px-5 pt-3 text-[13px] leading-relaxed text-ink-2">
        <Highlight text={h.content.slice(0, 620)} q={q} />
        {h.content.length > 620 && <span className="text-muted">…</span>}
      </p>

      {/* where to read this passage in full */}
      {h.url || h.app_path ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-slate-50/60 px-5 py-2 text-[11.5px]">
          {h.url && (
            <a href={h.url} target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline">
              {t('Official source')} <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {h.app_path && (
            <button onClick={() => navigate(h.app_path!)} className="btn btn-outline btn-sm h-7">
              {t('Open')} <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : <div className="pb-4" />}
    </div>
  );
}

/** Highlights query words in the passage — no rewriting of the source text. */
function Highlight({ text, q }: { text: string; q: string }) {
  const words = q.split(/\s+/).filter((w) => w.length > 3).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${words.join('|')})`, 'gi'));
  const set = new Set(words.map((w) => w.toLowerCase()));
  return <>{parts.map((p, i) =>
    set.has(p.toLowerCase())
      ? <mark key={i} className="rounded-sm bg-amber-100 px-0.5 font-semibold text-ink">{p}</mark>
      : <span key={i}>{p}</span>)}</>;
}

export default KnowledgePage;
