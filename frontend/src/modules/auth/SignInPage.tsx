import { useEffect, useState } from 'react';
import { Loader2, AlertTriangle, Brain, Radar, ClipboardCheck, UserCheck, Eye, EyeOff, ArrowRight, Sparkles } from 'lucide-react';
import { useAuthStatus, useLogin, useBootstrap } from '@/services/authApi';
import { tx, useT } from '@/i18n';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import '@/components/ui/premium.css';
import './auth.css';
import { NeuralCanvas } from './NeuralCanvas';
import { requestSplash } from './splash';

/**
 * What the product does, in its own words. Deliberately no figures: a sign-in
 * screen has no data behind it, and a number here would be a number from nowhere.
 */
const FEATURES = [
  { Icon: Radar, hex: '#0a84ff', title: 'Find the rules that apply' },
  { Icon: ClipboardCheck, hex: '#30d158', title: 'Check every duty against your documents' },
  { Icon: UserCheck, hex: '#ff9f0a', title: 'Close the critical gaps first' },
];

/**
 * Sign-in, and first-run admin creation.
 *
 * When no users exist the API is genuinely unauthenticated, and this screen
 * says so rather than showing a login form over an open backend.
 *
 * One sign-in for every company: which company to work in is chosen inside the
 * app (company switcher), and companies are added by an admin there.
 */
export function SignInPage() {
  const t = useT();
  const { data: status } = useAuthStatus();
  const login = useLogin();
  const bootstrap = useBootstrap();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');

  const firstRun = status && (status.firstRun ?? !status.enforcing);
  const busy = login.isPending || bootstrap.isPending;
  const err = (login.error || bootstrap.error) as Error | null;

  return (
    <div className="grid min-h-screen bg-[#f5f5f7] lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
      <BrainPanel />

      <div className="relative grid place-items-center overflow-hidden px-4 py-10">
        {/* on a narrow screen the brain lives behind the card */}
        <div className="pointer-events-none absolute inset-0 lg:hidden" aria-hidden="true">
          <NeuralCanvas tone="light" density={0.8} />
        </div>
        <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden="true">
          <span className="pm-blob right-[-8%] top-[-6%] h-[360px] w-[360px] bg-[#0a84ff]" style={{ opacity: 0.12 }} />
          <span className="pm-blob pm-blob-2 bottom-[-8%] left-[10%] h-[320px] w-[320px] bg-[#bf5af2]" style={{ opacity: 0.1 }} />
        </div>

        {/* choose a language before signing in */}
        <div className="absolute right-5 top-5 z-10"><LanguageSwitcher /></div>

        <div className="relative w-full max-w-[400px]">
          <div className="cb-rise rounded-[28px] bg-white/85 px-7 pb-7 pt-8 shadow-[0_40px_100px_-40px_rgba(0,0,0,0.35),0_0_0_0.5px_rgba(0,0,0,0.06)] backdrop-blur-2xl sm:px-9">
            <span className="pm-pop mx-auto grid h-16 w-16 place-items-center rounded-[20px] bg-gradient-to-br from-[#2b8cff] via-[#5e5ce6] to-[#bf5af2] text-white shadow-[0_14px_30px_-12px_rgba(94,92,230,0.7)] lg:hidden">
              <Brain className="h-8 w-8" />
            </span>
            <h1 className="mt-5 text-center text-[26px] font-semibold tracking-tight text-ink lg:mt-0 lg:text-left">{t(firstRun ? 'Set up Company Brain' : 'Welcome back')}</h1>
            <p className="mt-1 text-center text-[14px] text-muted lg:text-left">{t(firstRun ? 'Create the first administrator account.' : 'Sign in to your compliance workspace.')}</p>

            <form
              className="mt-7 space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                // the splash after sign-in plays once, for this sign-in only
                const onSuccess = () => requestSplash();
                if (firstRun) bootstrap.mutate({ email, name, password }, { onSuccess });
                else login.mutate({ email, password }, { onSuccess });
              }}
            >
              {firstRun && (
                <div className="rounded-[16px] border border-warning-200/70 bg-gradient-to-br from-warning-50 to-white px-3.5 py-3 text-[12.5px] leading-relaxed text-warning-700">
                  <b>{t('No users exist yet, so the API is currently unauthenticated.')}</b>{' '}
                  {t('Creating this first administrator turns enforcement on for everyone.')}
                </div>
              )}

              {firstRun && (
                <Field label={t('Your name')} value={name} onChange={setName} placeholder={t('e.g. Ramprasad')} autoComplete="name" required />
              )}
              <Field label={t('Email')} value={email} onChange={setEmail} type="email" placeholder="you@company.com" autoComplete="email" required />
              <Field label={t('Password')} value={password} onChange={setPassword} type="password" required
                     autoComplete={firstRun ? 'new-password' : 'current-password'}
                     hint={firstRun ? t('At least 12 characters, with a letter and a digit.') : undefined} />

              {err && (
                <div className="pm-open flex gap-2 rounded-[14px] bg-critical-50 px-3.5 py-2.5 text-[12.5px] text-critical-600">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{err.message}</span>
                </div>
              )}

              <button className="group mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#0071e3] via-[#4f46e5] to-[#7c3aed] bg-[length:200%_100%] bg-left text-[15px] font-semibold text-white shadow-[0_12px_28px_-12px_rgba(79,70,229,0.85)] transition-all duration-500 hover:bg-right active:scale-[0.98] disabled:opacity-60"
                      disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t(firstRun ? 'Create administrator' : 'Sign in')}
                {!busy && <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />}
              </button>
            </form>

            {status?.enforcing && (
              <p className="mt-5 text-center text-[12px] text-muted lg:text-left">
                {t('Sessions last {h} hours and can be revoked by an administrator.', { h: status.sessionHours })}
              </p>
            )}
          </div>

          {/* what it does, in three lines — the brain panel says it on a wide screen */}
          <ul className="pm-stagger mt-6 flex flex-wrap justify-center gap-2 lg:hidden">
            {FEATURES.map(({ Icon, hex, title }) => (
              <li key={title} className="inline-flex items-center gap-2 rounded-full bg-white/70 px-3 py-1.5 text-[12.5px] text-ink-2 shadow-[0_0_0_0.5px_rgba(0,0,0,0.06)] backdrop-blur">
                <span className="grid h-5 w-5 place-items-center rounded-full text-white" style={{ background: hex }}><Icon className="h-3 w-3" /></span>
                {t(title)}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-center text-[12px] text-muted lg:hidden">
            <span className="font-semibold text-ink-2">Company Brain</span> · {t('Compliance intelligence')}
          </p>
        </div>
      </div>
    </div>
  );
}

/** What the brain is doing, phrased without figures: there is no data behind a sign-in screen. */
const AT_WORK = [
  tx('Reading the rules that apply to you'),
  tx('Matching every duty to your documents'),
  tx('Scoring risk with versioned rules'),
  tx('Flagging what changed overnight'),
];

/** The wide-screen left half: the knowledge graph at work, and what the product does. */
function BrainPanel() {
  const t = useT();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % AT_WORK.length), 2600);
    return () => window.clearInterval(id);
  }, []);
  return (
    <aside className="relative hidden overflow-hidden text-white lg:flex lg:flex-col"
           style={{ background: 'radial-gradient(1000px 520px at 15% 0%, rgba(79,70,229,0.55), transparent 60%), radial-gradient(800px 480px at 90% 100%, rgba(147,51,234,0.45), transparent 60%), linear-gradient(140deg, #0a0f24 0%, #11163a 50%, #1a1142 100%)' }}>
      <NeuralCanvas tone="dark" density={1.5} />
      {/* the words sit on a calmer band, so the graph never fights the text */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#0a0f24]/80 via-[#0a0f24]/30 to-transparent" aria-hidden="true" />
      <div className="relative flex flex-1 flex-col justify-between p-10 xl:p-14">
        <div className="cb-rise flex items-center gap-3">
          <span className="cb-glow grid h-11 w-11 place-items-center rounded-[14px] bg-gradient-to-br from-[#2b8cff] via-[#5e5ce6] to-[#bf5af2]">
            <Brain className="cb-think h-6 w-6" />
          </span>
          <span className="leading-tight">
            <span className="block text-[16px] font-semibold tracking-tight">Company Brain</span>
            <span className="block text-[12.5px] text-indigo-200/80">{t('Compliance intelligence')}</span>
          </span>
        </div>

        <div className="max-w-[520px]">
          <h2 className="cb-rise cb-rise-1 text-[40px] font-semibold leading-[1.12] tracking-tight xl:text-[46px]">
            <span className="block text-white">{t('Every rule. Every duty.')}</span>
            <span className="cb-shimmer block">{t('One brain.')}</span>
          </h2>
          <p className="cb-rise cb-rise-2 mt-4 text-[16px] leading-relaxed text-indigo-100/85">
            {t('It reads the rules that apply to you, checks each duty against your documents, and shows what to fix first.')}
          </p>
          <div className="cb-rise cb-rise-3 mt-7 inline-flex items-center gap-2.5 rounded-full bg-white/[0.08] py-2 pl-2 pr-4 ring-1 ring-white/15 backdrop-blur-md">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-cyan-400 to-indigo-500">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span key={i} className="cb-line-in text-[14px] text-indigo-50">{t(AT_WORK[i])}</span>
            <span className="cb-caret -ml-1 h-4 w-[2px] rounded bg-cyan-300" aria-hidden="true" />
          </div>
          <ul className="cb-rise cb-rise-4 mt-8 space-y-2.5">
            {FEATURES.map(({ Icon, hex, title }) => (
              <li key={title} className="flex items-center gap-3 text-[14.5px] text-indigo-50/90">
                <span className="grid h-8 w-8 place-items-center rounded-[10px] ring-1 ring-white/15" style={{ background: `${hex}33` }}>
                  <Icon className="h-4 w-4" style={{ color: hex }} />
                </span>
                {t(title)}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[12.5px] text-indigo-200/70">{t('Rules decide. People approve. Every step is recorded.')}</p>
      </div>
    </aside>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder, hint, autoComplete, required }: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; hint?: string; autoComplete?: string; required?: boolean;
}) {
  const t = useT();
  const [show, setShow] = useState(false);
  const secret = type === 'password';
  return (
    <label className="block">
      <span className="mb-1.5 block px-1 text-[12.5px] font-medium text-ink-2">{label}</span>
      <span className="relative block">
        <input className="h-12 w-full rounded-[14px] border border-transparent bg-black/[0.04] px-4 text-[15px] text-ink outline-none transition-all duration-200 placeholder:text-muted-2 focus:border-[#0071e3]/50 focus:bg-white focus:shadow-[0_0_0_4px_rgba(0,113,227,0.15)]"
               type={secret && show ? 'text' : type} value={value} placeholder={placeholder} required={required}
               onChange={(e) => onChange(e.target.value)}
               autoComplete={autoComplete ?? (secret ? 'current-password' : 'on')} />
        {secret && (
          <button type="button" onClick={() => setShow((v) => !v)} aria-label={t(show ? 'Hide password' : 'Show password')}
                  className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:bg-black/[0.05] hover:text-ink">
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </span>
      {hint && <span className="mt-1 block px-1 text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

export default SignInPage;
