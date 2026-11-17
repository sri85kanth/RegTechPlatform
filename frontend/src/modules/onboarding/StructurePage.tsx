import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight, FolderTree, Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { Avatar, EmptyState, MetricCard, Section } from '@/components/ui/primitives';
import { BarList, ScoreRing } from '@/components/ui/charts';
import { useStructure, useStructureMutations, type OrgNode } from '@/services/structureApi';
import { childrenOf } from '@/modules/departments/model';
import { regulatorColor } from '@/modules/regulatory/RegulationFilters';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

/** A department keeps one colour — its folder tile, its children's tiles and its bar. Stable per id. */
const colourOf = (id: string) => regulatorColor(id);

/**
 * The company's own structure, in the user's words.
 *
 * Collections arrive from what was collected — a folder's name, an API's
 * collection context, a department field — and are then the user's to rename,
 * nest, move or delete. Nothing here is generated: a department with no head
 * recorded says so rather than showing a guess, and deleting a folder never
 * deletes the records inside it; they go back to "Not filed yet".
 */
interface Values {
  name: string;
  kind: string;
  description: string;
  headName: string;
  headRole: string;
}

const EMPTY: Values = { name: '', kind: '', description: '', headName: '', headRole: '' };

export function StructurePage() {
  const t = useT();
  const { data, isLoading } = useStructure();
  const { addNode, editNode, moveNode, removeNode } = useStructureMutations();
  const flat = useMemo(() => data?.flat ?? [], [data]);
  const counts = data?.counts;

  const [open, setOpen] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [addingUnder, setAddingUnder] = useState<string | null | undefined>(undefined);
  const [values, setValues] = useState<Values>(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const navigate = useNavigate();
  const roots = flat.filter((n) => !n.parent_id);
  const filed = counts?.filed ?? 0;
  const unfiled = counts?.unfiled ?? 0;
  const filedPct = filed + unfiled > 0 ? Math.round((filed / (filed + unfiled)) * 100) : 0;
  const headed = roots.filter((n) => n.head_name || (counts?.heads?.[n.id] ?? []).length > 0).length;
  // the top-level department each node sits under, so a whole branch shares one colour
  const rootOf = useMemo(() => {
    const byId = new Map(flat.map((n) => [n.id, n]));
    return (n: OrgNode): string => {
      let cur: OrgNode | undefined = n;
      while (cur?.parent_id && byId.get(cur.parent_id)) cur = byId.get(cur.parent_id);
      return cur?.id ?? n.id;
    };
  }, [flat]);
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const startAdd = (parentId: string | null) => {
    setAddingUnder(parentId);
    setEditing(null);
    setValues(EMPTY);
    setError(null);
  };
  const startEdit = (n: OrgNode) => {
    setEditing(n.id);
    setAddingUnder(undefined);
    setValues({
      name: n.name, kind: n.kind ?? '', description: n.description ?? '',
      headName: n.head_name ?? '', headRole: n.head_role ?? '',
    });
    setError(null);
  };

  const save = async () => {
    setError(null);
    const v = {
      name: values.name.trim(), kind: values.kind.trim() || undefined,
      description: values.description.trim() || undefined,
      headName: values.headName.trim(), headRole: values.headRole.trim(),
    };
    if (!v.name) { setError(t('A name is needed.')); return; }
    try {
      if (editing) await editNode.mutateAsync({ id: editing, ...v });
      else await addNode.mutateAsync({ ...v, parentId: addingUnder ?? null });
      setEditing(null);
      setAddingUnder(undefined);
      setValues(EMPTY);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const drop = async (n: OrgNode) => {
    const held = counts?.total?.[n.id] ?? 0;
    const msg = held
      ? held === 1
        ? t('Delete “{name}”? Its 1 record is not deleted — it moves to “Not filed yet”.', { name: n.name })
        : t('Delete “{name}”? Its {n} records are not deleted — they move to “Not filed yet”.', { name: n.name, n: held.toLocaleString() })
      : t('Delete “{name}”?', { name: n.name });
    if (!confirm(msg)) return;
    setError(null);
    try {
      await removeNode.mutateAsync(n.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const row = (n: OrgNode, depth: number) => {
    const kids = childrenOf(flat, n.id);
    const shown = open.has(n.id) || depth === 0;
    const total = counts?.total?.[n.id] ?? 0;
    const heads = counts?.heads?.[n.id] ?? [];
    const c = colourOf(rootOf(n));
    const head = n.head_name || heads[0]?.name;
    return (
      <div key={n.id}>
        <div className={cn('group flex flex-wrap items-center gap-2 rounded-lg px-2 hover:bg-slate-50 focus-within:bg-slate-50',
               depth === 0 ? 'py-2' : 'py-1.5')}
          style={{ paddingLeft: 8 + depth * 22 }}>
          <button onClick={() => toggle(n.id)} className="text-muted hover:text-ink" aria-expanded={shown}
            aria-label={shown ? t('Collapse {name}', { name: n.name }) : t('Expand {name}', { name: n.name })}>
            {kids.length ? (shown ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)
              : <span className="inline-block h-4 w-4" />}
          </button>
          <span className={cn('grid shrink-0 place-items-center rounded-lg', c.tile, depth === 0 ? 'h-8 w-8' : 'h-6 w-6')}>
            <FolderTree className={depth === 0 ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
          </span>
          <Link to={`/departments/${n.id}`} className={cn('font-semibold text-ink hover:text-brand-600 hover:underline', depth === 0 ? 'text-[14px]' : 'text-[13px]')}>{n.name}</Link>
          {n.kind && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">{n.kind}</span>}
          <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
            total > 0 ? 'bg-brand-50 text-brand-700' : 'bg-slate-100 text-slate-500')}>
            {total === 1 ? t('1 record') : t('{n} records', { n: total.toLocaleString() })}
          </span>
          {kids.length > 0 && <span className="text-[11.5px] text-muted">{t('{n} inside', { n: kids.length.toLocaleString() })}</span>}
          {(n.head_name || heads.length > 0 || depth === 0) && (
            <span className="flex items-center gap-1.5 text-[12px]">
              {head ? <Avatar name={head} size={22} /> : <UserRound className="h-3.5 w-3.5 text-muted" />}
              {n.head_name
                ? <span className="text-ink-2">{n.head_name}{n.head_role ? ` · ${n.head_role}` : ''}</span>
                : heads.length
                  ? <span className="text-ink-2">{heads[0].name}{heads[0].role ? ` · ${heads[0].role}` : ''}
                    <span className="text-muted"> ({t('org chart')})</span></span>
                  : <span className="text-warning-700">{t('No head recorded')}</span>}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <button className="btn btn-sm btn-ghost" onClick={() => startAdd(n.id)} title={t('Add inside')} aria-label={t('Add inside {name}', { name: n.name })}>
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => startEdit(n)} title={t('Rename or record a head')} aria-label={t('Edit {name}', { name: n.name })}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button className="btn btn-sm btn-ghost text-muted hover:text-critical-600" onClick={() => drop(n)} title={t('Delete')} aria-label={t('Delete {name}', { name: n.name })}>
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>

        {(editing === n.id || addingUnder === n.id) && (
          <div style={{ marginLeft: 18 + depth * 18 }}>
            <NodeForm values={values} setValues={setValues} error={error}
              title={editing === n.id ? t('Edit {name}', { name: n.name }) : t('Add inside {name}', { name: n.name })}
              busy={addNode.isPending || editNode.isPending}
              onSave={save} onCancel={() => { setEditing(null); setAddingUnder(undefined); setError(null); }} />
          </div>
        )}

        {shown && kids.map((c) => row(c, depth + 1))}

        {shown && kids.length > 0 && (
          <div className="flex items-center gap-2 py-1" style={{ paddingLeft: 26 + depth * 18 }}>
            <select className="h-8 w-auto rounded-lg border border-dashed border-line-2 bg-transparent px-2.5 text-[12px] text-muted hover:border-slate-400 hover:text-ink-2"
              aria-label={t('Move something inside {name}', { name: n.name })} value=""
              onChange={(e) => e.target.value && moveNode.mutate({ id: e.target.value, parentId: n.id })}>
              <option value="">{t('Move something inside {name}…', { name: n.name })}</option>
              {flat.filter((o) => o.id !== n.id && o.parent_id !== n.id && !o.path.startsWith(`${n.path}/`))
                .map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <Topbar
        title="Structure"
        icon="FolderTree"
        tone={toneFor('overview')}
        subtitle="Your own words for how the company is organised. Collected records are filed into it; renaming or moving a folder here never changes the records inside it."
        actions={<Link className="btn" to="/departments">{t('Open Departments')}</Link>}
      />

      <div className="w-full space-y-4 p-4 sm:p-6">
        {error && !editing && addingUnder === undefined && (
          <p role="alert" className="rounded-lg bg-critical-50 px-3 py-2 text-[12.5px] text-critical-600">{error}</p>
        )}

        {/* ---- KPI row: every figure is a count the structure endpoint returned */}
        {!isLoading && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricCard label={t('Departments')} value={roots.length} tone="brand" icon="Building2"
                        foot={flat.length === 1 ? t('1 folder in all') : t('{n} folders in all', { n: flat.length.toLocaleString() })} />
            <MetricCard label={t('Records filed')} value={filed.toLocaleString()} tone="green" icon="FolderOpen"
                        pct={filed + unfiled > 0 ? filedPct : undefined} />
            <MetricCard label={t('Not filed yet')} value={unfiled.toLocaleString()} tone="amber" icon="Inbox"
                        foot={t('Collected before a home existed')}
                        onClick={unfiled > 0 ? () => navigate('/departments/unfiled') : undefined} />
            <MetricCard label={t('Departments with a head')} value={`${headed} / ${roots.length}`} tone="purple" icon="UserCheck"
                        pct={roots.length ? Math.round((headed / roots.length) * 100) : undefined} />
            <MetricCard label={t('Sub-folders')} value={(flat.length - roots.length).toLocaleString()} tone="teal" icon="FolderTree" />
          </div>
        )}

        {roots.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Section title={t('Filing coverage')} icon="PieChart" tone="green">
              <div className="flex flex-wrap items-center gap-5">
                <ScoreRing value={filedPct} max={100} size={120} thickness={12} label={`${filedPct}%`} sub={t('filed')} />
                <div className="min-w-0 flex-1 space-y-2 text-[13px]">
                  <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-success-500" />
                    <span className="flex-1 text-ink-2">{t('Filed in a department')}</span><b className="tabular-nums">{filed.toLocaleString()}</b></div>
                  <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full bg-warning-500" />
                    <span className="flex-1 text-ink-2">{t('Not filed yet')}</span><b className="tabular-nums">{unfiled.toLocaleString()}</b></div>
                  <p className="text-xs text-muted">{t('Deleting a folder never deletes its records — they return to “Not filed yet”.')}</p>
                </div>
              </div>
            </Section>
            <Section title={t('Records by department')} icon="BarChart3" tone="brand">
              <BarList data={[...roots]
                .sort((a, b) => (counts?.total?.[b.id] ?? 0) - (counts?.total?.[a.id] ?? 0))
                .slice(0, 8)
                .map((n) => ({
                  label: n.name, value: counts?.total?.[n.id] ?? 0, color: colourOf(n.id).hex,
                  onClick: () => navigate(`/departments/${n.id}`),
                }))} />
            </Section>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-sm btn-primary" onClick={() => startAdd(null)}>
            <Plus className="h-3.5 w-3.5" /> {t('Add department')}
          </button>
          {(counts?.unfiled ?? 0) > 0 && (
            <Link to="/departments/unfiled" className="btn btn-sm">
              {t('Not filed yet')} · {(counts?.unfiled ?? 0).toLocaleString()}
            </Link>
          )}
        </div>

        {addingUnder === null && (
          <NodeForm values={values} setValues={setValues} error={error} title={t('Add a department')}
            busy={addNode.isPending}
            onSave={save} onCancel={() => { setAddingUnder(undefined); setError(null); }} />
        )}

        {isLoading ? (
          <p className="text-[12.5px] text-muted">{t('Reading the structure…')}</p>
        ) : roots.length === 0 ? (
          <EmptyState title={t('Nothing in the structure yet')}
            hint={t('Add a department here, or connect a folder or an API in Integrations — what you collect builds the structure itself.')} />
        ) : (
          <div className="card p-2">{roots.map((n) => row(n, 0))}</div>
        )}
      </div>
    </>
  );
}

function NodeForm({ values, setValues, onSave, onCancel, title, busy, error }: {
  values: Values;
  setValues: (v: Values) => void;
  onSave: () => void;
  onCancel: () => void;
  title: string;
  busy: boolean;
  error: string | null;
}) {
  const t = useT();
  const set = (k: keyof Values) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setValues({ ...values, [k]: e.target.value });
  return (
    <div className="card my-2 space-y-2.5 p-3.5">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">{t('Name')}</span>
          <input className="input" value={values.name} onChange={set('name')} autoFocus autoComplete="off" />
        </label>
        <label className="block">
          <span className="field-label">{t('What kind is it?')}</span>
          <input className="input" value={values.kind} onChange={set('kind')} placeholder={t('e.g. Department, Ward, Site')}
            autoComplete="off" />
        </label>
        <label className="block sm:col-span-2">
          <span className="field-label">{t('What belongs here?')}</span>
          <input className="input" value={values.description} onChange={set('description')}
            placeholder={t('In your words — this is what records are matched against.')} autoComplete="off" />
        </label>
        <label className="block">
          <span className="field-label">{t('Head — the person who runs it')}</span>
          <input className="input" value={values.headName} onChange={set('headName')}
            placeholder={t('Leave empty if not recorded')} autoComplete="off" />
        </label>
        <label className="block">
          <span className="field-label">{t('Their role')}</span>
          <input className="input" value={values.headRole} onChange={set('headRole')}
            placeholder={t('e.g. HOD, Manager')} autoComplete="off" />
        </label>
      </div>
      {error && <p className="text-[12px] text-critical-600">{error}</p>}
      <div className="flex items-center gap-2">
        <button className="btn btn-sm btn-primary" onClick={onSave} disabled={busy}>{busy ? t('Saving…') : t('Save')}</button>
        <button className="btn btn-sm btn-ghost" onClick={onCancel}>{t('Cancel')}</button>
        <span className="text-[11.5px] text-muted">{t('A head is only ever what someone typed here, or what an organisation chart says.')}</span>
      </div>
    </div>
  );
}

export default StructurePage;
