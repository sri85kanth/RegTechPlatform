import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  UploadCloud, FileSpreadsheet, CheckCircle2, AlertTriangle, Database, Network, Files, ListChecks,
  Download, X, ArrowRight, ArrowLeft, SkipForward, type LucideIcon,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useData } from '@/app/store/data';
import {
  buildEntities, templateFor, readHeaders, suggestMapping, applyMapping,
  MAPPABLE_FIELDS, detectDelimiter, TYPE_TO_DOMAIN, type ParseResult, type FieldKey,
} from '@/services/csvImport';
import { routeFile } from '@/services/fileRouter';
import { SECTIONS } from './sections';
import { GuidedForm } from './GuidedForm';
import { useEmbedded } from './embedded';
import { Icon } from '@/config/icons';
import { toneFor } from '@/config/tones';
import { cn } from '@/utils/ui';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useLiquidPill } from '@/components/ui/motion';
import { MiniRing, StatTile } from './AddDataUi';
import { useT } from '@/i18n';

type Status = 'pending' | 'done' | 'skipped';

/**
 * step index: one per entity section, then review. The documents behind the
 * records are uploaded on the Documents tab, which sorts them — this wizard
 * no longer has an upload step of its own.
 */
const REVIEW_STEP = SECTIONS.length;

export function OnboardingPage() {
  const t = useT();
  const navigate = useNavigate();
  const embedded = useEmbedded(); // a tab of Add data, which draws the header
  const { entities, relationships, importEntities } = useData();

  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});

  // per-section parse state, reset when the step changes
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<ParseResult | null>(null);
  const [parseError, setParseError] = useState('');
  const [rawText, setRawText] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<FieldKey, string>>({} as Record<FieldKey, string>);
  const [delimiter, setDelimiter] = useState(',');

  const existingIds = useMemo(() => new Set(entities.map((e) => e.id)), [entities]);
  const section = step < SECTIONS.length ? SECTIONS[step] : null;

  const clearParse = () => {
    setResult(null); setFileName(''); setParseError('');
    setRawText(''); setHeaders([]); setMapping({} as Record<FieldKey, string>);
  };
  const goto = (i: number) => { clearParse(); setStep(i); };

  const readCsv = (file: File) => {
    if (!section) return;
    setParseError('');
    const verdict = routeFile(file);
    if (verdict.route !== 'records' || !verdict.readyNow) {
      setParseError(`${verdict.format}: ${verdict.note ?? verdict.action}`);
      setFileName(file.name);
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      try {
        const text = String(r.result ?? '');
        const hdrs = readHeaders(text);
        const guess = suggestMapping(hdrs);
        setRawText(text); setHeaders(hdrs); setMapping(guess);
        setDelimiter(detectDelimiter(text));
        setResult(buildEntities(applyMapping(text, guess), existingIds, section.type));
        setFileName(file.name);
      } catch (err) { setParseError(err instanceof Error ? err.message : t('Could not read that file.')); }
    };
    r.onerror = () => setParseError(t('Could not read that file.'));
    r.readAsText(file);
  };

  /** re-run the parse when the user changes a column mapping */
  const remap = (field: FieldKey, header: string) => {
    if (!section) return;
    const next = { ...mapping, [field]: header };
    setMapping(next);
    setResult(buildEntities(applyMapping(rawText, next), existingIds, section.type));
  };

  const importSection = () => {
    if (!section || !result) return;
    const list = result.rows.map((r) => r.entity).filter(Boolean) as NonNullable<(typeof result.rows)[number]['entity']>[];
    if (list.length) importEntities(list, `${section.label} — ${fileName}`);
    setCounts((c) => ({ ...c, [section.id]: (c[section.id] ?? 0) + list.length }));
    setStatus((s) => ({ ...s, [section.id]: 'done' }));
    goto(step + 1);
  };

  const skipSection = () => {
    if (!section) return;
    setStatus((s) => ({ ...s, [section.id]: s[section.id] === 'done' ? 'done' : 'skipped' }));
    goto(step + 1);
  };

  const downloadTemplate = () => {
    if (!section) return;
    const blob = new Blob([templateFor(section.examples)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${section.id}-template.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const totalImported = Object.values(counts).reduce((a, b) => a + b, 0);

  /**
   * What is already in the Brain for a section — only for sections that own a
   * whole domain. The company-context sections (entities, locations, products,
   * activities) share one domain, so a per-section count there would be a guess.
   */
  const inBrain = useMemo(() => {
    const byDomain: Record<string, number> = {};
    entities.forEach((e) => { byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1; });
    const shared = new Set(SECTIONS.map((s) => TYPE_TO_DOMAIN[s.type])
      .filter((d, _i, all) => all.indexOf(d) !== all.lastIndexOf(d)));
    const out: Record<string, number | undefined> = {};
    SECTIONS.forEach((s) => {
      const d = TYPE_TO_DOMAIN[s.type];
      out[s.id] = d && !shared.has(d) ? byDomain[d] ?? 0 : undefined;
    });
    return out;
  }, [entities]);

  return (
    <>
      {!embedded && (
        <Topbar
          title="Import Data"
          subtitle="One section at a time — upload what you have, skip what you don't"
          icon="UploadCloud"
          tone={toneFor('overview')}
          hideSearch
          actions={<button className="btn" onClick={() => navigate('/company-setup')}>{t('Company setup')}</button>}
        />
      )}

      <div className="w-full space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile index={0} icon={Database} hex="#0071e3" label={t('Records in the Brain')} value={entities.length}
                    foot={t('company records on file')} />
          <StatTile index={1} icon={Network} hex="#8b5cf6" label={t('Links between records')} value={relationships.length}
                    foot={t('impact travels along these links')} />
          <StatTile index={2} icon={UploadCloud} hex="#16a34a" label={t('Imported this session')} value={totalImported}
                    foot={t('Records from CSV files')} />
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[272px_minmax(0,1fr)]">
          <StepRail step={step} status={status} counts={counts} onGoto={goto} inBrain={inBrain} />

          <div className="min-w-0">
            {section && (
              <SectionStep
                key={section.id}
                index={step}
                total={REVIEW_STEP + 1}
                section={section}
                fileName={fileName}
                result={result}
                parseError={parseError}
                alreadyImported={counts[section.id] ?? 0}
                onFile={readCsv}
                onClear={clearParse}
                onTemplate={downloadTemplate}
                headers={headers}
                mapping={mapping}
                delimiter={delimiter}
                onRemap={remap}
                onImport={importSection}
                onSkip={skipSection}
                onBack={step > 0 ? () => goto(step - 1) : undefined}
              />
            )}

            {step === REVIEW_STEP && (
              <ReviewStep
                counts={counts} status={status} total={totalImported}
                onBack={() => goto(REVIEW_STEP - 1)}
                onFinish={() => navigate('/graph')}
                onDocuments={() => navigate('/add-data/documents')}
                onFix={(id) => goto(SECTIONS.findIndex((s) => s.id === id))}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/* ---------------- vertical step rail ---------------- */
function StepRail({
  step, status, counts, onGoto, inBrain,
}: {
  step: number; status: Record<string, Status>; counts: Record<string, number>; onGoto: (i: number) => void;
  inBrain: Record<string, number | undefined>;
}) {
  const t = useT();
  const box = useRef<HTMLOListElement>(null);
  // the highlight flows from the step you left to the one you opened
  const pill = useLiquidPill(box, '[aria-current="step"]', 'y', [step]);
  const rows = [
    ...SECTIONS.map((s, i) => ({
      i, label: s.label, icon: s.icon, hex: s.hex,
      state: status[s.id] ?? 'pending',
      note: counts[s.id] ? t('{n} imported', { n: counts[s.id].toLocaleString() }) : status[s.id] === 'skipped' ? t('Skipped') : '',
      brain: inBrain[s.id],
    })),
    { i: REVIEW_STEP, label: 'Review', icon: 'CheckCircle2', hex: '#15803d', state: 'pending' as Status, note: '', brain: undefined },
  ];
  const finished = SECTIONS.filter((s) => status[s.id] === 'done').length;

  return (
    <div className="card ad-rise sticky top-[156px] flex h-fit max-h-[calc(100vh-172px)] flex-col overflow-hidden" style={{ '--d': '120ms' } as CSSProperties}>
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-gradient-to-br from-brand-50 via-white to-violet-50/70 px-4 py-3.5">
        <MiniRing part={finished} whole={SECTIONS.length} hex="#16a34a" size={60} thickness={6}>
          <span className="text-[15px] font-semibold tabular-nums text-ink">{finished}<span className="text-[11px] font-medium text-muted">/{SECTIONS.length}</span></span>
        </MiniRing>
        <div className="min-w-0 text-[12px] leading-snug text-ink-2">
          <b className="block text-[13.5px] text-ink">{t('Your progress')}</b>
          {t('Step {n} of {total} — skip anything you do not have.', { n: Math.min(step + 1, rows.length), total: rows.length })}
        </div>
      </div>
      <ol ref={box} className="relative min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
        <span aria-hidden="true" className="liquid-pill left-2 right-2 rounded-xl bg-brand-50 ring-1 ring-brand-200" style={pill} />
        {rows.map((r, idx) => {
          const current = r.i === step;
          const done = r.state === 'done';
          const skipped = r.state === 'skipped';
          return (
            <li key={r.label} className="relative">
              {idx < rows.length - 1 && (
                <span aria-hidden="true" className={cn('absolute left-[23px] top-[38px] h-[calc(100%-32px)] w-0.5 rounded-full transition-colors duration-500', done ? 'bg-success-500' : 'bg-line')} />
              )}
              <button
                onClick={() => onGoto(r.i)}
                aria-current={current ? 'step' : undefined}
                className={cn('group relative z-[1] flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors',
                  !current && 'hover:bg-slate-50/80')}
              >
                <span className="relative shrink-0">
                  <span className={cn('ad-ic grid h-8 w-8 place-items-center rounded-lg ring-2 ring-white', skipped && 'opacity-50')}
                        style={current ? { background: r.hex, color: '#fff' } : { background: `${r.hex}1f`, color: r.hex }}>
                    <Icon name={r.icon} className="h-4 w-4" />
                  </span>
                  <span className={cn('absolute -right-1.5 -top-1.5 grid h-4 min-w-4 place-items-center rounded-full px-0.5 text-[10.5px] font-bold leading-none text-white ring-2 ring-white',
                    done ? 'ad-pop bg-success-500' : current ? 'bg-brand-600' : 'bg-slate-400')}>
                    {done ? <CheckCircle2 className="h-2.5 w-2.5" /> : skipped ? '–' : r.i + 1}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block truncate text-[12.5px]', current ? 'font-semibold text-brand-700' : done ? 'font-medium text-ink' : 'text-ink-2')}>
                    {t(r.label)}
                  </span>
                  {r.note
                    ? <span className={cn('block truncate text-[11px]', done ? 'font-medium text-success-600' : 'text-muted')}>{r.note}</span>
                    : r.brain != null && <span className="block truncate text-[11px] text-muted">{t('{n} already in the Brain', { n: r.brain.toLocaleString() })}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---------------- shared drop zone ---------------- */
function DropZone({ accept, multiple, onFiles, title, hint, icon: I }: {
  accept: string; multiple?: boolean; onFiles: (f: File[]) => void; title: string; hint: string; icon: typeof UploadCloud;
}) {
  const t = useT();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = Array.from(e.dataTransfer.files); if (f.length) onFiles(multiple ? f : [f[0]]); }}
      className={cn('flex flex-col items-center justify-center rounded-card border-2 border-dashed px-6 py-8 text-center transition-colors',
        over ? 'border-brand-500 bg-brand-50' : 'border-line-2 bg-gradient-to-b from-slate-50 to-white hover:border-brand-300')}
    >
      <span className={cn('grid h-12 w-12 place-items-center rounded-full', over ? 'bg-brand-200 text-brand-700' : 'bg-brand-100 text-brand-600')}>
        <I className="h-6 w-6" />
      </span>
      <div className="mt-3 text-sm font-semibold text-ink">{title}</div>
      <p className="mt-1 max-w-sm text-[12.5px] text-muted">{hint}</p>
      <button className="btn btn-outline mt-4" onClick={() => input.current?.click()}>{t(multiple ? 'Choose files' : 'Choose file')}</button>
      <input ref={input} type="file" accept={accept} multiple={multiple} className="hidden"
        onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) onFiles(f); e.target.value = ''; }} />
    </div>
  );
}

/* ---------------- one entity section ---------------- */
function SectionStep({
  index, total, section, fileName, result, parseError, alreadyImported,
  headers, mapping, delimiter, onRemap,
  onFile, onClear, onTemplate, onImport, onSkip, onBack,
}: {
  index: number; total: number; section: (typeof SECTIONS)[number];
  fileName: string; result: ParseResult | null; parseError: string; alreadyImported: number;
  headers: string[]; mapping: Record<FieldKey, string>; delimiter: string;
  onRemap: (f: FieldKey, h: string) => void;
  onFile: (f: File) => void; onClear: () => void; onTemplate: () => void;
  onImport: () => void; onSkip: () => void; onBack?: () => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'guided' | 'csv'>('guided');
  const [addedHere, setAddedHere] = useState(0);
  const blocked = !!result?.missingColumns.length;
  return (
    <div className="card ad-tab-in overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5"
           style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${section.hex} 7%, white), #fff 60%)` }}>
        <div className="flex min-w-0 items-start gap-3.5">
          <span className="ad-pop grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-white shadow-sm"
                style={{ background: `linear-gradient(135deg, ${section.hex}, color-mix(in srgb, ${section.hex} 68%, black))` }}>
            <Icon name={section.icon} className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: section.hex }}>
              {t('Step {n} of {total}', { n: index + 1, total })} · {t(section.label)}
            </div>
            <h3 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">{t(section.question)}</h3>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-muted">{t(section.help)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <SegmentedControl
            ariaLabel="How to add records"
            options={[{ key: 'guided', label: 'Answer questions' }, { key: 'csv', label: 'Upload CSV' }]}
            value={mode}
            onChange={setMode}
          />
          {mode === 'csv' && <button className="btn btn-sm" onClick={onTemplate}><Download className="h-3.5 w-3.5" /> {t('Template')}</button>}
        </div>
      </div>

      <div className="space-y-4 p-4 sm:p-5">
        {alreadyImported > 0 && (
          <div className="flex items-center gap-2 rounded-card border border-success-500/25 bg-success-50 px-3 py-2 text-[12.5px] text-success-600">
            <CheckCircle2 className="h-4 w-4 shrink-0" /> {t('{n} already imported in this section — uploading again adds more.', { n: alreadyImported.toLocaleString() })}
          </div>
        )}

        {mode === 'guided' && (
          <GuidedForm section={section} onAdded={() => setAddedHere((n) => n + 1)} />
        )}

        {mode === 'csv' && !result && !parseError && (
          <>
            <ExampleTable examples={section.examples} />
            <DropZone
              icon={FileSpreadsheet}
              accept=".csv,text/csv"
              title={t('Upload your {section} CSV', { section: t(section.label).toLowerCase() })}
              hint={t('Only `name` is required. Optional: description, owner, criticality, entity_id. Note: CSV cannot carry connections — use Answer questions for those.')}
              onFiles={(f) => onFile(f[0])}
            />
          </>
        )}

        {mode === 'csv' && parseError && (
          <div className="flex items-start gap-2 rounded-card border border-critical-500/25 bg-critical-50 p-3 text-[13px] text-critical-600">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {parseError}
          </div>
        )}

        {mode === 'csv' && result && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="pill bg-slate-100 text-slate-600"><FileSpreadsheet className="h-3.5 w-3.5" /> {fileName}</span>
              <span className="pill bg-success-50 text-success-600">{t('{n} ready', { n: result.validCount.toLocaleString() })}</span>
              {result.errorCount > 0 && <span className="pill bg-critical-50 text-critical-600">{t('{n} rejected', { n: result.errorCount.toLocaleString() })}</span>}
              <button className="btn btn-sm ml-auto" onClick={onClear}><X className="h-3.5 w-3.5" /> {t('Different file')}</button>
            </div>

            {headers.length > 0 && (
              <ColumnMapper headers={headers} mapping={mapping} delimiter={delimiter} onRemap={onRemap} />
            )}

            {blocked && (
              <div className="flex items-start gap-2 rounded-card border border-critical-500/25 bg-critical-50 p-3 text-[13px] text-critical-600">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t('Missing required column')}: <b>{result.missingColumns.join(', ')}</b>. {t('Download the template above to see the expected header row.')}</span>
              </div>
            )}

            <PreviewTable result={result} />
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <button className="btn" disabled={!onBack} onClick={onBack}><ArrowLeft className="h-4 w-4" /> {t('Back')}</button>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={onSkip}><SkipForward className="h-4 w-4" /> {t('Skip this section')}</button>
            {mode === 'csv' ? (
              <button className="btn btn-primary" disabled={!result || blocked || result.validCount === 0} onClick={onImport}>
                {t('Import {n}', { n: (result?.validCount ?? 0).toLocaleString() })} <ArrowRight className="h-4 w-4" />
              </button>
            ) : (
              <button className="btn btn-primary" onClick={onSkip}>
                {addedHere > 0 ? t('Done — {n} added', { n: addedHere.toLocaleString() }) : t('Continue')} <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Map the customer's column names onto ours — their headers never match. */
function ColumnMapper({ headers, mapping, delimiter, onRemap }: {
  headers: string[]; mapping: Record<FieldKey, string>; delimiter: string;
  onRemap: (f: FieldKey, h: string) => void;
}) {
  const t = useT();
  const delimName = delimiter === ',' ? t('comma-separated') : delimiter === ';' ? t('semicolon-separated') : delimiter === '\t' ? t('tab-separated') : t('pipe-separated');
  const auto = MAPPABLE_FIELDS.filter((f) => mapping[f.key]).length;
  return (
    <div className="rounded-card border border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div>
          <div className="text-[12.5px] font-semibold text-ink">{t('Match your columns to ours')}</div>
          <div className="text-[11.5px] text-muted">
            {t('{n} of {total} matched automatically', { n: auto, total: MAPPABLE_FIELDS.length })} · {headers.length === 1 ? t('1 column found') : t('{n} columns found', { n: headers.length.toLocaleString() })} · {delimName}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {MAPPABLE_FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="field-label">
              {t(f.label)}{f.required && <span className="ml-1 text-critical-600" aria-hidden="true">*</span>}
            </span>
            <select className="input" value={mapping[f.key] ?? ''} onChange={(e) => onRemap(f.key, e.target.value)}>
              <option value="">{t('— not in my file —')}</option>
              {headers.map((h) => <option key={h} value={h}>{h}</option>)}
            </select>
            <span className="mt-1 block text-[11px] text-muted">{t(f.hint)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ExampleTable({ examples }: { examples: string[][] }) {
  const t = useT();
  return (
    <div className="rounded-card border border-line">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs font-medium text-muted">
        <Icon name="Info" className="h-3.5 w-3.5 text-brand-600" />
        {t('What goes in this section')}
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{t('Illustrative rows — not your data')}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="whitespace-nowrap border-b border-line bg-slate-50 text-xs font-medium text-muted">
              <th className="px-4 py-2">{t('Name')}</th><th className="px-4 py-2">{t('Description')}</th>
              <th className="px-4 py-2">{t('Owner')}</th><th className="px-4 py-2">{t('Criticality')}</th>
            </tr>
          </thead>
          <tbody>
            {examples.map((e) => (
              <tr key={e[0]} className="border-b border-line last:border-b-0">
                <td className="whitespace-nowrap px-4 py-2 font-medium">{t(e[0])}</td>
                <td className="px-4 py-2 text-muted"><span className="block max-w-[280px] truncate">{t(e[1])}</span></td>
                <td className="whitespace-nowrap px-4 py-2 text-muted">{e[2] || '—'}</td>
                <td className="whitespace-nowrap px-4 py-2 text-muted">{e[3] && t(e[3])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewTable({ result }: { result: ParseResult }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const rows = all ? result.rows : result.rows.slice(0, 10);
  return (
    <div className="rounded-card border border-line">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="whitespace-nowrap border-b border-line bg-slate-50 text-xs font-medium text-muted">
              <th className="px-4 py-2.5">{t('Line')}</th><th className="px-4 py-2.5">{t('Name')}</th>
              <th className="px-4 py-2.5">{t('Owner')}</th><th className="px-4 py-2.5">{t('Criticality')}</th><th className="px-4 py-2.5">{t('Status')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line} className="border-b border-line last:border-b-0 hover:bg-slate-50">
                <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-muted">{r.line}</td>
                <td className="px-4 py-2.5"><span className="block max-w-[240px] truncate font-medium" title={r.raw.name}>{r.raw.name || '—'}</span></td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{r.raw.owner || '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{r.entity?.criticality ? t(r.entity.criticality) : '—'}</td>
                <td className="px-4 py-2.5">
                  {r.errors.length ? <span className="block max-w-[280px] truncate pill bg-critical-50 text-critical-600" title={r.errors.join('; ')}>{r.errors[0]}</span>
                    : r.warnings.length ? <span className="block max-w-[280px] truncate pill bg-warning-50 text-warning-600" title={r.warnings.join('; ')}>{r.warnings[0]}</span>
                    : <span className="pill bg-success-50 text-success-600">{t('Ready')}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.rows.length > 10 && (
        <div className="border-t border-line px-4 py-2 text-center">
          <button className="text-[12.5px] font-semibold text-brand-600 hover:underline" onClick={() => setAll((v) => !v)}>
            {all ? t('Show first 10') : t('Show all {n} rows', { n: result.rows.length.toLocaleString() })}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---------------- review ---------------- */
function ReviewStep({ counts, status, total, onBack, onFinish, onFix, onDocuments }: {
  counts: Record<string, number>; status: Record<string, Status>; total: number;
  onBack: () => void; onFinish: () => void; onFix: (id: string) => void; onDocuments: () => void;
}) {
  const t = useT();
  const skipped = SECTIONS.filter((s) => (status[s.id] ?? 'pending') !== 'done');
  const done = SECTIONS.length - skipped.length;
  return (
    <div className="card ad-tab-in overflow-hidden">
      <div className="border-b border-line bg-gradient-to-br from-success-50/70 via-white to-white px-4 py-4 sm:px-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-success-600">
          {t('Step {n} of {total}', { n: REVIEW_STEP + 1, total: REVIEW_STEP + 1 })} · {t('Review')}
        </div>
        <h3 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">{t('What you brought in')}</h3>
      </div>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-line p-4">
          <MiniRing part={done} whole={SECTIONS.length} hex="#16a34a" size={84} thickness={8}>
            <span className="block text-[18px] font-semibold tabular-nums text-ink">{done}<span className="text-[12px] font-medium text-muted">/{SECTIONS.length}</span></span>
            <span className="mt-0.5 block text-[10.5px] text-muted">{t('sections')}</span>
          </MiniRing>
          <div className="grid min-w-0 flex-1 grid-cols-2 gap-3">
            <StatTile index={0} icon={Database} hex="#0071e3" label={t('Entities imported')} value={total} />
            <StatTile index={1} icon={ListChecks} hex="#16a34a" label={t('Sections completed')} value={done}
                      foot={`${Math.round((done / SECTIONS.length) * 100)}%`} />
          </div>
        </div>

        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
          {SECTIONS.map((s, i) => {
            const n = counts[s.id] ?? 0;
            const ok = (status[s.id] ?? 'pending') === 'done';
            return (
              <li key={s.id} className="ad-row ad-rise group flex items-center gap-3 px-4 py-2.5"
                  style={{ '--c': s.hex, '--d': `${120 + i * 40}ms` } as CSSProperties}>
                <span className="ad-ic grid h-8 w-8 shrink-0 place-items-center rounded-[9px]" style={{ background: `${s.hex}1f`, color: s.hex }}>
                  <Icon name={s.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{t(s.label)}</span>
                {ok ? <span className="pill bg-success-50 text-success-600"><CheckCircle2 className="h-3.5 w-3.5" />{t('{n} imported', { n: n.toLocaleString() })}</span>
                  : <span className="pill bg-slate-100 text-slate-600">{t('Not provided')}</span>}
                <button className={cn('btn btn-sm', !ok && 'btn-outline')} onClick={() => onFix(s.id)}>{ok ? t('Add more') : t('Add now')}</button>
              </li>
            );
          })}
        </ul>

        {skipped.length > 0 && (
          <div className="flex items-start gap-2 rounded-2xl border border-line bg-slate-50 p-3 text-[12.5px] text-muted">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {skipped.length === 1
                ? t("1 section left empty. Obligations can only map to entities that exist, so anything missing here simply won't be matched — you can come back and add it at any time.")
                : t("{n} sections left empty. Obligations can only map to entities that exist, so anything missing here simply won't be matched — you can come back and add it at any time.", { n: skipped.length.toLocaleString() })}
            </span>
          </div>
        )}

        <NextCard icon={Files} hex="#6366f1" onClick={onDocuments}
                  title={t('Next: upload the documents behind these records')}
                  line={t('Policies, SOPs, forms and evidence — the Documents tab reads, sorts and files each one.')} />

        <div className="flex items-center justify-between gap-2 border-t border-line pt-4">
          <button className="btn" onClick={onBack}><ArrowLeft className="h-4 w-4" /> {t('Back')}</button>
          <button className="btn btn-primary" onClick={onFinish}>{t('Open Company Graph')} <ArrowRight className="h-4 w-4" /></button>
        </div>
      </div>
    </div>
  );
}

/** A large, clickable "what to do next" tile. */
function NextCard({ icon: I, hex, title, line, onClick }: { icon: LucideIcon; hex: string; title: string; line: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ad-choice" style={{ '--c': hex } as CSSProperties}>
      <span className="ad-ic grid h-11 w-11 shrink-0 place-items-center rounded-xl text-white shadow-sm"
            style={{ background: `linear-gradient(135deg, ${hex}, color-mix(in srgb, ${hex} 68%, black))` }}>
        <I className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-[12px] leading-snug text-muted">{line}</span>
      </span>
      <ArrowRight className="ad-go h-4 w-4 shrink-0" aria-hidden="true" />
    </button>
  );
}

export default OnboardingPage;
