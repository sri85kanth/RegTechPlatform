/**
 * Shared pieces of the Risk inputs screens: the form controls the record panels
 * are built from. The words for each value are in labels.ts.
 */
import type { ReactNode } from 'react';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

export function FieldRow({ label, hint, required, children, className }: {
  label: string; hint?: string; required?: boolean; children: ReactNode; className?: string;
}) {
  const t = useT();
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-[12px] font-semibold text-ink-2">
        {t(label)}{required && <span className="ml-0.5 text-critical-600" aria-hidden="true">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-snug text-muted">{t(hint)}</span>}
    </label>
  );
}

export function Pill({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold', className)}>
      {children}
    </span>
  );
}
