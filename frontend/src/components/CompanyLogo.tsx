import { useQuery } from '@tanstack/react-query';
import { api, getCompany } from '@/services/http';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';

/** a gradient per company, so companies without a logo are still told apart at a glance */
const TILES = ['from-blue-500 to-indigo-600', 'from-teal-500 to-emerald-600', 'from-violet-500 to-purple-600',
  'from-amber-500 to-orange-600', 'from-sky-500 to-cyan-600', 'from-rose-500 to-pink-600'];
const tileFor = (key: string) => TILES[[...key].reduce((a, ch) => a + ch.charCodeAt(0), 0) % TILES.length];

/**
 * One company's logo (/api/company/logo), asked of that company. slug '' is the
 * main company; undefined is the company open now.
 */
export function useCompanyLogo(slug?: string) {
  const key = slug ?? getCompany();
  return useQuery<{ logo: string | null }>({
    queryKey: ['company-logo', key],
    queryFn: () => api('/api/company/logo', { headers: { 'X-Company': key } }),
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** The company's logo, or its first letter on a coloured tile when it has none. */
export function CompanyLogo({ slug, name, size = 40, className }: {
  slug?: string; name: string; size?: number; className?: string;
}) {
  const t = useT();
  const { data } = useCompanyLogo(slug);
  const radius = size >= 32 ? 'rounded-xl' : 'rounded-lg';
  if (data?.logo) {
    return (
      <span className={cn('grid shrink-0 place-items-center overflow-hidden border border-slate-200 bg-white', radius, className)}
            style={{ width: size, height: size }}>
        <img src={data.logo} alt={t('{name} logo', { name })} className="h-full w-full object-contain p-[12%]" />
      </span>
    );
  }
  return (
    <span aria-hidden="true"
          className={cn('grid shrink-0 place-items-center bg-gradient-to-br font-bold uppercase text-white', radius, tileFor(slug ?? getCompany() ?? name), className)}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}>
      {name.trim().charAt(0)}
    </span>
  );
}
