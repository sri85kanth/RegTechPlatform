import { useMemo, useState } from 'react';
import { UserPlus, Loader2, AlertTriangle, UserX, Search as SearchIcon } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import {
  useUsers, useMe, useCreateUser, useSetRole, useDeactivate, can,
  type Role, type User,
} from '@/services/authApi';
import { cn, toneClass, type Tone } from '@/utils/ui';
import { Avatar, Callout, EmptyState, IconTile, MetricCard } from '@/components/ui/primitives';
import { tx, useT } from '@/i18n';

const ROLE_HELP: Record<Role, string> = {
  viewer: tx('Read only'),
  reviewer: tx('Can propose actions and run the engine'),
  compliance_manager: tx('Can accept, assign and close work'),
  admin: tx('Can manage users'),
  auditor: tx('External: sees only the cascade and documents shared with them (Auditor access)'),
  none: tx('No access to this company — works only in the companies they were added to'),
};

/** One colour per role, everywhere on this page. */
const ROLE_TONE: Record<Role, Tone> = { admin: 'purple', compliance_manager: 'blue', reviewer: 'teal', viewer: 'gray', auditor: 'orange', none: 'gray' };
// the English role name; draw it through t() — the role value sent to the server stays as it is
const roleName = (r: string) => (r === 'none' ? tx('No access') : r.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (ch: string) => ch.toUpperCase()));
const pctOf = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** How long ago someone last signed in, as a bucket — read from last_login_at. */
const SIGN_IN_BUCKETS = [tx('Last 24 hours'), tx('Last 7 days'), tx('Last 30 days'), tx('Over 30 days ago'), tx('Never signed in')] as const;
function bucketOf(u: User): (typeof SIGN_IN_BUCKETS)[number] {
  if (!u.last_login_at) return 'Never signed in';
  const t = Date.parse(u.last_login_at.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(u.last_login_at) ? u.last_login_at : `${u.last_login_at}Z`);
  if (!Number.isFinite(t)) return 'Over 30 days ago';
  const days = (Date.now() - t) / 86_400_000;
  if (days <= 1) return 'Last 24 hours';
  if (days <= 7) return 'Last 7 days';
  if (days <= 30) return 'Last 30 days';
  return 'Over 30 days ago';
}

/**
 * User administration.
 *
 * Roles are what make "a human approved this" mean anything, so the screen
 * states plainly what each one permits rather than leaving it to be discovered
 * through a 403.
 *
 * In a company other than the main one this is that company's team: adding a
 * person gives an existing account access (or makes a new one), and removing
 * them takes away this company only. Administrators of the main company work
 * in every company and are listed, not edited, here.
 */
export function UsersPage() {
  const t = useT();
  const { data: me } = useMe();
  const { data, error, isLoading } = useUsers();
  const create = useCreateUser();
  const setRole = useSetRole();
  const deactivate = useDeactivate();
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'viewer' as Role });
  const [q, setQ] = useState('');
  const company = data?.company ? me?.companies?.find((c) => c.slug === data.company)?.name ?? data.company : '';

  const items = useMemo(() => data?.items ?? [], [data]);
  const stats = useMemo(() => {
    const active = items.filter((u) => u.active);
    const byRole = new Map<Role, number>();
    for (const u of active) byRole.set(u.role, (byRole.get(u.role) ?? 0) + 1);
    return {
      total: items.length,
      active: active.length,
      deactivated: items.length - active.length,
      admins: byRole.get('admin') ?? 0,
      mfa: active.filter((u) => u.mfaEnabled).length,
      never: active.filter((u) => !u.last_login_at).length,
    };
  }, [items]);

  if (!can(me, 'administer')) {
    return (
      <>
        <Topbar title="Users" subtitle="Accounts and roles" icon="Users" />
        <div className="p-6">
          <div className="card mx-auto flex max-w-xl flex-col items-center gap-3 px-6 py-14 text-center">
            <IconTile icon="ShieldAlert" tone="amber" size="lg" />
            <div className="text-base font-semibold text-ink">{t('Administrator access required')}</div>
            <p className="text-[13px] text-muted">
              {t('Your role is')}{' '}
              <span className={cn('pill', toneClass(me ? ROLE_TONE[me.role] : 'gray'))}>{me ? t(roleName(me.role)) : t('unauthenticated')}</span>.
              {' '}{t('Only an administrator can manage accounts.')}
            </p>
          </div>
        </div>
      </>
    );
  }

  const roles = data?.roles ?? [];
  const shown = q
    ? items.filter((u) => `${u.name} ${u.email} ${u.role}`.toLowerCase().includes(q.toLowerCase()))
    : items;

  return (
    <>
      <Topbar
        title="Users"
        subtitle={company ? t('The people who work in {company}', { company }) : tx('Accounts, roles and access')}
        icon="Users"
        meta={
          data
            ? [
                { icon: 'Users', label: 'Accounts', value: stats.total.toLocaleString() },
                { icon: 'UserCheck', label: 'Active', value: stats.active.toLocaleString() },
                { icon: 'Lock', label: 'Two-factor', value: t('{pct}% of active', { pct: pctOf(stats.mfa, stats.active) }) },
              ]
            : undefined
        }
      />
      <div className="space-y-4 p-4 sm:p-6">
        {/* KPIs */}
        {data && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricCard label={t('Total users')} value={stats.total} tone="brand" icon="Users" foot={t('{n} deactivated', { n: stats.deactivated.toLocaleString() })} />
            <MetricCard label={t('Active')} value={stats.active} tone="green" icon="UserCheck" pct={pctOf(stats.active, stats.total)} />
            <MetricCard label={t('Administrators')} value={stats.admins} tone="purple" icon="ShieldCheck" pct={pctOf(stats.admins, stats.active)} />
            <MetricCard label={t('Two-factor on')} value={stats.mfa} tone="teal" icon="Lock" pct={pctOf(stats.mfa, stats.active)} />
            <MetricCard label={t('Never signed in')} value={stats.never} tone="amber" icon="Clock" pct={pctOf(stats.never, stats.active)} />
          </div>
        )}

        {/* add a user */}
        <form
          className="card space-y-3 p-5"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(form, { onSuccess: () => setForm({ email: '', name: '', password: '', role: 'viewer' }) });
          }}
        >
          <div className="flex items-center gap-2.5">
            <IconTile icon="Plus" tone="brand" size="sm" />
            <h2 className="text-[15px] font-semibold text-ink">{company ? t('Add a person to {company}', { company }) : t('Add a user')}</h2>
          </div>
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_12rem_auto]">
            <label className="block">
              <span className="field-label">{t('Name')}</span>
              <input className="input" placeholder={t('Full name')} value={form.name} autoComplete="off"
                     onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label className="block">
              <span className="field-label">{t('Email')}</span>
              <input className="input" type="email" placeholder="name@company.com" value={form.email} autoComplete="off"
                     onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </label>
            <label className="block">
              <span className="field-label">{t('Password')}</span>
              <input className="input" type="password" placeholder={t(company ? 'Only for a new account' : '12 or more characters')} value={form.password}
                     autoComplete="new-password"
                     onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </label>
            <label className="block">
              <span className="field-label">{t('Role')}</span>
              <select className="input" value={form.role}
                      onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {roles.map((r) => <option key={r} value={r}>{t(roleName(r))}</option>)}
              </select>
            </label>
            <button className="btn btn-primary h-9" disabled={create.isPending}>
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
              {company ? t('Add') : t('Create')}
            </button>
          </div>
          {company && (
            <p className="text-xs text-muted">
              {t('Someone who already has an account only needs their email — they sign in as before and find {company} in the company menu.', { company })}
            </p>
          )}
          <p className="flex items-center gap-2 text-xs text-muted">
            <span className={cn('pill', toneClass(ROLE_TONE[form.role]))}>{t(roleName(form.role))}</span>
            {t(ROLE_HELP[form.role])}
          </p>
          {create.error && (
            <div className="flex gap-2 rounded-lg bg-critical-50 px-3 py-2 text-[12.5px] text-critical-600">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{(create.error as Error).message}
            </div>
          )}
        </form>

        {error && <Callout tone="red" title={t('Could not load users')}>{(error as Error).message}</Callout>}

        {/* the user table */}
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <div className="relative w-full sm:w-64">
              <SearchIcon className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" aria-hidden="true" />
              <input className="input h-9 pl-9" placeholder={t('Search users…')} aria-label={t('Search users')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {roles.map((r) => (
                <span key={r} className={cn('pill', toneClass(ROLE_TONE[r]))} title={t(ROLE_HELP[r])}>
                  {t(roleName(r))} <b className="tabular-nums">{items.filter((u) => u.role === r).length}</b>
                </span>
              ))}
            </div>
            <span className="ml-auto text-[13px] text-muted">
              <b className="font-semibold tabular-nums text-ink">{shown.length}</b> {shown.length === 1 ? t('user') : t('users')}
            </span>
          </div>
          {isLoading ? (
            <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />)}</div>
          ) : shown.length === 0 ? (
            <EmptyState title={t(q ? 'No users match your search.' : 'No users yet.')} icon="Users" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="whitespace-nowrap border-b border-line bg-slate-50 text-xs font-semibold text-muted">
                    <th className="w-10 px-4 py-2.5">#</th>
                    <th className="px-4 py-2.5">{t('User')}</th>
                    <th className="px-4 py-2.5">{t('Role')}</th>
                    <th className="px-4 py-2.5">{t('Two-factor')}</th>
                    <th className="px-4 py-2.5">{t('Last sign-in')}</th>
                    <th className="px-4 py-2.5">{t('Status')}</th>
                    <th className="px-4 py-2.5"><span className="sr-only">{t('Actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((u: User, i) => (
                    <tr key={u.id} className={cn('border-b border-slate-100 last:border-0 hover:bg-slate-50', !u.active && 'opacity-70')}>
                      <td className="px-4 py-2.5 text-xs tabular-nums text-muted">{i + 1}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <Avatar name={u.name} size={34} />
                          <div className="min-w-0 leading-tight">
                            <div className="truncate font-semibold text-ink">
                              {u.name}
                              {u.id === me?.id && <span className="ml-1.5 pill bg-brand-50 px-1.5 py-0.5 text-[11px] text-brand-700">{t('you')}</span>}
                            </div>
                            <div className="truncate text-xs text-muted">{u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          className={cn(
                            'h-8 w-44 rounded-lg border-0 px-2 text-[12.5px] font-semibold focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:cursor-not-allowed disabled:opacity-75',
                            toneClass(ROLE_TONE[u.role]),
                          )}
                          aria-label={t('Role for {name}', { name: u.name })}
                          value={u.role}
                          // changing your own role could lock every admin out of the system
                          disabled={u.id === me?.id || !u.active || (!!company && !!u.platformAdmin)}
                          title={t(u.id === me?.id ? 'You cannot change your own role'
                            : company && u.platformAdmin ? 'An administrator of the main company is admin in every company'
                            : ROLE_HELP[u.role])}
                          onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value as Role })}
                        >
                          {roles.map((r) => <option key={r} value={r}>{t(roleName(r))}</option>)}
                        </select>
                      </td>
                      <td className="px-4 py-2.5">
                        {typeof u.mfaEnabled === 'boolean' ? (
                          <span className={cn('pill', u.mfaEnabled ? 'bg-success-50 text-success-600' : 'bg-warning-50 text-warning-600')}>
                            {u.mfaEnabled ? t('On') : t('Off')}
                          </span>
                        ) : (
                          <span className="text-muted-2">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <div className="text-ink-2">{u.last_login_at ? u.last_login_at.slice(0, 16).replace('T', ' ') : t('never')}</div>
                        <div className="text-xs text-muted">{t(bucketOf(u))}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn('pill', u.active ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-600')}>
                          {u.active ? t('Active') : t('Deactivated')}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {u.active && u.id !== me?.id && !(company && u.platformAdmin) && (
                          <button
                            onClick={() => {
                              const ask = company ? t('Remove {name} from {company}? Their other companies are not affected.', { name: u.name, company })
                                                  : t('Deactivate {name}? Their sessions are revoked immediately.', { name: u.name });
                              if (confirm(ask)) deactivate.mutate(u.id);
                            }}
                            className="btn btn-sm hover:border-critical-200 hover:bg-critical-50 hover:text-critical-600"
                          >
                            <UserX className="h-3.5 w-3.5" /> {company ? t('Remove') : t('Deactivate')}
                          </button>
                        )}
                        {company && u.platformAdmin && <span className="text-xs text-muted">{t('Admin of the main company')}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <p className="text-[12px] text-muted">
          {company
            ? t('Removing someone takes away {company} only; their account and other companies stay as they are.', { company })
            : t('Deactivating a user revokes their live sessions in the same transaction — access ends immediately, not at token expiry.')}
        </p>
      </div>
    </>
  );
}

export default UsersPage;
