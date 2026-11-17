/**
 * What a page shows when it crashes, in place of React Router's bare
 * "Unexpected Application Error!". The sidebar stays (this sits inside the
 * shell), the reader can retry or go home, and the technical detail is one
 * click away for whoever reports it.
 */
import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { Icon } from '@/config/icons';
import { useT } from '@/i18n';
import '@/components/ui/premium.css';

export function RouteError() {
  const t = useT();
  const navigate = useNavigate();
  const err = useRouteError();
  const detail = isRouteErrorResponse(err)
    ? `${err.status} ${err.statusText}`
    : err instanceof Error ? `${err.message}${err.stack ? `\n\n${err.stack}` : ''}` : String(err);
  return (
    <div className="grid min-h-[70vh] place-items-center p-6">
      <div className="pm-modal w-full max-w-[460px] rounded-[24px] bg-white p-7 text-center shadow-[0_30px_80px_-30px_rgba(0,0,0,0.3),0_0_0_0.5px_rgba(0,0,0,0.06)]">
        <span className="pm-pop mx-auto grid h-14 w-14 place-items-center rounded-[18px] bg-gradient-to-br from-[#ff9f0a] to-[#ff6a00] text-white shadow-[0_10px_24px_-10px_rgba(255,106,0,0.6)]">
          <Icon name="AlertTriangle" className="h-7 w-7" />
        </span>
        <h1 className="mt-4 text-[20px] font-semibold tracking-tight text-ink">{t('This page ran into a problem')}</h1>
        <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
          {t('Nothing was lost. Try loading it again, or go back to the dashboard.')}
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            <Icon name="RefreshCw" className="h-4 w-4" /> {t('Try again')}
          </button>
          <button type="button" className="btn btn-outline" onClick={() => navigate('/')}>{t('Go to the dashboard')}</button>
        </div>
        <details className="mt-5 text-left">
          <summary className="cursor-pointer text-center text-xs font-medium text-muted hover:text-ink">{t('Technical details')}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[14px] bg-black/[0.04] p-3 text-[11px] leading-relaxed text-ink-2">{detail}</pre>
        </details>
      </div>
    </div>
  );
}
