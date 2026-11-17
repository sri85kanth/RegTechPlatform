import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  AlertTriangle, ExternalLink, Ban, CheckCircle2, ShieldCheck,
  FileText, Link2, History, Fingerprint, Layers, Scale, BookOpen,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useRegulationDetail, type RegulationDetail, type Provision } from '@/services/regulationDetailApi';
import { cn } from '@/utils/ui';

/**
 * The Regulation — what the regulator actually said.
 *
 * Seven groups, in the order a reviewer reads them. Company impact is
 * deliberately absent: it is a different layer, and putting it here makes
 * "our engine thinks this applies" look like "the regulation says so".
 *
 * A field the source does not state renders as "not stated", never as blank —
 * blank reads as an oversight, "not stated" is a fact about the regulation.
 */
const GROUPS = ['Identity', 'Scope', 'Structure', 'Legal content',
                'Relationships', 'Versions', 'Provenance'] as const;
type Group = typeof GROUPS[number];

const GROUP_ICON: Record<Group, typeof Scale> = {
  Identity: Scale, Scope: Layers, Structure: BookOpen, 'Legal content': FileText,
  Relationships: Link2, Versions: History, Provenance: Fingerprint,
};

export function RegulationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group>('Identity');
  const { data, isLoading, error } = useRegulationDetail(id);

  return (
    <>
      <Topbar
        title={data?.identity.title?.slice(0, 68) || 'Regulation'}
        subtitle={data ? `${data.identity.regulator} · ${data.identity.regulationType ?? 'Regulation'}` : ''}
        icon="Scale" tone="#1b4dbf" section="Regulatory"
        onBack={() => navigate('/reg-regulations')} backLabel="All regulations"
        actions={
          data?.provenance.sourceUrl ? (
            <a href={data.provenance.sourceUrl} target="_blank" rel="noreferrer" className="btn btn-sm">
              <ExternalLink className="h-3.5 w-3.5" /> Official source
            </a>
          ) : undefined
        }
        below={
          <nav className="flex flex-wrap gap-1">
            {GROUPS.map((g) => {
              const I = GROUP_ICON[g];
              return (
                <button key={g} onClick={() => setGroup(g)}
                  className={cn('flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium transition',
                    group === g ? 'border-brand-500 text-brand-600'
                                : 'border-transparent text-muted hover:text-ink')}>
                  <I className="h-3.5 w-3.5" />{g}
                </button>
              );
            })}
          </nav>
        }
      />

      <div className="space-y-4 p-4 sm:p-6">
        {isLoading && <div className="card py-14 text-center text-[13px] text-muted">Loading the regulation…</div>}
        {error && (
          <div className="card flex items-center gap-3 p-4 text-[13px] text-critical-600">
            <AlertTriangle className="h-4 w-4" />{(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <p className="rounded-card border border-line bg-surface px-4 py-2 text-[12px] text-muted">
              {data.note}
            </p>
            {group === 'Identity' && <Identity d={data} />}
            {group === 'Scope' && <Scope d={data} />}
            {group === 'Structure' && <Structure d={data} />}
            {group === 'Legal content' && <Legal d={data} />}
            {group === 'Relationships' && <Relationships d={data} />}
            {group === 'Versions' && <Versions d={data} />}
            {group === 'Provenance' && <Provenance d={data} />}
          </>
        )}
      </div>
    </>
  );
}

/* ---------- shared ---------- */
function Field({ k, v, hint }: { k: string; v: string | number | null | undefined; hint?: string }) {
  const missing = v === null || v === undefined || v === '';
  return (
    <div>
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-2">{k}</dt>
      <dd className={cn('mt-0.5 text-[13px]', missing ? 'italic text-muted-2' : 'font-medium text-ink-2')}>
        {missing ? 'not stated in the source' : v}
      </dd>
      {hint && <div className="text-[11px] text-muted-2">{hint}</div>}
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="card overflow-hidden">
      <div className="border-b border-line px-5 py-2.5">
        <h3 className="text-[13px] font-bold text-ink">{title}</h3>
        {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Empty({ msg }: { msg: string }) {
  return <p className="py-6 text-center text-[12.5px] text-muted">{msg}</p>;
}

/* ---------- 1 · identity ---------- */
function Identity({ d }: { d: RegulationDetail }) {
  const i = d.identity;
  return (
    <>
      <Card title="Identity" sub="Who issued it, under what authority, and when it bites.">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field k="Title" v={i.title} />
          <Field k="Short title" v={i.shortTitle} />
          <Field k="Regulator" v={i.regulator} />
          <Field k="Type" v={i.regulationType} />
          <Field k="Status" v={i.status} />
          <Field k="Notification number" v={i.notificationNumber} />
          <Field k="Circular number" v={i.circularNumber} />
          <Field k="Reference" v={i.referenceNumber} />
          <Field k="Issuing authority" v={i.issuingAuthority} />
        </dl>
      </Card>

      <Card title="Dates" sub="Kept separate on purpose — a document's printed date is not the date the rule starts binding.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field k="Issued" v={i.issuedDate} hint="date on the document" />
          <Field k="Published" v={i.publishedDate} hint="date made public" />
          <Field k="Effective from" v={i.effectiveDate} hint="date it starts binding" />
        </dl>
      </Card>

      <Card title="Legal authority" sub="The power the regulator is acting under.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field k="Legal authority" v={i.legalAuthority} />
          <Field k="Enabling act" v={i.enablingAct} />
          <Field k="Enabling section" v={i.enablingSection} />
        </dl>
      </Card>
    </>
  );
}

/* ---------- 2 · scope ---------- */
function Scope({ d }: { d: RegulationDetail }) {
  const s = d.scope;
  return (
    <>
      <Card title="Scope" sub="Who and where the regulation reaches, as stated in the text.">
        <dl className="grid gap-4 sm:grid-cols-3">
          <Field k="Jurisdiction" v={s.jurisdiction} />
          <Field k="Sector" v={s.sector} />
          <Field k="Sub-sector" v={s.subSector} />
        </dl>
        {s.entityTypes.length > 0 && (
          <div className="mt-4">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-2">Entity types named</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {s.entityTypes.map((t) => <span key={t} className="pill bg-slate-100 text-slate-600">{t}</span>)}
            </div>
          </div>
        )}
        {s.notExtracted.length > 0 && (
          <p className="mt-4 rounded-lg bg-warning-50 px-3 py-2 text-[12px] text-warning-700">
            <b>Not yet extracted:</b> {s.notExtracted.join(', ')}. These are shown as unknown rather
            than empty — an empty list would read as "the regulation names none".
          </p>
        )}
      </Card>

      <Card title={`Applicability rules (${s.applicabilityRules.length})`}
            sub="Extracted from the regulation's own text, each carrying its source clause.">
        {s.applicabilityRules.length === 0 ? <Empty msg="No applicability rules extracted." /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead><tr className="border-b border-line text-[10.5px] uppercase tracking-wide text-muted-2">
                <th className="py-1.5 pr-3">Entity type</th><th className="py-1.5 pr-3">Applies</th>
                <th className="py-1.5 pr-3">Source clause</th><th className="py-1.5 pr-3">Conf.</th>
                <th className="py-1.5">Rule</th>
              </tr></thead>
              <tbody>
                {s.applicabilityRules.map((r, i) => (
                  <tr key={i} className="border-b border-line/60 align-top">
                    <td className="py-1.5 pr-3 font-medium text-ink">{r.entity_type ?? '—'}</td>
                    <td className="py-1.5 pr-3">
                      <span className={cn('pill', r.applicability === 'Applies'
                        ? 'bg-success-50 text-success-600' : 'bg-slate-100 text-slate-600')}>
                        {r.applicability ?? '—'}
                      </span>
                    </td>
                    <td className="py-1.5 pr-3 font-mono text-[11px] text-muted-2">{r.source_clause ?? '—'}</td>
                    <td className="py-1.5 pr-3 tabular-nums text-muted">{r.confidence ?? '—'}</td>
                    <td className="py-1.5 text-muted">{(r.applicability_rule ?? '').slice(0, 150)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* ---------- 3 · structure ---------- */
function Structure({ d }: { d: RegulationDetail }) {
  const s = d.structure;
  return (
    <>
      <div className="grid grid-cols-3 gap-3">
        <Stat n={s.sections} label="sections" />
        <Stat n={s.clauses} label="clauses" hint={s.clauses === 0 ? 'not yet parsed' : undefined} />
        <Stat n={s.tables} label="tables" hint="extracted by docling" />
      </div>
      <Card title="Document structure" sub="Every node keeps its source reference.">
        {s.tree.length === 0 ? <Empty msg="No structure extracted." /> : (
          <ul className="max-h-[520px] space-y-0.5 overflow-y-auto">
            {s.tree.map((n) => (
              <li key={n.id} className={cn('flex items-baseline gap-2 rounded px-2 py-1 text-[12.5px] hover:bg-slate-50',
                                           n.parent_section_id && 'ml-5')}>
                <span className="w-14 shrink-0 font-mono text-[11px] text-brand-600">§{n.section_number}</span>
                <span className="min-w-0 flex-1 truncate text-ink-2">{n.section_title || '—'}</span>
                <span className="shrink-0 tabular-nums text-[11px] text-muted-2">{n.chars} chars</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Stat({ n, label, hint }: { n: number; label: string; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <div className={cn('text-2xl font-extrabold tabular-nums', n ? 'text-ink' : 'text-muted-2')}>{n}</div>
      <div className="text-[12px] font-medium text-ink-2">{label}</div>
      {hint && <div className="text-[11px] text-muted-2">{hint}</div>}
    </div>
  );
}

/* ---------- 4 · legal content ---------- */
const MODALITY_TONE: Record<string, string> = {
  SHALL: 'bg-brand-50 text-brand-600', MUST: 'bg-brand-50 text-brand-600',
  REQUIRED: 'bg-brand-50 text-brand-600',
  SHALL_NOT: 'bg-critical-50 text-critical-600', MUST_NOT: 'bg-critical-50 text-critical-600',
  PROHIBITED: 'bg-critical-50 text-critical-600', MAY_NOT: 'bg-critical-50 text-critical-600',
  MAY: 'bg-success-50 text-success-600', PERMITTED: 'bg-success-50 text-success-600',
  SHOULD: 'bg-warning-50 text-warning-600',
};

function Legal({ d }: { d: RegulationDetail }) {
  const l = d.legal;
  const [q, setQ] = useState('');
  const shown = l.provisions.filter((p) =>
    !q || p.source_text.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat n={l.counts.provisions} label="provisions" />
        <Stat n={l.counts.prohibitions} label="prohibitions" hint="shall not / prohibited" />
        <Stat n={l.counts.permissions} label="permissions" hint="may / permitted" />
        <Stat n={l.counts.definitions} label="definitions" />
        <Stat n={l.counts.conditions} label="conditions" />
      </div>

      <Card title="Legal modality"
            sub="What the regulation actually commands — a system that cannot tell 'shall' from 'shall not' is dangerous here.">
        <div className="flex flex-wrap gap-2">
          {Object.entries(l.modalityBreakdown).map(([m, n]) => (
            <span key={m} className={cn('pill', MODALITY_TONE[m] ?? 'bg-slate-100 text-slate-600')}>
              {m.replace(/_/g, ' ')} · {n}
            </span>
          ))}
        </div>
      </Card>

      {l.definitions.length > 0 && (
        <Card title={`Definitions (${l.counts.definitions})`}
              sub="Stored verbatim. The authoritative wording is never paraphrased.">
          <dl className="space-y-3">
            {l.definitions.slice(0, 25).map((def) => (
              <div key={def.id}>
                <dt className="text-[13px] font-semibold text-ink">“{def.term}”</dt>
                <dd className="mt-0.5 border-l-2 border-brand-300 pl-3 text-[12.5px] leading-relaxed text-ink-2">
                  {def.definition_text.slice(0, 500)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}

      <Card title={`Provisions (${shown.length} of ${l.counts.provisions})`}
            sub="Actor · modality · action · object, with the source sentence kept intact.">
        <input className="input mb-3 w-full" placeholder="Search the provision text…"
               value={q} onChange={(e) => setQ(e.target.value)} />
        {shown.length === 0 ? <Empty msg="No provisions match." /> : (
          <ul className="max-h-[560px] space-y-2 overflow-y-auto">
            {shown.slice(0, 60).map((p) => <ProvisionRow key={p.id} p={p} d={d} />)}
          </ul>
        )}
      </Card>

      {/* Requirements are regulatory fact — the duty as the drafter marked it,
          cited to its clause. What it means for THIS company (owner, control,
          compliance) is deliberately not on this page; it lives on /compliance. */}
      <Card title={`Requirements (${(l.requirements ?? []).length} of ${l.counts.requirements})`}
            sub="One per clause carrying a duty. Verbatim. Frequency, deadline, threshold and owner are only shown when the text itself names them.">
        {(l.requirements ?? []).length === 0
          ? <Empty msg="No requirements extracted — this document carries no enumerated clauses with a duty." />
          : (
          <ul className="max-h-[560px] space-y-2 overflow-y-auto">
            {l.requirements.map((r) => (
              <li key={r.id} className="rounded-[8px] border border-line bg-surface px-3.5 py-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono text-[11.5px] font-semibold text-brand-600">
                    {r.source_clause ?? '—'}
                  </span>
                  <span className="pill bg-slate-100 text-slate-600">{r.review_status}</span>
                  <span className="ml-auto text-[11px] text-muted-2">{r.derivation_method}</span>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-2">{r.statement}</p>
                {(r.frequency || r.deadline || r.threshold || r.responsible_role) && (
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    {r.frequency && <span className="pill bg-brand-50 text-brand-600">every {r.frequency}</span>}
                    {r.deadline && <span className="pill bg-warning-50 text-warning-600">{r.deadline}</span>}
                    {r.threshold && <span className="pill bg-slate-100 text-slate-700">{r.threshold}</span>}
                    {r.responsible_role && <span className="pill bg-slate-100 text-slate-700">{r.responsible_role}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function ProvisionRow({ p, d }: { p: Provision; d: RegulationDetail }) {
  const conds = d.legal.conditions.filter((c) => c.provision_id === p.id);
  const excs = d.legal.exceptions.filter((e) => e.provision_id === p.id);
  const thr = d.legal.thresholds.filter((t) => t.provision_id === p.id);
  const tim = d.legal.timingRules.filter((t) => t.provision_id === p.id);

  return (
    <li className="rounded-card border border-line px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {p.is_prohibition && <Ban className="h-3.5 w-3.5 text-critical-600" />}
        {p.is_permission && <CheckCircle2 className="h-3.5 w-3.5 text-success-600" />}
        <span className={cn('pill', MODALITY_TONE[p.modality ?? ''] ?? 'bg-slate-100 text-slate-600')}>
          {(p.modality ?? '—').replace(/_/g, ' ')}
        </span>
        {p.section_number && (
          <span className="font-mono text-[11px] text-brand-600">§{p.section_number}</span>
        )}
        {p.actor && <span className="text-[12px] text-muted"><b className="text-ink-2">{p.actor}</b></span>}
        <span className="ml-auto pill bg-warning-50 text-warning-600">{p.review_status}</span>
      </div>

      {/* the source sentence, verbatim — never a paraphrase */}
      <p className="mt-1.5 border-l-2 border-line-2 pl-2.5 text-[12.5px] leading-relaxed text-ink-2">
        {p.source_text.slice(0, 460)}{p.source_text.length > 460 && '…'}
      </p>

      {(conds.length > 0 || excs.length > 0 || thr.length > 0 || tim.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {conds.map((c, i) => (
            <span key={`c${i}`} className="pill bg-slate-100 text-slate-600" title={c.expression}>
              if · {c.condition_type.toLowerCase().replace(/_/g, ' ')}
            </span>
          ))}
          {excs.map((e, i) => (
            <span key={`e${i}`} className="pill bg-warning-50 text-warning-600" title={e.expression}>
              {e.exception_type.toLowerCase()}
            </span>
          ))}
          {thr.map((t, i) => (
            <span key={`t${i}`} className="pill bg-brand-50 text-brand-600" title={t.source_text}>
              {t.metric} {t.currency ?? ''} {t.value}{t.unit ?? ''}
            </span>
          ))}
          {tim.map((t, i) => (
            <span key={`m${i}`} className="pill bg-success-50 text-success-600" title={t.source_text}>
              {t.rule_type.toLowerCase()} · {t.value}{t.unit ? ` ${t.unit}` : ''}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/* ---------- 5 · relationships ---------- */
function Relationships({ d }: { d: RegulationDetail }) {
  const r = d.relationships;
  return (
    <>
      <Card title={`Cross references (${r.crossReferences.length})`}
            sub="Where this regulation points at other law. Unresolved targets are kept as text rather than dropped.">
        {r.crossReferences.length === 0 ? <Empty msg="No cross references extracted." /> : (
          <ul className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {r.crossReferences.map((x, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-2 text-[12.5px]">
                {x.source_reference && <span className="font-mono text-[11px] text-brand-600">§{x.source_reference}</span>}
                <span className="pill bg-slate-100 text-slate-600">{x.relation.replace(/_/g, ' ').toLowerCase()}</span>
                <span className="text-ink-2">{x.target_reference}</span>
                {!x.resolved && <span className="text-[11px] italic text-muted-2">target not held</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Amendments (${r.amendments.length})`}
            sub="What the document itself records. This is the regulator speaking — not a change this system detected.">
        {r.amendments.length === 0 ? <Empty msg="The document records no amendments." /> : (
          <ul className="space-y-2">
            {r.amendments.map((a, i) => (
              <li key={i} className="text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer"
                       className="font-mono text-[11.5px] font-semibold text-brand-600 hover:underline">
                      {a.reference} <ExternalLink className="inline h-3 w-3" />
                    </a>
                  ) : <span className="font-mono text-[11.5px]">{a.reference}</span>}
                  <span className="tabular-nums text-muted">{a.amended_on}</span>
                  {a.operation && <span className="pill bg-slate-100 text-slate-600">{a.operation}</span>}
                </div>
                <p className="mt-0.5 text-muted">{a.raw?.slice(0, 180)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/* ---------- 6 · versions ---------- */
function Versions({ d }: { d: RegulationDetail }) {
  const v = d.versions;
  return (
    <>
      <Card title="Change status" sub={v.changeStatus.explanation}>
        <div className="flex flex-wrap items-center gap-3">
          <span className={cn('pill', v.changeStatus.status === 'CHANGE_DETECTED'
            ? 'bg-critical-50 text-critical-600' : 'bg-slate-100 text-slate-600')}>
            {v.changeStatus.status.replace(/_/g, ' ').toLowerCase()}
          </span>
          <span className="text-[12.5px] text-muted">
            <b className="tabular-nums text-ink-2">{v.changes}</b> sections differ between captures
          </span>
        </div>
      </Card>

      <Card title={`Captured versions (${v.versions.length})`}
            sub="The date a copy is FROM, and the date we fetched it, are different facts.">
        {v.versions.length === 0 ? <Empty msg="No versions captured." /> : (
          <ul className="space-y-2">
            {v.versions.map((x, i) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 text-[12.5px]">
                <span className="pill bg-slate-100 text-slate-600">v{i + 1}</span>
                <span className="tabular-nums font-medium text-ink-2">{x.captured_at?.slice(0, 10)}</span>
                {x.retrieved_at && x.retrieved_at.slice(0, 10) !== x.captured_at?.slice(0, 10) && (
                  <span className="text-[11.5px] text-muted-2">fetched {x.retrieved_at.slice(0, 10)}</span>
                )}
                <span className={cn('pill', x.retrieved_from === 'INTERNET_ARCHIVE'
                  ? 'bg-warning-50 text-warning-600' : 'bg-success-50 text-success-600')}>
                  {x.retrieved_from === 'INTERNET_ARCHIVE' ? 'web archive' : 'regulator'}
                </span>
                {x.section_count != null && <span className="text-muted-2">{x.section_count} sections</span>}
                <span className="ml-auto break-all font-mono text-[10.5px] text-muted-2">
                  {x.document_hash?.slice(0, 26)}…
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/* ---------- 7 · provenance ---------- */
function Provenance({ d }: { d: RegulationDetail }) {
  const p = d.provenance;
  return (
    <>
      <Card title="Source" sub="Verifiable by re-downloading and comparing the hash.">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-2">Official document</dt>
            <dd className="mt-0.5">
              {p.sourceUrl ? (
                <a href={p.sourceUrl} target="_blank" rel="noreferrer"
                   className="break-all text-[12.5px] font-medium text-brand-600 hover:underline">{p.sourceUrl}</a>
              ) : <span className="text-[13px] italic text-muted-2">not recorded</span>}
            </dd>
          </div>
          <Field k="Source authority" v={p.sourceAuthority} />
          <Field k="Retrieved" v={p.retrievedAt} />
          <Field k="Pages" v={p.pageCount} />
          <Field k="Extraction" v={p.extractionMethod} hint={p.ocrUsed ? 'OCR was used — machine-read, not the official wording' : undefined} />
        </dl>
        <div className="mt-4">
          <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-2">SHA-256</dt>
          <dd className="mt-0.5 break-all font-mono text-[11.5px] text-ink-2">{p.sha256 ?? '—'}</dd>
        </div>
      </Card>

      <Card title="Traceability" sub="Every extracted fact points back to the exact sentence it came from.">
        <div className="flex flex-wrap items-center gap-5 text-[12.5px]">
          <span className="text-muted">
            <b className="tabular-nums text-ink-2">{p.facts}</b> facts with a provenance record
          </span>
          {p.avgExtractionConfidence != null && (
            <span className="text-muted">
              avg extraction confidence <b className="tabular-nums text-ink-2">{p.avgExtractionConfidence}</b>
            </span>
          )}
          <span className={cn('pill', p.sourceVerified ? 'bg-success-50 text-success-600' : 'bg-warning-50 text-warning-600')}>
            <ShieldCheck className="mr-1 inline h-3 w-3" />
            {p.sourceVerified ? 'source verified' : 'not verified'}
          </span>
        </div>
      </Card>
    </>
  );
}

export default RegulationPage;
