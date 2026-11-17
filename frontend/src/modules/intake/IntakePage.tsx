/**
 * Document intake — upload a folder (or connect one) and every document in it is
 * sorted into the company structure: read, split when one file holds several,
 * typed (policy, SOP, form…), placed in its department and linked to the people
 * it names. Confident documents are filed straight away; the rest wait on the
 * upload's review screen with the reason.
 */
import { useRef, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check, ChevronRight, FileSearch, Files, FolderOpen, FolderTree, History, Link2, ListChecks, Plug, ShieldCheck, Split,
  Upload, UploadCloud, Users, Workflow, X, type LucideIcon,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useEmbedded } from '@/modules/onboarding/embedded';
import { CardHead } from '@/modules/onboarding/AddDataUi';
import { Callout, EmptyState, Skeleton } from '@/components/ui/primitives';
import { can, useMe } from '@/services/authApi';
import { uploadFolder } from '@/services/integrationsApi';
import { useIntakeBatches, useStartIntake, when, type IntakeBatch } from '@/services/intakeApi';
import { tx, useT } from '@/i18n';

const ACCEPT = '.pdf,.docx,.doc,.txt,.md,.xlsx,.png,.jpg,.jpeg,.tif,.tiff,.zip,.pptx,.rtf,.odt';
/** What happens to each document: [icon, step, what it does, colour]. */
const STEPS: [LucideIcon, string, string, string][] = [
  [FileSearch, tx('Read'), tx('Word, PDF, scanned PDFs and photos (OCR), Excel, text and the files inside a .zip'), '#0071e3'],
  [Split, tx('Split'), tx('a manual or forms pack that holds many documents becomes one record each'), '#30b0c7'],
  [ListChecks, tx('Sort'), tx('policy, SOP, form, register, plan, licence, minutes… from its code, title and layout'), '#5856d6'],
  [FolderTree, tx('Place'), tx('in its department — from what it says, its code prefix (NUR → Nursing) or its folder'), '#8b5cf6'],
  [Users, tx('People'), tx('“Prepared / Approved by”, owners and custodians, matched to the employee directory'), '#ff9f0a'],
  [Link2, tx('Link'), tx('an SOP to the policy it names, a form to the SOP that uses it'), '#34c759'],
];
/** Shapes a folder can arrive in that need no tidying first. */
const FINE = [tx('Folders named after people'), tx('Files called scan0001.pdf'), tx('One manual holding forty SOPs')];
/** The promises the sorting keeps. */
const RULES = [
  tx('Confident documents are filed straight away, with verification pending'),
  tx('A department your structure lacks is proposed, never created on its own'),
  tx('A code already on record is not filed twice'),
];
/** The two ways to choose documents: [icon, title, line, gradient, colour]. */
const CHOICES: { key: 'folder' | 'loose'; icon: LucideIcon; title: string; line: string; tile: string; hex: string }[] = [
  { key: 'folder', icon: FolderOpen, title: tx('A folder'), line: tx('Its sub-folders are kept — they help place each document'),
    tile: 'bg-gradient-to-br from-amber-400 to-orange-500', hex: '#f59e0b' },
  { key: 'loose', icon: Upload, title: tx('Files or a .zip'), line: tx('Pick loose files, or one .zip that holds them'),
    tile: 'bg-gradient-to-br from-indigo-500 to-violet-600', hex: '#6366f1' },
];

export function IntakePage() {
  const t = useT();
  const embedded = useEmbedded(); // a tab of Add data, which draws the header
  const { data: me } = useMe();
  const allowed = can(me, 'approve');
  const nav = useNavigate();
  const batches = useIntakeBatches();
  const start = useStartIntake();
  const folder = useRef<HTMLInputElement>(null);
  const loose = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState('');
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const size = files.reduce((n, f) => n + f.size, 0);
  const items = batches.data?.items ?? [];

  const pick = (list: FileList | null) => {
    const f = Array.from(list ?? []).filter((x) => !x.name.startsWith('.') && !x.name.startsWith('~$'));
    if (!f.length) return;
    setFiles(f);
    const top = (f[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0];
    if (!label) setLabel(top || 'Uploaded documents');
  };

  const go = async () => {
    setErr('');
    try {
      setBusy(t('Uploading {pct}%', { pct: 0 })); setPct(0);
      const up = await uploadFolder(files, label || 'Uploaded documents', (p) => { setBusy(t('Uploading {pct}%', { pct: p })); setPct(p); });
      setBusy(t('Starting to sort…')); setPct(100);
      const b = await start.mutateAsync({ path: up.path, label: label || 'Uploaded documents' });
      nav(`/intake/${b.id}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Upload failed'));
    } finally { setBusy(''); setPct(null); }
  };

  return (
    <div>
      {!embedded && (
        <Topbar title="Document intake" icon="Files"
                subtitle="Upload a folder of the hospital's documents in whatever shape it is. Each document is read, sorted and filed in its department; anything unsure waits here for you." />
      )}
      <div className="space-y-5 p-4 sm:p-6">
        {!allowed && (
          <Callout tone="amber" icon="Lock" title={t('Compliance managers and admins only')}>
            {t('Filing documents into the company structure needs the compliance manager role. You can still read past uploads below.')}
          </Callout>
        )}

        {allowed && (
          <section className="card ad-rise overflow-hidden">
            <div className="grid lg:grid-cols-2 2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              {/* ---- choose and upload */}
              <div className="flex flex-col border-b border-line p-5 lg:border-b-0 lg:border-r">
                <CardHead icon={UploadCloud} hex="#0071e3" title={t('Upload documents')}
                  note={t('Choose a folder — no renaming or re-arranging first')} />
                <div className="grid gap-3 sm:grid-cols-2">
                  {CHOICES.map((c, i) => (
                    <button key={c.key} type="button" disabled={!!busy}
                            onClick={() => (c.key === 'folder' ? folder : loose).current?.click()}
                            className="ad-choice ad-rise !flex-col !items-start !gap-3 !p-[18px]" style={{ '--c': c.hex, '--d': `${80 + i * 80}ms` } as CSSProperties}>
                      <span className={`ad-ic grid h-[52px] w-[52px] shrink-0 place-items-center rounded-2xl text-white shadow-sm ${c.tile}`}>
                        <c.icon className="h-6 w-6" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
                          {t(c.title)}
                          {c.key === 'folder' && (
                            <span className="ad-pop rounded-full bg-success-50 px-1.5 py-px text-[11px] font-semibold text-success-600"
                                  style={{ '--d': '350ms' } as CSSProperties}>{t('Best')}</span>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-snug text-muted">{t(c.line)}</span>
                      </span>
                      <ChevronRight className="ad-go absolute right-4 top-5 h-4 w-4" aria-hidden="true" />
                    </button>
                  ))}
                  <input ref={folder} type="file" multiple className="hidden"
                         {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                         onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
                  <input ref={loose} type="file" multiple accept={ACCEPT} className="hidden"
                         onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
                </div>
                <div className="mt-4 rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-[12px] font-semibold text-ink-2">{t('No tidying needed — all of these are fine')}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {FINE.map((f, i) => (
                      <span key={f} className="ad-pop inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[12px] text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.08)]"
                            style={{ '--d': `${300 + i * 70}ms` } as CSSProperties}>
                        <Check className="h-3.5 w-3.5 text-success-600" aria-hidden="true" />{t(f)}
                      </span>
                    ))}
                  </div>
                </div>

                {files.length > 0 && (
                  <div className="ad-open mt-4 rounded-2xl border border-brand-200 bg-brand-50/40 p-4">
                    <div className="flex items-center gap-3">
                      <span className="ad-pop grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white text-brand-600 shadow-sm">
                        <Files className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-semibold text-ink">
                          {files.length === 1
                            ? t('1 file · {size} MB', { size: (size / 1048576).toFixed(1) })
                            : t('{n} files · {size} MB', { n: files.length.toLocaleString(), size: (size / 1048576).toFixed(1) })}
                        </div>
                        <div className="text-[11.5px] text-muted">{t('Ready to upload and sort')}</div>
                      </div>
                      {!busy && (
                        <button className="btn btn-sm btn-ghost" onClick={() => setFiles([])}>
                          <X className="h-3.5 w-3.5" aria-hidden="true" /> {t('Clear')}
                        </button>
                      )}
                    </div>
                    <label className="mt-3 block text-[12px] font-medium text-ink-2">{t('Name this upload')}
                      <input className="input mt-1 w-full" value={label} onChange={(e) => setLabel(e.target.value)}
                             placeholder={t('e.g. Quality department documents, March 2026')} />
                    </label>
                    {pct != null && (
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                        <i className="ad-sheen block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600 transition-[width] duration-300"
                           style={{ width: `${Math.max(3, pct)}%` }} />
                      </div>
                    )}
                    <button className="btn btn-primary mt-3" onClick={go} disabled={!!busy}>
                      <UploadCloud className="h-4 w-4" aria-hidden="true" /> {busy || t('Upload and sort')}
                    </button>
                  </div>
                )}
                {err && <div className="ad-open mt-3"><Callout tone="red" title={t('The upload did not finish')}>{err}</Callout></div>}
                <p className="mt-auto flex items-start gap-1.5 pt-4 text-[12px] leading-snug text-muted">
                  <Plug className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {t('A connected folder under Integrations is sorted the same way every time it syncs.')}
                </p>
              </div>

              {/* ---- what happens next */}
              <div className="bg-slate-50/50 p-5">
                <CardHead icon={Workflow} hex="#8b5cf6" title={t('What happens to each document')} />
                <ol className="ad-steps space-y-3">
                  {STEPS.map(([I, title, d, hex], i) => (
                    <li key={title} className="ad-rise relative flex gap-3" style={{ '--d': `${150 + i * 80}ms` } as CSSProperties}>
                      <span className="ad-pop relative z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full text-white ring-4 ring-[#fcfdfe]"
                            style={{ background: hex, '--d': `${220 + i * 80}ms` } as CSSProperties}>
                        <I className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 pt-0.5 text-[12.5px] leading-snug">
                        <b className="block text-[13px] font-semibold text-ink">{t(title)}</b>
                        <span className="text-muted">{t(d)}</span>
                      </div>
                    </li>
                  ))}
                </ol>
                <ul className="mt-4 space-y-1.5 border-t border-line pt-3.5">
                  {RULES.map((r, i) => (
                    <li key={r} className="ad-rise flex items-start gap-2 text-[12px] leading-snug text-ink-2" style={{ '--d': `${650 + i * 80}ms` } as CSSProperties}>
                      <ShieldCheck className="mt-px h-3.5 w-3.5 shrink-0 text-success-600" aria-hidden="true" />{t(r)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        {/* ---- past uploads */}
        <section className="card ad-rise overflow-hidden" style={{ '--d': '120ms' } as CSSProperties}>
          <div className="px-5 pt-5">
            <CardHead icon={History} hex="#0071e3" title={t('Uploads')}
              note={t('Newest first · open one to see how its documents were sorted')} />
          </div>
          {batches.isLoading ? <div className="border-t border-line"><Skeleton rows={4} /></div> : items.length === 0 ? (
            <div className="border-t border-line">
              <EmptyState icon="Files" title={t('Nothing uploaded yet')}
                          hint={t('Upload a folder above, or connect one under Integrations — its documents appear here, sorted.')} />
            </div>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {items.map((b, i) => <BatchRow key={b.id} b={b} index={i} onOpen={() => nav(`/intake/${b.id}`)} />)}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/** Where an upload's documents went: [key, label, colour]. */
const SPLIT: ['saved' | 'review' | 'on_record', string, string][] = [
  ['saved', tx('Filed'), '#34c759'], ['review', tx('To review'), '#ff9f0a'], ['on_record', tx('On record'), '#a1a1a6'],
];

function BatchRow({ b, index, onOpen }: { b: IntakeBatch; index: number; onOpen: () => void }) {
  const t = useT();
  const running = b.status === 'RUNNING';
  const [state, hex] = running ? [t('Sorting {done}/{total}', { done: b.files_done, total: b.files_total || '…' }), '#0071e3']
    : b.status === 'FAILED' ? [t('Failed'), '#dc2626']
    : b.status === 'UNDONE' ? [t('Undone'), '#94a3b8']
    : b.review ? [t('Waiting for review'), '#f59e0b']
    : [t('Done'), '#16a34a'];
  const whole = Math.max(1, b.items, b.saved + b.review + b.on_record);
  const SourceIcon = b.integration_id ? Plug : FolderOpen;
  return (
    <li>
      <button type="button" onClick={onOpen}
              className="ad-row ad-rise group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 px-5 py-3.5 text-left md:grid-cols-[auto_minmax(0,1fr)_minmax(180px,280px)_140px_16px]"
              style={{ '--c': hex, '--d': `${180 + index * 60}ms` } as CSSProperties}>
        <span className="ad-ic grid h-10 w-10 place-items-center rounded-xl"
              style={{ background: `color-mix(in srgb, ${hex} 12%, white)`, color: hex }}>
          <SourceIcon className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{b.label}</span>
          <span className="block truncate text-[11.5px] text-muted">
            {b.integration_id ? t('from a connected folder') : t('uploaded')} · {b.created_by.replace(/^integration:/, `${t('connection')}: `)} · {when(b.created_at)}
          </span>
        </span>
        <span className="hidden min-w-0 md:block">
          {running ? (
            <span className="block h-2 overflow-hidden rounded-full bg-slate-100">
              <i className="ad-sheen block h-full rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                 style={{ width: `${b.files_total ? Math.max(4, (b.files_done / b.files_total) * 100) : 4}%` }} />
            </span>
          ) : b.status === 'FAILED' ? (
            <span className="block truncate text-[12px] text-critical-600" title={b.message}>{b.message || t('Failed')}</span>
          ) : b.items ? (
            <>
              <span className="flex h-2 overflow-hidden rounded-full bg-slate-100">
                {SPLIT.map(([k, , c], i) => b[k] > 0 && (
                  <i key={k} className="ad-grow block h-full" style={{ width: `${(b[k] / whole) * 100}%`, background: c, '--d': `${index * 60 + i * 120}ms` } as CSSProperties} />
                ))}
              </span>
              <span className="mt-1.5 flex flex-wrap gap-x-3 text-[11.5px] text-muted">
                {SPLIT.map(([k, l, c]) => b[k] > 0 && (
                  <span key={k} className="inline-flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} aria-hidden="true" />
                    <b className="font-semibold tabular-nums text-ink">{b[k].toLocaleString()}</b> {t(l)}
                  </span>
                ))}
              </span>
            </>
          ) : (
            <span className="text-[12px] text-muted">—</span>
          )}
        </span>
        <span className="pill justify-self-start whitespace-nowrap" style={{ background: `color-mix(in srgb, ${hex} 12%, white)`, color: `color-mix(in srgb, ${hex} 85%, black)` }}>
          <span className={running ? 'ad-pulse h-1.5 w-1.5 rounded-full bg-current' : 'h-1.5 w-1.5 rounded-full bg-current'}
                style={{ '--c': hex } as CSSProperties} aria-hidden="true" />
          {state}
        </span>
        <ChevronRight className="hidden h-4 w-4 text-muted transition-transform duration-300 group-hover:translate-x-0.5 md:block" aria-hidden="true" />
      </button>
    </li>
  );
}
