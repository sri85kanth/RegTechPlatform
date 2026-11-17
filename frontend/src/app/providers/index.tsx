import { type ReactNode, useState } from 'react';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useData } from '@/app/store/data';

export function AppProviders({ children }: { children: ReactNode }) {
  // load the Company Brain from the database once, at start-up
  const hydrate = useData((s) => s.hydrate);
  useEffect(() => { void hydrate(); }, [hydrate]);

  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
