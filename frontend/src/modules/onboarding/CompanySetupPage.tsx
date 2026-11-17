import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, BadgeCheck, Briefcase, Building2, Check, CheckCircle2, ChevronRight, ExternalLink, FileText,
  Flag, Info, Landmark, Layers, Loader2, MapPin, Search, ShieldCheck, TrendingUp, Users, X, type LucideIcon,
} from 'lucide-react';
import { Topbar } from '@/layouts/Topbar';
import { useRegulationFacets, useCompanyProfile } from '@/services/regulationsApi';
import { lookupCompanyRecord, saveProfile, type CompanySuggestion, type PublicRecord } from '@/services/companyApi';
import { api, switchCompany } from '@/services/http';
import { useMe } from '@/services/authApi';
import type { CompanyRow } from '@/services/workspacesApi';
import { useCompanyLogo } from '@/components/CompanyLogo';
import { CompanyLogoUpload } from '@/components/CompanyLogoUpload';
import { toneFor } from '@/config/tones';
import {
  authoritiesFor, thresholdFlags, CONSTITUTIONS, ORGANISATION_TYPES, SECTORS, LICENCES, JURISDICTIONS,
  type CompanyProfile,
} from '@/services/applicabilityProfile';
import { cn } from '@/utils/ui';
import { SkeletonCards, useDelayedFlag } from '@/components/ui/skeletons';
import { IconTile } from '@/components/ui/primitives';
import { CountUp, prefersReducedMotion } from '@/components/ui/motion';
import { Icon } from '@/config/icons';
import { regulatorColor } from '@/modules/regulatory/RegulationFilters';
import { CompanySearch } from './CompanySearch';
import { tx, useDateLocale, useT } from '@/i18n';
import './companySetup.css';

/**
 * Company Setup — one form.
 *
 * It was a five-step wizard: Identity, Footprint, Activities, Scale, and a last
 * step that only showed a result. Nothing in it depended on an earlier step,
 * so the steps only hid the rest of the form and made every correction a walk
 * back through it. Now everything is on one page, the result updates beside
 * the answers as they are given, and the identity fills itself from the public
 * register when the company is found there.
 *
 * What is ASKED is only what something downstream reads: applicability runs on
 * the type of organisation, sectors, licences and jurisdictions; the size
 * figures switch threshold rules on; personal data brings in DPDP. The
 * checklist beside the form names exactly those.
 *
 * /company-setup?new=1 is "Add new company": the same form, empty. Saving it
 * adds the company (the server's timer creates it within a minute), saves this
 * profile into the new company, and switches to it.
 */
const EMPTY: CompanyProfile = {
  legalName: '', registrationNo: '', entityType: '', legalForm: '', registeredAddress: '', lei: '',
  incorporated: '', hqState: '', jurisdictions: [], sectors: [], licences: [],
  employees: '', turnoverCr: '', customers: '',
  listed: false, handlesPersonalData: false, importsExports: false,
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

/** The fields a public record can answer. */
type PublicField = 'legalName' | 'registrationNo' | 'legalForm' | 'incorporated' | 'hqState'
  | 'registeredAddress' | 'listed' | 'lei';
type PublicValues = Partial<Pick<CompanyProfile, PublicField>>;

interface RecordState {
  values: PublicValues;
  source: { name: string; record?: string; lastUpdated?: string | null; corroboration?: string | null; fetchedAt?: string };
  authority?: string | null;
  status?: string | null;
  notes: string[];
  cin?: PublicRecord['cin'];
  /** the state this record added to "where it operates", so clearing it can take it back out */
  addedJurisdiction?: string;
}

/**
 * The stored row, as the form's fields.
 *
 * Profiles saved before the form split "legal form" from "type of
 * organisation" hold the legal form in entity_type — "Private company limited
 * by shares" — which matches no regulated-entity family. It is moved to the
 * legal-form field and the type is asked for again, rather than left looking
 * answered.
 */
function fromRow(r: Row): { profile: CompanyProfile; movedLegalForm?: string } {
  const entity = str(r.entity_type);
  const legalForm = str(r.legal_form);
  const moved = !legalForm && CONSTITUTIONS.includes(entity) ? entity : undefined;
  return {
    movedLegalForm: moved,
    profile: {
      legalName: str(r.legal_name), registrationNo: str(r.registration_no),
      entityType: moved ? '' : entity, legalForm: legalForm || moved || '',
      registeredAddress: str(r.registered_address), lei: str(r.lei),
      incorporated: str(r.incorporated), hqState: str(r.hq_state),
      jurisdictions: arr(r.jurisdictions), sectors: arr(r.sectors), licences: arr(r.licences),
      employees: str(r.employees), turnoverCr: str(r.turnover_cr), customers: str(r.customers),
      listed: Boolean(r.listed), handlesPersonalData: Boolean(r.handles_personal_data),
      importsExports: Boolean(r.imports_exports),
    },
  };
}

/** Field names as they are stored, for the "read from your documents" notice. */
const DERIVED_LABEL: Record<string, string> = {
  legal_name: tx('Legal name'), registration_no: tx('Registration / CIN'), entity_type: tx('Entity type'),
  incorporated: tx('Incorporated'), hq_state: tx('Head office state'), sectors: tx('Sectors'), licences: tx('Licences'),
};
const SNAKE: Partial<Record<keyof CompanyProfile, string>> = {
  legalName: 'legal_name', registrationNo: 'registration_no', entityType: 'entity_type',
  incorporated: 'incorporated', hqState: 'hq_state', sectors: 'sectors', licences: 'licences',
};

const fmtDate = (locale: string, iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
};

export function CompanySetupPage() {
  const t = useT();
  const locale = useDateLocale('en-IN');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const isNew = params.get('new') === '1';
  const { data: me } = useMe();
  /** while a new company is being added: what is happening now */
  const [creating, setCreating] = useState<string | null>(null);
  /** which of CREATE_STEPS it is on */
  const [createStep, setCreateStep] = useState(0);
  // the logo: saved at once for this company; for a new one, held until it exists
  const { data: logoHere } = useCompanyLogo();
  const [pendingLogo, setPendingLogo] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const logo = isNew ? pendingLogo : logoHere?.logo ?? null;
  const changeLogo = async (next: string | null) => {
    if (isNew) { setPendingLogo(next); return; }
    setLogoBusy(true);
    try {
      await api('/api/company/logo', next ? { method: 'PUT', body: JSON.stringify({ logo: next }) } : { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['company-logo'] });
    } finally { setLogoBusy(false); }
  };
  const [p, setP] = useState<CompanyProfile>(EMPTY);
  const [record, setRecord] = useState<RecordState | null>(null);
  const [movedLegalForm, setMovedLegalForm] = useState<string | undefined>();
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const set = <K extends keyof CompanyProfile>(k: K, v: CompanyProfile[K]) => {
    setSaved(false);
    setP((s) => ({ ...s, [k]: v }));
  };
  const toggle = (k: 'jurisdictions' | 'sectors' | 'licences', v: string) => {
    setSaved(false);
    setP((s) => ({ ...s, [k]: s[k].includes(v) ? s[k].filter((x) => x !== v) : [...s[k], v] }));
  };

  const { data: facets } = useRegulationFacets();
  const { data: storedHere, isLoading: loadingHere } = useCompanyProfile();
  // a new company starts empty; the profile on file belongs to the company open now
  const stored = isNew ? undefined : storedHere;
  const loadingProfile = !isNew && loadingHere;
  const showSkeleton = useDelayedFlag(loadingProfile);

  // Read what is stored, once — never over the top of typing.
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !stored?.profile) return;
    prefilled.current = true;
    const row = stored.profile as Row;
    const { profile, movedLegalForm: moved } = fromRow(row);
    setP(profile);
    setMovedLegalForm(moved);
    const pr = row.public_record as { values?: PublicValues; source?: string; record?: string; lastUpdated?: string; corroboration?: string; fetchedAt?: string } | undefined;
    if (pr?.values) {
      setRecord({ values: pr.values, notes: [], source: {
        name: pr.source ?? tx('a public register'), record: pr.record, lastUpdated: pr.lastUpdated,
        corroboration: pr.corroboration, fetchedAt: pr.fetchedAt } });
    }
  }, [stored]);

  const profileRow = (stored?.profile ?? null) as Row | null;
  const derived = profileRow?.derived_from as Record<string, { file?: string }> | undefined;
  const unconfirmed = !!profileRow && 'source_verified' in profileRow && Number(profileRow.source_verified) === 0;

  // ------------------------------------------------------- the public record
  const pick = async (s: CompanySuggestion) => {
    setLoadingRecord(true); setRecordError(null);
    try {
      const d = await lookupCompanyRecord(s.lei);
      const values: PublicValues = { legalName: d.legalName, lei: d.lei };
      if (d.registrationNo) values.registrationNo = d.registrationNo;
      if (d.legalForm) values.legalForm = d.legalForm;
      if (d.incorporated) values.incorporated = d.incorporated;
      if (d.hqState) values.hqState = d.hqState;
      if (d.registeredAddress) values.registeredAddress = d.registeredAddress;
      if (d.listed !== null) values.listed = d.listed;
      // The registered office's state is a place the company certainly operates.
      const added = d.hqState && !p.jurisdictions.includes(d.hqState) ? d.hqState : undefined;
      setP((cur) => ({
        ...cur, ...values,
        jurisdictions: added && !cur.jurisdictions.includes(added) ? [...cur.jurisdictions, added] : cur.jurisdictions,
      }));
      setRecord({ values, source: d.source, authority: d.registrationAuthority, status: d.status,
        notes: d.notes, cin: d.cin, addedJurisdiction: added });
      setSaved(false);
    } catch (e) {
      setRecordError((e as Error).message.replace(/^\d{3}:\s*/, '') || t('The public record could not be read.'));
    } finally {
      setLoadingRecord(false);
    }
  };

  /** "This is not my company": take back exactly what that record filled. */
  const clearRecord = () => {
    if (!record) return;
    setP((cur) => {
      const next = { ...cur };
      for (const [k, v] of Object.entries(record.values) as [PublicField, unknown][]) {
        if (cur[k] === v) (next as Record<string, unknown>)[k] = EMPTY[k];
      }
      if (record.addedJurisdiction) next.jurisdictions = cur.jurisdictions.filter((j) => j !== record.addedJurisdiction);
      return next;
    });
    setRecord(null);
    setSaved(false);
  };

  // ------------------------------------------------------- what is needed
  const needed = [
    { id: 'f-legalName', label: t('Legal name'), done: !!p.legalName.trim() },
    { id: 'f-entityType', label: t('Type of organisation'), done: !!p.entityType },
    { id: 'f-sectors', label: t('Sectors'), done: p.sectors.length > 0 },
    { id: 'f-jurisdictions', label: t('Where it operates'), done: p.jurisdictions.length > 0 },
  ];
  const recommended = [
    { id: 'f-registrationNo', label: t('CIN or registration number'), why: t('identifies the company to a regulator'), done: !!p.registrationNo.trim() },
    { id: 'f-licences', label: t('Licences held'), why: t('a licence binds you directly'), done: p.licences.length > 0 },
    { id: 'f-size', label: t('Employees and turnover'), why: t('size thresholds switch rules on'), done: !!p.employees.trim() && !!p.turnoverCr.trim() },
  ];
  const missing = needed.filter((n) => !n.done);
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // completeness: every needed and recommended answer, counted the same
  const answered = needed.filter((n) => n.done).length + recommended.filter((n) => n.done).length;
  const completeness = Math.round((answered / (needed.length + recommended.length)) * 100);

  const authorities = useMemo(() => authoritiesFor(p), [p]);
  const flags = useMemo(() => thresholdFlags(p), [p]);
  const countFor = (short: string) => facets?.regulators.find((r) => r.value === short)?.count ?? 0;
  const inScope = authorities.reduce((n, a) => n + countFor(a.short), 0);

  const save = async () => {
    setTried(true);
    if (missing.length) { go(missing[0].id); return; }
    setSaving(true); setSaveError(null);
    const payload = {
      ...p,
      // Which answers came from a public record, and which record — kept so
      // the badges survive a reload and an auditor can see the source.
      publicRecord: record ? {
        source: record.source.name, record: record.source.record, lastUpdated: record.source.lastUpdated,
        corroboration: record.source.corroboration, fetchedAt: record.source.fetchedAt, values: record.values,
      } : null,
    };
    if (isNew) { await createCompany(payload); return; }
    try {
      await saveProfile(payload);
      await qc.invalidateQueries({ queryKey: ['company-profile'] });
      setSaved(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setSaveError((e as Error).message.replace(/^\d{3}:\s*/, '') || t('The profile could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Add the company, wait for the server to create it, save this profile into
   * it, then open it. If the page is left part-way the company is still
   * created; its profile can then be filled in from its own Company Setup.
   */
  const createCompany = async (payload: Record<string, unknown>) => {
    try {
      setCreateStep(0);
      setCreating(t('Adding {name}…', { name: p.legalName.trim() }));
      const added = await api<{ id: number; slug: string }>('/api/workspaces/companies', {
        method: 'POST', body: JSON.stringify({ company_name: p.legalName.trim(), sector: p.sectors[0] }),
      });
      setCreateStep(1);
      setCreating(t('Creating its workspace — this takes about a minute…'));
      const until = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 3000));
        const { items } = await api<{ items: CompanyRow[] }>('/api/workspaces/companies');
        const row = items.find((r) => r.id === added.id);
        if (row?.status === 'READY') break;
        if (row?.status === 'FAILED') throw new Error(row.message || t('The company could not be created.'));
        if (Date.now() > until) throw new Error(t('Creating the company is taking longer than usual. It will appear in the company menu when it is ready; fill in its profile from there.'));
      }
      setCreateStep(2);
      setCreating(t('Saving the company profile…'));
      // its server may still be finishing start-up: retry a refused save for a short while
      for (let attempt = 1; ; attempt++) {
        try { await saveProfile(payload, added.slug); break; } catch (e) {
          if (attempt >= 10 || !/HTTP 50[234]/.test((e as Error).message)) throw e;
          await new Promise((r) => window.setTimeout(r, 3000));
        }
      }
      if (pendingLogo) {
        // a logo that will not save is not worth losing the new company over
        await api('/api/company/logo', { method: 'PUT', body: JSON.stringify({ logo: pendingLogo }), headers: { 'X-Company': added.slug } }).catch(() => undefined);
      }
      setCreateStep(3);
      setCreating(t('Opening the new company…'));
      switchCompany(added.slug, '/company-setup');
    } catch (e) {
      setCreating(null);
      setSaving(false);
      setSaveError((e as Error).message.replace(/^\d{3}:\s*/, '') || t('The company could not be added.'));
    }
  };

  /** Where a field's value came from, next to its label. */
  const origin = (k: keyof CompanyProfile): ReactNode => {
    const pub = record?.values[k as PublicField];
    if (pub !== undefined) {
      const same = typeof pub === 'boolean' ? p[k] === pub : String(p[k]).trim() === String(pub).trim();
      return same
        ? <Tag tone="public" title={record!.source.lastUpdated
            ? t('From {source}, record updated {date}', { source: t(record!.source.name), date: fmtDate(locale, record!.source.lastUpdated) })
            : t('From {source}', { source: t(record!.source.name) })}>{t('Public record')}</Tag>
        : <Tag tone="edited" title={t('The public record says: {value}', { value: typeof pub === 'boolean' ? (pub ? t('Yes') : t('No')) : String(pub) })}>{t('Changed from public record')}</Tag>;
    }
    const snake = SNAKE[k];
    if (snake && derived?.[snake]) return <Tag tone="doc" title={derived[snake]?.file}>{t('From your documents')}</Tag>;
    return null;
  };

  const loading = loadingProfile && showSkeleton;
  // one sentence around the "Public record" tag, split where the tag is drawn
  const markedPublic = t('Every field it filled is marked {tag} — change any that are wrong.').split('{tag}');

  // ------------------------------------------------------- the timeline
  const identityDone = [p.legalName, p.registrationNo, p.legalForm, p.incorporated, p.registeredAddress, p.hqState].filter((v) => v.trim()).length;
  const activitiesDone = [!!p.entityType, p.sectors.length > 0, p.licences.length > 0].filter(Boolean).length;
  const whereDone = p.jurisdictions.length > 0 ? 1 : 0;
  const sizeDone = [p.employees, p.turnoverCr, p.customers].filter((v) => v.trim()).length;
  const steps: JourneyStep[] = [
    { id: 'sec-find', label: t('Find'), icon: Search, done: record ? 1 : 0, of: 1, optional: true, tone: FIND_TONE },
    { id: 'sec-identity', label: t('Identity'), icon: Building2, done: identityDone, of: 6, tone: SECTION_TONE[0] },
    { id: 'sec-activities', label: t('Activities'), icon: Briefcase, done: activitiesDone, of: 3, tone: SECTION_TONE[1] },
    { id: 'sec-where', label: t('Where'), icon: MapPin, done: whereDone, of: 1, tone: SECTION_TONE[2] },
    { id: 'sec-size', label: t('Size'), icon: Users, done: sizeDone, of: 3, tone: SECTION_TONE[3] },
    { id: 'sec-save', label: t('Save'), icon: Flag, done: saved ? 1 : 0, of: 1, tone: SAVE_TONE, ready: missing.length === 0 },
  ];
  const active = useActiveSection(steps.map((s) => s.id), !loading);
  const goSection = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const ready = missing.length === 0;
  const saveLabel = t(isNew ? (saving ? 'Creating…' : 'Create company') : saving ? 'Saving…' : 'Save company profile');

  if (isNew && me && !me.platformAdmin) {
    return (
      <>
        <Topbar title="Add new company" icon="Building2" tone={toneFor('overview')} hideSearch />
        <div className="p-6">
          <div className="card mx-auto max-w-xl p-6 text-center text-[13px] text-muted">
            {t('Only an administrator of the main company can add companies.')}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title={isNew ? tx('Add new company') : tx('Company Setup')}
        subtitle={isNew ? tx('Fill in the new company\'s profile. Creating it gives the company its own records, team and gaps; the regulation library is shared.') : undefined}
        icon="Building2"
        tone={toneFor('overview')}
        hideSearch
        titleExtra={
          saved ? <span key="saved" className="pill cs-pop-in bg-success-50 text-success-600"><CheckCircle2 className="h-3.5 w-3.5" />{t('Saved')}</span>
            : unconfirmed ? <span className="pill bg-warning-50 text-warning-600"><AlertTriangle className="h-3.5 w-3.5" />{t('Not confirmed yet')}</span>
            : stored?.profile ? <span className="pill bg-brand-50 text-brand-700"><Landmark className="h-3.5 w-3.5" />{t('Profile on file')}</span>
            : null
        }
        toolbar={
          <span className="text-[12.5px] text-muted">
            {ready
              ? <><CheckCircle2 className="-mt-0.5 mr-1 inline h-4 w-4 text-success-600" />{t('Everything needed to onboard is answered')}</>
              : t('{n} of {total} needed answers given', { n: needed.length - missing.length, total: needed.length })}
          </span>
        }
        actions={
          <>
            {isNew
              ? <button className="btn" onClick={() => navigate('/workspaces')} disabled={!!creating}>{t('Cancel')}</button>
              : <button className="btn" onClick={() => navigate('/integrations')}>{t('Connect a source instead')}</button>}
            <button className="btn btn-primary" onClick={save} disabled={saving}>{saveLabel}</button>
          </>
        }
      />

      <div className="cs w-full p-4 sm:p-6">
        {creating && (
          <div className="card cs-found mb-4 border-brand-100 p-4 sm:p-5" role="status">
            <div className="text-[13px] leading-relaxed text-ink"><b>{creating}</b> {t('Keep this page open; you are taken to the new company when it is ready.')}</div>
            <ol className="mt-4 flex items-start" aria-label={t('Adding the company')}>
              {CREATE_STEPS.map((label, i) => {
                const done = i < createStep;
                const now = i === createStep;
                return (
                  <li key={label} className={cn('flex min-w-0 items-start', i < CREATE_STEPS.length - 1 && 'flex-1')}>
                    <div className="flex w-[78px] shrink-0 flex-col items-center gap-1.5 text-center sm:w-[96px]">
                      <span key={done ? 'd' : now ? 'n' : 'w'} className={cn('cs-pop-in relative grid h-8 w-8 place-items-center rounded-full text-[12px] font-semibold',
                        done ? 'bg-success-500 text-white' : now ? 'cs-busy bg-brand-600 text-white' : 'bg-black/[0.06] text-muted')}>
                        {done ? <Check className="h-4 w-4" strokeWidth={3} /> : now ? <Loader2 className="h-4 w-4 animate-spin" /> : i + 1}
                      </span>
                      <span className={cn('text-[11.5px] leading-tight', now ? 'font-semibold text-ink' : 'text-muted')}>{t(label)}</span>
                    </div>
                    {i < CREATE_STEPS.length - 1 && (
                      <span className="relative mt-[15px] h-[3px] min-w-[6px] flex-1 overflow-hidden rounded-full bg-black/[0.07]">
                        <span className="cs-link-fill absolute inset-0 origin-left rounded-full bg-success-500" style={{ transform: `scaleX(${done ? 1 : 0})` }} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        )}
        {saved && (
          <div className="card cs-found mb-4 flex flex-wrap items-center gap-3 border-success-500/40 bg-gradient-to-r from-success-50 to-white p-4">
            <span className="cs-pop-in grid h-9 w-9 shrink-0 place-items-center rounded-full bg-success-500 text-white shadow-sm">
              <Check className="h-5 w-5" strokeWidth={3} />
            </span>
            <div className="min-w-0 flex-1 text-[13px] text-ink">
              <b>{t('Saved and confirmed.')}</b> {t('Applicability for the regulation library now runs against this profile.')}
            </div>
            <button className="btn btn-sm" onClick={() => navigate('/integrations')}>
              {t('Next: connect your data')} <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        )}
        {saveError && <div className="card cs-found mb-4 border-critical-500/30 bg-critical-50 p-3 text-[12.5px] text-critical-600">{saveError}</div>}

        {unconfirmed && (
          <div className="card mb-4 border-warning-500/40 bg-warning-50 p-4">
            <div className="flex items-start gap-2.5">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
              <div className="min-w-0 text-[12.5px] leading-relaxed text-muted">
                <b className="text-[13px] text-ink">
                  {t(Object.keys(derived ?? {}).length > 0
                    ? 'Some of this was read from the documents you uploaded'
                    : 'This profile has not been confirmed by anyone yet')}
                </b>
                <p className="mt-0.5">
                  {t('Check each answer and save — saving is the confirmation.')}
                  {Object.keys(derived ?? {}).length > 0 && <> {t('Read from:')} {Object.entries(derived ?? {}).map(([k, v], i) => (
                    <span key={k}>{i > 0 && ', '}<b className="font-semibold text-ink-2">{DERIVED_LABEL[k] ? t(DERIVED_LABEL[k]) : k}</b> ({v?.file || t('a document')})</span>
                  ))}.</>}
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <ProfileCard p={p} logo={logo} isNew={isNew} completeness={completeness} />
            <JourneyBar steps={steps} active={active} onGo={goSection} />

            {/* ------------------------------------------------ find it */}
            <section id="sec-find" className="card scroll-mt-[188px]">
              <header className="flex items-start gap-3.5 px-4 pb-4 pt-5 sm:px-6">
                <span className="cs-badge grid h-11 w-11 shrink-0 place-items-center rounded-[14px] text-white"
                      style={{ background: `linear-gradient(135deg, ${FIND_TONE.from}, ${FIND_TONE.to})`, '--glow-c': `${FIND_TONE.from}66` } as CSSProperties}>
                  <Search className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: FIND_TONE.ink }}>{t('Optional')}</div>
                  <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">{t('Find your company in public records')}</h2>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
                    {t('Type the registered name or the CIN. The public LEI register answers with what it holds — legal name, CIN, legal form, incorporation date, registered office — and those fields fill themselves.')}
                  </p>
                </div>
              </header>
              <div className="px-4 pb-5 sm:px-6">
                <CompanySearch onPick={pick} busy={loadingRecord} />
                {recordError && <p className="cs-fade mt-2 text-[12px] text-critical-600">{recordError}</p>}

                {record && (
                  <div className="cs-found mt-3 rounded-2xl border border-success-200 bg-gradient-to-br from-success-50 via-white to-white p-4">
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="cs-pop-in grid h-9 w-9 shrink-0 place-items-center rounded-full bg-success-500 text-white shadow-[0_6px_14px_-6px_rgba(52,199,89,0.8)]">
                        <Check className="h-5 w-5" strokeWidth={3} />
                      </span>
                      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-2">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-success-700">
                          {t('Found in public records')} · {t('Filled {n} fields', { n: Object.keys(record.values).length })}
                        </div>
                        <b className="text-[14px] text-ink">{record.values.legalName ?? p.legalName}</b>
                        {record.status && <span className={cn('ml-2 rounded-full px-2 py-px text-[11px] font-semibold',
                          record.status === 'ACTIVE' ? 'bg-success-100 text-success-700' : 'bg-warning-50 text-warning-600')}>
                          {record.status === 'ACTIVE' ? t('Active') : record.status.toLowerCase()}</span>}
                        <p className="text-muted">
                          {t('From the {source}', { source: t(record.source.name) })}
                          {record.source.lastUpdated && <>, {t('record updated {date}', { date: fmtDate(locale, record.source.lastUpdated) })}</>}
                          {record.source.corroboration === 'FULLY_CORROBORATED' && record.authority &&
                            <> · {t('checked against the {authority}', { authority: record.authority })}</>}
                          . {markedPublic[0]}<Tag tone="public">{t('Public record')}</Tag>{markedPublic[1]}
                        </p>
                        {record.cin && (
                          <p className="mt-1 text-muted">
                            {t('The CIN itself says:')} {t(record.cin.listed ? 'listed' : 'unlisted')}
                            {record.cin.state && <>, {t('registered in {state}', { state: record.cin.state })}</>}, {t('incorporated {year}', { year: record.cin.year })}
                            {record.cin.kind && <>, {record.cin.kind.toLowerCase()}</>}
                            {' '}({t('industry code {code} — the sector is yours to choose below', { code: record.cin.industryCode })}).
                          </p>
                        )}
                        {record.notes.map((n) => (
                          <p key={n} className="mt-1 flex items-start gap-1.5 text-warning-600">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{n}
                          </p>
                        ))}
                        <div className="-ml-2.5 mt-2 flex flex-wrap items-center gap-1">
                          {record.source.record && (
                            <a href={record.source.record} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-brand-600 transition-colors hover:bg-brand-50">
                              {t('View record')} <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          <button onClick={clearRecord} title={t('Not my company — undo what it filled')}
                            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-black/[0.05] hover:text-ink">
                            <X className="h-3.5 w-3.5" /> {t('Not my company')}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t('Source: Global LEI Index (GLEIF), public domain. It lists every company that holds an LEI — all listed companies and most larger borrowers — not every company in India. The MCA register itself needs a login and a CAPTCHA, so it is not searched automatically.')}
                </p>
              </div>
            </section>

            {loading ? <SkeletonCards count={2} lines={6} /> : (
              <>
                {/* ------------------------------------------------ identity */}
                <FormSection id="sec-identity" n={1} icon="Building2" title="Company identity" hint="Who the company is in law. Filled from the public record when it is found."
                  done={identityDone} of={6}>
                  <div className="mb-5 rounded-2xl bg-black/[0.025] p-3.5">
                    <div className="mb-2 text-[13px] font-medium text-ink-2">{t('Company logo')} <span className="font-normal text-muted">({t('optional')})</span></div>
                    <CompanyLogoUpload value={logo} onChange={changeLogo} busy={logoBusy} name={p.legalName} />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field id="f-legalName" htmlFor="in-legalName" label="Legal name" required origin={origin('legalName')}
                      error={tried && !p.legalName.trim() ? t('Needed — the name the company is registered under.') : undefined}>
                      <input id="in-legalName" className="input" value={p.legalName} onChange={(e) => set('legalName', e.target.value)}
                        placeholder={t('As on the certificate of incorporation')} {...noAutofill} />
                    </Field>
                    <Field id="f-registrationNo" htmlFor="in-registrationNo" label="CIN / registration number" origin={origin('registrationNo')}>
                      <input id="in-registrationNo" className="input text-[13px] tracking-wide" value={p.registrationNo}
                        onChange={(e) => set('registrationNo', e.target.value.toUpperCase())}
                        placeholder={t('e.g. {example}', { example: 'U00000XX0000PTC000000' })} {...noAutofill} />
                    </Field>
                    <Field htmlFor="in-legalForm" label="Legal form" origin={origin('legalForm')}>
                      <input id="in-legalForm" className="input" value={p.legalForm} onChange={(e) => set('legalForm', e.target.value)}
                        placeholder={t('e.g. Private limited company, LLP, Trust')} list="legal-forms" {...noAutofill} />
                      <datalist id="legal-forms">{CONSTITUTIONS.map((c) => <option key={c} value={c} />)}</datalist>
                    </Field>
                    <Field htmlFor="in-incorporated" label="Incorporated on" origin={origin('incorporated')}>
                      <input id="in-incorporated" className="input" value={p.incorporated} onChange={(e) => set('incorporated', e.target.value)}
                        placeholder={t('e.g. {example}', { example: '1989-11-20' })} {...noAutofill} />
                    </Field>
                    <Field htmlFor="in-registeredAddress" label="Registered office address" wide origin={origin('registeredAddress')}>
                      <input id="in-registeredAddress" className="input" value={p.registeredAddress} onChange={(e) => set('registeredAddress', e.target.value)}
                        placeholder={t('As filed with the Registrar of Companies')} {...noAutofill} />
                    </Field>
                    <Field htmlFor="in-hqState" label="Head office state" origin={origin('hqState')}>
                      <input id="in-hqState" className="input" value={p.hqState} onChange={(e) => set('hqState', e.target.value)}
                        placeholder={t('e.g. {example}', { example: 'Telangana' })} {...noAutofill} />
                    </Field>
                    <Field label="Listed on a stock exchange" origin={origin('listed')}>
                      <Switch on={p.listed} onChange={(v) => set('listed', v)} label={t(p.listed ? 'Listed — SEBI LODR applies' : 'Unlisted')} />
                    </Field>
                    {p.lei && (
                      <p className="text-[11.5px] text-muted sm:col-span-2">
                        {t('Legal Entity Identifier')} <span className="font-medium tracking-wide text-ink-2">{p.lei}</span>
                      </p>
                    )}
                  </div>
                </FormSection>

                {/* ------------------------------------------------ what it does */}
                <FormSection id="sec-activities" n={2} icon="Briefcase" title="What the company does"
                  hint="Not in any public register, and the answers applicability depends on most."
                  done={activitiesDone} of={3}>
                  <div className="space-y-6">
                    <Field id="f-entityType" htmlFor="in-entityType" label="Type of organisation" required origin={origin('entityType')}
                      why={t('Decides which kinds of regulation reach you — a multispecialty hospital answers to clinical-establishment, biomedical-waste and radiation rules.')}
                      error={tried && !p.entityType ? t('Needed — pick the closest.') : undefined}>
                      <select id="in-entityType" className="input" value={p.entityType} onChange={(e) => set('entityType', e.target.value)}>
                        <option value="">{t('Select…')}</option>
                        {p.entityType && !ORGANISATION_TYPES.includes(p.entityType) && <option value={p.entityType}>{p.entityType}</option>}
                        {ORGANISATION_TYPES.map((o) => <option key={o} value={o}>{t(o)}</option>)}
                      </select>
                      {movedLegalForm && !p.entityType && (
                        <p className="mt-1.5 text-[12px] text-muted">
                          {t('This profile had “{value}” here. That is the legal form — it is now shown above. Choose what kind of organisation this is.', { value: movedLegalForm })}
                        </p>
                      )}
                    </Field>
                    <Field id="f-sectors" label="Sectors" required origin={origin('sectors')}
                      why={t('Sector-specific regulations are matched on these.')}
                      error={tried && !p.sectors.length ? t('Needed — pick at least one.') : undefined}>
                      <ChipSet options={SECTORS} selected={p.sectors} onToggle={(v) => toggle('sectors', v)} />
                    </Field>
                    <Field id="f-licences" label="Licences and registrations held" origin={origin('licences')}
                      why={t('The strongest signal there is: a licence binds its holder directly.')}>
                      <ChipSet options={LICENCES} selected={p.licences} onToggle={(v) => toggle('licences', v)} />
                    </Field>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <Field label="Processes personal data" why={t('Patient, employee or customer records bring in the DPDP Act.')}>
                        <Switch on={p.handlesPersonalData} onChange={(v) => set('handlesPersonalData', v)}
                          label={t(p.handlesPersonalData ? 'Yes — DPDP applies' : 'No')} />
                      </Field>
                      <Field label="Imports or exports goods" why={t('Brings in DGFT and customs rules.')}>
                        <Switch on={p.importsExports} onChange={(v) => set('importsExports', v)} label={t(p.importsExports ? 'Yes' : 'No')} />
                      </Field>
                    </div>
                  </div>
                </FormSection>

                {/* ------------------------------------------------ where */}
                <FormSection id="sec-where" n={3} icon="MapPin" title="Where it operates" hint="State laws — shops and establishments, clinical establishments, labour — follow these."
                  done={whereDone} of={1}>
                  <Field id="f-jurisdictions" label="States and jurisdictions" required
                    error={tried && !p.jurisdictions.length ? t('Needed — pick every state you operate in.') : undefined}>
                    <ChipSet options={JURISDICTIONS} selected={p.jurisdictions} onToggle={(v) => toggle('jurisdictions', v)} />
                    {record?.addedJurisdiction && p.jurisdictions.includes(record.addedJurisdiction) && (
                      <p className="mt-2.5 flex items-start gap-1.5 text-[12px] text-muted">
                        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {t('{state} was added because the registered office is there. Add every other state you operate in.', { state: record.addedJurisdiction })}
                      </p>
                    )}
                  </Field>
                </FormSection>

                {/* ------------------------------------------------ size */}
                <FormSection id="sec-size" n={4} icon="Users" title="Size" hint="Thresholds decide whether some obligations engage at all. Approximate figures are fine."
                  done={sizeDone} of={3}>
                  <div id="f-size" className="grid scroll-mt-40 grid-cols-1 gap-4 sm:grid-cols-3">
                    <Field htmlFor="in-employees" label="Employees">
                      <input id="in-employees" className="input tabular-nums" value={p.employees} onChange={(e) => set('employees', e.target.value)}
                        placeholder={t('e.g. {example}', { example: '850' })} inputMode="numeric" {...noAutofill} />
                    </Field>
                    <Field htmlFor="in-turnover" label="Annual turnover (₹ crore)">
                      <input id="in-turnover" className="input tabular-nums" value={p.turnoverCr} onChange={(e) => set('turnoverCr', e.target.value)}
                        placeholder={t('e.g. {example}', { example: '320' })} inputMode="numeric" {...noAutofill} />
                    </Field>
                    <Field htmlFor="in-customers" label="Customers / patients a year">
                      <input id="in-customers" className="input tabular-nums" value={p.customers} onChange={(e) => set('customers', e.target.value)}
                        placeholder={t('e.g. {example}', { example: '120000' })} inputMode="numeric" {...noAutofill} />
                    </Field>
                  </div>
                  {flags.length > 0 && (
                    <ul className="cs-stagger mt-4 grid gap-2 sm:grid-cols-2">
                      {flags.map((f) => (
                        <li key={f.label} className="flex items-start gap-3 rounded-2xl border border-warning-500/25 bg-warning-50/70 p-3.5">
                          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-warning-500/15 text-warning-600">
                            <AlertTriangle className="h-4 w-4" />
                          </span>
                          <span className="min-w-0"><span className="block text-[13px] font-semibold text-ink">{t(f.label)}</span>
                            <span className="block text-[12px] leading-relaxed text-muted">{t(f.note)}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </FormSection>

                {/* ------------------------------------------------ the finish line */}
                <section id="sec-save" className={cn('card cs-finish relative scroll-mt-[188px] overflow-hidden p-5 sm:p-6', ready && 'is-ready')}>
                  <div className="relative flex flex-wrap items-center gap-4">
                    <span key={ready ? 'r' : 'n'} className={cn('cs-pop-in grid h-12 w-12 shrink-0 place-items-center rounded-2xl',
                      ready ? 'bg-success-500 text-white shadow-[0_10px_22px_-10px_rgba(52,199,89,0.9)]' : 'bg-brand-50 text-brand-600')}>
                      {ready ? <Check className="h-6 w-6" strokeWidth={3} /> : <Flag className="h-5 w-5" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h2 className="text-[17px] font-semibold tracking-tight text-ink">{t(ready ? 'Ready to save' : 'Almost there')}</h2>
                      <p className="mt-0.5 text-[13px] text-muted">
                        {ready ? t('Everything needed to onboard is answered')
                          : t('{n} of {total} needed answers given', { n: needed.length - missing.length, total: needed.length })}
                      </p>
                      {!ready && (
                        <div className="mt-2.5 flex flex-wrap gap-1.5">
                          {missing.map((m) => (
                            <button key={m.id} type="button" onClick={() => go(m.id)}
                              className={cn('group inline-flex items-center gap-1 rounded-full px-3 py-1 text-[12px] font-medium transition-all active:scale-95',
                                tried ? 'bg-critical-50 text-critical-600 hover:bg-critical-100' : 'bg-black/[0.05] text-ink-2 hover:bg-black/[0.08]')}>
                              {m.label} <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button className={cn('btn btn-primary', ready && !saving && 'cs-ready')} onClick={save} disabled={saving}>
                      {saving && <Loader2 className="h-4 w-4 animate-spin" />}{saveLabel}
                    </button>
                  </div>
                </section>
              </>
            )}
          </div>

          {/* ------------------------------------------------ beside the form */}
          <aside className="space-y-4 lg:sticky lg:top-[80px]">
            <section className="card p-5">
              <div className="flex items-center gap-4">
                <CompletenessRing value={completeness} />
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold tracking-tight text-ink">{t('Profile completeness')}</h2>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-muted">
                    {t('{n} of {total} answers given', { n: answered, total: needed.length + recommended.length })}
                  </p>
                  {ready
                    ? <span key="ready" className="cs-pop-in mt-2 inline-flex items-center gap-1 rounded-full bg-success-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-success-700">
                        <CheckCircle2 className="h-3.5 w-3.5" />{t('Ready to save')}</span>
                    : <span key="todo" className="mt-2 inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-[11.5px] font-semibold text-brand-700">
                        {needed.length - missing.length}/{needed.length} {t('needed')}</span>}
                </div>
              </div>

              <div className="mt-5 flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-ink">{t('Needed to onboard')}</h3>
                <span className={cn('text-[12px] font-semibold tabular-nums', ready ? 'text-success-600' : 'text-muted')}>{needed.length - missing.length}/{needed.length}</span>
              </div>
              <ul className="-mx-2 mt-1.5 space-y-0.5">
                {needed.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => go(n.id)} className="group flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-black/[0.035]">
                      <CheckDot done={n.done} alert={tried && !n.done} />
                      <span className={n.done ? 'text-ink-2' : 'font-medium text-ink'}>{n.label}</span>
                      <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-muted-2 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t('Recommended')}</p>
              <ul className="-mx-2 space-y-0.5">
                {recommended.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => go(n.id)} className="group flex w-full items-start gap-2.5 rounded-xl px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-black/[0.035]">
                      <CheckDot done={n.done} />
                      <span className="min-w-0"><span className="text-ink-2">{n.label}</span>
                        {!n.done && <span className="block text-[11.5px] text-muted">{n.why}</span>}</span>
                      <ChevronRight className="ml-auto mt-0.5 h-4 w-4 shrink-0 text-muted-2 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card p-5">
              <div className="flex items-center gap-2.5">
                <IconTile icon="Landmark" tone="purple" size="sm" />
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold tracking-tight text-ink">{t('Who regulates you')}</h2>
                  <p className="text-[12px] text-muted">{t('Updates as you answer.')}</p>
                </div>
              </div>
              <div className="mt-3.5 grid grid-cols-2 gap-2">
                <div className="rounded-2xl bg-gradient-to-br from-violet-50 to-white p-3 ring-1 ring-violet-100">
                  <div className="text-[24px] font-semibold leading-none tabular-nums tracking-tight text-ink"><CountUp value={authorities.length} /></div>
                  <div className="mt-1 text-[11.5px] font-medium text-muted">{t('Authorities')}</div>
                </div>
                <div className="rounded-2xl bg-gradient-to-br from-brand-50 to-white p-3 ring-1 ring-brand-100">
                  <div className="text-[24px] font-semibold leading-none tabular-nums tracking-tight text-ink"><CountUp value={inScope} /></div>
                  <div className="mt-1 text-[11.5px] font-medium text-muted">{t('Regulations tracked')}</div>
                </div>
              </div>
              <ul className="cs-stagger -mx-2 mt-3 space-y-0.5">
                {authorities.map((a) => {
                  const c = regulatorColor(a.short);
                  const n = countFor(a.short);
                  return (
                    <li key={a.short} className="flex items-start gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-black/[0.03]">
                      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-[10px]', c.tile)}>
                        <Landmark className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 text-[12px] leading-snug">
                        <span className="font-semibold" style={{ color: c.ink }}>{a.short}</span>
                        <span className="ml-1.5 rounded-full bg-black/[0.05] px-1.5 py-px text-[10.5px] font-medium text-ink-2">{t(a.basis)}</span>
                        <span className="mt-0.5 block text-muted">{t(a.reason)}</span>
                      </span>
                      {n > 0 && (
                        <span className="shrink-0 rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-2"
                              title={t('{n} regulations from {regulator} in the library', { n: n.toLocaleString(), regulator: a.short })}>
                          {n.toLocaleString()}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t('A scoping answer, not a legal opinion. Each obligation is still checked clause by clause, and a person confirms every mapping.')}
              </p>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

/* ---------------- small pieces ---------------- */
// Browsers treat a page of text boxes as a form to autofill, and put a saved
// login into the first one. None of these fields is a login.
const noAutofill = { autoComplete: 'off', 'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other' } as const;

/** What a new company goes through before it opens, in order. */
const CREATE_STEPS = [tx('Add the company'), tx('Create its workspace'), tx('Save its profile'), tx('Open it')];

interface Tone { from: string; to: string; ink: string }
/** Each section keeps its own colour: its badge, its ring and its step on the timeline. */
const SECTION_TONE: Tone[] = [
  { from: '#0071e3', to: '#5e5ce6', ink: '#0058b0' },
  { from: '#af52de', to: '#7c3aed', ink: '#7e3aa8' },
  { from: '#14b8a6', to: '#0a84a0', ink: '#0f766e' },
  { from: '#ff9f0a', to: '#f56a00', ink: '#a85a00' },
];
const FIND_TONE: Tone = { from: '#0a84ff', to: '#30b0c7', ink: '#0058b0' };
const SAVE_TONE: Tone = { from: '#34c759', to: '#30b0c7', ink: '#1a7434' };

interface JourneyStep {
  id: string; label: string; icon: LucideIcon; done: number; of: number; tone: Tone;
  /** a step that can be skipped: shown as such until it is done */
  optional?: boolean;
  /** the last step, once everything it needs is answered */
  ready?: boolean;
}

/**
 * The section being read: the last one whose top has passed 40% of the window.
 * At the very bottom of the page it is the last one, which may never get that high.
 */
function useActiveSection(ids: string[], enabled: boolean) {
  const key = ids.join(' ');
  const [active, setActive] = useState(ids[0]);
  useEffect(() => {
    if (!enabled) return;
    const list = key.split(' ');
    let raf = 0;
    const measure = () => {
      raf = 0;
      let cur = list[0];
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.4) cur = id;
      }
      const doc = document.documentElement;
      if (window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 8) cur = list[list.length - 1];
      setActive(cur);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [key, enabled]);
  return active;
}

/** A value that is drawn rather than set: it starts from 0, then follows. */
function useDrawn(target: number) {
  const [v, setV] = useState(prefersReducedMotion() ? target : 0);
  useEffect(() => {
    let id2 = 0;
    const id = requestAnimationFrame(() => { id2 = requestAnimationFrame(() => setV(target)); });
    return () => { cancelAnimationFrame(id); cancelAnimationFrame(id2); };
  }, [target]);
  return v;
}

/** The company as the answers so far describe it — fills in while the form is answered. */
function ProfileCard({ p, logo, isNew, completeness }: { p: CompanyProfile; logo: string | null; isNew: boolean; completeness: number }) {
  const t = useT();
  const name = p.legalName.trim();
  const sub = [p.legalForm, p.hqState, p.registrationNo].map((v) => v.trim()).filter(Boolean).join(' · ');
  const facts = ([
    p.entityType && { icon: Briefcase, text: t(p.entityType) },
    p.sectors.length > 0 && { icon: Layers, text: p.sectors.length === 1 ? t(p.sectors[0]) : t('{n} sectors', { n: p.sectors.length }) },
    p.licences.length > 0 && { icon: BadgeCheck, text: p.licences.length === 1 ? t('1 licence') : t('{n} licences', { n: p.licences.length }) },
    p.jurisdictions.length > 0 && { icon: MapPin, text: p.jurisdictions.length === 1 ? t(p.jurisdictions[0]) : t('{n} states', { n: p.jurisdictions.length }) },
    p.employees.trim() && { icon: Users, text: t('{n} employees', { n: p.employees.trim() }) },
    { icon: TrendingUp, text: t(p.listed ? 'Listed on a stock exchange' : 'Unlisted') },
    p.handlesPersonalData && { icon: ShieldCheck, text: t('Personal data') },
  ].filter(Boolean)) as { icon: LucideIcon; text: string }[];
  return (
    <section className="card cs-hero relative overflow-hidden p-5 sm:p-6">
      <span aria-hidden="true" className="cs-blob b1" />
      <span aria-hidden="true" className="cs-blob b2" />
      <span aria-hidden="true" className="cs-blob b3" />
      <div className="relative flex items-center gap-4">
        <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-[20px] bg-white shadow-card ring-1 ring-black/5">
          {logo
            ? <img src={logo} alt="" className="h-full w-full object-contain p-2" />
            : <span key={name[0] ?? ''} className="cs-pop-in grid h-full w-full place-items-center bg-gradient-to-br from-[#0071e3] to-[#5e5ce6] text-[26px] font-semibold text-white">
                {(name[0] ?? '?').toUpperCase()}</span>}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{t(isNew ? 'New company' : 'Company profile')}</div>
          <h2 key={name ? 'named' : 'empty'} className={cn('cs-fade truncate text-[22px] font-semibold tracking-tight sm:text-[26px]', name ? 'text-ink' : 'text-muted-2')}>
            {name || t('Your company')}
          </h2>
          <p className="truncate text-[13px] text-muted">{sub || t('Answer the questions below — this card fills in as you go.')}</p>
        </div>
        <span className="shrink-0 rounded-full bg-white/80 px-2.5 py-1 text-[12px] font-semibold tabular-nums text-ink-2 shadow-sm ring-1 ring-black/5 lg:hidden">
          {t('{n}% complete', { n: completeness })}
        </span>
      </div>
      <ul className="cs-stagger relative mt-4 flex flex-wrap gap-1.5">
        {facts.map((f) => (
          <li key={f.text} className="inline-flex items-center gap-1.5 rounded-full bg-white/75 px-2.5 py-1 text-[12px] font-medium text-ink-2 shadow-sm ring-1 ring-black/5 backdrop-blur">
            <f.icon className="h-3.5 w-3.5 text-muted" />{f.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The steps as a timeline that stays in view: where you are, what is done, a press to go there. */
function JourneyBar({ steps, active, onGo }: { steps: JourneyStep[]; active: string; onGo: (id: string) => void }) {
  const t = useT();
  const R = 16.5;
  const C = 2 * Math.PI * R;
  return (
    <nav aria-label={t('Setup steps')}
         className="liquid-glass sticky top-[76px] z-10 rounded-[22px] border border-black/[0.06] px-2 py-2.5 shadow-card sm:px-4">
      <ol className="flex items-start">
        {steps.map((s, i) => {
          const complete = s.done >= s.of;
          const on = s.id === active;
          const frac = s.of ? Math.min(1, s.done / s.of) : 0;
          return (
            <li key={s.id} className={cn('flex min-w-0 items-start', i < steps.length - 1 && 'flex-1')}>
              <button type="button" onClick={() => onGo(s.id)} aria-current={on ? 'step' : undefined}
                title={`${s.label} · ${complete ? t('Done') : s.optional ? t('Optional') : `${s.done}/${s.of}`}`}
                className={cn('cs-node flex w-[46px] shrink-0 flex-col items-center gap-1 rounded-2xl py-0.5 sm:w-[72px]',
                  on && 'is-active', complete && 'is-done', s.ready && 'is-ready')}
                style={{ '--tone': s.tone.from } as CSSProperties}>
                <span className="cs-dot relative grid h-9 w-9 place-items-center rounded-full">
                  <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
                    <circle cx="18" cy="18" r={R} fill="none" stroke="rgba(120,120,128,0.16)" strokeWidth="3" />
                    <circle className="cs-arc" cx="18" cy="18" r={R} fill="none" stroke={complete ? '#34c759' : s.tone.from}
                            strokeWidth="3" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
                            style={{ opacity: frac > 0 ? 1 : 0 }} />
                  </svg>
                  <span key={complete ? 'done' : 'todo'}
                        className={cn('cs-pop-in relative grid h-7 w-7 place-items-center rounded-full transition-colors duration-300',
                          complete ? 'bg-success-500 text-white' : on ? 'text-white' : 'bg-white text-muted')}
                        style={on && !complete ? { background: s.tone.from } : undefined}>
                    {complete ? <Check className="h-4 w-4" strokeWidth={3} /> : <s.icon className="h-[15px] w-[15px]" />}
                  </span>
                </span>
                <span className={cn('hidden max-w-full truncate text-[12px] font-semibold transition-colors sm:block', on ? 'text-ink' : 'text-ink-2')}>{s.label}</span>
                <span className={cn('hidden text-[10.5px] tabular-nums md:block', complete ? 'text-success-600' : 'text-muted')}>
                  {complete ? t('Done') : s.optional ? t('Optional') : s.ready ? t('Ready') : `${s.done}/${s.of}`}
                </span>
              </button>
              {i < steps.length - 1 && (
                <span className="relative mt-[19px] h-[3px] min-w-[4px] flex-1 overflow-hidden rounded-full bg-black/[0.07]">
                  <span className="cs-link-fill absolute inset-0 origin-left rounded-full"
                        style={{ transform: `scaleX(${complete ? 1 : frac * 0.5})`,
                                 background: complete && steps[i + 1].done >= steps[i + 1].of ? '#34c759'
                                   : `linear-gradient(90deg, ${complete ? '#34c759' : s.tone.from}, ${steps[i + 1].tone.from})` }} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function FormSection({ id, n, title, hint, icon, done, of, children }: {
  id: string; n: number; title: string; hint: string; icon: string; done: number; of: number; children: ReactNode;
}) {
  const tr = useT();
  const tone = SECTION_TONE[(n - 1) % SECTION_TONE.length];
  const complete = done >= of;
  const frac = useDrawn(of ? Math.min(1, done / of) : 0);
  return (
    <section id={id} className={cn('card relative scroll-mt-[188px] overflow-hidden', complete && 'cs-complete')}>
      <span aria-hidden="true" className="cs-accent" style={{ transform: `scaleX(${frac})`, background: complete ? '#34c759' : `linear-gradient(90deg, ${tone.from}, ${tone.to})` }} />
      <header className="flex items-start gap-3.5 px-4 pb-4 pt-5 sm:px-6">
        <span className="cs-badge relative grid h-11 w-11 shrink-0 place-items-center rounded-[14px] text-white"
              style={{ background: `linear-gradient(135deg, ${tone.from}, ${tone.to})`, '--glow-c': `${tone.from}66` } as CSSProperties}>
          <Icon name={icon} className="h-5 w-5" />
          <span key={complete ? 'c' : 'n'}
                className={cn('cs-pop-in absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full text-[10.5px] font-bold shadow-sm ring-2 ring-white',
                  complete ? 'bg-success-500 text-white' : 'bg-white')}
                style={complete ? undefined : { color: tone.ink }}>
            {complete ? <Check className="h-3 w-3" strokeWidth={3.5} /> : n}
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tone.ink }}>{tr('Step {n} of {total}', { n, total: SECTION_TONE.length })}</div>
          <h2 className="mt-0.5 text-[17px] font-semibold tracking-tight text-ink">{tr(title)}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{tr(hint)}</p>
        </div>
        <MiniRing done={done} of={of} tone={tone} frac={frac} />
      </header>
      <div className="px-4 pb-5 sm:px-6">{children}</div>
    </section>
  );
}

/** A section's answers as a small ring: how many of its questions are answered. */
function MiniRing({ done, of, tone, frac }: { done: number; of: number; tone: Tone; frac: number }) {
  const t = useT();
  const R = 18;
  const C = 2 * Math.PI * R;
  const complete = done >= of;
  return (
    <span className="relative hidden h-11 w-11 shrink-0 sm:block" title={t('{n} of {total} answered', { n: done, total: of })}>
      <svg viewBox="0 0 44 44" className="h-11 w-11 -rotate-90" aria-hidden="true">
        <circle cx="22" cy="22" r={R} fill="none" stroke="rgba(120,120,128,0.14)" strokeWidth="4" />
        <circle className="cs-arc" cx="22" cy="22" r={R} fill="none" stroke={complete ? '#34c759' : tone.from} strokeWidth="4"
                strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} style={{ opacity: frac > 0 ? 1 : 0 }} />
      </svg>
      <span className="absolute inset-0 grid place-items-center">
        {complete
          ? <Check key="c" className="cs-pop-in h-4 w-4 text-success-600" strokeWidth={3} />
          : <span className="text-[11px] font-semibold tabular-nums text-ink-2">{done}/{of}</span>}
      </span>
    </span>
  );
}

/** Profile completeness: a ring that draws itself, blue while answers are missing, green when none are. */
function CompletenessRing({ value }: { value: number }) {
  const t = useT();
  const size = 108;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const drawn = useDrawn(value);
  const full = value >= 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <defs>
          <linearGradient id="cs-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" style={{ stopColor: full ? '#30d158' : '#0a84ff' }} />
            <stop offset="100%" style={{ stopColor: full ? '#28a745' : '#5e5ce6' }} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(120,120,128,0.14)" strokeWidth={stroke} />
        <circle className="cs-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#cs-ring)" strokeWidth={stroke}
                strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - drawn / 100)} style={{ opacity: drawn > 0 ? 1 : 0 }} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div className="text-[26px] font-semibold leading-none tabular-nums tracking-tight text-ink"><CountUp value={value} />%</div>
          <div className="mt-1 text-[11px] font-medium text-muted">{t('complete')}</div>
        </div>
      </div>
    </div>
  );
}

/** A checklist mark: an empty circle, then a green check that pops in when the answer is given. */
function CheckDot({ done, alert }: { done: boolean; alert?: boolean }) {
  return (
    <span key={done ? 'd' : 'o'}
          className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full', done ? 'cs-pop-in bg-success-500 text-white'
            : alert ? 'border-2 border-critical-500' : 'border-2 border-black/15')}>
      {done && <Check className="h-3 w-3" strokeWidth={3.5} />}
    </span>
  );
}

function Field({ id, htmlFor, label, required, origin, why, error, wide, children }: {
  id?: string; htmlFor?: string; label: string; required?: boolean; origin?: ReactNode; why?: string; error?: string;
  wide?: boolean; children: ReactNode;
}) {
  const t = useT();
  // a real <label> when there is one control to point at; a group label for chip sets and toggles
  const text = <>{t(label)}{required && <span className="ml-1 text-critical-600" aria-hidden="true">*</span>}</>;
  return (
    <div id={id} role={htmlFor ? undefined : 'group'} aria-label={htmlFor ? undefined : t(label)}
      className={cn('block scroll-mt-40', wide && 'sm:col-span-2')}>
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        {htmlFor
          ? <label htmlFor={htmlFor} className="field-label mb-0">{text}</label>
          : <span className="field-label mb-0">{text}</span>}
        {origin}
      </div>
      {children}
      {why && !error && <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted">{why}</p>}
      {error && <p className="cs-shake mt-1.5 flex items-center gap-1 text-[12px] font-medium text-critical-600"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />{error}</p>}
    </div>
  );
}

function Tag({ tone, title, children }: { tone: 'public' | 'edited' | 'doc'; title?: string; children: ReactNode }) {
  // "Public record" is the normal case — a quiet word with an icon, not a pill;
  // an edit away from the record is the one worth noticing.
  if (tone === 'public') {
    return (
      <span title={title} className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600">
        <Landmark className="h-3 w-3" aria-hidden="true" />{children}
      </span>
    );
  }
  return (
    <span title={title} className={cn('inline-flex items-center rounded-full px-2 py-px text-[11px] font-medium',
      tone === 'edited' && 'bg-warning-50 text-warning-600',
      tone === 'doc' && 'bg-black/[0.05] text-ink-2')}>
      {children}
    </span>
  );
}

/**
 * Options plus anything already selected that is not among them — a value in
 * the data is shown whether or not this build happens to know about it. A long
 * list gets a filter, and a count of what is chosen.
 */
function ChipSet({ options, selected, onToggle }: { options: string[]; selected: string[]; onToggle: (v: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const extras = selected.filter((v) => !options.includes(v));
  const all = [...extras, ...options];
  const needle = q.trim().toLowerCase();
  const shown = needle ? all.filter((o) => o.toLowerCase().includes(needle) || t(o).toLowerCase().includes(needle)) : all;
  return (
    <div>
      {all.length > 12 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] max-w-xs flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-2" />
            <input className="input h-9 rounded-full pl-9 text-[13px]" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder={t('Filter {n} options', { n: all.length })} aria-label={t('Filter {n} options', { n: all.length })} {...noAutofill} />
          </label>
          {selected.length > 0 && (
            <>
              <span key={selected.length} className="cs-pop-in rounded-full bg-brand-50 px-2.5 py-1 text-[12px] font-semibold tabular-nums text-brand-700">
                {t('{n} selected', { n: selected.length })}
              </span>
              <button type="button" onClick={() => selected.forEach(onToggle)}
                className="rounded-full px-2.5 py-1 text-[12px] font-medium text-muted transition-colors hover:bg-black/[0.05] hover:text-ink">
                {t('Clear')}
              </button>
            </>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {shown.map((o) => {
          const on = selected.includes(o);
          return (
            <button key={o} type="button" onClick={() => onToggle(o)} aria-pressed={on}
              className={cn('cs-chip inline-flex min-h-[34px] items-center rounded-full border px-3.5 py-1.5 text-[13px] font-medium',
                on ? 'is-on border-brand-600 bg-brand-600 text-white' : 'border-black/10 bg-white text-ink-2 hover:border-black/20')}>
              <span className="cs-tick" aria-hidden="true"><Check className="h-3.5 w-3.5" strokeWidth={3} /></span>
              {t(o)}
            </button>
          );
        })}
        {shown.length === 0 && <p className="py-1.5 text-[12.5px] text-muted">{t('Nothing matches “{q}”.', { q })}</p>}
      </div>
    </div>
  );
}

/** An iOS switch on a row that is pressed as a whole; the knob stretches while it is held. */
function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className={cn('cs-switch-row flex min-h-[46px] w-full items-center gap-3 rounded-2xl border px-3.5 py-2 text-left transition-colors duration-300',
        on ? 'border-success-500/30 bg-success-50/70' : 'border-black/10 bg-white hover:bg-black/[0.02]')}>
      <span key={label} className="cs-fade min-w-0 flex-1 text-[13px] font-medium text-ink-2">{label}</span>
      <span className={cn('cs-switch', on && 'is-on')} aria-hidden="true"><span className="cs-knob" /></span>
    </button>
  );
}

export default CompanySetupPage;
