/**
 * The moment after sign-in: the knowledge graph gathers around the brain, three
 * short lines say what it is getting ready, and the app fades in underneath —
 * it has been loading all along, so the splash costs no waiting of its own.
 *
 * About two and a half seconds; a click, Enter or Esc skips it, and people who
 * ask for reduced motion get a short, still version.
 */
import { useEffect, useRef, useState } from 'react';
import { Brain, Sparkles } from 'lucide-react';
import { cn } from '@/utils/ui';
import { tx, useT } from '@/i18n';
import { NeuralCanvas } from './NeuralCanvas';
import './auth.css';

const STEPS = [
  tx('Reading the rules that apply to you'),
  tx('Matching every duty to your documents'),
  tx('Getting your workspace ready'),
];

export function SplashScreen({ name, onDone }: { name?: string | null; onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const done = useRef(onDone);
  done.current = onDone;
  const first = (name ?? '').trim().split(/\s+/)[0];

  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // design check in development only: ?splash-hold keeps it on screen
    const hold = import.meta.env.DEV && new URLSearchParams(window.location.search).has('splash-hold');
    const total = still ? 900 : 2600;
    const tick = window.setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), still ? 280 : 780);
    const fade = hold ? 0 : window.setTimeout(() => setLeaving(true), total - 450);
    const end = hold ? 0 : window.setTimeout(() => done.current(), total);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Enter') done.current(); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(fade);
      window.clearTimeout(end);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" onClick={() => done.current()}
         className={cn('fixed inset-0 z-[100] grid cursor-pointer place-items-center overflow-hidden text-white', leaving && 'cb-splash-out')}
         style={{ background: 'radial-gradient(900px 520px at 50% 40%, rgba(79,70,229,0.55), transparent 65%), radial-gradient(700px 420px at 50% 100%, rgba(147,51,234,0.4), transparent 60%), linear-gradient(160deg, #0a0f24 0%, #11163a 55%, #1a1142 100%)' }}>
      <NeuralCanvas tone="dark" converge density={1.1} />
      {/* a calm centre, so the gathering graph frames the words instead of crossing them */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true"
           style={{ background: 'radial-gradient(340px 230px at 50% 54%, rgba(10,15,36,0.7), transparent 72%)' }} />

      <div className="relative flex flex-col items-center px-6 text-center">
        <div className="relative grid h-36 w-36 place-items-center">
          {/* thinking: rings go out, small signals circle the brain */}
          <span className="cb-ring absolute inset-4 rounded-full border border-indigo-300/50" aria-hidden="true" />
          <span className="cb-ring cb-ring-2 absolute inset-4 rounded-full border border-cyan-300/40" aria-hidden="true" />
          <span className="cb-ring cb-ring-3 absolute inset-4 rounded-full border border-fuchsia-300/40" aria-hidden="true" />
          <span className="cb-orbit absolute inset-0" aria-hidden="true">
            <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-cyan-300 shadow-[0_0_12px_4px_rgba(103,232,249,0.7)]" />
          </span>
          <span className="cb-orbit-rev absolute inset-3" aria-hidden="true">
            <span className="absolute bottom-0 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-fuchsia-300 shadow-[0_0_10px_3px_rgba(240,171,252,0.7)]" />
          </span>
          <span className="cb-glow relative grid h-20 w-20 place-items-center rounded-[26px] bg-gradient-to-br from-[#2b8cff] via-[#5e5ce6] to-[#bf5af2]">
            <Brain className="cb-think h-10 w-10" />
          </span>
        </div>

        <p className="cb-rise mt-8 text-[12px] font-semibold uppercase tracking-[0.22em] text-indigo-200/80">Company Brain</p>
        <h1 className="cb-rise cb-rise-1 mt-2 text-[30px] font-semibold tracking-tight">
          {first ? t('Welcome, {name}', { name: first }) : t('Welcome back')}
        </h1>
        <p key={step} className="cb-line-in mt-3 flex h-6 items-center gap-2 text-[14.5px] text-indigo-100/85">
          <Sparkles className="h-4 w-4 text-cyan-300" /> {t(STEPS[step])}
        </p>
        <div className="mt-6 h-1 w-60 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <span className="block h-full rounded-full bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-300 transition-[width] duration-700 ease-out"
                style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <p className="mt-8 text-[11.5px] text-indigo-200/50">{t('Click to skip')}</p>
      </div>
    </div>
  );
}
