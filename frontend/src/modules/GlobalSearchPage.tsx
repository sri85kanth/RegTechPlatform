import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { getDomainConfig } from '@/config/registry';
import { Avatar, Badge, EmptyState } from '@/components/ui/primitives';
import { useData } from '@/app/store/data';
import { useUi } from '@/app/store/ui';
import { useT } from '@/i18n';

export function GlobalSearchPage() {
  const t = useT();
  const { entities } = useData();
  const openEntity = useUi((s) => s.openEntity);
  const [q, setQ] = useState('');

  const results = useMemo(() => {
    if (!q.trim()) return [];
    const s = q.toLowerCase();
    // One search across Company Brain + Regulatory Brain; grouped by domain below.
    return entities
      .filter((e) => (e.name + ' ' + (e.type ?? '') + ' ' + Object.values(e.attrs).join(' ')).toLowerCase().includes(s))
      .slice(0, 40);
  }, [q, entities]);

  const grouped = new Map<string, typeof results>();
  results.forEach((e) => {
    const arr = grouped.get(e.domain) ?? [];
    arr.push(e);
    grouped.set(e.domain, arr);
  });

  return (
    <>
      <Topbar title="Search" subtitle="One search across the entire Company Brain graph" icon="Search" />
      <div className="p-6">
        <div className="relative mx-auto max-w-2xl">
          <Search className="pointer-events-none absolute left-3.5 top-3.5 h-5 w-5 text-muted-2" />
          <input autoFocus className="input h-12 pl-11 text-base" placeholder={t('Search people, processes, systems, data, controls, risks…')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="mx-auto mt-4 max-w-2xl space-y-4">
          {q && results.length === 0 && <EmptyState title={t('No results for “{q}”.', { q })} />}
          {[...grouped.entries()].map(([domain, list]) => (
            <div key={domain} className="card overflow-hidden">
              <div className="border-b border-line bg-slate-50/70 px-4 py-2 text-2xs font-semibold uppercase tracking-wide text-muted">
                {t(getDomainConfig(domain)?.title ?? domain)}
              </div>
              {list.map((e) => (
                <button key={e.id} onClick={() => openEntity(e.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-brand-50/40">
                  {e.domain === 'people' && e.type === 'Person' ? <Avatar name={e.name} size={26} /> : <span className="h-2 w-2 rounded-full bg-brand-400" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{e.name}</div>
                    <div className="truncate text-2xs text-muted">{e.type}</div>
                  </div>
                  <Badge value={e.verification} kind="verification" />
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
