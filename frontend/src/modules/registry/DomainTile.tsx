import { registryVisual } from '@/config/companyBrain';
import { Icon } from '@/config/icons';
import { cn } from '@/utils/ui';

/** A record domain's tinted icon tile — People violet, Systems sky, Risks red… */
export function DomainTile({ domain, size = 'md', className }: { domain?: string; size?: 'xs' | 'sm' | 'md' | 'lg'; className?: string }) {
  const v = registryVisual(domain);
  const box = { xs: 'h-6 w-6 rounded-md', sm: 'h-8 w-8 rounded-lg', md: 'h-10 w-10 rounded-xl', lg: 'h-12 w-12 rounded-xl' }[size];
  const ic = { xs: 'h-3.5 w-3.5', sm: 'h-4 w-4', md: 'h-5 w-5', lg: 'h-6 w-6' }[size];
  return (
    <span className={cn('grid shrink-0 place-items-center', box, v.tile, className)} aria-hidden="true">
      <Icon name={v.icon} className={ic} />
    </span>
  );
}
