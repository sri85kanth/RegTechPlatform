// ============================================================
// Session and identity.
//
// Enforcement is conditional server-side: until the first user exists the API
// is open. The UI reflects that honestly rather than showing a login wall over
// an unprotected backend, or pretending to be secured when it is not.
// ============================================================
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setToken, getToken, getCompany } from '@/services/http';

/**
 * 'auditor' is an external role outside the ladder: it sees only what the company shares with it.
 * 'none' is an account with no role in the home company: it works only in the companies it was added to.
 */
export type Role = 'viewer' | 'reviewer' | 'compliance_manager' | 'admin' | 'auditor' | 'none';

/** A company this person may switch to. slug '' is the home company. */
export interface CompanyAccess { slug: string; name: string; role: Role; sector?: string | null }

export interface User {
  id: string; email: string; name: string; role: Role;
  person_id: string | null; active: number;
  created_at: string; last_login_at: string | null;
  mfaEnabled?: boolean;
  /** /api/auth/me only: the role in the home company (role is the one in the company open now) */
  homeRole?: Role;
  /** /api/auth/me only: where this person may work, home first */
  companies?: CompanyAccess[];
  /** an admin of the home company: admin in every company, and adds companies */
  platformAdmin?: boolean;
  /** users list of another company: an admin of the home company (role is set there) */
  existing?: boolean;
}

export interface AuthStatus {
  usersConfigured: number;
  roles: Role[];
  capabilities: Record<string, Role>;
  sessionHours: number;
  enforcing: boolean;
  /** no user exists yet; the screen offers to create the first administrator */
  firstRun?: boolean;
  note: string | null;
}

const RANK: Record<string, number> = { viewer: 0, reviewer: 1, compliance_manager: 2, admin: 3 };

/** Mirrors the server's capability table — the server is still the authority. */
export function can(user: User | null | undefined, capability: 'read' | 'audit' | 'propose' | 'approve' | 'administer') {
  if (!user) return false;
  // an external auditor inherits nothing; it may only see what was shared with it
  if (user.role === 'auditor') return capability === 'audit';
  const need: Record<string, Role> = {
    read: 'viewer', audit: 'viewer', propose: 'reviewer', approve: 'compliance_manager', administer: 'admin',
  };
  return (RANK[user.role] ?? -1) >= RANK[need[capability]];
}

export const isAuditor = (user: User | null | undefined) => user?.role === 'auditor';

export const useAuthStatus = () =>
  useQuery<AuthStatus>({ queryKey: ['auth-status'], queryFn: () => api('/api/auth/status'), staleTime: 30_000 });

export const useMe = () =>
  useQuery<User | null>({
    queryKey: ['me'],
    queryFn: async () => {
      if (!getToken()) return null;
      try {
        const me = await api<User>('/api/auth/me');
        // Every screen checks can(me, ...) — so me.role is the role in the company
        // open now, not the home company's. The server checks the same thing.
        const here = me.companies?.find((c) => c.slug === getCompany());
        return { ...me, homeRole: me.role, role: here?.role ?? me.role };
      } catch { return null; }
    },
    retry: false,
  });

export const useLogin = () => {
  const qc = useQueryClient();
  return useMutation<{ token: string; user: User }, Error, { email: string; password: string; otp?: string }>({
    mutationFn: (b) => api('/api/auth/login', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: (d) => {
      setToken(d.token);
      qc.invalidateQueries();          // every query re-runs, now authenticated
    },
  });
};

export const useMfaEnroll = () =>
  useMutation<{ secret: string; otpauthUri: string; note: string }, Error, void>({
    mutationFn: () => api('/api/auth/mfa/enroll', { method: 'POST', body: '{}' }),
  });

export const useMfaConfirm = () => {
  const qc = useQueryClient();
  return useMutation<{ mfaEnabled: boolean }, Error, { otp: string }>({
    mutationFn: (b) => api('/api/auth/mfa/confirm', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useMfaDisable = () => {
  const qc = useQueryClient();
  return useMutation<{ mfaEnabled: boolean }, Error, { otp: string }>({
    mutationFn: (b) => api('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useBootstrap = () => {
  const qc = useQueryClient();
  return useMutation<User, Error, { email: string; name: string; password: string }>({
    mutationFn: (b) => api('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['auth-status'] }),
  });
};

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationFn: () => api('/api/auth/logout', { method: 'POST' }),
    onSettled: () => { setToken(''); qc.clear(); },
  });
};

export const useUsers = () =>
  useQuery<{ items: (User & { platformAdmin?: boolean })[]; roles: Role[]; company: string }>({
    queryKey: ['users'], queryFn: () => api('/api/auth/users') });

export const useCreateUser = () => {
  const qc = useQueryClient();
  return useMutation<User, Error, { email: string; name: string; password?: string; role: Role; person_id?: string }>({
    mutationFn: (b) => api('/api/auth/users', { method: 'POST', body: JSON.stringify(b) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
};

export const useSetRole = () => {
  const qc = useQueryClient();
  return useMutation<User, Error, { id: string; role: Role }>({
    mutationFn: ({ id, role }) => api(`/api/auth/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
};

export const useDeactivate = () => {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => api(`/api/auth/users/${id}/deactivate`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
};
