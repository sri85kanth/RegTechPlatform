import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Boxes, FileCheck2, FolderTree, Inbox, UserRound, UsersRound } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { toneFor } from '@/config/tones';
import { Icon } from '@/config/icons';
import { Avatar } from '@/components/ui/primitives';
import { type Slice } from '@/components/ui/charts';
import { CountUp } from '@/components/ui/motion';
import { Fill } from '@/components/ui/premium';
import { SkeletonCards } from '@/components/ui/skeletons';
import { can, useMe } from '@/services/authApi';
import { useStructure, type OrgNode, type Structure } from '@/services/structureApi';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import { childrenOf, groupWord, kindLabel, unitWordText } from './model';
import { deptAccent, deptIcon, rootOrder } from './accent';
import { headFor } from './signals';

/**
 * Every department, side by side — what opens when "Departments" is clicked.
 *
 * One summary strip (how many, and where the records sit), the unfiled
 * records as a banner, then a card per department. Every figure is a count the structure
 * endpoint already keeps, so the page is one request however many records sit
 * underneath. Unfiled records and head coverage are for administrators.
 */
export function DepartmentsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const admin = can(me, 'administer');
  const { data: structure, isLoading } = useStructure();
  const flat = useMemo(() => structure?.flat ?? [], [structure]);
  const counts = structure?.counts;
  const roots = useMemo(() => rootOrder(flat), [flat]);
  const unfiled = counts?.unfiled ?? 0;
  const filed = counts?.filed ?? 0;

  const stats = useMemo(() => {
    const units = flat.filter((n) => n.parent_id).length;
    const withHead = roots.filter((r) => headFor(r, counts).head).length;
    return { units, withHead };
  }, [flat, roots, counts]);

  const all = filed + unfiled;
  // where the records sit: one segment per department, in the structure's own order
  const share: (Slice & { id: string })[] = roots.map((r) => ({
    id: r.id, label: r.name, value: counts?.total?.[r.id] ?? 0, color: deptAccent(flat, r.id).hex,
    onClick: () => navigate(`/departments/${r.id}`),
  }));
  if (admin && unfiled > 0) share.push({ id: 'unfiled', label: t('Not filed yet'), value: unfiled, color: '#cbd5e1', onClick: () => navigate('/departments/unfiled') });

  return (
    <>
      <Topbar
        title="Departments"
        subtitle="Your company's own structure, built from what you connected"
        icon="FolderTree"
        tone={toneFor('overview')}
        actions={<>
          <Link className="btn btn-outline" to="/graph"><Icon name="Network" className="h-4 w-4" /> {t('Org chart')}</Link>
          {admin && <Link className="btn" to="/structure"><Icon name="Pencil" className="h-4 w-4" /> {t('Edit structure')}</Link>}
        </>}
      />

      <div className="w-full space-y-5 p-4 sm:p-6">
        {isLoading ? (
          <SkeletonCards count={3} lines={4} />
        ) : roots.length === 0 && unfiled === 0 ? (
          <div className="card flex flex-col items-center px-6 py-12 text-center">
            <div className="grid h-12 w-12 place-items-center rounded-xl bg-brand-50">
              <FolderTree className="h-6 w-6 text-brand-600" />
            </div>
            <p className="mt-3 text-[14px] font-semibold text-ink">{t('No departments yet')}</p>
            <p className="mt-1 max-w-md text-[12.5px] leading-relaxed text-muted">
              {t('A department appears here when data arrives for it. Connect a folder or an API in Integrations and give it the department’s name — for example “Biomedical” — and what it holds is filed under that name.')}
            </p>
            {admin && (
              <div className="mt-4 flex gap-2">
                <Link className="btn btn-sm btn-primary" to="/integrations">{t('Go to Integrations')}</Link>
                <Link className="btn btn-sm" to="/structure">{t('Add one by hand')}</Link>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* the whole structure in one strip: four counts, and where the records sit */}
            <section className="pm-tile card overflow-hidden p-0">
              <div className={cn('grid grid-cols-2 divide-black/[0.06] sm:divide-x', admin ? 'sm:grid-cols-4' : 'sm:grid-cols-3')}>
                <Stat icon={FolderTree} hex="#7c3aed" n={roots.length} label={roots.length === 1 ? t('Department') : t('Departments')} />
                <Stat icon={Boxes} hex="#0d9488" n={stats.units} label={stats.units === 1 ? t('Unit inside them') : t('Units inside them')} />
                <Stat icon={FileCheck2} hex="#16a34a" n={filed} label={t('Records filed')} />
                {admin && <Stat icon={UsersRound} hex="#0071e3" n={stats.withHead} of={roots.length} label={t('Heads recorded')}
                                onClick={stats.withHead < roots.length ? () => navigate('/structure') : undefined} />}
              </div>
              {all > 0 && (
                <div className="border-t border-black/[0.06] px-5 py-4">
                  <div className="mb-2 text-[12px] font-medium text-muted">{t('Where the records sit')}</div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-black/[0.05]">
                    {share.filter((x) => x.value > 0).map((x, i) => (
                      <button key={x.id} type="button" onClick={x.onClick} title={`${x.label}: ${x.value.toLocaleString()}`}
                              className="pm-grow h-full transition-opacity hover:opacity-80"
                              style={{ width: `${(x.value / all) * 100}%`, background: x.color, animationDelay: `${i * 0.06}s` }} />
                    ))}
                  </div>
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                    {share.filter((x) => x.value > 0).map((x) => (
                      <button key={x.id} type="button" onClick={x.onClick} className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-2 hover:text-ink">
                        <span className="h-2 w-2 rounded-full" style={{ background: x.color }} />
                        {x.label}<span className="tabular-nums text-muted">{x.value.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {admin && unfiled > 0 && (
              <Link to="/departments/unfiled"
                    className="pm-tile group flex items-center gap-3 rounded-[18px] border border-amber-200/70 bg-gradient-to-r from-amber-50 to-white px-4 py-3 transition-shadow hover:shadow-sm">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-warning-600 shadow-[0_1px_2px_rgba(0,0,0,0.06)]"><Inbox className="h-[18px] w-[18px]" /></span>
                <span className="min-w-0 flex-1 text-[13.5px] text-ink-2">
                  <Fill text={t(unfiled === 1 ? '{n} record is not in any department yet.' : '{n} records are not in any department yet.')}
                        vars={{ n: <b className="tabular-nums text-ink">{unfiled.toLocaleString()}</b> }} />
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-brand-600">
                  {t('File them')} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            )}

            {/* the departments themselves */}
            <div className="pm-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {roots.map((n) => <DepartmentCard key={n.id} node={n} structure={structure!} all={all} />)}
            </div>
          </>
        )}
      </div>
    </>
  );
}

function DepartmentCard({ node, structure, all }: { node: OrgNode; structure: Structure; all: number }) {
  const t = useT();
  const counts = structure.counts;
  const total = counts?.total?.[node.id] ?? 0;
  const kinds = [...(counts?.collected?.[node.id] ?? [])].sort((a, b) => b.n - a.n);
  const kids = childrenOf(structure.flat, node.id);
  const word = groupWord(kids);
  const accent = deptAccent(structure.flat, node.id);
  const head = headFor(node, counts);
  const share = all ? Math.round((total / all) * 100) : 0;
  const kindTotal = kinds.reduce((a, k) => a + k.n, 0);
  // the record types as one bar, lightest to darkest shade of the department's colour
  const shade = (i: number) => `color-mix(in srgb, ${accent.hex} ${Math.max(28, 100 - i * 18)}%, white)`;

  return (
    <Link to={`/departments/${node.id}`}
          className="card card-int group flex flex-col overflow-hidden transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5">
      <div className="flex items-start gap-3.5 px-5 pt-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[14px] text-white transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-3"
              style={{ background: `linear-gradient(135deg, color-mix(in srgb, ${accent.hex} 70%, white), ${accent.hex})`, boxShadow: `0 8px 18px -10px ${accent.hex}` }}>
          <Icon name={deptIcon(node.name)} className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold tracking-tight text-ink" title={node.name}>{node.name}</p>
          <p className="truncate text-[12px] text-muted">
            {kids.length > 0 ? `${kids.length.toLocaleString()} ${unitWordText(t, word, kids.length)}` : (node.kind ? t(node.kind) : t('Unit'))}
            {' · '}{kinds.length === 1 ? t('1 record type') : t('{n} record types', { n: kinds.length })}
          </p>
        </div>
      </div>

      <div className="px-5 pt-4">
        <div className="flex items-baseline gap-2">
          <span className="text-[30px] font-semibold leading-none tracking-tight tabular-nums text-ink"><CountUp value={total} /></span>
          <span className="text-[12px] text-muted">{t('records')} · {t('{pct}% of all', { pct: share })}</span>
        </div>
        {kindTotal > 0 && (
          <>
            <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-black/[0.05]">
              {kinds.slice(0, 6).map((k, i) => (
                <span key={`${k.domain}:${k.type}`} className="pm-grow h-full" title={`${t(kindLabel(k.domain, k.type))}: ${k.n.toLocaleString()}`}
                      style={{ width: `${(k.n / kindTotal) * 100}%`, background: shade(i), animationDelay: `${0.1 + i * 0.05}s` }} />
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {kinds.slice(0, 3).map((k, i) => (
                <span key={`${k.domain}:${k.type}`} className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: shade(i) }} />
                  <span className="max-w-[110px] truncate">{t(kindLabel(k.domain, k.type))}</span>
                  <span className="tabular-nums text-muted">{k.n.toLocaleString()}</span>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <footer className="mt-auto flex items-center gap-2 border-t border-black/[0.05] px-5 py-3 mt-4"
        title={head.headFromChart ? t('As the organisation chart names the head') : undefined}>
        {head.head ? (
          <>
            <Avatar name={head.head} size={24} />
            <span className="min-w-0 flex-1 truncate text-[12.5px]">
              <span className="font-medium text-ink">{head.head}</span>
              <span className="text-muted"> · {head.headRole ?? t('Head')}{head.moreHeads ? ` +${head.moreHeads}` : ''}</span>
            </span>
          </>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-muted">
            <UserRound className="h-3.5 w-3.5" /> {t('No head recorded')}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-brand-600">
          {t('Open')} <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </footer>
    </Link>
  );
}

/** One count in the summary strip: an icon, the number, what it counts. */
function Stat({ icon: I, hex, n, of, label, onClick }: { icon: typeof FolderTree; hex: string; n: number; of?: number; label: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px]" style={{ background: `color-mix(in srgb, ${hex} 12%, white)`, color: hex }}>
        <I className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[22px] font-semibold leading-none tracking-tight tabular-nums text-ink">
          <CountUp value={n} />{of != null && <span className="text-[14px] font-medium text-muted"> / {of.toLocaleString()}</span>}
        </span>
        <span className="mt-1 block truncate text-[12px] text-muted">{label}</span>
      </span>
    </>
  );
  const cls = 'flex items-center gap-3 px-5 py-4 text-left';
  return onClick
    ? <button type="button" onClick={onClick} className={cn(cls, 'transition-colors hover:bg-black/[0.02]')}>{body}</button>
    : <div className={cls}>{body}</div>;
}
