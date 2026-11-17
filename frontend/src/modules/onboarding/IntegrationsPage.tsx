import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  FolderOpen, Plug, Globe, RefreshCw, FlaskConical, ListOrdered, KeyRound, AlertTriangle, MinusCircle, Database, Building2,
  ShieldCheck, Activity, BarChart3, PlusCircle, Cable, Tag, Clock, ChevronDown,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useEmbedded } from './embedded';
import { toneFor } from '@/config/tones';
import { EmptyState } from '@/components/ui/primitives';
import { CountUp } from '@/components/ui/motion';
import { CardHead, MiniRing, StatTile } from './AddDataUi';
import { cn, readable } from '@/utils/ui';
import {
  STATUS_LABEL, uploadFolder, useCatalogue, useChangeIntegrationKey, useCreateIntegration, useDeleteIntegration,
  useIntegrations, useSyncIntegration, useTestIntegration,
  type ConnStatus, type Connector, type Integration, type UploadResult,
} from '@/services/integrationsApi';
import { tx, useDateLocale, useT, type TFunction } from '@/i18n';

/**
 * Connecting the systems a customer already runs.
 *
 * Two ways in, both real: a folder of documents, or an API that returns JSON
 * or CSV. Nothing here invents a connection — a card only ever reports what
 * the server last said, a key is written and never read back, and every sync
 * shows the run's own words, including the parts it could not collect.
 */
const STATUS_TONE: Record<ConnStatus, string> = {
  CONNECTED: 'bg-success-50 text-success-600',
  FAILED: 'bg-critical-50 text-critical-600',
  NEEDS_CREDENTIALS: 'bg-warning-50 text-warning-600',
  NOT_CONNECTED: 'bg-slate-100 text-ink-2',
};
const OUTCOME_TONE: Record<string, string> = {
  OK: 'bg-success-50 text-success-600',
  PARTIAL: 'bg-warning-50 text-warning-600',
  FAILED: 'bg-critical-50 text-critical-600',
};
const STATUS_HEX: Record<ConnStatus, string> = {
  CONNECTED: '#16a34a', FAILED: '#dc2626', NEEDS_CREDENTIALS: '#f59e0b', NOT_CONNECTED: '#94a3b8',
};
const OUTCOME_HEX: Record<string, string> = { OK: '#16a34a', PARTIAL: '#f59e0b', FAILED: '#dc2626' };

/**
 * Each kind of connector keeps one look — a coloured tile with its icon — on
 * the catalogue card and on every connection made from it.
 */
const CONNECTOR_LOOK: Record<string, { tile: string; hex: string; Icon: typeof Plug }> = {
  folder: { tile: 'bg-gradient-to-br from-amber-400 to-orange-500 text-white', hex: '#f59e0b', Icon: FolderOpen },
  http_csv: { tile: 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white', hex: '#6366f1', Icon: Globe },
};
const lookFor = (connector: string, auth?: string) =>
  CONNECTOR_LOOK[connector] ?? (auth === 'path'
    ? CONNECTOR_LOOK.folder
    : { tile: 'bg-gradient-to-br from-sky-500 to-blue-600 text-white', hex: '#0ea5e9', Icon: Plug });

const when = (t: TFunction, locale: string, s?: string | null) => (s ? new Date(s).toLocaleString(locale, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : t('never'));

export function IntegrationsPage() {
  const t = useT();
  const embedded = useEmbedded(); // a tab of Add data, which draws the header
  const { data: catalogue } = useCatalogue();
  const { data, isLoading } = useIntegrations();
  const create = useCreateIntegration();
  const test = useTestIntegration();
  const sync = useSyncIntegration();
  const remove = useDeleteIntegration();
  const changeKey = useChangeIntegrationKey();

  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ pct: number; note?: string } | null>(null);
  const connectors = useMemo(() => (catalogue?.connectors ?? []).filter((c) => c.ready), [catalogue]);
  const items = data?.items ?? [];

  // ---- figures, all from the connections the server returned
  const byStatus = (s: ConnStatus) => items.filter((i) => i.status === s).length;
  const attention = byStatus('FAILED') + byStatus('NEEDS_CREDENTIALS');
  const latest = (it: Integration) => (it.syncs ?? []).find((r) => r.outcome) ?? null;
  const collected = items
    .map((it) => ({ it, run: latest(it) }))
    .filter((x) => x.run)
    .map(({ it, run }) => ({ label: it.label, value: (run!.entities_written ?? 0) + (run!.documents_written ?? 0), color: lookFor(it.connector).hex, Icon: lookFor(it.connector).Icon }));
  const collectedTotal = collected.reduce((a, c) => a + c.value, 0);

  const add = async (connector: string, label: string, config: Record<string, unknown>, secret?: string) => {
    setError(null);
    try {
      await create.mutateAsync({ connector, label, config, secret });
      setAdding(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const run = async (fn: { mutateAsync: (id: string) => Promise<unknown> }, id: string) => {
    setError(null);
    try {
      await fn.mutateAsync(id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const connected = byStatus('CONNECTED');
  const notYet = byStatus('NOT_CONNECTED');
  const top = collected.sort((a, b) => b.value - a.value).slice(0, 6);
  const topMax = Math.max(1, ...top.map((c) => c.value));

  return (
    <>
      {!embedded && (
        <Topbar
          title="Integrations"
          icon="Plug"
          tone={toneFor('overview')}
          subtitle="Connect a folder or an API. Everything collected is filed under the collection name you give it, and every record keeps the source it came from."
        />
      )}

      <div className="w-full space-y-5 p-4 sm:p-6">
        {error && (
          <p role="alert" className="ad-open flex items-start gap-2 rounded-xl bg-critical-50 px-3.5 py-2.5 text-[12.5px] text-critical-600">
            <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />{error}
          </p>
        )}

        {/* ---- how the connections are doing, and what the latest runs brought in */}
        {(isLoading || items.length > 0) && (
          <section className="card ad-rise p-5">
            <div className="grid gap-5 2xl:grid-cols-2 2xl:gap-6">
              <div className="min-w-0">
                <CardHead icon={Activity} hex={attention ? '#f59e0b' : '#16a34a'} title={t('How your connections are doing')}
                  note={isLoading ? t('Reading connections…') : attention
                    ? (attention === 1 ? t('1 needs attention') : t('{n} need attention', { n: attention }))
                    : t('Everything is connected and nothing is failing')} />
                <div className="flex items-center gap-4">
                  <MiniRing part={connected} whole={items.length} hex={attention ? '#f59e0b' : '#16a34a'} size={108} thickness={10}>
                    <span className="block text-[24px] font-semibold tabular-nums text-ink">
                      <CountUp value={connected} /><span className="text-[14px] font-medium text-muted">/{items.length}</span>
                    </span>
                    <span className="mt-1 block text-[11px] font-medium text-muted">{t('connected')}</span>
                  </MiniRing>
                  <div className="grid min-w-0 flex-1 grid-cols-2 gap-2.5 lg:grid-cols-4 2xl:grid-cols-2">
                    <StatTile index={0} icon={Plug} hex="#0071e3" label={t('Connections')} value={isLoading ? null : items.length}
                      foot={connectors.length ? (connectors.length === 1 ? t('1 connector type available') : t('{n} connector types available', { n: connectors.length.toLocaleString() })) : undefined} />
                    <StatTile index={1} icon={attention ? AlertTriangle : ShieldCheck} hex={attention ? '#dc2626' : '#16a34a'} label={t('Need attention')} value={isLoading ? null : attention}
                      foot={attention ? t('{failed} failed · {keys} need a key', { failed: byStatus('FAILED'), keys: byStatus('NEEDS_CREDENTIALS') }) : t('Nothing is failing')} />
                    <StatTile index={2} icon={Database} hex="#8b5cf6" label={t('Records collected')} value={isLoading ? null : collectedTotal}
                      foot={t('in the latest runs')} />
                    <StatTile index={3} icon={MinusCircle} hex="#94a3b8" label={t('Not connected yet')} value={isLoading ? null : notYet}
                      foot={t('Added, never tested')} />
                  </div>
                </div>
              </div>

              <div className="min-w-0 border-t border-line pt-5 2xl:border-l 2xl:border-t-0 2xl:pl-6 2xl:pt-0">
                <CardHead icon={BarChart3} hex="#8b5cf6" title={t('Collected in the latest run')} note={t('records and documents, by connection')} />
                {top.length ? (
                  <ul className="grid gap-x-8 gap-y-3 lg:grid-cols-2 2xl:grid-cols-1">
                    {top.map((c, i) => (
                      <li key={c.label} className="ad-rise" style={{ '--d': `${120 + i * 70}ms` } as CSSProperties}>
                        <div className="flex items-center gap-2 text-[12.5px]">
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white" style={{ background: c.color }} aria-hidden="true">
                            <c.Icon className="h-3.5 w-3.5" />
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium text-ink" title={c.label}>{c.label}</span>
                          <span className="font-semibold tabular-nums text-ink"><CountUp value={c.value} /></span>
                        </div>
                        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100">
                          <i className="ad-grow block h-full rounded-full"
                             style={{ width: `${Math.max(2, (c.value / topMax) * 100)}%`, background: `linear-gradient(90deg, color-mix(in srgb, ${c.color} 45%, white), ${c.color})`, '--d': `${i * 80}ms` } as CSSProperties} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="grid h-[108px] place-items-center rounded-2xl bg-slate-50 px-4 text-center text-[12.5px] text-muted">
                    {isLoading ? t('Reading connections…') : t('No connection has finished a sync yet — press Sync on one below.')}
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ---- adding one */}
        <section id="add-connection" className="card ad-rise scroll-mt-28 p-5" style={{ '--d': '80ms' } as CSSProperties}>
          <CardHead icon={PlusCircle} hex="#0071e3" title={t('Add a connection')} note={t('Two ways in: a folder of documents, or an API that returns JSON or CSV')} />
          <ol className="ad-flow mb-5 grid grid-cols-2 gap-x-3 gap-y-4 md:grid-cols-4">
            {FLOW.map(([I, title, sub, hex], i) => (
              <li key={title} className="ad-rise relative z-[1] min-w-0" style={{ '--d': `${150 + i * 90}ms` } as CSSProperties}>
                <span className="ad-pop grid h-7 w-7 place-items-center rounded-full text-white ring-4 ring-white"
                      style={{ background: hex, '--d': `${250 + i * 90}ms` } as CSSProperties}>
                  <I className="h-3.5 w-3.5" aria-hidden="true" />
                </span>
                <p className="mt-2 text-[12.5px] font-semibold text-ink">{t(title)}</p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-muted">{t(sub)}</p>
              </li>
            ))}
          </ol>
          <div className="grid gap-3 lg:grid-cols-2">
            {connectors.map((c, i) => (
              <ConnectorCard key={c.id} index={i} connector={c} open={adding === c.id}
                onOpen={() => { setAdding(adding === c.id ? null : c.id); setError(null); }}
                busy={create.isPending}
                onAdd={add}
                onUpload={async (files, label) => {
                  setUpload({ pct: 0 });
                  try {
                    const res = await uploadFolder(files, label, (pct) => setUpload({ pct }));
                    setUpload({ pct: 100, note: res.note });
                    return res;
                  } catch (e) {
                    setUpload(null);
                    setError((e as Error).message);
                    return null;
                  }
                }}
                upload={upload} />
            ))}
          </div>
        </section>

        {/* ---- the connections */}
        <section className="card ad-rise overflow-hidden" style={{ '--d': '160ms' } as CSSProperties}>
          <div className="px-5 pt-5">
            <CardHead icon={Cable} hex="#16a34a" title={t('Your connections')}
              note={t('Test checks the source can be reached · Sync collects from it')} />
          </div>
          {isLoading ? (
            <p className="border-t border-line px-5 py-4 text-[12.5px] text-muted">{t('Reading connections…')}</p>
          ) : items.length === 0 ? (
            <div className="border-t border-line">
              <EmptyState title={t('Nothing is connected yet')}
                hint={t('Add a folder or an API above. Until then the company pages stay empty — nothing is filled in for you.')} />
            </div>
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {items.map((it, i) => (
                <ConnectionRow key={it.id} it={it} index={i}
                  onTest={() => run(test, it.id)}
                  onSync={() => run(sync, it.id)}
                  onDelete={() => run(remove, it.id)}
                  onKey={async (secret) => {
                    setError(null);
                    try {
                      await changeKey.mutateAsync({ id: it.id, secret });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                  busy={test.isPending || sync.isPending || remove.isPending} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** How a connection works, in four steps: [icon, title, line, colour]. */
const FLOW: [typeof Plug, string, string, string][] = [
  [Plug, tx('Connect'), tx('A folder or an API, named for what it holds'), '#0071e3'],
  [RefreshCw, tx('Sync'), tx('Nothing is collected until you press Sync'), '#30b0c7'],
  [Building2, tx('Filed by department'), tx('Every record keeps the source it came from'), '#8b5cf6'],
  [ShieldCheck, tx('Checked against regulations'), tx('Documents become evidence for duties'), '#34c759'],
];

/* ---------------- adding one ---------------- */
function ConnectorCard({ connector, open, onOpen, onAdd, onUpload, upload, busy, index }: {
  connector: Connector;
  index: number;
  open: boolean;
  onOpen: () => void;
  onAdd: (connector: string, label: string, config: Record<string, unknown>, secret?: string) => void;
  onUpload: (files: File[], label: string) => Promise<UploadResult | null>;
  upload: { pct: number; note?: string } | null;
  busy: boolean;
}) {
  const t = useT();
  const isApi = connector.auth === 'token';
  const [label, setLabel] = useState('');
  const [context, setContext] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [scheme, setScheme] = useState('bearer');
  const [headerName, setHeaderName] = useState('X-API-KEY');
  const [path, setPath] = useState('');
  const picker = useRef<HTMLInputElement>(null);

  const submit = () => {
    const name = label.trim() || connector.name;
    const config: Record<string, unknown> = {};
    if (context.trim()) config.collection_context = context.trim();
    if (isApi) {
      config.url = url.trim();
      config.auth_scheme = scheme;
      if (scheme === 'header') config.auth_header = headerName.trim();
      onAdd(connector.id, name, config, secret.trim() || undefined);
    } else {
      config.path = path.trim();
      onAdd(connector.id, name, config);
    }
  };

  const pick = async (files: FileList | null) => {
    if (!files?.length) return;
    const res = await onUpload([...files], label.trim() || connector.name);
    if (res) setPath(res.path);
  };

  const look = lookFor(connector.id, connector.auth);
  return (
    <div className={cn('ad-card ad-rise group rounded-2xl border bg-white p-4', open ? 'shadow-pop' : 'border-line')}
         style={{ '--d': `${300 + index * 90}ms`, borderColor: open ? `color-mix(in srgb, ${look.hex} 45%, white)` : undefined } as CSSProperties}>
      <div className="flex items-start gap-3.5">
        <span className={cn('ad-ic grid h-12 w-12 shrink-0 place-items-center rounded-xl shadow-sm', look.tile)}>
          <look.Icon className="h-6 w-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-ink">{connector.name}</p>
            {connector.category && <span className="pill bg-slate-100 text-slate-600">{connector.category}</span>}
            <button className={cn('btn btn-sm ml-auto shrink-0', open ? 'btn-ghost' : 'btn-primary')} onClick={onOpen} aria-expanded={open}>
              {open ? t('Close') : t('Connect')}
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-300', open && 'rotate-180')} aria-hidden="true" />
            </button>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{connector.gives}</p>
          <p className="mt-1.5 flex items-start gap-1.5 text-[11.5px] text-muted">
            <KeyRound className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('Needs:')} {connector.needs}
          </p>
          {connector.domains?.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1">
              {connector.domains.map((d) => (
                <span key={d} className="rounded-md px-1.5 py-0.5 text-[11px] font-medium"
                      style={{ background: `color-mix(in srgb, ${look.hex} 10%, white)`, color: `color-mix(in srgb, ${look.hex} 80%, black)` }}>{readable(d)}</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="ad-open mt-3 space-y-2.5 border-t border-line pt-3">
          <Field label="Name this connection">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder={t('e.g. {example}', { example: connector.name })} autoComplete="off" />
          </Field>
          <Field label="Collection name" hint="What this holds, in your words — “Biomedical”. Everything collected is filed under it.">
            <input className="input" value={context} onChange={(e) => setContext(e.target.value)}
              placeholder={t('e.g. Biomedical')} autoComplete="off" />
          </Field>

          {isApi ? (
            <>
              <Field label="API URL" hint="It must return JSON or CSV.">
                <input className="input" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder={t('e.g. {example}', { example: 'https://example.com/api/v1/partner/equipment?limit=5000' })} autoComplete="off" />
              </Field>
              <Field label="How the key is sent">
                <select className="input" value={scheme} onChange={(e) => setScheme(e.target.value)}>
                  <option value="bearer">Authorization: Bearer &lt;key&gt;</option>
                  <option value="header">{t('A header of its own')}</option>
                  <option value="basic">Authorization: Basic (user:password)</option>
                  <option value="none">{t('No key')}</option>
                </select>
              </Field>
              {scheme === 'header' && (
                <Field label="Header name">
                  <input className="input" value={headerName} onChange={(e) => setHeaderName(e.target.value)}
                    placeholder={t('e.g. {example}', { example: 'X-API-KEY' })} autoComplete="off" />
                </Field>
              )}
              {scheme !== 'none' && (
                <Field label="Key" hint="Stored write-only: it is sent to the API and never shown again.">
                  <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
                    autoComplete="new-password" data-lpignore="true" data-1p-ignore="true" />
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Folder on the server">
                <input className="input" value={path} onChange={(e) => setPath(e.target.value)}
                  placeholder={t('e.g. {example}', { example: '/srv/company-brain/input/policies' })} autoComplete="off" />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-sm" onClick={() => picker.current?.click()}>{t('Upload a folder instead')}</button>
                <input ref={picker} type="file" multiple className="hidden"
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  {...({ webkitdirectory: '', directory: '' } as any)}
                  onChange={(e) => pick(e.target.files)} />
                {upload && (
                  <span className="text-[12px] text-muted">
                    {upload.pct < 100 ? t('Uploading… {pct}%', { pct: upload.pct }) : upload.note ?? t('Uploaded')}
                  </span>
                )}
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted">
                {t('An uploaded folder is a copy taken now. Files added to your own folder afterwards are not in it — upload it again to bring them in.')}
              </p>
            </>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button className="btn btn-sm btn-primary" onClick={submit}
              disabled={busy || (isApi ? !url.trim() : !path.trim())}>
              {busy ? t('Connecting…') : t('Connect')}
            </button>
            <span className="text-[11.5px] text-muted">{t('Nothing is collected until you press Sync.')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const t = useT();
  return (
    <label className="block">
      <span className="field-label">{t(label)}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{t(hint)}</span>}
    </label>
  );
}

/* ---------------- one connection ---------------- */
function ConnectionRow({ it, index, onTest, onSync, onDelete, onKey, busy }: {
  it: Integration;
  index: number;
  onTest: () => void;
  onSync: () => void;
  onDelete: () => void;
  onKey: (secret: string) => void;
  busy: boolean;
}) {
  const t = useT();
  const locale = useDateLocale('en-IN');
  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [keying, setKeying] = useState(false);
  const where = it.config?.url || it.config?.path || '';
  const context = it.config?.collection_context;
  const look = lookFor(it.connector);
  const runs = [...(it.syncs ?? [])].reverse();   // oldest → newest, left to right
  const written = (r: (typeof runs)[number]) => (r.entities_written ?? 0) + (r.documents_written ?? 0);
  const runMax = Math.max(1, ...runs.map(written));
  const WhereIcon = it.config?.url ? Globe : FolderOpen;

  return (
    <li className="ad-row ad-rise group px-5 py-4"
        style={{ '--c': STATUS_HEX[it.status], '--d': `${220 + index * 70}ms` } as CSSProperties}>
      <div className="flex flex-wrap items-start gap-3.5 lg:flex-nowrap">
        <span className={cn('ad-ic grid h-11 w-11 shrink-0 place-items-center rounded-xl shadow-sm', look.tile)} aria-hidden="true">
          <look.Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-ink">{it.label}</span>
            <span className={cn('pill', STATUS_TONE[it.status])}>
              <span className={cn('h-1.5 w-1.5 rounded-full bg-current', it.status === 'FAILED' && 'ad-pulse')}
                    style={{ '--c': STATUS_HEX[it.status] } as CSSProperties} aria-hidden="true" />
              {t(STATUS_LABEL[it.status])}
            </span>
            <span className="text-[11.5px] text-muted">{it.connector_name}</span>
          </div>
          {where && (
            <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-muted" title={where}>
              <WhereIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate font-mono text-[11.5px]">{where}</span>
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
            {context && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-ink-2">
                <Tag className="h-3 w-3 text-muted" aria-hidden="true" />{t('Filed under')} <b className="font-semibold text-ink">{context}</b>
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-ink-2">
              <Clock className="h-3 w-3 text-muted" aria-hidden="true" />{t('last collected {when}', { when: when(t, locale, it.last_sync_at) })}
            </span>
            {it.has_secret && (
              <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-ink-2">
                <KeyRound className="h-3 w-3 text-muted" aria-hidden="true" />{t('key stored')}
              </span>
            )}
          </div>
          {it.status_detail && (
            <p className={cn('mt-2 text-[12px] leading-relaxed', it.status === 'FAILED' ? 'text-critical-600' : 'text-muted')}>
              {it.status_detail}
            </p>
          )}
          <IntakeLink text={it.status_detail} />
          {it.is_upload_snapshot && (
            <p className="mt-2 flex items-start gap-2 rounded-xl bg-warning-50 px-3 py-2 text-[11.5px] leading-relaxed text-warning-700">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {t('This folder is the copy your upload left on the server. Sync re-reads that copy, so files you have added to your own folder since cannot appear — upload the folder again to bring them in.')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn btn-sm btn-ghost" onClick={onTest} disabled={busy}><FlaskConical className="h-3.5 w-3.5" />{t('Test')}</button>
            <button className="btn btn-sm btn-primary" onClick={onSync} disabled={busy}><RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />{t('Sync')}</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              <ListOrdered className="h-3.5 w-3.5" />{open ? t('Hide runs') : t('Runs')}
            </button>
          </div>
          {runs.length > 0 && (
            <div className="flex items-end gap-2 text-[11px] text-muted" aria-label={t('Recent runs, oldest first')}>
              <span className="pb-px">{runs.length === 1 ? t('Last 1 run') : t('Last {n} runs', { n: runs.length })}</span>
              <span className="flex h-6 items-end gap-[3px]">
                {runs.map((r, i) => (
                  <span key={r.id} className="ad-rise-up w-2 rounded-[3px]"
                        style={{ height: `${r.outcome ? Math.max(5, (written(r) / runMax) * 24) : 24}px`,
                                 background: r.outcome ? OUTCOME_HEX[r.outcome] ?? '#94a3b8' : '#cbd5e1', '--d': `${index * 70 + i * 50}ms` } as CSSProperties}
                        title={`${when(t, locale, r.started_at)} · ${r.outcome ? (r.outcome === 'OK' ? t('Completed') : t(readable(r.outcome))) : t('Running')} · ${t('{n} records', { n: r.entities_written })}`} />
                ))}
              </span>
            </div>
          )}
        </div>
      </div>

      {open && (
        <div className="ad-open mt-3 space-y-2 border-t border-line pt-3 lg:ml-[58px]">
          {(it.syncs ?? []).length === 0 ? (
            <p className="text-[12px] text-muted">{t('It has not collected anything yet.')}</p>
          ) : (
            <ul className="space-y-1.5">
              {(it.syncs ?? []).map((r) => (
                <li key={r.id} className="rounded-xl border border-line bg-slate-50/50 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className={cn('pill', OUTCOME_TONE[r.outcome ?? ''] ?? 'bg-slate-100 text-ink-2')}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                      {r.outcome === 'OK' ? t('Completed') : r.outcome ? t(readable(r.outcome)) : t('Running')}
                    </span>
                    <span className="text-muted">{when(t, locale, r.started_at)}</span>
                    <span className="text-ink-2">
                      {r.documents_written && r.skipped
                        ? t('{records} records, {documents} documents, {skipped} skipped of {seen} seen', { records: r.entities_written, documents: r.documents_written, skipped: r.skipped, seen: r.items_seen })
                        : r.documents_written
                          ? t('{records} records, {documents} documents of {seen} seen', { records: r.entities_written, documents: r.documents_written, seen: r.items_seen })
                          : r.skipped
                            ? t('{records} records, {skipped} skipped of {seen} seen', { records: r.entities_written, skipped: r.skipped, seen: r.items_seen })
                            : t('{records} records of {seen} seen', { records: r.entities_written, seen: r.items_seen })}
                    </span>
                  </div>
                  {r.detail && <p className="mt-1 text-[11.5px] leading-relaxed text-muted">{r.detail}</p>}
                  <IntakeLink text={r.detail} />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {keying ? (
              <>
                <input className="input h-9 w-64" type="password" placeholder={t('New key')} value={newKey}
                  onChange={(e) => setNewKey(e.target.value)} autoComplete="new-password"
                  data-lpignore="true" data-1p-ignore="true" />
                <button className="btn btn-sm" disabled={!newKey.trim()}
                  onClick={() => { onKey(newKey.trim()); setNewKey(''); setKeying(false); }}>{t('Save key')}</button>
                <button className="btn btn-sm btn-ghost" onClick={() => { setKeying(false); setNewKey(''); }}>{t('Cancel')}</button>
              </>
            ) : (
              <button className="btn btn-sm" onClick={() => setKeying(true)}>{t('Change key')}</button>
            )}
            <button className="btn btn-sm btn-ghost ml-auto text-critical-600"
              onClick={() => { if (confirm(t('Delete “{name}”? Records already collected stay where they are.', { name: it.label }))) onDelete(); }}>
              {t('Delete connection')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export default IntegrationsPage;

/** A sync that handed documents to document intake links to where they were sorted. */
function IntakeLink({ text }: { text?: string | null }) {
  const t = useT();
  const id = /document intake \(batch (ib-[0-9a-f]+)\)/.exec(text ?? '')?.[1];
  if (!id) return null;
  return (
    <Link to={`/intake/${id}`} className="mt-1 inline-flex items-center gap-1 text-[12px] font-semibold text-brand-600 hover:underline">
      {t('See how the documents were sorted →')}
    </Link>
  );
}
