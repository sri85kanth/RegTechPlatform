import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain, Loader2, AlertTriangle, ShieldCheck, ShieldAlert, Radar,
  CheckCircle2, XCircle, Cpu, Database, GitBranch } from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import {
  useEngineStatus, useAnalyse, useEvals, useWatcherStatus,
  type ImpactRun,
} from '@/services/impactEngineApi';
import { useRegulations } from '@/services/regulationsApi';
import { cn } from '@/utils/ui';

/**
 * Impact Engine console.
 *
 * Two things this screen must never blur:
 *   - which ROUTE produced a result (a reasoning model, or the deterministic
 *     fallback that runs when no key is configured), and
 *   - that everything shown is a proposal awaiting human approval.
 * Both are rendered on every result, not tucked into a tooltip.
 */
export function ImpactEnginePage() {
  const navigate = useNavigate();
  const { data: status } = useEngineStatus();
  const { data: watcher } = useWatcherStatus();
  const { data: regs } = useRegulations({ page: 1, size: 50 });
  const [rid, setRid] = useState('reg-mdkyc');
  const analyse = useAnalyse();
  const evals = useEvals();
  const run = analyse.data;

  return (
    <>
      <Topbar
        title="Impact Engine"
        subtitle="Reason about what a regulatory change means for this company — as proposals, never decisions"
        icon="Brain"
        tone="#7c3aed"
        section="Compliance"
      />

      <div className="space-y-4 p-4 sm:p-6">
        {/* capability banner — say plainly what will actually run */}
        <div className="card flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-[12.5px]">
          <span className="inline-flex items-center gap-1.5">
            <Cpu className="h-4 w-4 text-muted-2" />
            {status?.models.available ? (
              <>model <b className="text-ink-2">{status.models.usable[0]}</b></>
            ) : (
              <span className="text-warning-700">
                No model key — the deterministic fallback will run and be labelled as such
              </span>
            )}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Database className="h-4 w-4 text-muted-2" />
            memory <b className="text-ink-2">{status?.memory.backend}</b>
          </span>
          <span className="text-muted">runs <b className="text-ink-2">{status?.runs ?? 0}</b></span>
          <span className="text-muted">confidence floor <b className="text-ink-2">{status?.confidenceFloor}</b></span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select className="input min-w-72 flex-1" value={rid} onChange={(e) => setRid(e.target.value)}>
            {(regs?.items ?? []).map((r) => (
              <option key={r.id} value={r.id}>{r.title.slice(0, 90)}</option>
            ))}
          </select>
          <button className="btn btn-primary" disabled={analyse.isPending} onClick={() => analyse.mutate(rid)}>
            {analyse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
            Analyse impact
          </button>
          <button className="btn" onClick={() => navigate(`/regulation/${rid}/impact`)}>
            <GitBranch className="h-4 w-4" /> Impact graph
          </button>
          <button className="btn" disabled={evals.isPending} onClick={() => evals.mutate()}>
            {evals.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            Run safety evals
          </button>
        </div>

        {analyse.error && (
          <div className="card flex items-center gap-3 p-4 text-[13px] text-critical-600">
            <AlertTriangle className="h-4 w-4" /> {(analyse.error as Error).message}
          </div>
        )}

        {evals.data && <Evals d={evals.data} />}
        {run && <RunView run={run} />}

        {watcher && (
          <section className="card p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Radar className="h-4 w-4 text-muted-2" />
              <h2 className="text-[13px] font-bold text-ink">Source watcher</h2>
              <span className="text-[12px] text-muted">
                {watcher.totalChecks} checks · {watcher.dueNow} due · {watcher.changesDetected} computed changes
              </span>
            </div>
            <p className="mb-2 text-[12px] leading-relaxed text-muted">{watcher.note}</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(watcher.byOutcome).map(([k, v]) => (
                <span key={k} className={cn('pill',
                  k === 'CHANGED' ? 'bg-critical-50 text-critical-600'
                    : k === 'UNCHANGED' ? 'bg-success-50 text-success-600'
                    : 'bg-slate-100 text-slate-600')}>{k} {v}</span>
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function RunView({ run }: { run: ImpactRun }) {
  const llm = run.route === 'llm';
  return (
    <div className="space-y-3">
      {/* route is stated first — it changes how much weight the result carries */}
      <div className={cn('card flex flex-wrap items-center gap-3 border-l-4 px-4 py-3',
        llm ? 'border-l-brand-500' : 'border-l-warning-500')}>
        <span className={cn('pill', llm ? 'bg-brand-50 text-brand-600' : 'bg-warning-50 text-warning-600')}>
          {llm ? 'model reasoning' : 'deterministic fallback'}
        </span>
        <span className="text-[13px] font-semibold text-ink">{run.status}</span>
        {run.fallbackReason && <span className="text-[12px] text-muted">({run.fallbackReason})</span>}
        {run.validation && (
          <span className="ml-auto text-[12px] text-muted">
            hallucination rate <b className={cn(run.validation.hallucinationRate > 0 ? 'text-critical-600' : 'text-success-600')}>
              {run.validation.hallucinationRate}</b>
            {run.validation.dropped.length > 0 && <> · {run.validation.dropped.length} dropped</>}
          </span>
        )}
      </div>

      <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-[12.5px] text-warning-700">
        {run.disclaimer}
      </div>

      {run.applicability && (
        <div className="card p-4">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold text-ink">Applicability</span>
            <span className="pill bg-slate-100 text-slate-600">{run.applicability.applies}</span>
            <span className="text-[12px] text-muted">{run.applicability.confidence}% confidence</span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{run.applicability.reasoning}</p>
        </div>
      )}

      {run.notes.length > 0 && (
        <ul className="card space-y-1 p-4 text-[12.5px] text-muted">
          {run.notes.map((n, i) => <li key={i}>• {n}</li>)}
        </ul>
      )}

      {run.impacts.length > 0 && (
        <div className="card overflow-hidden">
          <div className="border-b border-line px-4 py-2.5 text-[13px] font-bold text-ink">
            {run.impacts.length} proposed impact{run.impacts.length === 1 ? '' : 's'}
          </div>
          <ul className="divide-y divide-line">
            {run.impacts.map((i, n) => (
              <li key={n} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11.5px] text-muted-2">{i.entity_id}</span>
                  <span className="pill bg-slate-100 text-slate-600">{i.impact_type}</span>
                  <span className="pill bg-slate-100 text-slate-600">{i.severity}</span>
                  <span className="text-[12px] text-muted">{i.confidence}%</span>
                  {i.needs_human_review && (
                    <span className="pill bg-warning-50 text-warning-600">needs review</span>
                  )}
                  {i.disputed_by_critique && (
                    <span className="pill bg-critical-50 text-critical-600">disputed by critique</span>
                  )}
                </div>
                <p className="mt-1 text-[12.5px] text-ink-2">{i.rationale}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.trace && run.trace.length > 0 && (
        <details className="card p-4">
          <summary className="cursor-pointer text-[13px] font-bold text-ink">
            Pipeline trace ({run.trace.length} stages)
          </summary>
          <ul className="mt-2 space-y-1 text-[12px]">
            {run.trace.map((t, i) => (
              <li key={i} className="flex items-center gap-2">
                {t.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />
                      : <XCircle className="h-3.5 w-3.5 text-critical-600" />}
                <span className="font-medium text-ink-2">{t.stage}</span>
                <span className="text-muted">{t.model}</span>
                <span className="ml-auto text-muted-2">{t.latency_s}s</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Evals({ d }: { d: { passed: number; failed: number; skipped: number; modelKeyPresent: boolean;
                            results: { case: string; property: string; result: string; detail: string }[] } }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        {d.failed === 0 ? <ShieldCheck className="h-4 w-4 text-success-600" />
                        : <ShieldAlert className="h-4 w-4 text-critical-600" />}
        <span className="text-[13px] font-bold text-ink">Safety evals</span>
        <span className="text-[12.5px] text-muted">
          {d.passed} passed · {d.failed} failed · {d.skipped} skipped
          {!d.modelKeyPresent && ' (model cases skipped — no key)'}
        </span>
      </div>
      <ul className="divide-y divide-line text-[12.5px]">
        {d.results.map((r, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
            <span className={cn('pill',
              r.result === 'PASS' ? 'bg-success-50 text-success-600'
                : r.result === 'FAIL' ? 'bg-critical-50 text-critical-600'
                : 'bg-slate-100 text-slate-600')}>{r.result}</span>
            <span className="font-medium text-muted-2">{r.property}</span>
            <span className="text-ink-2">{r.case}</span>
            <span className="ml-auto truncate text-[11.5px] text-muted-2">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ImpactEnginePage;
