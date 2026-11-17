/**
 * Add data — the one place records come in. Connections (folders and APIs),
 * Documents (document intake) and Spreadsheet import used to be three nav items
 * that answered the same question; they are tabs here. Each tab is the existing
 * page, rendered without its own header — this page draws the one header and
 * the tab row. The old /integrations, /intake and /onboarding URLs redirect to
 * the matching tab.
 */
import { useRef } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Files, FileSpreadsheet, Plug, type LucideIcon } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useLiquidPill } from '@/components/ui/motion';
import { toneFor } from '@/config/tones';
import { IntakePage } from '@/modules/intake/IntakePage';
import { IntegrationsPage } from './IntegrationsPage';
import { OnboardingPage } from './OnboardingPage';
import { EmbeddedPage } from './embedded';
import { cn } from '@/utils/ui';
import { useT } from '@/i18n';
import './addData.css';

type TabKey = 'connections' | 'documents' | 'import';

/** `path` is the URL segment after /add-data; the first tab has none. `hint` says what the tab is for. */
const TABS: { key: TabKey; path: string; label: string; icon: LucideIcon; hint: string }[] = [
  {
    key: 'connections', path: '', label: 'Connections', icon: Plug,
    hint: 'Folders and systems that send records in each time you sync them',
  },
  {
    key: 'documents', path: 'documents', label: 'Documents', icon: Files,
    hint: 'Upload a folder of documents as it is — each one is read, sorted and filed in its department',
  },
  {
    key: 'import', path: 'import', label: 'Spreadsheet import', icon: FileSpreadsheet,
    hint: "Fill in the company's records one section at a time — answer questions or upload a CSV",
  },
];

const urlFor = (key: TabKey) => {
  const path = TABS.find((t) => t.key === key)?.path;
  return path ? `/add-data/${path}` : '/add-data';
};

export function AddDataPage() {
  const tr = useT();
  const { tab } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const current = TABS.find((t) => t.path === (tab ?? ''));
  if (!current) return <Navigate to="/add-data" replace />;

  return (
    <>
      <Topbar
        title="Add data"
        subtitle="Bring the hospital's records into the Brain — connect a system, upload documents or import a spreadsheet."
        icon="UploadCloud"
        tone={toneFor('overview')}
        hideSearch={current.key === 'import'}
        actions={
          current.key === 'import'
            ? <button className="btn" onClick={() => navigate('/company-setup')}>{tr('Company setup')}</button>
            : undefined
        }
        below={<AddDataTabs active={current.key} onChange={(key) => navigate(urlFor(key))} />}
      />
      <EmbeddedPage.Provider value>
        <div key={current.key} className="ad-tab-in">
          {current.key === 'connections' && <IntegrationsPage />}
          {current.key === 'documents' && <IntakePage />}
          {current.key === 'import' && <OnboardingPage />}
        </div>
      </EmbeddedPage.Provider>
    </>
  );
}

/** The three ways in, each with its icon; a pill flows to the open one and a line says what it is for. */
function AddDataTabs({ active, onChange }: { active: TabKey; onChange: (key: TabKey) => void }) {
  const tr = useT();
  const box = useRef<HTMLDivElement>(null);
  const pill = useLiquidPill(box, '[aria-selected="true"]', 'x', [active]);
  const hint = TABS.find((t) => t.key === active)?.hint;
  return (
    <div className="pb-2.5">
      <div ref={box} role="tablist" aria-label={tr('Add data sections')}
           className="relative inline-flex max-w-full gap-1 overflow-x-auto rounded-2xl bg-slate-100/80 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span aria-hidden="true" className="liquid-pill top-1 bottom-1 rounded-xl bg-white shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.07)]" style={pill} />
        {TABS.map((t) => {
          const on = t.key === active;
          return (
            <button key={t.key} role="tab" aria-selected={on} onClick={() => onChange(t.key)} title={tr(t.hint)}
                    className={cn('group relative z-[1] flex shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors',
                      on ? 'text-brand-700' : 'text-ink-2 hover:bg-white/60 hover:text-ink')}>
              <t.icon className={cn('ad-ic h-4 w-4 transition-colors', on ? 'text-brand-600' : 'text-muted')} aria-hidden="true" />
              {tr(t.label)}
            </button>
          );
        })}
      </div>
      {hint && <p key={active} className="animate-fade mt-2 truncate px-1 text-[12.5px] text-muted">{tr(hint)}</p>}
    </div>
  );
}
