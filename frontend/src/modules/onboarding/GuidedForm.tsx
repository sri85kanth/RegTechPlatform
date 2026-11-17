import { useMemo, useState } from 'react';
import { Plus, Check, Info } from 'lucide-react';
import { useData } from '@/app/store/data';
import { TYPE_TO_DOMAIN } from '@/services/csvImport';
import { getDomainConfig } from '@/config/registry';
import { Icon } from '@/config/icons';
import type { Section } from './sections';
import type { Criticality, Entity } from '@/types/entity';
import { cn } from '@/utils/ui';
import { useT, type TFunction } from '@/i18n';

const CRIT: Criticality[] = ['Critical', 'High', 'Medium', 'Low'];

/** Placeholders are examples, and say so. */
const eg = (t: TFunction, s?: string) => (!s ? undefined : /^e\.g\./i.test(s) ? t(s) : t('e.g. {example}', { example: t(s) }));

/**
 * Add one entity at a time, answering the questions that matter for its type —
 * including the relationship questions. This is the mode for companies that
 * don't already have registers to export, and it's the only mode that builds
 * graph edges.
 */
export function GuidedForm({ section, onAdded }: { section: Section; onAdded: () => void }) {
  const t = useT();
  const { entities, addEntityWithLinks } = useData();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [criticality, setCriticality] = useState<Criticality>('Medium');
  const [attrs, setAttrs] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<Record<string, string[]>>({});
  const [justAdded, setJustAdded] = useState<{ name: string; links: number } | null>(null);

  const people = useMemo(() => entities.filter((e) => e.domain === 'people'), [entities]);
  const optionsFor = (domain: string) => entities.filter((e) => e.domain === domain);

  const toggleLink = (verb: string, id: string) =>
    setLinks((l) => {
      const cur = l[verb] ?? [];
      return { ...l, [verb]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] };
    });

  const reset = () => {
    setName(''); setDescription(''); setCriticality('Medium'); setAttrs({}); setLinks({});
  };

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const domain = TYPE_TO_DOMAIN[section.type];
    const id = `gd-${section.id}-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 28)}`;
    const entity: Entity = {
      id, domain, name: trimmed,
      type: section.singular.replace(/\b\w/g, (c) => c.toUpperCase()),
      description: description || undefined,
      status: 'Active', criticality,
      lifecycle: 'Discovered', verification: 'Pending',
      ownerId: ownerId || undefined,
      provenance: { source: 'Manual', sourceReference: 'Guided onboarding', confidence: 100, createdAt: 'Just now', updatedAt: 'Just now' },
      attrs: { ...attrs, ...(description ? { purpose: description } : {}) },
    };
    const edges = Object.entries(links).flatMap(([verb, ids]) => ids.map((targetId) => ({ type: verb, targetId })));
    addEntityWithLinks(entity, edges);
    setJustAdded({ name: trimmed, links: edges.length });
    reset();
    onAdded();
  };

  const linkCount = Object.values(links).reduce((n, a) => n + a.length, 0);

  return (
    <div className="space-y-5">
      {justAdded && (
        <div className="flex items-center gap-2 rounded-card border border-success-500/25 bg-success-50 px-3 py-2 text-[12.5px] text-success-600">
          <Check className="h-4 w-4 shrink-0" /> {!justAdded.links ? t('{name} added — add the next one below.', { name: justAdded.name })
            : justAdded.links === 1 ? t('{name} added with 1 connection — add the next one below.', { name: justAdded.name })
            : t('{name} added with {n} connections — add the next one below.', { name: justAdded.name, n: justAdded.links.toLocaleString() })}
        </div>
      )}

      {/* the basics */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">
            {t('Name')} <span className="text-critical-600" aria-hidden="true">*</span>
          </span>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder={eg(t, section.examples[0]?.[0])} />
        </label>
        <label className="block">
          <span className="field-label">{t('What does it do?')}</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={eg(t, section.examples[0]?.[1])} />
        </label>
        <label className="block">
          <span className="field-label">{t('Who owns it?')}</span>
          <select className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t('Not assigned')}</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="field-label">{t('How critical is it?')}</span>
          <select className="input" value={criticality} onChange={(e) => setCriticality(e.target.value as Criticality)}>
            {CRIT.map((c) => <option key={c} value={c}>{t(c)}</option>)}
          </select>
        </label>
      </div>

      {/* type-specific detail */}
      {section.fields && section.fields.length > 0 && (
        <div>
          <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <span className="grid h-6 w-6 place-items-center rounded-md" style={{ background: `${section.hex}1f`, color: section.hex }}>
              <Icon name={section.icon} className="h-3.5 w-3.5" />
            </span>
            {t('Detail for {section}', { section: t(section.label).toLowerCase() })}
          </h4>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {section.fields.map((f) => (
              <label key={f.key} className="block">
                <span className="field-label">{t(f.label)}</span>
                <input
                  className="input" value={attrs[f.key] ?? ''} placeholder={eg(t, f.placeholder)}
                  onChange={(e) => setAttrs((a) => ({ ...a, [f.key]: e.target.value }))}
                />
                {f.hint && <span className="mt-1 block text-[11px] text-muted">{t(f.hint)}</span>}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* the questions that build the graph */}
      {section.links && section.links.length > 0 && (
        <div className="space-y-3 rounded-card border border-brand-200 bg-brand-50/40 p-4">
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <p className="text-[12.5px] text-ink-2">
              <b>{t('These connections are what make impact analysis work.')}</b>{' '}
              {t('A regulation reaches a system through the process that uses it — without these links the graph has no edges to follow.')}
            </p>
          </div>

          {section.links.map((l) => {
            const opts = optionsFor(l.domain);
            const cfg = getDomainConfig(l.domain);
            const chosen = links[l.verb] ?? [];
            return (
              <div key={l.verb}>
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                  <span className="grid h-5 w-5 place-items-center rounded bg-white text-brand-600 ring-1 ring-brand-200">
                    <Icon name={cfg?.icon ?? 'Link2'} className="h-3 w-3" />
                  </span>
                  <span className="text-[12.5px] font-semibold text-ink">{t(l.question)}</span>
                  {chosen.length > 0 && <span className="pill bg-brand-50 text-brand-600">{t('{n} selected', { n: chosen.length.toLocaleString() })}</span>}
                </div>
                {opts.length === 0 ? (
                  <p className="text-[11.5px] text-muted">
                    {t('No {things} yet — add them in that section, then come back to link them.', { things: cfg ? t(cfg.title).toLowerCase() : l.domain })}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {opts.slice(0, 24).map((o) => {
                      const on = chosen.includes(o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleLink(l.verb, o.id)}
                          className={cn('inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
                            on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-ink-2 hover:border-line-2 hover:bg-slate-50')}
                        >
                          <Icon name={cfg?.icon ?? 'Box'} className="h-3 w-3" />
                          {o.name}
                        </button>
                      );
                    })}
                  </div>
                )}
                {l.hint && <p className="mt-1 text-[11px] text-muted">{t(l.hint)}</p>}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-muted">
          {linkCount === 0 ? t('No connections selected yet.')
            : linkCount === 1 ? t('1 connection will be created with this record.')
            : t('{n} connections will be created with this record.', { n: linkCount.toLocaleString() })}
        </p>
        <button className="btn btn-primary" disabled={!name.trim()} onClick={submit}>
          <Plus className="h-4 w-4" /> {t('Add {noun}', { noun: t(section.singular) })}
        </button>
      </div>
    </div>
  );
}
