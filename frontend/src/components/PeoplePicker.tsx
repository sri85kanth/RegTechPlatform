import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, UserCog } from 'lucide-react';
import type { Entity } from '@/types/entity';
import { Avatar } from '@/components/ui/primitives';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

/**
 * Who can own a record: every person in the People register. Staff arrive from
 * the HR feed as type "Employee" (413 of them); departments, teams and roles
 * are groupings, not people, so they are left out.
 */
const NOT_A_PERSON = /department|team|role|function|unit|group/i;
export function ownerCandidates(entities: Entity[]): Entity[] {
  return entities
    .filter((x) => x.domain === 'people' && !NOT_A_PERSON.test(x.type ?? ''))
    .sort((a, b) => personName(a).localeCompare(personName(b)));
}

export function personName(p: Entity): string {
  return String(p.attrs.displayName ?? p.name ?? '').trim() || p.name;
}
export function personRole(p: Entity): string {
  return [p.attrs.jobTitle ?? p.attrs.role ?? p.attrs.designation, p.attrs.department]
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(String)
    .join(' · ');
}

/**
 * Searchable owner picker — type a name, a job title or a department.
 * A native <select> with 413 unsorted names was unusable; this lists people
 * with their role and department so the right "Ravi" can be told apart.
 */
export function PeoplePicker({
  people, value, onPick, placeholder = tx('Assign owner…'), className, compact = false, align = 'left',
}: {
  people: Entity[];
  value?: string | null;
  onPick: (id: string) => void;
  placeholder?: string;
  className?: string;
  compact?: boolean;
  align?: 'left' | 'right';
}) {
  // the search filter below has its own `t`, so the translate function is `tr` here
  const tr = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const current = people.find((p) => p.id === value);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return people.slice(0, 200);
    return people.filter((p) => `${personName(p)} ${personRole(p)} ${p.attrs.location ?? ''}`.toLowerCase().includes(t)).slice(0, 200);
  }, [people, q]);

  useEffect(() => {
    if (!open) return;
    setHi(0);
    input.current?.focus();
    const onDoc = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (p: Entity) => { onPick(p.id); setOpen(false); setQ(''); };

  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn('flex w-full items-center gap-2 rounded-lg border bg-white text-left text-sm transition',
          compact ? 'h-8 border-brand-200 px-2.5 text-[12.5px]' : 'h-10 border-line px-3',
          open ? 'border-brand-400 ring-2 ring-brand-100' : 'hover:border-brand-300')}
      >
        {current ? (
          <>
            <Avatar name={personName(current)} size={compact ? 20 : 24} />
            <span className="min-w-0 flex-1 truncate font-medium text-ink">{personName(current)}</span>
          </>
        ) : (
          <>
            <UserCog className="h-4 w-4 shrink-0 text-brand-600" />
            <span className="min-w-0 flex-1 truncate text-ink-2">{tr(placeholder)}</span>
          </>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-2" />
      </button>

      {open && (
        <div className={cn('absolute z-50 mt-1.5 w-[340px] overflow-hidden rounded-xl border border-line bg-white shadow-float',
          align === 'right' ? 'right-0' : 'left-0')}>
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <Search className="h-4 w-4 text-muted-2" />
            <input
              ref={input}
              value={q}
              onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(list.length - 1, h + 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
                else if (e.key === 'Enter' && list[hi]) { e.preventDefault(); pick(list[hi]); }
                else if (e.key === 'Escape') setOpen(false);
              }}
              placeholder={tr('Search name, job title or department')}
              aria-label={tr('Search people')}
              className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
            />
          </div>
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            {list.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-muted">
                {people.length === 0 ? tr('No people in the People register yet — import staff first.') : tr('No one matches “{q}”.', { q })}
              </li>
            )}
            {list.map((p, i) => {
              const role = personRole(p);
              const sel = p.id === value;
              return (
                <li key={p.id} role="option" aria-selected={sel}>
                  <button
                    type="button"
                    onMouseEnter={() => setHi(i)}
                    onClick={() => pick(p)}
                    className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left', i === hi ? 'bg-brand-50' : 'hover:bg-slate-50')}
                  >
                    <Avatar name={personName(p)} size={30} />
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-medium text-ink">{personName(p)}</span>
                      {role && <span className="block truncate text-xs text-muted">{role}</span>}
                    </span>
                    {sel && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-line bg-slate-50 px-3 py-1.5 text-[11px] text-muted">
            {q
              ? (list.length === 1 ? tr('1 match') : tr('{n} matches', { n: list.length.toLocaleString() }))
              : (people.length === 1 ? tr('1 person') : tr('{n} people', { n: people.length.toLocaleString() }))} · {tr('↑↓ to move, Enter to choose')}
          </div>
        </div>
      )}
    </div>
  );
}
