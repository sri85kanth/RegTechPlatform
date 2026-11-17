/**
 * Who this installation is configured for.
 *
 * The name used to be typed into the sidebar as a literal string, which is wrong
 * the moment someone edits the profile and wrong for anyone else who deploys
 * this. It now comes from GET /api/company/profile.
 *
 * "Active" means a company profile is configured — that is the only status the
 * data supports. There is no lifecycle column on company_profile, so a badge
 * asserting anything more would be decoration. An installation with no profile
 * says "Setup incomplete" and links to the page that fixes it.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '@/services/http';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';

export interface CompanyProfileRow {
  legal_name?: string;
  entity_type?: string;
  registration_no?: string;
  hq_state?: string;
}

export const useCompanyProfile = () =>
  useQuery<{ configured: boolean; profile: CompanyProfileRow | null }>({
    queryKey: ['company-profile'],
    queryFn: () => api('/api/company/profile'),
    staleTime: 300_000,
  });

/** First letters of the legal name, so the mark follows the configured company. */
function initials(name: string) {
  const words = name.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/);
  return (words[0]?.[0] ?? 'C').toUpperCase();
}

export function CompanyBadge({ compact = false, className }: {
  /** compact drops the text and shows only the mark — for narrow layouts. */
  compact?: boolean;
  className?: string;
}) {
  const navigate = useNavigate();
  const t = useT();
  const { data, isLoading } = useCompanyProfile();

  const name = data?.profile?.legal_name?.trim() || '';
  const configured = Boolean(data?.configured && name);
  const subtitle = configured
    ? (data?.profile?.entity_type || tx('Active'))
    : tx('Setup incomplete');

  if (isLoading) {
    return (
      <div className={cn('flex items-center gap-2.5 rounded-[10px] px-2 py-1', className)}>
        <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-slate-200" />
        {!compact && <div className="hidden h-3 w-28 animate-pulse rounded bg-slate-200 lg:block" />}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => navigate('/company-setup')}
      title={configured
        ? t('{name} — open company setup', { name: `${name}${data?.profile?.registration_no ? ` · ${data.profile.registration_no}` : ''}` })
        : t('No company profile configured — open company setup')}
      className={cn(
        'flex items-center gap-2.5 rounded-[10px] border border-line bg-surface px-2 py-1 text-left transition hover:border-brand-300 hover:bg-canvas',
        className,
      )}
    >
      <span className={cn(
        'grid h-7 w-7 shrink-0 place-items-center rounded-md text-[13px] font-bold text-white',
        configured ? 'bg-brand-500' : 'bg-slate-400',
      )}>
        {configured ? initials(name) : '?'}
      </span>
      {!compact && (
        <span className="hidden min-w-0 leading-tight lg:block">
          <span className="block max-w-[15rem] truncate text-[13px] font-semibold text-ink">
            {configured ? name : t('No company configured')}
          </span>
          <span className={cn(
            'flex items-center gap-1 text-[11px]',
            configured ? 'text-success-600' : 'text-warning-600',
          )}>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full',
              configured ? 'bg-success-500' : 'bg-warning-500')} />
            <span className="truncate">{configured ? t('Active') : t(subtitle)}</span>
          </span>
        </span>
      )}
    </button>
  );
}
