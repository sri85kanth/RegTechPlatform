import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { EntityDrawer } from '@/components/EntityDrawer';
import { SignInPage } from '@/modules/auth/SignInPage';
import { SplashScreen } from '@/modules/auth/SplashScreen';
import { clearSplash, splashRequested } from '@/modules/auth/splash';
import { AuditorShell } from '@/modules/auditor/AuditorPortal';
import { isAuditor, useAuthStatus, useLogout, useMe } from '@/services/authApi';
import { getCompany, getToken, switchCompany } from '@/services/http';
import { useData } from '@/app/store/data';
import { useT } from '@/i18n';

/**
 * The shell decides whether anything is shown at all.
 *
 * Auth is enforced only when the server says it is (i.e. once a user exists),
 * so this does not lock out a deployment that has not created accounts yet —
 * but it also never presents a signed-in-looking UI when there is no session.
 */
export function AppShell() {
  const t = useT();
  const { data: status, isLoading: loadingStatus } = useAuthStatus();
  const { data: me, isLoading: loadingMe, refetch } = useMe();
  // the splash after sign-in: asked for by the sign-in page, shown once the session is ready
  const [splash, setSplash] = useState(false);
  const showSplash = splash || (!!me && splashRequested());
  useEffect(() => {
    if (me && splashRequested()) { clearSplash(); setSplash(true); }
  }, [me]);

  // The shared HTTP client fires this when a request comes back 401, so an
  // expired or revoked session drops the user out immediately instead of
  // leaving a dead UI that fails on every action.
  useEffect(() => {
    const onOut = () => refetch();
    window.addEventListener('cb:signed-out', onOut);
    return () => window.removeEventListener('cb:signed-out', onOut);
  }, [refetch]);

  if (loadingStatus || (getToken() && loadingMe)) {
    return <div className="grid min-h-screen place-items-center text-[13px] text-muted">{t('Loading…')}</div>;
  }
  if (status?.enforcing && !me) {
    return <SignInPage />;
  }
  // The company remembered in this browser may not be open to this person (a
  // different sign-in, or they were removed from it): go to the first one they
  // may work in. With none, say so rather than showing a wall of refusals.
  const companies = me?.companies;
  if (me && companies) {
    if (!companies.some((c) => c.slug === getCompany())) {
      if (companies.length) { switchCompany(companies[0].slug); return null; }
      return <NoCompany />;
    }
  }
  // An external auditor gets its own two-screen portal, never the company's app.
  if (isAuditor(me)) {
    return <AuditorShell />;
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <EntityDrawer />
      <StoreError />
      {showSplash && <SplashScreen name={me?.name} onDone={() => setSplash(false)} />}
    </div>
  );
}

/** Signed in, but not yet added to any company. */
function NoCompany() {
  const t = useT();
  const logout = useLogout();
  return (
    <div className="grid min-h-screen place-items-center bg-canvas p-6">
      <div className="card max-w-sm space-y-3 p-6 text-center">
        <h1 className="text-xl font-semibold text-ink">{t('No company yet')}</h1>
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          {t('Your account is not part of any company yet. Ask your administrator to add you, then sign in again.')}
        </p>
        <button type="button" className="btn btn-outline mx-auto" onClick={() => logout.mutate()}>{t('Sign out')}</button>
      </div>
    </div>
  );
}

/** A failed save used to be swallowed; the store now records it and this says so. */
function StoreError() {
  const t = useT();
  const error = useData((s) => s.error);
  const clear = useData((s) => s.clearError);
  if (!error) return null;
  return (
    <div role="alert" className="fixed bottom-4 right-4 z-[60] flex max-w-md items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-800 shadow-lg">
      <span className="flex-1">{error}</span>
      <button type="button" onClick={clear} className="font-semibold text-red-700 hover:underline">{t('Dismiss')}</button>
    </div>
  );
}
