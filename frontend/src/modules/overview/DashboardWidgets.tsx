/** The dashboard's card shell and its header link. */
import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, type LucideIcon } from 'lucide-react';
import { cn } from '@/utils/ui';
import { GlowIcon, type PTone } from '@/components/ui/premium';

export function DashCard({ title, icon, tone = 'blue', action, children, className }: {
  title: string; icon: LucideIcon; tone?: PTone; action?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn('pm-tile card flex h-full flex-col p-5', className)}>
      <header className="mb-4 flex items-center gap-2.5">
        <GlowIcon icon={icon} tone={tone} size={32} />
        <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink">{title}</h3>
        {action}
      </header>
      <div className="flex-1">{children}</div>
    </section>
  );
}

export function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="group inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-600 hover:underline">
      {children} <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}
