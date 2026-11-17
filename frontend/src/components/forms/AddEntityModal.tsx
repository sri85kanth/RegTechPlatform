import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { X, Plus, AlertCircle } from 'lucide-react';
import type { DomainConfig } from '@/config/domains';
import type { Criticality, Entity, VerificationState } from '@/types/entity';
import { useData } from '@/app/store/data';
import { cn } from '@/utils/ui';
import { DomainTile } from '@/modules/registry/DomainTile';
import { tMaybe, tx, useT } from '@/i18n';
import '@/components/ui/premium.css';

const schema = z.object({
  name: z.string().min(2, tx('Name is required (min 2 chars)')),
  description: z.string().optional(),
  criticality: z.enum(['Critical', 'High', 'Medium', 'Low']),
  status: z.string().min(1),
  ownerId: z.string().optional(),
  verification: z.enum(['Verified', 'Pending', 'Needs Review', 'Rejected']),
});
type FormValues = z.infer<typeof schema>;

/** Criticality choices, each in its one meaning colour. */
const CRIT_CHOICES: { value: Criticality; on: string; dot: string }[] = [
  { value: tx('Critical'), on: 'border-critical-500 bg-critical-50 text-critical-700', dot: 'bg-critical-500' },
  { value: tx('High'), on: 'border-notcov-500 bg-notcov-50 text-notcov-700', dot: 'bg-notcov-500' },
  { value: tx('Medium'), on: 'border-warning-500 bg-warning-50 text-warning-700', dot: 'bg-warning-500' },
  { value: tx('Low'), on: 'border-slate-400 bg-slate-100 text-slate-700', dot: 'bg-slate-400' },
];

export function AddEntityModal({ config, onClose }: { config: DomainConfig; onClose: () => void }) {
  const t = useT();
  const { entities, addEntity } = useData();
  const people = entities.filter((e) => e.domain === 'people' && e.type === 'Person');
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { criticality: 'Medium', status: 'Active', verification: 'Pending' },
  });
  const crit = watch('criticality');

  // close on Escape, like the record drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function onSubmit(v: FormValues) {
    const parsed = schema.safeParse(v);
    if (!parsed.success) return;
    const now = new Date();
    const e: Entity = {
      id: `${config.id.slice(0, 3)}-${Math.random().toString(36).slice(2, 7)}`,
      domain: config.id,
      name: v.name,
      type: config.entityNoun,
      description: v.description,
      status: v.status,
      ownerId: v.ownerId || undefined,
      criticality: v.criticality as Criticality,
      verification: v.verification as VerificationState,
      lifecycle: v.verification === 'Verified' ? 'Active' : 'Pending Review',
      attrs: {},
      provenance: {
        source: 'Manual',
        confidence: 100,
        createdAt: now.toISOString().slice(0, 10),
        updatedAt: now.toISOString().slice(0, 10),
      },
    };
    addEntity(e);
    onClose();
  }

  const titleId = `add-${config.id}-title`;
  const noun = t(config.entityNoun);

  return (
    <div className="pm-fade fixed inset-0 z-50 flex items-start justify-center bg-ink/30 p-4 backdrop-blur-[3px] sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="pm-modal mt-[6vh] w-[560px] max-w-full overflow-hidden rounded-[24px] bg-white shadow-[0_30px_80px_-24px_rgba(0,0,0,0.38),0_0_0_0.5px_rgba(0,0,0,0.08)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5 border-b border-line px-5 py-4">
          <DomainTile domain={config.id} size="md" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold tracking-tight text-ink">{t('Add {noun}', { noun })}</h2>
            <p className="text-[13px] text-muted">{t('Create a new {noun} in the Company Brain', { noun: noun.toLowerCase() })}</p>
          </div>
          <button
            type="button"
            className="grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-slate-100 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-100"
            onClick={onClose}
            aria-label={t('Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 p-5">
          <div>
            <label className="field-label" htmlFor={`${titleId}-name`}>{t('Name')}</label>
            <input
              id={`${titleId}-name`}
              className={cn('input', errors.name && 'border-critical-500 focus:border-critical-500 focus:ring-critical-100')}
              placeholder={t('{noun} name', { noun })}
              aria-invalid={Boolean(errors.name)}
              {...register('name')}
            />
            {errors.name && (
              <p className="mt-1 flex items-center gap-1 text-xs text-critical-600">
                <AlertCircle className="h-3.5 w-3.5" /> {tMaybe(t, errors.name.message)}
              </p>
            )}
          </div>

          <fieldset>
            <legend className="field-label">{t('Criticality')}</legend>
            <div className="grid grid-cols-4 gap-2">
              {CRIT_CHOICES.map((c) => (
                <label key={c.value} className="cursor-pointer">
                  <input type="radio" value={c.value} className="peer sr-only" {...register('criticality')} />
                  <span
                    className={cn(
                      'flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition peer-focus-visible:ring-2 peer-focus-visible:ring-brand-100',
                      crit === c.value ? c.on : 'border-line bg-white text-ink-2 hover:border-line-2 hover:bg-slate-50',
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', c.dot)} aria-hidden="true" />
                    {t(c.value)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="field-label" htmlFor={`${titleId}-owner`}>{t('Owner')}</label>
              <select id={`${titleId}-owner`} className="input" {...register('ownerId')}>
                <option value="">{t('Unassigned')}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor={`${titleId}-status`}>{t('Status')}</label>
              <select id={`${titleId}-status`} className="input" {...register('status')}>
                {[tx('Active'), tx('Draft'), tx('Under Review')].map((c) => (
                  <option key={c} value={c}>{t(c)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label" htmlFor={`${titleId}-verification`}>{t('Verification')}</label>
              <select id={`${titleId}-verification`} className="input" {...register('verification')}>
                {[tx('Pending'), tx('Verified'), tx('Needs Review')].map((c) => (
                  <option key={c} value={c}>{t(c)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor={`${titleId}-desc`}>{t('Description')}</label>
            <textarea
              id={`${titleId}-desc`}
              className="input h-24 py-2"
              placeholder={t('Describe this {noun}…', { noun: noun.toLowerCase() })}
              {...register('description')}
            />
          </div>
          <div className="-mx-5 -mb-5 mt-2 flex justify-end gap-2 border-t border-line bg-slate-50/60 px-5 py-3">
            <button type="button" className="btn" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
              <Plus className="h-4 w-4" /> {t('Add {noun}', { noun })}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
