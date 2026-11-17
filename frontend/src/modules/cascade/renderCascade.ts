/**
 * The cascade itself: lattice SVG, treatment plan, requirement summary and the
 * right-hand detail panel, rendered imperatively into one container.
 *
 * Kept out of React on purpose — the lattice is a few hundred SVG nodes whose
 * positions depend on one another, and the hover/focus highlighting walks the
 * edges directly. React owns the data fetching and the regulation picker; this
 * owns one regulation's view. mountCascade returns a cleanup for the effect.
 *
 * COLOUR MEANS STATUS, NOTHING ELSE
 * ---------------------------------
 * Boxes for the hospital's records (regulation, policy, control, owner)
 * are neutral: white card, slate border, slate icon. Only an obligation's status
 * is coloured (accent bar + pill), a missing link is dashed red, and a line
 * takes the status colour of the obligation whose path it is on only while that
 * path is highlighted. The words for each colour live in cascadeText.ts.
 *
 * HIGHLIGHTING AND SELECTION
 * --------------------------
 * Every edge carries the obligations whose path it belongs to (data-o). Hovering
 * any box previews the paths through it; clicking any box selects it — its
 * paths stay lit and the detail panel opens on the right. Closing the panel
 * (× or Esc) clears the selection. The entrance animation must not use
 * fill-mode "both"/"forwards" on nodes: a finished animation that holds
 * opacity:1 overrides the .dim class.
 *
 * WHERE A DOCUMENT LIVES
 * ----------------------
 * cascade_graph stores, per document, the file it was parsed from (`f`, a file
 * name — cascade_build.py records no folder path). Policies, SOPs and forms are
 * blocks of a manual or forms pack identified by their code; controls are rows
 * of the register workbook's "… Control Matrix" sheet. Risks carry no `f`, but
 * cascade_build.py parses them from the same workbook as the controls, so a
 * risk's location is that workbook's "… Risk Register" sheet — shown only when
 * every control names one and the same workbook.
 *
 * TRANSLATION
 * -----------
 * Interface text is translated with tNow() as the HTML is built, so it is read
 * once per mount: CascadePage remounts the cascade when the language changes.
 * Records from the API (titles, gaps, document text) stay as they are. The
 * downloaded and copied action plan stays in English, like the export file.
 */
import type { CascadeDoc, CascadeGraph, CascadeItem, CascadeRegulation, CascadeUnit, Risk, Status } from './cascadeTypes';
import { MEANING } from './cascadeText';
import { DRAWER, trapTab } from '@/modules/compliance/uiKit';
import { tNow, tx } from '@/i18n';
import {
  draftKey, isRunning, latestDrafts,
  type DraftKind, type DraftSummary, type LlmStatus,
} from './remediationApi';

type Scoped = CascadeItem & { unit: CascadeUnit };
interface Node {
  col: number; id: string; l: string; full: string; s: string[];
  h?: number; miss?: boolean; obl?: boolean; it?: Scoped; x?: number; y?: number; dot?: string; loc?: string;
}
interface Edge { a: string; b: string; owners: Set<string> }
/** What the page needs to open the AI drafting drawer for one duty and one kind of artefact. */
export interface DraftRequest {
  rid: string; code: string; kind: DraftKind; regId: string;
  item: { t: string; gap: string; fix: string; why: string; st: Status; rk: Risk; ob: string };
}
export interface CascadeOptions {
  nav?: (path: string) => void;
  /** a remediation chip was clicked — the page opens its drafting drawer */
  onDraft?: (req: DraftRequest) => void;
  /**
   * An external auditor's view: the actions each duty needs are shown as plain
   * labels (no AI drafting), and there are no links into the rest of the app.
   */
  readOnly?: boolean;
  /** auditor view: "Request" in the Documents column — the page asks the hospital for that duty's documents */
  onRequestDocs?: (r: DocRequestInfo) => void;
  /**
   * The regulation box was clicked: the page opens its own regulation sheet
   * ('info'), or its picker ('change') from the box's Change button. Without
   * it the box opens the side panel, as before.
   */
  onRegulation?: (tab: 'info' | 'change') => void;
}
/** One obligation whose supporting documents an auditor asks for. */
export interface DocRequestInfo { regId: string; code: string; title: string; codes: string[] }
/** the table / panel action chip class → the kind of draft it starts */
const KIND_OF: Record<string, DraftKind> = { 'a-risk': 'risk', 'a-pol': 'policy', 'a-ctl': 'control', 'a-ev': 'evidence' };

const ST: Record<Status, [string, string, string, string]> = {
  MET: [tx('Documented'), 't-met', 'var(--verdigris)', 'var(--verdigris-soft)'],
  PARTIAL: [tx('Partial'), 't-partial', 'var(--amber)', 'var(--amber-soft)'],
  GAP: [tx('Gap'), 't-gap', 'var(--oxide)', 'var(--oxide-soft)'],
  NOT_COVERED: [tx('Not covered'), 't-nc', 'var(--nc)', 'var(--nc-soft)'],
  NOT_APPLICABLE: [tx('Not applicable'), 't-na', 'var(--ink-faint)', 'var(--hair-soft)'],
};
/** darker ink of each status hue, for status words drawn on the canvas (AA) */
const STINK: Record<Status, string> = {
  MET: 'var(--verdigris-ink)', PARTIAL: 'var(--amber-ink)', GAP: 'var(--oxide-ink)', NOT_COVERED: 'var(--nc-ink)', NOT_APPLICABLE: 'var(--ink-soft)',
};
/** arrow-head marker per status colour */
const STMK: Record<Status, string> = { MET: 'verdigris', PARTIAL: 'amber', GAP: 'oxide', NOT_COVERED: 'nc', NOT_APPLICABLE: 'ink-faint' };
/** worst first — a line shared by several highlighted paths takes the worst status */
const SEV: Status[] = ['GAP', 'NOT_COVERED', 'PARTIAL', 'MET', 'NOT_APPLICABLE'];
const RK: Record<string, string> = { Critical: 't-crit', High: 't-high', Medium: 't-med', Low: 't-low' };
const RCOL: Record<Risk, string> = { Critical: '#DC2626', High: '#EA580C', Medium: '#D97706', Low: '#64748B', None: '#16A34A' };
const RORD: Record<Risk, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, None: 4 };
/** a band as a priority ("Critical priority"), one phrase per band */
const RISK_PRIORITY: Record<Risk, string> = {
  Critical: tx('Critical priority'), High: tx('High priority'), Medium: tx('Medium priority'), Low: tx('Low priority'), None: tx('No priority'),
};
/** a count beside a band, as a tag ("3 Critical") and in running text ("3 critical"): one key per band, so the number can move */
const RISK_N: Record<string, string> = { Critical: tx('{n} Critical'), High: tx('{n} High'), Medium: tx('{n} Medium'), Low: tx('{n} Low') };
const RISK_N_LC: Record<string, string> = { Critical: tx('{n} critical'), High: tx('{n} high'), Medium: tx('{n} medium'), Low: tx('{n} low') };
/** what kind of record a code is, as a word (SOP is an acronym and stays) */
const KIND_WORD: Record<string, string> = { Policy: tx('Policy'), Form: tx('Form'), Control: tx('Control'), Risk: tx('Risk') };
const kindWord = (k: string) => tNow(KIND_WORD[k] ?? k);
/** a remediation chip's text per kind of draft: whole phrases, so the noun can move */
const CHIP_TEXT: Record<DraftKind, { run: string; ask: string; ready: string; saved: string; savedTip: string }> = {
  policy: { run: tx('Drafting policy…'), ask: tx('Policy: answer questions'), ready: tx('Policy draft ready'), saved: tx('Policy saved ✓'), savedTip: tx('Saved to Policies as a draft record') },
  risk: { run: tx('Drafting risk…'), ask: tx('Risk: answer questions'), ready: tx('Risk draft ready'), saved: tx('Risk saved ✓'), savedTip: tx('Saved to Risks as a draft record') },
  control: { run: tx('Drafting control…'), ask: tx('Control: answer questions'), ready: tx('Control draft ready'), saved: tx('Control saved ✓'), savedTip: tx('Saved to Controls as a draft record') },
  evidence: { run: tx('Drafting evidence…'), ask: tx('Evidence: answer questions'), ready: tx('Evidence draft ready'), saved: tx('Evidence saved ✓'), savedTip: tx('Saved to Evidence as a draft record') },
};
// No risk column: a register risk was only ever reached through a control, so
// the column repeated the Controls column and called a missing control "not in
// the risk register". A control's register risks are shown in its own panel.
const COLS: [string, number][] = [[tx('Regulation'), 20], [tx('Obligations'), 270], [tx('Policies'), 520], [tx('Controls'), 770], [tx('Owners'), 1020]];
const CICON = ['landmark', 'listchecks', 'filetext', 'shieldcheck', 'user'];
const CSING = [tx('Regulation'), tx('Obligation'), tx('Policy'), tx('Control'), tx('Owner')];
const LCUT = 22;
const W = 174, H = 46, GAPY = 16;
const CANVAS_W = 1240;
const ZMIN = 0.4, ZMAX = 2;
/** lucide icon geometry (24×24, stroked), drawn as SVG symbols so the lattice needs no React */
const SYM: Record<string, string> = {
  chev: '<path d="m9 18 6-6-6-6"/>',
  unlink: '<path d="m18.84 12.25 1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="m5.17 11.75-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" x2="8" y1="2" y2="5"/><line x1="2" x2="5" y1="8" y2="8"/><line x1="16" x2="16" y1="19" y2="22"/><line x1="19" x2="22" y1="16" y2="16"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
  collapse: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>',
  chevl: '<path d="m15 18-6-6 6-6"/>',
  landmark: '<line x1="3" x2="21" y1="22" y2="22"/><line x1="6" x2="6" y1="18" y2="11"/><line x1="10" x2="10" y1="18" y2="11"/><line x1="14" x2="14" y1="18" y2="11"/><line x1="18" x2="18" y1="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  listchecks: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
  shieldalert: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  filetext: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  shieldcheck: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
};
const SYMBOLS = Object.entries(SYM).map(([k, v]) =>
  `<symbol id="cci-${k}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${v}</symbol>`).join('');
const useIcon = (k: string, x: number, y: number, s: number, color: string) =>
  `<use href="#cci-${k}" x="${x}" y="${y}" width="${s}" height="${s}" style="color:${color}"/>`;
/** the same icon as inline HTML svg, for the panel and the key */
const htmlIcon = (k: string, s = 13) =>
  `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SYM[k]}</svg>`;
const MARKERS = ['edge-mk', 'verdigris', 'amber', 'oxide', 'nc', 'ink-faint'];
const DEFAULT_ST: Status[] = ['GAP', 'PARTIAL', 'NOT_COVERED'];
const KICON: Record<string, string> = { Policy: 'filetext', SOP: 'filetext', Form: 'filetext', Control: 'shieldcheck', Risk: 'shieldalert' };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const cut = (s: unknown, n: number) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const cap = (s: string) => { const t = s.trim().toLowerCase(); return t ? t[0].toUpperCase() + t.slice(1) : ''; };
const unmetOf = (x: CascadeItem) => x.st !== 'MET' && x.st !== 'NOT_APPLICABLE';

export function mountCascade(root: HTMLElement, reg: CascadeRegulation, graph: CascadeGraph, opts: CascadeOptions = {}): () => void {
  const docs = graph.docs, risks = graph.risks;
  const ctrlsOf: Record<string, string[]> = {};
  Object.entries(docs).forEach(([c, d]) => {
    if (d.k === 'Control') {
      (d.sops ?? []).forEach((s) => (ctrlsOf[s] ??= []).push(c));
      (d.forms ?? []).forEach((f) => (ctrlsOf[f] ??= []).push(c));
    }
  });
  const go = (path: string) => { if (opts.nav) opts.nav(path); else window.location.assign(path); };

  // ---------- where each record lives (see the header comment) ----------
  const registerFiles = new Set(Object.values(docs).filter((d) => d.k === 'Control' && d.f).map((d) => d.f!));
  const registerFile = registerFiles.size === 1 ? [...registerFiles][0] : '';
  const locOf = (code: string): { file: string; where: string } | null => {
    const d = docs[code];
    if (d) return d.f ? { file: d.f, where: d.k === 'Control' ? tNow('Control Matrix sheet › {code}', { code }) : code } : null;
    if (risks[code] && registerFile) return { file: registerFile, where: tNow('Risk Register sheet › {code}', { code }) };
    return null;
  };
  const locStr = (l: { file: string; where: string }) => `${l.file} › ${l.where}`;

  const resolve = (it: CascadeItem) => {
    const ctrls = new Set<string>(), pols = new Set<string>();
    (it.by ?? []).forEach((code) => {
      const d = docs[code]; if (!d) return;
      if (d.k === 'Control') ctrls.add(code);
      if (d.k === 'Policy') { pols.add(code); (d.sops ?? []).forEach((s) => (ctrlsOf[s] ?? []).forEach((c) => ctrls.add(c))); }
      if (d.k === 'SOP') { (ctrlsOf[code] ?? []).forEach((c) => ctrls.add(c)); (d.pol ?? []).forEach((p) => pols.add(p)); }
      if (d.k === 'Form') { (ctrlsOf[code] ?? []).forEach((c) => ctrls.add(c)); (d.sops ?? []).forEach((s) => (docs[s]?.pol ?? []).forEach((p) => pols.add(p))); }
    });
    [...ctrls].forEach((c) => (docs[c].sops ?? []).forEach((s) => (docs[s]?.pol ?? []).forEach((p) => { if (!pols.size) pols.add(p); })));
    const rs = new Set<string>(); [...ctrls].forEach((c) => (docs[c].risks ?? []).forEach((r) => rs.add(r)));
    return { ctrls: [...ctrls], pols: [...pols], risks: [...rs] };
  };
  /**
   * What the diagram draws for one obligation: at most two controls (those
   * that mitigate a register risk first), and only the risks and policies
   * those two actually connect to. Drawing every linked document made each
   * obligation fan out to ten boxes and the lines unreadable; the panel and
   * the table still list everything.
   */
  const resolveForDiagram = (it: CascadeItem) => {
    const r = resolve(it);
    const ctrls = [...r.ctrls].sort((a, b) => (docs[b].risks?.length ? 1 : 0) - (docs[a].risks?.length ? 1 : 0)).slice(0, 2);
    const risks = [...new Set(ctrls.flatMap((c) => docs[c].risks ?? []))].slice(0, 2);
    const governing = new Set(ctrls.flatMap((c) => (docs[c].sops ?? []).flatMap((s) => docs[s]?.pol ?? [])));
    const pols = (r.pols.filter((p) => governing.has(p)).length ? r.pols.filter((p) => governing.has(p)) : r.pols).slice(0, 2);
    return { ctrls, risks, pols, moreCtrls: r.ctrls.length - ctrls.length };
  };
  const link = (code: string) => {
    const l = locOf(code);
    const tip = docs[code] ? `${kindWord(docs[code].k)}: ${docs[code].t}` : risks[code] ? `${kindWord('Risk')}: ${risks[code].t}` : code;
    return docs[code] || risks[code]
      ? `<button type="button" class="doclink" data-doc="${esc(code)}" title="${esc(tip + (l ? `\n${tNow('Location')}: ${locStr(l)}` : ''))}">${esc(code)}</button>`
      : `<span class="mono">${esc(code)}</span>`;
  };
  const links = (codes?: string[]) => (codes ?? []).map(link).join('') || '—';
  /**
   * Who answers for a duty, and where that name came from: the owner of the
   * policy that covers it, else the owner of its control, else the role the AI
   * review named. A suggestion until a person confirms it. `via` stays English
   * for the check in `chain`; `viaText` is how it is shown.
   */
  const ownerFor = (x: CascadeItem, r = resolve(x)): { name: string; via: string; viaText: string } => {
    const p = r.pols.find((c) => docs[c]?.o);
    if (p) return { name: docs[p].o!, via: `policy ${p}`, viaText: tNow('policy {code}', { code: p }) };
    const c = r.ctrls.find((k) => docs[k]?.o);
    if (c) return { name: docs[c].o!, via: `control ${c}`, viaText: tNow('control {code}', { code: c }) };
    return x.who ? { name: x.who, via: 'AI review', viaText: tNow('AI review') } : { name: '', via: '', viaText: '' };
  };

  // ---------- where the chain breaks (whole regulation, not the filtered view) ----------
  // Counts what the assessment cited, not what resolve() reaches: resolve()
  // walks policy → every SOP under it → every control of those SOPs, so a
  // duty covered by one HR policy "has" every HR control. A control counts
  // here only when it, or an SOP or form it implements, was cited for the duty.
  const cited = (x: CascadeItem) => {
    const ctrls = new Set<string>();
    (x.by ?? []).forEach((c) => {
      const k = docs[c]?.k;
      if (k === 'Control') ctrls.add(c);
      else if (k === 'SOP' || k === 'Form') (ctrlsOf[c] ?? []).forEach((k2) => ctrls.add(k2));
    });
    return [...ctrls];
  };
  const chain = (() => {
    const xs = reg.units.flatMap((u) => u.items);
    const n = (f: (x: CascadeItem) => boolean) => xs.filter(f).length;
    const steps: [string, number][] = [
      [tNow('Requirements'), xs.length],
      [tNow('Policy or SOP'), n((x) => (x.by ?? []).some((c) => docs[c]?.k === 'Policy' || docs[c]?.k === 'SOP'))],
      [tNow('Control'), n((x) => cited(x).length > 0)],
      [tNow('Evidence form'), n((x) => (x.by ?? []).some((c) => docs[c]?.k === 'Form') || cited(x).some((c) => (docs[c].forms ?? []).length > 0))],
      [tNow('Owner named in a document'), n((x) => { const o = ownerFor(x); return !!o.name && o.via !== 'AI review'; })],
    ];
    // the weakest link: the biggest drop from one step to the next
    let weak = -1, drop = 0;
    steps.forEach(([, n], i) => { if (i && steps[i - 1][1] - n > drop) { drop = steps[i - 1][1] - n; weak = i; } });
    // a timeline, top to bottom: a dot per link joined by a line that draws down, each
    // link's count and share; where most fall away the line breaks (red, dashed) and carries the drop
    const top = Math.max(1, steps[0][1]);
    return `<div class="step chtl" aria-label="${esc(tNow('Where the chain breaks'))}" title="${esc(tNow("How many of this regulation's requirements reach each link, counting only the documents the assessment cited for them. Owners are suggestions until a person confirms them."))}">
      <h4>${tNow('Where the chain breaks')}</h4>
      <ol class="tl">${steps.map(([l, n], i) => {
        const fall = i ? steps[i - 1][1] - n : 0;
        return `<li class="${i === weak ? 'weak' : ''}${i > weak && weak > 0 ? ' after' : ''}" style="--d:${i * 110}ms;--w:${Math.max(n ? 3 : 0, (n / top) * 100)}%">
          <span class="dot"></span>
          <span class="tlb"><span class="lbl">${esc(l)}${i === weak && fall > 0 ? `<em>${htmlIcon('unlink', 11)}−${fall.toLocaleString()}</em>` : ''}</span><span class="bar"><i></i></span></span>
          <b>${n.toLocaleString()}</b></li>`;
      }).join('')}</ol>
    </div>`;
  })();

  // ---------- skeleton ----------
  root.innerHTML = `
    <!-- the plan as three cards in a row above the diagram, so the diagram has the full width -->
    <aside class="dossier" data-r="dossier"></aside>
    <div class="grid2">
      <div class="canvas">
        <!-- the filters are the diagram's own header: they narrow both it and the summary table -->
        <div class="fbar" role="search">
          <div class="frow ftop">
            <label class="ffield"><span class="flabel">${tNow('Scope')}</span><select id="cc-scope"></select></label>
            <span class="fend">
              <button type="button" class="linkbtn fclear" data-r="clear" hidden>${tNow('Clear filters')}</button>
              <button type="button" class="fullbtn" data-full aria-pressed="false" title="${esc(tNow('Full view'))}">${htmlIcon('expand', 14)}<span>${tNow('Full view')}</span></button>
              ${reg.url ? `<a class="srclink" href="${esc(reg.url)}" target="_blank" rel="noopener">${tNow('Source document')} ↗</a>` : ''}
            </span>
          </div>
          <div class="frow fchiprow">
            <div class="fgroup"><span class="flabel">${tNow('Status')}</span><div class="fchips" data-r="f-status"></div></div>
            <div class="fgroup"><span class="flabel">${tNow('Priority')}</span><div class="fchips" data-r="f-risk"></div></div>
            <span data-r="qchip"></span>
          </div>
        </div>
        <div class="viewport" data-r="vp" aria-label="${esc(tNow('Cascade canvas — Ctrl + scroll to zoom, drag to pan'))}">
          <span class="chint" aria-hidden="true">${tNow('Click any box for its details · Ctrl + scroll to zoom · drag to move')}</span>
          <div class="stage" data-r="svg"></div>
          <!-- the whole lattice in miniature, the visible part framed; click to jump there -->
          <div class="minimap">
            <div class="mmap" data-r="mmap"><div class="mstage" data-r="mstage" aria-hidden="true"></div><div class="mview" data-r="mview"></div></div>
            <div class="ztools" data-r="ztools" role="group" aria-label="${esc(tNow('Zoom'))}">
              <button type="button" class="zb" data-zoom="out" aria-label="${esc(tNow('Zoom out'))}" title="${esc(tNow('Zoom out (10%)'))}">−</button>
              <span class="zl" data-r="zl" aria-live="polite">100%</span>
              <button type="button" class="zb" data-zoom="in" aria-label="${esc(tNow('Zoom in'))}" title="${esc(tNow('Zoom in (10%)'))}">+</button>
              <span class="zsep" aria-hidden="true"></span>
              <button type="button" class="zb wide" data-zoom="fit" title="${esc(tNow('Fit the diagram to the width'))}">${tNow('Fit')}</button>
              <button type="button" class="zb wide" data-zoom="reset" title="${esc(tNow('Actual size'))}">100%</button>
              <span class="zsep" aria-hidden="true"></span>
              <button type="button" class="zb" data-full aria-pressed="false" aria-label="${esc(tNow('Full view'))}" title="${esc(tNow('Full view'))}">${htmlIcon('expand', 14)}</button>
            </div>
          </div>
        </div>
        <div class="more" data-r="more"></div>
      </div>
    </div>
    <section class="tcard" aria-labelledby="cc-sum-h">
      <header class="tchead">
        <h2 id="cc-sum-h"><span class="h2ic">${htmlIcon('listchecks')}</span>${tNow('Requirement summary')}<span class="tcount" data-r="tcount"></span></h2>
        <!-- the same status filter as above the diagram, kept at hand for the table -->
        <div class="fchips" data-r="t-status" role="group" aria-label="${esc(tNow('Status'))}"></div>
      </header>
      <div class="tablewrap"><table class="sumtable"><thead><tr>
        <th class="tn">#</th><th class="treqh">${tNow('Requirement')}</th><th class="tsth">${tNow('Status')}</th><th class="trkh">${tNow('Priority')}</th>
        <th class="townh">${tNow('Owner')}</th><th class="tnum">${tNow('Controls')}</th><th class="tnum">${tNow('Documents')}</th><th class="tgo" aria-hidden="true"></th>
      </tr></thead><tbody data-r="rows"></tbody></table></div>
      <footer class="tfoot" data-r="tmore"></footer>
    </section>
    <div class="${DRAWER.backdrop} ${DRAWER.backdropClosed}" data-r="drback" aria-hidden="true"></div>
    <aside class="ccdrawer ${DRAWER.panel} ${DRAWER.panelClosed}" data-r="drawer" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="cc-dr-title" tabindex="-1" inert><div class="flex min-h-0 flex-1 flex-col" data-r="dr"></div></aside>
    <div class="toast" data-r="toast"></div>`;
  const $ = (r: string) => root.querySelector(`[data-r="${r}"]`) as HTMLElement;
  const scopeSel = root.querySelector('#cc-scope') as HTMLSelectElement;

  // ---------- scope + filters ----------
  const state = { scope: 'top', sel: null as string | null, q: '', st: new Set<Status>(DEFAULT_ST), rk: new Set<Risk>() };
  const score = (u: CascadeUnit) => u.items.reduce((a, x) => a + (unmetOf(x) ? [40, 12, 4, 1, 0][RORD[x.rk]] : 0), 0);
  const groups: Record<string, number[]> = {};
  reg.units.forEach((u, i) => (groups[u.g] ??= []).push(i));
  const scopeOpts = [`<option value="top">${tNow('Whole regulation (highest priority first)')}</option>`];
  Object.entries(groups).forEach(([g, idxs]) => {
    if (Object.keys(groups).length > 1) scopeOpts.push(`<option value="g:${esc(g)}">${esc(tNow('{group} (all)', { group: cut(g, 60) }))}</option>`);
    idxs.sort((a, b) => score(reg.units[b]) - score(reg.units[a]))
      .forEach((i) => scopeOpts.push(`<option value="u:${i}">  ${esc(reg.units[i].u)} — ${esc(cut(reg.units[i].ut, 55))}</option>`));
  });
  scopeSel.innerHTML = scopeOpts.join('');
  scopeSel.value = state.scope;
  const haystack = (x: Scoped) => [x.c, x.t, x.ob, x.rq, x.gap, x.fix, x.who, ...(x.by ?? [])].join(' ').toLowerCase();
  const everything: Scoped[] = reg.units.flatMap((u) => u.items.map((x) => ({ ...x, unit: u })));

  const itemsInScope = (): Scoped[] => {
    if (state.scope.startsWith('u:')) { const u = reg.units[+state.scope.slice(2)]; return u.items.map((x) => ({ ...x, unit: u })); }
    if (state.scope.startsWith('g:')) return reg.units.filter((u) => u.g === state.scope.slice(2)).flatMap((u) => u.items.map((x) => ({ ...x, unit: u })));
    return everything;
  };

  // ---------- detail panel: shared pieces ----------
  const statusTag = (s: Status) => `<span class="tag ${ST[s][1]}" title="${esc(tNow(MEANING[s]))}">${tNow(ST[s][0])}</span>`;
  const riskTag = (k: Risk) => (k && k !== 'None' ? `<span class="tag ${RK[k] ?? 't-na'}" title="${esc(tNow(MEANING.RISK))}">${tNow(RISK_PRIORITY[k] ?? k)}</span>` : '');
  const head = (eyebrow: string, title: string, pills = '') =>
    `<header class="${DRAWER.header} border-b border-line"><div class="min-w-0 flex-1"><div class="${DRAWER.eyebrow}">${eyebrow}</div><h2 id="cc-dr-title" class="${DRAWER.title}">${esc(title)}</h2>${pills ? `<div class="${DRAWER.badges}">${pills}</div>` : ''}</div>
      <button type="button" class="${DRAWER.close}" data-r="dr-close" data-r2="x" aria-label="${esc(tNow('Close panel'))}" title="${esc(tNow('Close (Esc)'))}">${htmlIcon('x', 16)}</button></header>`;
  const callout = (tone: 'red' | 'amber' | 'orange' | 'green' | 'slate', title: string, body: string) =>
    `<div class="callout c-${tone}">${htmlIcon(tone === 'green' ? 'shieldcheck' : 'alert', 16)}<div><b>${title}</b>${body ? `<div class="cbody">${body}</div>` : ''}</div></div>`;
  const fields = (rows: [string, string][]) =>
    `<dl class="fgrid">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v || '—'}</dd></div>`).join('')}</dl>`;
  type Step = { icon: string; label: string; sub: string; tone: 'ok' | 'miss' | Status };
  const flow = (steps: Step[]) => `<div class="flow" aria-label="${esc(tNow('Relationship'))}">${steps.map((s, i) => {
    const style = s.tone !== 'ok' && s.tone !== 'miss' ? ` style="--c:${ST[s.tone][2]};--k:${ST[s.tone][3]}"` : '';
    return `<div class="fstep"><span class="ftile ${s.tone === 'miss' ? 'miss' : s.tone === 'ok' ? 'ok' : 'st'}"${style}>${htmlIcon(s.icon, 16)}</span>
      <span class="fl" title="${esc(s.label)}">${esc(s.label)}</span><span class="fs" title="${esc(s.sub)}">${esc(s.sub)}</span></div>${i < steps.length - 1 ? `<span class="farr">${htmlIcon('arrow', 12)}</span>` : ''}`;
  }).join('')}</div>`;
  const block = (title: string, body: string, extra = '') => `<section class="dblock"><h4>${title}${extra}</h4>${body}</section>`;
  const locBlock = (code: string) => {
    const l = locOf(code);
    if (!l) return `<div class="loc none">${htmlIcon('folder', 15)}<span>${tNow('No file location is recorded for this item.')}</span></div>`;
    return `<div class="loc"><span class="locic">${htmlIcon('folder', 16)}</span><div class="loctxt"><div class="lock">${tNow('Location')}</div>
      <div class="locp" title="${esc(locStr(l))}">${esc(l.file)} <span class="sep">›</span> ${esc(l.where)}</div></div>
      <button type="button" class="ghost sm" data-copy="${esc(locStr(l))}">${htmlIcon('copy', 13)} ${tNow('Copy path')}</button></div>`;
  };
  const docRow = (code: string) => {
    const d = docs[code], r = risks[code];
    const kind = d ? d.k : r ? 'Risk' : '';
    const t = d ? d.t : r ? r.t : '';
    const l = locOf(code);
    if (!d && !r) return `<li><span class="drow plain"><span class="drow-main"><span class="drow-t"><b>${esc(code)}</b> <span class="sub">${tNow('not in the document register')}</span></span></span></span></li>`;
    return `<li><button type="button" class="drow" data-doc="${esc(code)}"><span class="drow-ic">${htmlIcon(KICON[kind] ?? 'filetext', 14)}</span>
      <span class="drow-main"><span class="drow-t"><b>${esc(code)}</b> ${esc(cut(t, 80))}</span>${l ? `<span class="drow-l" title="${esc(locStr(l))}">${htmlIcon('folder', 11)} ${esc(locStr(l))}</span>` : ''}</span>
      <span class="drow-k">${esc(kindWord(kind))}</span></button></li>`;
  };
  const docList = (codes: string[], empty: string) => (codes.length ? `<ul class="dlist">${codes.map(docRow).join('')}</ul>` : `<p class="sub">${empty}</p>`);
  const oblRow = (x: Scoped) => `<li><button type="button" class="drow" data-oblfocus="${esc(x.c)}"><span class="sbar" style="background:${ST[x.st][2]}"></span>
    <span class="drow-main"><span class="drow-t"><b>${esc(x.c)}</b> ${esc(cut((x.ob || x.t).replace(/^The hospital shall /i, ''), 90))}</span></span>${statusTag(x.st)}</button></li>`;
  const oblList = (xs: Scoped[], empty: string) => {
    const sorted = [...xs].sort((a, b) => SEV.indexOf(a.st) - SEV.indexOf(b.st) || RORD[a.rk] - RORD[b.rk]);
    return sorted.length
      ? `<ul class="dlist">${sorted.slice(0, 12).map(oblRow).join('')}</ul>${sorted.length > 12 ? `<p class="sub">${tNow('…and {n} more in the summary table.', { n: (sorted.length - 12).toLocaleString() })}</p>` : ''}`
      : `<p class="sub">${empty}</p>`;
  };
  const relies = (code: string) => everything.filter((x) => {
    if ((x.by ?? []).includes(code)) return true;
    const r = resolve(x);
    return r.ctrls.includes(code) || r.pols.includes(code) || r.risks.includes(code);
  });
  const foot = (buttons: string) => `<footer class="${DRAWER.footer}">${buttons}<button type="button" class="btn ml-auto" data-r="dr-close">${tNow('Close')}</button></footer>`;
  const navBtn = (path: string, label: string, primary = false) => (opts.readOnly ? '' :
    `<button type="button" class="btn ${primary ? 'btn-primary' : 'btn-outline'}" data-nav="${esc(path)}">${label}</button>`);
  const regButtons = () => navBtn(`/regulation/${encodeURIComponent(reg.id)}`, tNow('Open regulation'), true) +
    navBtn(`/compliance?regulation=${encodeURIComponent(reg.id)}&applicability=`, tNow('Open in Requirements'));

  // the drawer: the same classes, backdrop, Esc, focus handling and slide-in as the Controls panel
  const cls = (el: HTMLElement, add: string, remove: string) => { el.classList.remove(...remove.split(' ')); el.classList.add(...add.split(' ')); };
  let backFocus: HTMLElement | null = null;
  const isOpen = () => $('drawer').getAttribute('aria-hidden') === 'false';
  const showPanel = (html: string) => {
    panelObl = null;
    const dr = $('drawer');
    if (!isOpen()) backFocus = document.activeElement as HTMLElement | null;
    $('dr').innerHTML = html;
    dr.removeAttribute('inert'); dr.setAttribute('aria-hidden', 'false');
    cls(dr, DRAWER.panelOpen, DRAWER.panelClosed);
    cls($('drback'), DRAWER.backdropOpen, DRAWER.backdropClosed);
    (dr.querySelector('[data-r2="x"]') as HTMLElement | null)?.focus({ preventScroll: true });
  };
  const closePanel = () => {
    const dr = $('drawer');
    const wasOpen = isOpen();
    dr.setAttribute('aria-hidden', 'true'); dr.setAttribute('inert', '');
    cls(dr, DRAWER.panelClosed, DRAWER.panelOpen);
    cls($('drback'), DRAWER.backdropClosed, DRAWER.backdropOpen);
    state.sel = null; panelObl = null; highlight(); syncRows();
    if (wasOpen && backFocus && document.contains(backFocus)) backFocus.focus({ preventScroll: true });
    backFocus = null;
  };
  const toast = (m: string, ms = 2600) => { const t = $('toast'); t.textContent = m; t.classList.add('show'); window.setTimeout(() => t.classList.remove('show'), ms); };

  // ---------- remediation: AI drafts behind the action chips ----------
  // The page pushes the regulation's drafts and the local model's status in a
  // `cc:drafts` event; a chip shows that draft's state and opens the page's
  // drafting drawer. Starting a new draft needs the local model, so that button
  // is drawn only while the model is known to be online; opening an existing
  // draft does not need it. The copied and downloaded plan still lists every action.
  let drafts = new Map<string, DraftSummary>();
  let llm: LlmStatus | null = null;
  let panelObl: Scoped | null = null;
  // auditor view: obligations whose documents the auditor has already asked for (pushed by the page)
  let requested = new Set<string>();
  const reqBtn = (x: Scoped, large = false) => {
    if (!opts.readOnly || !opts.onRequestDocs) return '';
    if (requested.has(x.c)) return `<span class="act reqd${large ? ' lg' : ''}" title="${esc(tNow('You asked the hospital for these documents'))}">${tNow('Requested ✓')}</span>`;
    const none = !(x.by ?? []).length;
    return `<button type="button" class="act actbtn a-req${large ? ' lg' : ''}" data-reqdoc="${esc(x.c)}" title="${esc(tNow(none
      ? 'No supporting document is on record. Ask the hospital for what shows this is done'
      : 'Ask the hospital for the files behind these documents'))}">${tNow(none ? 'Request documents' : 'Request files')}</button>`;
  };
  const chip = (x: Scoped, label: string, cls: string, large = false) => {
    const kind = KIND_OF[cls];
    // `label` is the English action from actionsFor (the copied plan keeps it); `lbl` is how it is shown
    const lbl = tNow(label);
    if (!kind || opts.readOnly) return `<span class="act ${cls}${large ? ' lg' : ''}">${lbl}</span>`;
    if (!x.rid) return `<span class="act ${cls}${large ? ' lg' : ''}" title="${esc(tNow('No requirement id is recorded for this duty, so it cannot be drafted'))}">${lbl}</span>`;
    const d = drafts.get(draftKey(x.rid, kind));
    if ((!d || d.status === 'FAILED') && !llm?.ok) return '';
    const words = CHIP_TEXT[kind];
    let text = lbl, state = '', tip = tNow('{action} — draft it with the local AI', { action: lbl });
    if (d && isRunning(d.status)) { state = ' run'; text = `<i class="spin" aria-hidden="true"></i>${tNow(words.run)}`; tip = d.message || tNow('Drafting…'); }
    else if (d?.status === 'QUESTIONS') { state = ' ready'; text = tNow(words.ask); tip = tNow('The AI asks a few questions before it drafts. Open to answer them'); }
    else if (d?.status === 'READY') { state = ' ready'; text = tNow(words.ready); tip = tNow('Open the draft to review, edit, save or download it'); }
    else if (d?.status === 'SAVED') { state = ' saved'; text = tNow(words.saved); tip = d.message || tNow(words.savedTip); }
    else if (d?.status === 'FAILED') { tip = d.message ? tNow('The last attempt failed — {reason}', { reason: d.message }) : tNow('The last attempt failed — try again'); }
    return `<button type="button" class="act actbtn ${cls}${state}${large ? ' lg' : ''}" data-draft="${kind}" data-code="${esc(x.c)}" title="${esc(tip)}">${text}</button>`;
  };
  /** the obligation panel's "What to do" block; empty when every chip is hidden */
  const oblActsBody = (x: Scoped) => {
    const chips = actionsFor(x).map(([l, c]) => chip(x, l, c, true)).join('');
    if (!chips) return '';
    if (opts.readOnly) return `<section class="dblock"><h4>${tNow('What is needed')}</h4><div class="acts">${chips}</div></section>`;
    return `<section class="dblock"><h4>${tNow('What to do')}</h4><div class="acts">${chips}</div>
      ${chips.includes('data-draft=') ? `<p class="sub" style="margin-top:6px">${tNow("Each button drafts the missing record with the local AI. A draft is saved as a Draft record for a person to review — it does not change the gap's status.")}</p>` : ''}</section>`;
  };
  /** the wrapper stays in the panel so the block can be re-rendered in place when draft or AI states change */
  const oblActs = (x: Scoped) => {
    const body = oblActsBody(x);
    return `<div data-r="oblacts"${body ? '' : ' hidden'}>${body}</div>`;
  };

  // ---------- detail panel: one per kind of box ----------
  /** An obligation: its status and what is missing, the chain behind it, and every linked record. */
  const openObl = (x: Scoped) => {
    const r = resolve(x), st = ST[x.st];
    const owner = ownerFor(x, r);
    const tone = x.st === 'MET' ? 'green' : x.st === 'PARTIAL' ? 'amber' : x.st === 'NOT_COVERED' ? 'orange' : 'red';
    const nBy = (x.by ?? []).length;
    const body = x.st === 'MET'
      ? `${esc(tNow(MEANING.MET))}.${nBy ? ` ${nBy === 1 ? tNow('Covered by 1 document.') : tNow('Covered by {n} documents.', { n: nBy.toLocaleString() })}` : ''}`
      : `${x.gap ? `<p><b>${tNow('What is missing')}:</b> ${esc(x.gap)}</p>` : ''}${x.fix ? `<p><b>${tNow('Fix')}:</b> ${esc(x.fix)}</p>` : ''}${x.why ? `<p><b>${tNow('If not fixed')}:</b> ${esc(x.why)}</p>` : ''}`;
    showPanel(
      head(`${tNow('Obligation')} · <span class="mono">${esc(x.c)}</span>`, cut(x.ob || x.t, 200), statusTag(x.st) + riskTag(x.rk)) +
      `<div class="dbody ${DRAWER.body}">
        ${callout(tone, `${tNow(st[0])} — ${esc(tNow(MEANING[x.st]))}`, body)}
        ${oblActs(x)}
        ${block(tNow('Relationship'), flow([
          { icon: 'listchecks', label: tNow('Obligation'), sub: tNow(st[0]), tone: x.st },
          { icon: 'filetext', label: r.pols.length ? (r.pols.length === 1 ? tNow('1 policy') : tNow('{n} policies', { n: r.pols.length.toLocaleString() })) : tNow('Policy'), sub: tNow(r.pols.length ? 'on file' : 'none on file'), tone: r.pols.length ? 'ok' : 'miss' },
          { icon: 'shieldcheck', label: r.ctrls.length ? (r.ctrls.length === 1 ? tNow('1 control') : tNow('{n} controls', { n: r.ctrls.length.toLocaleString() })) : tNow('Control'), sub: tNow(r.ctrls.length ? 'on file' : 'none on file'), tone: r.ctrls.length ? 'ok' : 'miss' },
          { icon: 'user', label: owner.name || tNow('Owner'), sub: owner.name ? tNow('suggested · {via}', { via: owner.viaText }) : tNow('unassigned'), tone: owner.name ? 'ok' : 'miss' },
        ]))}
        ${fields([
          [tNow('Status'), statusTag(x.st)], [tNow('Priority'), x.rk && x.rk !== 'None' ? `<span class="tag ${RK[x.rk] ?? 't-na'}" title="${esc(tNow(MEANING.RISK))}">${tNow(x.rk)}</span>` : tNow('None')],
          [tNow('Section'), `${esc(x.unit.u)} — ${esc(cut(x.unit.ut, 90))}`], [tNow('Category'), esc(x.cat)],
          [tNow('Suggested owner'), owner.name ? `${esc(owner.name)} <span class="sub">· ${esc(tNow('from {via}', { via: owner.viaText }))}</span>` : ''],
          [tNow('Named in AI review'), esc(x.who)], [tNow('Covered by'), nBy === 1 ? tNow('1 document') : tNow('{n} documents', { n: nBy.toLocaleString() })],
        ])}
        ${block(tNow('Requirement'), `<div class="quote">${esc(x.t)}</div>${x.rq ? `<p class="sub" style="margin-top:6px"><b>${tNow('Test')}:</b> ${esc(x.rq)}</p>` : ''}`)}
        ${block(tNow('Covered by'), docList([...new Set(x.by ?? [])], tNow('Nothing on file covers this duty.')) +
          (opts.readOnly && opts.onRequestDocs ? `<div data-r="reqbox" style="margin-top:8px">${reqBtn(x, true)}</div>` : ''))}
        ${block(tNow('Controls'), docList(r.ctrls, tNow('No control on file — design one.')))}
        ${block(tNow('Policies'), docList(r.pols, tNow('No policy on file.')))}
        ${r.risks.length ? block(tNow('Register risks (through its controls)'), docList(r.risks, '')) : ''}
        ${x.interp ? `<details class="gbinterp"><summary>${tNow('NABH guidebook interpretation')}${x.gbp ? ` · ${tNow('p{n}', { n: x.gbp })}` : ''}</summary><p>${esc(x.interp)}</p></details>` : ''}
        ${(x.subs ?? []).length ? `<div class="gbreqs"><h5>${tNow('Guidebook requirements ({n}) — status is rolled up from these', { n: x.subs!.length.toLocaleString() })}</h5>
          ${x.subs!.map((g) => `<div class="gbreq" style="--sev:${ST[g.st][2]}">
            <div class="dhead"><span class="mono">#${g.n}</span>${statusTag(g.st)}${g.risk !== 'None' ? `<span class="tag ${RK[g.risk] ?? 't-na'}">${tNow(g.risk)}</span>` : ''}</div>
            <p>${esc(g.rq)}</p>
            ${g.ev ? `<p class="sub">${tNow('Evidence')}: ${esc(g.ev)}</p>` : ''}
            ${g.gap ? `<p class="red">${tNow('Missing')}: ${esc(g.gap)}</p>` : ''}${g.fix ? `<p class="sub">${tNow('Fix')}: ${esc(g.fix)}</p>` : ''}
            ${g.by.length ? `<p>${links(g.by)}</p>` : ''}
          </div>`).join('')}</div>` : ''}
      </div>` +
      foot(regButtons()));
    panelObl = x;
  };

  /** A policy, SOP, form or control — or a risk-register entry. */
  const openDoc = (code: string) => {
    const d: CascadeDoc | undefined = docs[code], r = risks[code];
    const users = relies(code);
    const filterBtn = `<button type="button" class="btn btn-outline" data-searchcode="${esc(code)}">${tNow('Show its obligations')}</button>`;
    if (d) {
      const rel: [string, string[]][] = [];
      if (d.pol?.length) rel.push([tNow('Governed by policy'), d.pol]);
      if (d.sops?.length) rel.push([tNow(d.k === 'Policy' ? 'Related SOPs' : d.k === 'Form' ? 'Used in SOP' : 'Implements SOP'), d.sops]);
      if (d.forms?.length) rel.push([tNow('Evidence forms'), [...new Set(d.forms)]]);
      if (d.risks?.length) rel.push([tNow('Mitigates risks'), d.risks]);
      if (d.k === 'SOP' || d.k === 'Policy') {
        const cs = d.k === 'SOP' ? (ctrlsOf[code] ?? []) : (d.sops ?? []).flatMap((s) => ctrlsOf[s] ?? []);
        if (cs.length) rel.push([tNow('Controls'), [...new Set(cs)]]);
      }
      const owner = d.o || '';
      showPanel(
        head(`${esc(kindWord(d.k))} · <span class="mono">${esc(code)}</span>`, d.t, `<span class="tag t-na">${esc(kindWord(d.k))}</span>`) +
        `<div class="dbody ${DRAWER.body}">
          ${locBlock(code)}
          ${fields([
            [tNow('Owner'), esc(owner)], [tNow('Frequency'), esc(d.freq)], [tNow('Last test'), esc(d.test)], [tNow('Standards'), esc(d.std)],
            [tNow('Obligations relying on it'), `${users.length}`], [tNow('Unmet among them'), `${users.filter(unmetOf).length}`],
          ])}
          ${(d.x ?? []).map(([h, ps]) => block(esc(h), ps.length > 1 ? `<ul class="bul">${ps.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : `<p>${esc(ps[0])}</p>`)).join('')}
          ${rel.map(([h, cs]) => block(h, docList(cs, '—'))).join('')}
          ${block(tNow('Obligations in this regulation that rely on it'), oblList(users, tNow('No obligation in this regulation cites it.')))}
        </div>` +
        foot(filterBtn));
    } else if (r) {
      showPanel(
        head(`${tNow('Risk register')} · <span class="mono">${esc(code)}</span>`, r.t, r.rating ? `<span class="tag t-na">${esc(tNow('Inherent {rating}', { rating: tNow(cap(r.rating)) }))}</span>` : '') +
        `<div class="dbody ${DRAWER.body}">
          ${locBlock(code)}
          ${fields([[tNow('Inherent rating'), esc(tNow(cap(r.rating ?? '')))], [tNow('Residual score'), esc(r.res)], [tNow('Risk owner'), esc(r.o)], [tNow('Controls'), `${r.ctrls.length}`]])}
          ${block(tNow('Controls that mitigate it'), docList(r.ctrls, tNow('No control is recorded against this risk.')))}
          ${block(tNow('Obligations in this regulation on this risk'), oblList(users, tNow('No obligation in this regulation leads to this risk.')))}
        </div>` +
        foot(filterBtn));
    }
  };

  /** An owner box: the controls they own and the duties that depend on them. */
  const openOwner = (name: string) => {
    if (name === 'Unassigned') { openMissing('W:Unassigned'); return; }
    const owned = Object.entries(docs).filter(([, d]) => d.k === 'Control' && d.o === name).map(([c]) => c);
    const ownedSet = new Set(owned);
    const users = everything.filter((x) => resolve(x).ctrls.some((c) => ownedSet.has(c)));
    showPanel(
      head(tNow('Owner'), name, `<span class="tag t-na">${tNow('Control owner')}</span>`) +
      `<div class="dbody ${DRAWER.body}">
        ${fields([[tNow('Controls owned'), `${owned.length}`], [tNow('Obligations depending on them'), `${users.length}`], [tNow('Unmet among them'), `${users.filter(unmetOf).length}`]])}
        ${block(tNow('Controls they own'), docList(owned, tNow('No control names this owner.')))}
        ${block(tNow('Obligations in this regulation'), oblList(users, tNow('No obligation in this regulation depends on their controls.')))}
      </div>` +
      foot(''));
  };

  /** A placeholder for a link that does not exist: what is missing and which duties it leaves exposed. */
  const openMissing = (id: string) => {
    const affected = [...pathsThrough(id)].map((o) => idx[o]?.it).filter((x): x is Scoped => !!x);
    const n = idx[id];
    const what: Record<string, [string, string]> = {
      P: [tNow('No policy on file'), tNow('No policy on file covers these duties. Write or adopt one.')],
      C: [tNow('No control on file'), tNow('Nothing operates or tests these duties. Design a control.')],
      W: [tNow('No owner'), tNow('No one is named to answer for these duties. Assign an owner.')],
    };
    const [title, text] = what[id[0]] ?? [tNow('Missing link'), ''];
    showPanel(
      head(`${tNow('Missing link')} · ${esc(tNow(CSING[n?.col ?? 0]))}`, title, `<span class="tag t-miss">${tNow('Missing link')}</span>`) +
      `<div class="dbody ${DRAWER.body}">
        ${callout('red', esc(tNow(MEANING.MISSING)), esc(text))}
        ${block(tNow('Obligations in the diagram left exposed ({n})', { n: affected.length.toLocaleString() }), oblList(affected, tNow('None in the current view.')))}
      </div>` +
      foot(''));
  };

  /** The regulation itself: does it apply, how much it matters, where its gaps are. */
  const openReg = () => {
    const items = reg.units.flatMap((u) => u.items);
    const n = (f: (x: CascadeItem) => boolean) => items.filter(f).length;
    const counts: [Status, number][] = (['MET', 'PARTIAL', 'GAP', 'NOT_COVERED'] as Status[]).map((s) => [s, n((x) => x.st === s)]);
    const na = reg.not_applicable ?? 0;
    const total = items.length + na;
    const bar = counts.concat([['NOT_APPLICABLE', na]]).filter(([, c]) => c)
      .map(([s, c]) => `<i style="width:${(100 * c) / Math.max(1, total)}%;background:${ST[s][2]}" title="${esc(tNow(ST[s][0]))}: ${c} — ${esc(tNow(MEANING[s]))}"></i>`).join('');
    const risksN = (['Critical', 'High', 'Medium', 'Low'] as Risk[]).map((k) => [k, n((x) => x.rk === k)] as const);
    const unitScore = (u: CascadeUnit) => u.items.reduce((a, x) => a + (unmetOf(x) ? [40, 12, 4, 1, 0][RORD[x.rk]] : 0), 0);
    const units = reg.units.map((u, i) => ({ u, i, unmet: u.items.filter(unmetOf).length, crit: u.items.filter((x) => x.rk === 'Critical').length }))
      .sort((a, b) => unitScore(b.u) - unitScore(a.u));
    const worst = everything.filter(unmetOf).sort((a, b) => RORD[a.rk] - RORD[b.rk]).slice(0, 6);
    const verdict = reg.applicability || tx('Not assessed');
    showPanel(
      head(`${tNow('Regulation')}${reg.regulator ? ` · ${esc(reg.regulator)}` : ''}`, reg.title, `<span class="tag t-na">${esc(tNow(verdict.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())))}</span>`) +
      `<div class="dbody ${DRAWER.body}">
        ${fields([
          [tNow('Regulator'), esc(reg.regulator_full || reg.regulator)], [tNow('Type'), esc(reg.regulation_type)], [tNow('Jurisdiction'), esc(reg.jurisdiction)],
          [tNow('In force from'), esc(reg.effective_from)], [tNow('Impact score'), reg.impact_score != null ? `<b>${reg.impact_score}</b> / 100${reg.impact_level ? ` <span class="tag ${RK[reg.impact_level] ?? 't-na'}">${esc(tNow(reg.impact_level))}</span>` : ''}` : ''],
          [tNow('Duties on the hospital'), tNow('{n} of {total} provisions', { n: items.length.toLocaleString(), total: total.toLocaleString() })],
        ])}
        ${reg.applicability_reason ? block(tNow('Does it apply to the hospital?'), `<p>${esc(reg.applicability_reason)}</p>`) : ''}
        ${na ? `<p class="sub">${na === 1 ? tNow('1 provision binds someone else (government, regulator, manufacturer…).') : tNow('{n} provisions bind someone else (government, regulator, manufacturer…).', { n: na.toLocaleString() })}</p>` : ''}
        ${block(tNow("Compliance with the hospital's documents"), `<div class="rbar">${bar}</div>
          <div class="rlegend">${counts.map(([s, c]) => `<span title="${esc(tNow(MEANING[s]))}"><i style="background:${ST[s][2]}"></i>${tNow(ST[s][0])} <b>${c}</b></span>`).join('')}${na ? `<span><i style="background:var(--ink-faint)"></i>${tNow('Not applicable')} <b>${na}</b></span>` : ''}</div>`)}
        ${block(tNow('Priority of the unmet duties'), `<p>${risksN.filter(([, c]) => c).map(([k, c]) => `<span class="tag ${RK[k]}" style="margin-right:6px">${tNow(RISK_N[k], { n: c.toLocaleString() })}</span>`).join('') || '—'}</p>`)}
        ${worst.length ? block(tNow('Most serious gaps'), oblList(worst, '—')) : ''}
        ${units.length > 1 ? block(tNow('Sections — click to focus the diagram'), `<ul class="rlist">${units.slice(0, 40).map((x) =>
          `<li><button type="button" class="rlink" data-unit="${x.i}"><span class="mono">${esc(x.u.u)}</span> ${esc(cut(x.u.ut, 70))}
            <span class="sub">· ${tNow('{n} unmet', { n: x.unmet.toLocaleString() })}${x.crit ? ` · <b class="red">${tNow('{n} critical', { n: x.crit.toLocaleString() })}</b>` : ''}</span></button></li>`).join('')}</ul>`) : ''}
      </div>` +
      foot(regButtons() + (reg.url ? `<a class="btn" href="${esc(reg.url)}" target="_blank" rel="noopener">${tNow('Source')} ${htmlIcon('ext', 12)}</a>` : '')));
  };

  // ---------- lattice ----------
  let shown: Scoped[] = [];
  let idx: Record<string, Node> = {};
  const render = () => {
    const all = itemsInScope();
    const q = state.q.trim().toLowerCase();
    const searched = q ? all.filter((x) => haystack(x).includes(q)) : all;
    const stCount = (s: Status) => searched.filter((x) => x.st === s && (!state.rk.size || state.rk.has(x.rk))).length;
    const rkCount = (k: Risk) => searched.filter((x) => x.rk === k && (!state.st.size || state.st.has(x.st))).length;
    $('f-status').innerHTML = $('t-status').innerHTML = (['GAP', 'PARTIAL', 'NOT_COVERED', 'MET'] as Status[]).map((s) =>
      `<button type="button" class="fchip s-${s}" data-st="${s}" aria-pressed="${state.st.has(s)}" title="${esc(`${tNow(ST[s][0])}: ${tNow(MEANING[s])}`)}"><i></i>${tNow(ST[s][0])}<span>${stCount(s)}</span></button>`).join('');
    $('f-risk').innerHTML = (['Critical', 'High', 'Medium', 'Low'] as Risk[]).map((k) =>
      `<button type="button" class="fchip r-${k}" data-rk="${k}" aria-pressed="${state.rk.has(k)}" title="${esc(tNow(MEANING.RISK))}"><i></i>${tNow(k)}<span>${rkCount(k)}</span></button>`).join('');
    // a document code picked in the plan narrows the view; it shows as a chip so it can be seen and removed
    const filtered = !!q || state.rk.size > 0 || state.scope !== 'top' || state.st.size !== DEFAULT_ST.length || DEFAULT_ST.some((x) => !state.st.has(x));
    (root.querySelector('.fclear') as HTMLElement).hidden = !filtered;
    $('qchip').innerHTML = q ? `<button type="button" class="fchip qchip" data-r="qclear" aria-pressed="true" aria-label="${esc(tNow('Remove {label} filter', { label: state.q.trim() }))}" title="${esc(tNow('Remove filter'))}"><i></i>${esc(state.q.trim())}<span aria-hidden="true">✕</span></button>` : '';
    shown = searched.filter((x) => (!state.st.size || state.st.has(x.st)) && (!state.rk.size || state.rk.has(x.rk)))
      .sort((a, b) => RORD[a.rk] - RORD[b.rk] || String(a.c).localeCompare(String(b.c), undefined, { numeric: true }));
    const obls = shown.slice(0, 8);

    const cols: Node[][] = [[], [], [], [], []];
    idx = {};
    const edges = new Map<string, Edge>();
    const node = (n: Node) => { if (!idx[n.id]) { idx[n.id] = n; cols[n.col].push(n); } return n.id; };
    const edge = (a: string, b: string, owner: string) => {
      const k = a + '>' + b; if (!edges.has(k)) edges.set(k, { a, b, owners: new Set() }); edges.get(k)!.owners.add(owner);
    };
    const fileOf = (code: string) => locOf(code)?.file ?? '';
    const locLine = (code: string) => { const l = locOf(code); return l ? `\n${tNow('Location')}: ${locStr(l)}` : ''; };
    const R = node({ col: 0, id: 'REG', l: cut(reg.short || reg.title, LCUT), full: reg.title, s: [cut(reg.regulator ?? '', 28),
      all.length === 1 ? tNow('1 obligation in scope') : tNow('{n} obligations in scope', { n: all.length.toLocaleString() }),
      ...(opts.onRegulation ? [] : [tNow('ⓘ click for details')])], h: opts.onRegulation ? 80 : 72 });
    obls.forEach((it) => {
      const st = ST[it.st], rs = resolveForDiagram(it), unmet = unmetOf(it);
      const label = it.ob ? it.ob.replace(/^The hospital shall /i, '') : it.t;
      const o = node({ col: 1, id: 'O:' + it.c, l: cut(label, LCUT), full: `${it.c} · ${tNow(st[0])} — ${tNow(MEANING[it.st])} · ${tNow(RISK_PRIORITY[it.rk] ?? it.rk)}\n${label}${it.gap ? `\n${tNow('Missing')}: ${it.gap}` : ''}`, s: [it.c], obl: true, it, dot: RCOL[it.rk] });
      edge(R, o, o);
      const polIds = rs.pols.length
        ? rs.pols.map((p) => node({ col: 2, id: 'P:' + p, l: cut(docs[p].t, LCUT), full: `${p} · ${docs[p].t}${locLine(p)}`, s: [`${p} · ${tNow(unmet ? 'extend' : 'in force')}`], loc: fileOf(p) }))
        : [node({ col: 2, id: 'P:none', l: tNow('No policy on file'), full: tNow('No policy on file covers these obligations — write or adopt one'), s: [tNow('write / adopt policy')], miss: true })];
      const ctlIds = rs.ctrls.length
        ? rs.ctrls.map((c) => node({ col: 3, id: 'C:' + c, l: cut(docs[c].t, LCUT), full: `${c} · ${docs[c].t}\n${docs[c].freq ?? ''} · ${tNow('owner {name}', { name: docs[c].o ?? '—' })}${locLine(c)}`, s: [`${c} · ${cut(docs[c].freq ?? '', 10)} · ${cut((docs[c].test ?? '').toLowerCase(), 10)}`], loc: fileOf(c) }))
        : [node({ col: 3, id: 'C:none', l: tNow('No control on file'), full: tNow('No control operates or tests these obligations — design one'), s: [tNow('design control')], miss: true })];
      // Draw only relationships that exist, per control, instead of joining every
      // policy to every control: that cross product is what made the lines
      // unreadable. A control's chain is: the policy that governs its SOP → the
      // control → its owner.
      const polsOfCtl = (c: string) => {
        const governing = new Set((docs[c].sops ?? []).flatMap((s) => docs[s]?.pol ?? []));
        const hit = polIds.filter((pi) => pi !== 'P:none' && governing.has(pi.slice(2)));
        return hit.length ? hit : [polIds[0]];
      };
      const ownerOf = (ci: string) => {
        const own = ci === 'C:none' ? 'Unassigned' : (docs[ci.slice(2)].o || 'Unassigned');
        // 'Unassigned' is also the node id; only the words drawn are translated
        return node({ col: 4, id: 'W:' + own, l: cut(own === 'Unassigned' ? tNow('Unassigned') : own, LCUT), full: own === 'Unassigned' ? tNow('No owner — assign one') : `${tNow('Control owner')}: ${own}`, s: [tNow(own === 'Unassigned' ? 'needs an owner' : 'control owner')], miss: own === 'Unassigned' });
      };
      polIds.forEach((pi) => edge(o, pi, o));
      if (ctlIds[0] === 'C:none') {
        polIds.forEach((pi) => edge(pi, 'C:none', o));
        edge('C:none', ownerOf('C:none'), o);
      } else {
        ctlIds.forEach((ci) => {
          const ps = polsOfCtl(ci.slice(2));
          ps.forEach((pi) => edge(pi, ci, o));
          edge(ci, ownerOf(ci), o);
        });
      }
    });
    // a box with a file line is one line taller
    Object.values(idx).forEach((n) => { if (!n.h) n.h = H + (n.s.length - 1) * 12 + (n.loc ? 12 : 0); });
    // Order each column so a box sits beside the boxes it connects to (barycentre
    // heuristic, a few sweeps left→right then right→left). The obligation column
    // keeps its risk order. This is what removes most line crossings.
    const pos = new Map<string, number>();
    const index = () => cols.forEach((c) => c.forEach((n, i) => pos.set(n.id, i / Math.max(1, c.length - 1))));
    const nbrs = new Map<string, string[]>();
    edges.forEach((e) => { (nbrs.get(e.a) ?? nbrs.set(e.a, []).get(e.a)!).push(e.b); (nbrs.get(e.b) ?? nbrs.set(e.b, []).get(e.b)!).push(e.a); });
    const bary = (n: Node, side: number) => {
      const ns = (nbrs.get(n.id) ?? []).filter((m) => idx[m]?.col === n.col + side);
      return ns.length ? ns.reduce((a, m) => a + (pos.get(m) ?? 0), 0) / ns.length : (pos.get(n.id) ?? 0);
    };
    index();
    for (let sweep = 0; sweep < 4; sweep++) {
      for (let c = 2; c <= 4; c++) { cols[c].sort((a, b) => bary(a, -1) - bary(b, -1)); index(); }
      for (let c = 3; c >= 2; c--) { cols[c].sort((a, b) => bary(a, +1) - bary(b, +1)); index(); }
    }
    const heights = cols.map((c) => c.reduce((a, n) => a + (n.h ?? H) + GAPY, 0));
    const TOP = 54;
    const total = Math.max(300, ...heights) + TOP + 8;
    cols.forEach((c, ci) => { let y = TOP + (total - TOP - 4 - heights[ci]) / 2; c.forEach((n) => { n.x = COLS[ci][1]; n.y = y; y += (n.h ?? H) + GAPY; }); });
    canvasH = total;
    const svg = [`<svg viewBox="0 0 ${CANVAS_W} ${total}" width="${CANVAS_W}" height="${total}" role="img" aria-label="${esc(tNow('Impact cascade for {title}', { title: reg.title }))}">`];
    svg.push(`<defs>${SYMBOLS}${MARKERS.map((c) =>
      `<marker id="ar-${c}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--${c})"/></marker>`).join('')}</defs>`);
    // each column is a frosted group: a blue badge with its icon, its name, and a capsule with how many boxes it holds
    COLS.forEach(([lbl, x], ci) => {
      const n = String(cols[ci].length), cw = 14 + n.length * 7;
      svg.push(
        `<rect class="grp" x="${x - 12}" y="2" width="${W + 24}" height="${total - 4}" rx="20" ry="20"/>`,
        `<g class="colhead"><rect class="gbadge" x="${x - 2}" y="13" width="24" height="24" rx="7.5" ry="7.5"/>`,
        `${useIcon(CICON[ci], x + 3.5, 18.5, 13, '#fff')}`,
        `<text class="chl" x="${x + 31}" y="29.5">${tNow(lbl)}</text>`,
        `<rect class="gcount" x="${x + W + 2 - cw}" y="16" width="${cw}" height="18" rx="9" ry="9"/>`,
        `<text class="chn" x="${x + W + 2 - cw / 2}" y="28.5" text-anchor="middle">${n}</text></g>`);
    });
    // Connection ports: when several edges meet one box (a shared "No control on
    // file" box above all), spread their end points along the box edge in the
    // order of the other end's height, instead of piling them onto one point.
    const midY = (n: Node) => n.y! + (n.h ?? H) / 2;
    const outOf = new Map<string, Edge[]>(), into = new Map<string, Edge[]>();
    edges.forEach((e) => { (outOf.get(e.a) ?? outOf.set(e.a, []).get(e.a)!).push(e); (into.get(e.b) ?? into.set(e.b, []).get(e.b)!).push(e); });
    const portA = new Map<Edge, number>(), portB = new Map<Edge, number>();
    const spread = (n: Node, list: Edge[], other: (e: Edge) => Node, set: Map<Edge, number>) => {
      const h = n.h ?? H, cy = midY(n);
      if (list.length < 2) { list.forEach((e) => set.set(e, cy)); return; }
      const sorted = [...list].sort((p, q) => midY(other(p)) - midY(other(q)));
      const step = Math.min(8, (h - 16) / (sorted.length - 1));
      sorted.forEach((e, i) => set.set(e, cy + (i - (sorted.length - 1) / 2) * step));
    };
    outOf.forEach((list, id) => spread(idx[id], list, (e) => idx[e.b], portA));
    into.forEach((list, id) => spread(idx[id], list, (e) => idx[e.a], portB));
    // ports (a dot where a line meets a box) and link counts are drawn over the boxes, so they sit on their edges
    const over: string[] = [];
    const seenLabel = new Set<string>();
    let flowIdx = 0;
    edges.forEach((e) => {
      const a = idx[e.a], b = idx[e.b];
      const x1 = a.x! + W, y1 = portA.get(e) ?? midY(a), x2 = b.x!, y2 = portB.get(e) ?? midY(b), mx = (x1 + x2) / 2;
      svg.push(`<path class="edge${b.miss ? ' to-miss' : ''}" data-o="${esc([...e.owners].join('|'))}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" stroke="var(--edge)" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}"/>`);
      // the same curve again, as a stream of dots running left to right: the direction the chain reads.
      // A negative delay per link starts each stream at a different point, so the lattice does not pulse in step.
      svg.push(`<path class="flow" aria-hidden="true" style="animation-delay:-${((flowIdx++ * 0.37) % 1.8).toFixed(2)}s" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}"/>`);
      over.push(`<circle class="port" cx="${x1}" cy="${y1}" r="3"/>`, `<circle class="port${b.miss ? ' miss' : ''}" cx="${x2 - 1}" cy="${y2}" r="3"/>`);
      // a link several obligations travel along carries their count, like traffic on a line
      const cnt = e.owners.size, my = (y1 + y2) / 2, key = `${Math.round(mx / 6)}:${Math.round(my / 10)}`;
      if (cnt > 1 && !seenLabel.has(key)) {
        seenLabel.add(key);
        const lw = 16 + String(cnt).length * 6.5;
        over.push(`<g class="elbl${b.miss ? ' miss' : ''}"><rect x="${mx - lw / 2}" y="${my - 9}" width="${lw}" height="18" rx="9" ry="9"/><text x="${mx}" y="${my + 3.6}" text-anchor="middle">${cnt}</text></g>`);
      }
    });
    // the regulation box's own "Change" button: opens the page's regulation picker
    const changeBtn = (x: number, y: number) => {
      const word = tNow('Change'), w = Math.round(word.length * 6 + 34);
      return `<g class="regchange" data-r="changereg" role="button" aria-label="${esc(tNow('Change regulation'))}">
        <rect x="${x}" y="${y}" width="${w}" height="18" rx="9" ry="9" fill="#0071e3"/>
        ${useIcon('swap', x + 8, y + 4, 10, '#fff')}
        <text x="${x + 22}" y="${y + 12.5}" style="fill:#fff;font-size:10.5px;font-weight:600">${esc(word)}</text></g>`;
    };
    cols.flat().forEach((n, order) => {
      const h = n.h ?? H;
      const dcode = /^[PCR]:(?!none|gap)/.test(n.id) ? n.id.slice(2) : '';
      // every box opens with an icon tile: blue for records, the status colour for an
      // obligation, red for something that is missing
      const ic = n.miss ? 'alert' : n.obl ? 'listchecks' : CICON[n.col];
      const tile = n.miss ? 'var(--oxide)' : n.obl ? ST[n.it!.st][2] : 'var(--statute)';
      const tx = n.x! + 36;
      const kind = n.obl ? ' obl' : n.miss ? '' : ' doc';
      const stroke = n.miss ? 'var(--oxide)' : n.obl ? ST[n.it!.st][2] : 'var(--node-line)';
      const fill = n.miss ? 'var(--oxide-soft)' : '#fff';
      let body = '';
      if (n.obl) {
        // obligation: its code, and a small status capsule
        const s = n.it!.st, word = tNow(ST[s][0]);
        const pw = Math.round(word.length * 5.4 + 14);
        const px = n.x! + W - 8 - pw;
        body = `<text class="sl" x="${tx}" y="${n.y! + 35}">${esc(cut(n.it!.c, Math.max(6, Math.floor((px - tx - 4) / 5.4))))}</text>
          <rect class="spill" x="${px}" y="${n.y! + 25}" width="${pw}" height="15" rx="7.5" ry="7.5" fill="${ST[s][3]}" stroke="${ST[s][2]}"/>
          <text class="spt" x="${px + pw / 2}" y="${n.y! + 35.5}" text-anchor="middle" style="fill:${STINK[s]}">${word}</text>`;
      } else {
        // a record that opens on click says so with ↗, as a link would
        body = n.s.map((s, k) => `<text class="sl" x="${tx}" y="${n.y! + 33 + k * 12}">${esc(cut(s, 22))}${k === 0 && dcode ? ' ↗' : ''}</text>`).join('') +
          (n.loc ? `${useIcon('folder', tx, n.y! + 25 + n.s.length * 12, 9, 'var(--ink-faint)')}<text class="sl loc" x="${tx + 12}" y="${n.y! + 33 + n.s.length * 12}">${esc(cut(n.loc, 21))}</text>` : '');
      }
      const aria = `${n.miss ? tNow('{kind} (missing)', { kind: tNow(CSING[n.col]) }) : tNow(CSING[n.col])}: ${n.full.split('\n')[0]}`;
      // boxes arrive column by column, and one after another within a column
      const delay = Math.min(0.9, n.col * 0.1 + (order % 12) * 0.025);
      svg.push(`<g class="node${kind}${n.miss ? ' missing' : ''}${n.id === 'REG' ? ' reg' : ''}" data-id="${esc(n.id)}"${dcode ? ` data-doc="${esc(dcode)}"` : ''}${n.id === 'REG' ? ' data-reg="1"' : ''} tabindex="0" role="button" aria-label="${esc(aria)}" style="animation-delay:${delay.toFixed(3)}s">
        <title>${esc(n.full)}</title>
        <rect class="box" x="${n.x}" y="${n.y}" width="${W}" height="${h}" rx="12" ry="12" stroke="${stroke}" fill="${fill}"/>
        <rect class="ntile" x="${n.x! + 9}" y="${n.y! + 9}" width="20" height="20" rx="6.5" ry="6.5" style="fill:${tile}"/>
        ${useIcon(ic, n.x! + 13, n.y! + 13, 12, '#fff')}
        ${n.dot ? `<circle class="rdot" cx="${n.x! + 28}" cy="${n.y! + 10}" r="4" fill="${n.dot}"/>` : ''}
        <text class="lbl${n.miss ? ' mlbl' : ''}" x="${tx}" y="${n.y! + 20}">${esc(cut(n.l, 20))}</text>
        ${body}${n.id === 'REG' && opts.onRegulation ? changeBtn(tx, n.y! + 54) : ''}</g>`);
    });
    svg.push(...over);
    svg.push('</svg>');
    $('svg').innerHTML = obls.length ? svg.join('') : `<div class="empty">${tNow('No obligations match these filters.')} <button type="button" class="linkbtn" data-r="clear">${tNow('Clear filters')}</button></div>`;
    // the minimap is the same drawing, stripped of everything a person could focus or click
    $('mstage').innerHTML = obls.length ? svg.join('')
      .replace(/<defs>[\s\S]*?<\/defs>/, '').replace(/<title>[\s\S]*?<\/title>/g, '')
      .replace(/ (tabindex|role|aria-label|data-id|data-doc|data-reg|data-o|data-a|data-b|style)="[^"]*"/g, '') : '';
    $('mmap').hidden = !obls.length;
    ripple();
    $('more').textContent = shown.length > obls.length
      ? tNow('Showing the {n} highest-priority of {total} matching obligations. Narrow the scope, search, or use the filters to see the rest — all {total} are in the summary table below.', {
        n: obls.length.toLocaleString(), total: shown.length.toLocaleString(),
      }) : '';
    page = 1;
    highlight(); dossier(); table();
    fit();
  };

  // ---------- canvas: zoom and pan ----------
  const vp = $('vp'), stage = $('svg');
  let canvasH = 300;
  const view = { k: 1, x: 0, y: 0 };
  // minimap scale: the lattice shrunk to fit 176 × 104 px
  const MINI_W = 176, MINI_H = 104;
  let miniK = MINI_W / CANVAS_W;
  const sizeMini = () => {
    miniK = Math.min(MINI_W / CANVAS_W, MINI_H / Math.max(1, canvasH));
    const box = $('mmap');
    box.style.width = `${Math.round(CANVAS_W * miniK)}px`;
    box.style.height = `${Math.round(canvasH * miniK)}px`;
  };
  const applyView = () => {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    $('zl').textContent = `${Math.round(view.k * 100)}%`;
    // frame the part of the lattice the viewport shows
    const mv = $('mview');
    const x0 = Math.max(0, -view.x / view.k), y0 = Math.max(0, -view.y / view.k);
    const x1 = Math.min(CANVAS_W, (vp.clientWidth - view.x) / view.k), y1 = Math.min(canvasH, (vp.clientHeight - view.y) / view.k);
    mv.style.transform = `translate(${x0 * miniK}px, ${y0 * miniK}px)`;
    mv.style.width = `${Math.max(8, (x1 - x0) * miniK)}px`;
    mv.style.height = `${Math.max(8, (y1 - y0) * miniK)}px`;
  };
  // click or drag on the minimap: centre the viewport there
  const onMini = (ev: PointerEvent) => {
    if (ev.type === 'pointermove' && !(ev.buttons & 1)) return;
    ev.stopPropagation();
    const r = $('mmap').getBoundingClientRect();
    const cx = (ev.clientX - r.left) / miniK, cy = (ev.clientY - r.top) / miniK;
    view.x = vp.clientWidth / 2 - cx * view.k;
    view.y = vp.clientHeight / 2 - cy * view.k;
    applyView();
  };
  const clampK = (k: number) => Math.min(ZMAX, Math.max(ZMIN, k));
  // Width-first and top-aligned: the lattice is wide and short, so fitting it to
  // the height left it at ~60% scale with an empty band above. The viewport then
  // grows or shrinks to the drawing's height (360–820px).
  let lastW = 0;
  function fit() {
    const w = vp.clientWidth || CANVAS_W;
    lastW = w;
    if (full) {
      // full view: the viewport is the window, so the whole lattice fits both ways, centred
      sizeMini();
      const mini = root.querySelector<HTMLElement>('.minimap');
      const pad = mini ? mini.offsetHeight + 14 : 0;
      const h = vp.clientHeight || 600;
      view.k = clampK(Math.min((w - 48) / CANVAS_W, (h - 32 - pad) / Math.max(1, canvasH), 1.25));
      view.x = Math.max(12, (w - CANVAS_W * view.k) / 2);
      view.y = Math.max(16, (h - pad - canvasH * view.k) / 2);
      applyView();
      return;
    }
    view.k = clampK(Math.min((w - 24) / CANVAS_W, 1.1));
    // leave room under the drawing for the minimap card, so it never covers a box or a line
    sizeMini();
    const mini = root.querySelector<HTMLElement>('.minimap');
    const pad = mini ? mini.offsetHeight + 14 : 0;
    const vh = Math.round(Math.min(820, Math.max(360, canvasH * view.k + 32 + pad)));
    if (vp.style.height !== `${vh}px`) vp.style.height = `${vh}px`;
    view.x = Math.max(12, (w - CANVAS_W * view.k) / 2);
    view.y = 16;
    applyView();
  }
  const zoomTo = (k: number, cx: number, cy: number) => {
    const nk = clampK(k);
    view.x = cx - (cx - view.x) * (nk / view.k);
    view.y = cy - (cy - view.y) * (nk / view.k);
    view.k = nk;
    applyView();
  };
  // Zoom only with Ctrl/⌘ + wheel (a trackpad pinch arrives as a ctrlKey wheel):
  // a plain wheel scrolls the page. Each event's delta is normalised and capped,
  // so one mouse notch is ~6% and a pinch moves smoothly in small steps.
  const onWheel = (ev: WheelEvent) => {
    if (!(ev.ctrlKey || ev.metaKey)) return;
    ev.preventDefault();
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    const dy = Math.max(-60, Math.min(60, ev.deltaY * unit));
    const r = vp.getBoundingClientRect();
    zoomTo(view.k * Math.exp(-dy * 0.001), ev.clientX - r.left, ev.clientY - r.top);
  };
  const drag = { on: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  const onDown = (ev: PointerEvent) => {
    if (ev.button !== 0 || (ev.target as Element).closest('.node, button, a, .minimap')) return;
    Object.assign(drag, { on: true, moved: false, sx: ev.clientX, sy: ev.clientY, ox: view.x, oy: view.y });
    vp.classList.add('dragging');
    vp.setPointerCapture(ev.pointerId);
  };
  const onMove = (ev: PointerEvent) => {
    if (!drag.on) return;
    const dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    view.x = drag.ox + dx; view.y = drag.oy + dy; applyView();
  };
  const onUp = (ev: PointerEvent) => {
    if (!drag.on) return;
    drag.on = false; vp.classList.remove('dragging');
    try { vp.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
  };
  const ztools = $('ztools');
  const onZoomBtn = (ev: MouseEvent) => {
    const b = (ev.target as Element).closest('[data-zoom]') as HTMLElement | null;
    if (!b) return;
    const cx = vp.clientWidth / 2, cy = vp.clientHeight / 2;
    // ± buttons move in 10 % steps on round numbers (90 % → 100 % → 110 %)
    if (b.dataset.zoom === 'in') zoomTo(Math.round(view.k * 10 + 1) / 10, cx, cy);
    else if (b.dataset.zoom === 'out') zoomTo(Math.round(view.k * 10 - 1) / 10, cx, cy);
    else if (b.dataset.zoom === 'fit') fit();
    else { view.k = 1; view.x = 12; view.y = 16; applyView(); }
  };
  vp.addEventListener('wheel', onWheel, { passive: false });
  vp.addEventListener('pointerdown', onDown);
  vp.addEventListener('pointermove', onMove);
  vp.addEventListener('pointerup', onUp);
  vp.addEventListener('pointercancel', onUp);
  ztools.addEventListener('click', onZoomBtn);
  const mmap = $('mmap');
  mmap.addEventListener('pointerdown', onMini);
  mmap.addEventListener('pointermove', onMini);
  // ---------- full view ----------
  // The canvas card lifts out of the page and grows to fill the window, its
  // filters with it, while the page behind blurs away; the lattice refits on
  // every frame as the card grows, so the drawing zooms with it. Esc or the
  // same button flies it back to its place.
  const canvasEl = root.querySelector('.canvas') as HTMLElement;
  let full = false, flight: Animation | null = null, disposed = false;
  let holder: HTMLElement | null = null, back: HTMLElement | null = null;
  // run once the flight lands: on the finished promise, or by a timer if the browser holds the
  // animation back (a hidden tab) — the card must never stay stuck mid-air with the button locked
  const landed = (a: Animation, ms: number, fn: () => void) => {
    let done = false;
    const run = () => { if (done || disposed) return; done = true; fn(); };
    a.finished.then(run, run);
    window.setTimeout(run, ms + 150);
  };
  const rectFrames = (a: DOMRect, b: DOMRect) => [
    { top: `${a.top}px`, left: `${a.left}px`, width: `${a.width}px`, height: `${a.height}px` },
    { top: `${b.top}px`, left: `${b.left}px`, width: `${b.width}px`, height: `${b.height}px` },
  ];
  const fullLabels = () => root.querySelectorAll<HTMLElement>('[data-full]').forEach((b) => {
    const l = tNow(full ? 'Exit full view' : 'Full view');
    b.setAttribute('aria-pressed', String(full)); b.title = l;
    if (b.classList.contains('fullbtn')) b.innerHTML = `${htmlIcon(full ? 'collapse' : 'expand', 14)}<span>${l}</span>`;
    else { b.setAttribute('aria-label', l); b.innerHTML = htmlIcon(full ? 'collapse' : 'expand', 14); }
  });
  const leaveFull = () => {
    full = false;
    canvasEl.classList.remove('full');
    document.documentElement.classList.remove('cc-lock');
    holder?.remove(); back?.remove(); holder = back = null;
  };
  const setFull = (on: boolean) => {
    if (on === full || flight) return;
    const ms = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : on ? 480 : 380;
    const ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    // a page-enter animation still running on a parent (a transform) would trap the fixed card inside it
    if (on) for (let e = canvasEl.parentElement; e; e = e.parentElement) e.getAnimations().forEach((x) => x.finish());
    const from = canvasEl.getBoundingClientRect();
    if (on) {
      // a stand-in keeps the card's place so the page does not jump under it
      holder = document.createElement('div');
      holder.className = 'ccholder';
      holder.style.height = `${from.height}px`;
      back = document.createElement('div');
      back.className = 'ccfullback';
      canvasEl.before(holder, back);
      full = true;
      canvasEl.classList.add('full');
      document.documentElement.classList.add('cc-lock');
      fullLabels();
      const to = canvasEl.getBoundingClientRect();
      back.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
      const a = canvasEl.animate(rectFrames(from, to), { duration: ms, easing: ease });
      flight = a;
      landed(a, ms, () => { flight = null; fit(); });
      (root.querySelector('.fullbtn') as HTMLElement | null)?.focus({ preventScroll: true });
    } else {
      const to = holder ? holder.getBoundingClientRect() : from;
      back?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: 'ease-in', fill: 'forwards' });
      const a = canvasEl.animate(rectFrames(from, to), { duration: ms, easing: ease, fill: 'forwards' });
      flight = a;
      landed(a, ms, () => { leaveFull(); a.cancel(); flight = null; fullLabels(); fit(); });
    }
  };

  // refit on width changes only (fit() itself sets the viewport height); in full view on any change
  const ro = new ResizeObserver(() => { if (full || vp.clientWidth !== lastW) fit(); });
  ro.observe(vp);

  // ---------- highlighting ----------
  const worstOf = (oids: string[]): Status =>
    oids.map((o) => idx[o]?.it?.st).filter((s): s is Status => !!s).sort((a, b) => SEV.indexOf(a) - SEV.indexOf(b))[0] ?? 'NOT_APPLICABLE';
  // A set of obligation node ids → light up every edge on their paths (in the
  // obligation's status colour) and every node those edges touch.
  const lightUp = (oblIds: Set<string> | null) => {
    const box = $('svg');
    const live = new Set<string>(['REG']);
    box.querySelectorAll<SVGPathElement>('.edge').forEach((e) => {
      const hits = oblIds ? e.dataset.o!.split('|').filter((o) => oblIds.has(o)) : [];
      const on = hits.length > 0;
      e.classList.toggle('hot', on);
      e.classList.toggle('dim', !!oblIds && !on);
      if (on) {
        live.add(e.dataset.a!); live.add(e.dataset.b!);
        const s = worstOf(hits);
        e.style.stroke = ST[s][2];
        e.setAttribute('marker-end', `url(#ar-${STMK[s]})`);
      } else {
        // at rest lines carry no arrow: the columns already read left to right
        e.style.removeProperty('stroke');
        e.removeAttribute('marker-end');
      }
    });
    box.querySelectorAll<SVGGElement>('.node').forEach((n) => {
      const id = n.dataset.id!;
      n.classList.toggle('dim', !!oblIds && !live.has(id));
      n.classList.toggle('hot', !!oblIds && live.has(id) && id !== 'REG');
      n.classList.toggle('sel', state.sel === id);
    });
    $('svg').classList.toggle('focusing', !!oblIds);
  };
  // the obligations whose paths run through a node
  const pathsThrough = (id: string) => {
    if (id.startsWith('O:')) return new Set([id]);
    const s = new Set<string>();
    $('svg').querySelectorAll<SVGPathElement>('.edge').forEach((e) => {
      if (e.dataset.a === id || e.dataset.b === id) e.dataset.o!.split('|').forEach((o) => s.add(o));
    });
    return s;
  };
  /** the selected box's paths stay lit; the regulation box lights nothing (it is on every path) */
  const pinned = (): Set<string> | null => {
    const s = state.sel;
    if (!s || s === 'REG' || !idx[s]) return null;
    return s.startsWith('O:') ? new Set([s]) : pathsThrough(s);
  };
  const highlight = () => lightUp(pinned());
  const ripple = () => { const s = $('svg').querySelector('svg'); if (!s) return; s.classList.remove('ripple'); void s.getBoundingClientRect(); s.classList.add('ripple'); };

  // ---------- selection ----------
  const syncRows = () => root.querySelectorAll('tr[data-c]').forEach((tr) => tr.classList.toggle('selrow', 'O:' + (tr as HTMLElement).dataset.c === state.sel));
  const select = (id: string | null) => { state.sel = id; highlight(); syncRows(); };
  const findItem = (code: string) => shown.find((x) => x.c === code) ?? everything.find((x) => x.c === code);
  const showObl = (code: string) => { const x = findItem(code); if (!x) return; select('O:' + code); openObl(x); };
  const nodeIdOf = (code: string) => (docs[code]?.k === 'Policy' ? 'P:' + code : docs[code]?.k === 'Control' ? 'C:' + code : risks[code] ? 'R:' + code : '');
  /** a click (or Enter) on any box: select it and open its details */
  const onNode = (id: string) => {
    if (id === 'REG') { select('REG'); if (opts.onRegulation) opts.onRegulation('info'); else openReg(); return; }
    if (id.startsWith('O:')) { if (state.sel === id) closePanel(); else showObl(id.slice(2)); return; }
    select(id);
    const code = /^[PCR]:(?!none|gap)/.test(id) ? id.slice(2) : '';
    if (code) openDoc(code);
    else if (id.startsWith('W:')) openOwner(id.slice(2));
    else openMissing(id);
  };

  // ---------- treatment plan ----------
  // "Who does it" lists every owner and drifts upward on its own, in a loop: a
  // second copy of the list sits under the first so the loop has no seam. It
  // stops while the pointer is over it or a finger is on it, so it can be read
  // and scrolled by hand, and carries on from wherever it was left.
  let mqPos = 0, mqLast = 0, mqRaf = 0;
  const mqStill = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mqTick = (now: number) => {
    mqRaf = requestAnimationFrame(mqTick);
    const dt = mqLast ? Math.min(64, now - mqLast) : 16;
    mqLast = now;
    const box = root.querySelector<HTMLElement>('[data-r="owners"]');
    const copy = box?.querySelector<HTMLElement>('.mq-copy');
    if (!box || !copy) return;
    const r = box.getBoundingClientRect();
    const held = mqStill.matches || box.matches(':hover') || box.dataset.held === '1' || r.bottom < 0 || r.top > window.innerHeight;
    if (Math.abs(box.scrollTop - Math.round(mqPos)) > 2) mqPos = box.scrollTop;   // scrolled by hand
    if (held) return;
    const loop = copy.offsetTop - box.querySelector<HTMLElement>('table')!.offsetTop;
    mqPos += dt * 0.024;                                                            // about 24px a second
    if (mqPos >= loop) mqPos -= loop;
    box.scrollTop = mqPos;
  };
  const mqHold = (ev: PointerEvent) => {
    const box = (ev.target as Element).closest?.('[data-r="owners"]') as HTMLElement | null;
    if (box && ev.pointerType !== 'mouse') box.dataset.held = ev.type === 'pointerdown' ? '1' : '';
  };
  const dossier = () => {
    const unmet = shown.filter(unmetOf);
    const res = new Map(unmet.map((x) => [x.c, resolve(x)]));
    const noPol = unmet.filter((x) => !res.get(x.c)!.pols.length);
    const noCtl = unmet.filter((x) => !res.get(x.c)!.ctrls.length);
    const partial = unmet.filter((x) => x.st === 'PARTIAL' && (x.by ?? []).length);
    const byOwner: Record<string, Scoped[]> = {};
    unmet.forEach((x) => { const own = ownerFor(x, res.get(x.c)).name || 'Unassigned'; (byOwner[own] ??= []).push(x); });
    const sevs = (xs: Scoped[]) => (['Critical', 'High', 'Medium', 'Low'] as Risk[]).map((k) => [k, xs.filter((x) => x.rk === k).length] as const)
      .filter(([, n]) => n).map(([k, n]) => tNow(RISK_N_LC[k], { n: n.toLocaleString() })).join(', ');
    // The plan is a count of work, not a list of obligations: each obligation
    // appears once, in the summary table, with the actions it needs as tags.
    // [action, count, why, icon] — English, as the copied plan uses it; translated where drawn
    const steps: [string, number, string, string][] = [
      [tx('Write or extend a policy'), noPol.length, tx('no policy on file covers it'), 'filetext'],
      [tx('Design a control'), noCtl.length, tx('nothing operates or tests it'), 'shieldcheck'],
      [tx('Collect missing evidence'), partial.length, tx('a document exists but part is not shown'), 'listchecks'],
    ].filter(([, n]) => n) as [string, number, string, string][];
    const owners = Object.entries(byOwner).sort((a, b) => b[1].length - a[1].length);
    const sevTags = (['Critical', 'High', 'Medium', 'Low'] as Risk[]).map((k) => [k, unmet.filter((x) => x.rk === k).length] as const)
      .filter(([, c]) => c).map(([k, c]) => `<span class="tag ${RK[k]}">${tNow(RISK_N[k], { n: c.toLocaleString() })}</span>`).join('');
    const inView = !unmet.length ? tNow('{n} unmet obligations in this view.', { n: 0 })
      : unmet.length === 1 ? tNow('1 unmet obligation in this view ({sev}).', { sev: sevs(unmet) })
        : tNow('{n} unmet obligations in this view ({sev}).', { n: unmet.length.toLocaleString(), sev: sevs(unmet) });
    // the unmet obligations by priority, as one bar under the tags
    const sevBar = unmet.length ? `<div class="sevbar" aria-hidden="true">${(['Critical', 'High', 'Medium', 'Low'] as Risk[]).map((k, i) => {
      const c = unmet.filter((x) => x.rk === k).length;
      return c ? `<i style="width:${(c / unmet.length) * 100}%;background:${RCOL[k]};--d:${i * 90}ms"></i>` : '';
    }).join('')}</div>` : '';
    let html = `<div class="head"><h3>${tNow('Action plan')}</h3><div class="by">${inView} ${tNow('Click any box in the diagram, or any row below, for its details.')}</div>${sevTags ? `<div class="sevtags">${sevTags}</div>` : ''}${sevBar}</div>`;
    html += steps.length
      ? `<div class="step"><h4>${tNow('Work to do')}</h4><table class="worktable">${steps.map(([h, n, why, ic]) =>
          `<tr><td class="wn"><span class="stepic">${htmlIcon(ic)}</span></td><td><b>${tNow(h)}</b><div class="sub">${tNow(why)}</div><span class="wbar"><i style="width:${unmet.length ? Math.max(3, (n / unmet.length) * 100) : 0}%"></i></span></td><td class="wc">${n}</td></tr>`).join('')}</table></div>`
      : `<div class="step"><h4>${tNow('Nothing to treat')}</h4><p>${tNow("Every obligation in this view is covered by the hospital's documents.")}</p></div>`;
    const topOwner = Math.max(1, ...owners.map(([, xs]) => xs.length));
    if (owners.length) html += `<div class="step owners" data-r="owners"><h4>${tNow('Who does it')} <span class="sub">${tNow('(suggested)')}</span></h4><table class="worktable">${owners.map(([o, xs]) =>
      `<tr><td><span class="ownrow"><span class="ownic${o === 'Unassigned' ? ' none' : ''}">${htmlIcon('user')}</span><span class="ownname"><b>${esc(o === 'Unassigned' ? tNow('Unassigned') : o)}</b><span class="ownbar"><i style="width:${(100 * xs.length) / topOwner}%"></i></span></span></span></td><td class="wc">${xs.length}</td></tr>`).join('')}</table></div>`;
    $('dossier').innerHTML = chain + html;
    // a longer list than the card shows: add the seamless copy the drift loops on
    const own = root.querySelector<HTMLElement>('[data-r="owners"]');
    if (own && own.scrollHeight > own.clientHeight + 4) {
      const copy = own.querySelector('table')!.cloneNode(true) as HTMLElement;
      copy.classList.add('mq-copy');
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('inert', '');
      own.appendChild(copy);
    }
    mqPos = 0;
  };
  /** The actions one obligation needs, used for the table's tags and the copied plan. */
  const actionsFor = (x: Scoped): [string, string][] => {
    if (!unmetOf(x)) return [];
    const r = resolve(x), out: [string, string][] = [];
    // English, as the copied plan and the export use them; chip() translates them where drawn
    if (!r.pols.length) out.push([tx('Write policy'), 'a-pol']);
    if (!r.ctrls.length) out.push([tx('Design control'), 'a-ctl']);
    // evidence: where part of a document is not shown, and for every gap / uncovered duty
    if ((x.st === 'PARTIAL' && (x.by ?? []).length) || x.st === 'GAP' || x.st === 'NOT_COVERED') out.push([tx('Collect evidence'), 'a-ev']);
    if (!ownerFor(x, r).name) out.push([tx('Assign owner'), 'a-own']);
    return out;
  };

  // ---------- summary table ----------
  // One page at a time (10 rows unless the reader picks more): a whole
  // regulation is hundreds of obligations. Each row is the requirement with
  // its gap underneath, its status and priority, who answers for it, and how
  // many controls and documents back it; the row opens the full detail.
  // render() (scope, filters) starts again from page 1.
  const PAGE_SIZES = [10, 20, 50, 100];
  let page = 1, pageSize = 10;
  /** "Head – Nursing Services" → "HN" */
  const initials = (n: string) => n.split(/[^\p{L}]+/u).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  const AV = [['#E8F1FE', '#0062C4'], ['#E9F8EE', '#1A7434'], ['#F3EEFF', '#6D28D9'], ['#FFF4E5', '#9A5200'], ['#FDECF4', '#B0185E'], ['#E6F6F8', '#0E7490']];
  const avatar = (n: string) => { let h = 0; for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return AV[h % AV.length]; };
  /** 1 … 4 5 6 … 59 */
  const pageList = (n: number, cur: number) => {
    const out: (number | 0)[] = []; let prev = 0;
    [...new Set([1, n, cur - 1, cur, cur + 1])].filter((p) => p >= 1 && p <= n).sort((a, b) => a - b)
      .forEach((p) => { if (p - prev > 1) out.push(0); out.push(p); prev = p; });
    return out;
  };
  const counted = (codes: string[], icon: string) => codes.length
    ? `<span class="tlinks" title="${esc(codes.join(', '))}">${htmlIcon(icon, 14)}${codes.length.toLocaleString()}</span>`
    : '<span class="sub">—</span>';
  const table = () => {
    const pages = Math.max(1, Math.ceil(shown.length / pageSize));
    page = Math.min(Math.max(1, page), pages);
    const from = shown.length ? (page - 1) * pageSize + 1 : 0, to = Math.min(page * pageSize, shown.length);
    $('tcount').textContent = tNow('{n} obligations', { n: shown.length.toLocaleString() });
    $('tmore').innerHTML = shown.length ? `
      <span class="sub">${tNow('Showing {from}–{to} of {total}', { from: from.toLocaleString(), to: to.toLocaleString(), total: shown.length.toLocaleString() })}</span>
      <div class="tfright">
        <nav class="pager" aria-label="${esc(tNow('Pages'))}">
          <button type="button" class="pg" data-page="${page - 1}" aria-label="${esc(tNow('Previous page'))}"${page <= 1 ? ' disabled' : ''}>${htmlIcon('chevl', 15)}</button>
          ${pageList(pages, page).map((p) => p ? `<button type="button" class="pg${p === page ? ' on' : ''}" data-page="${p}" aria-label="${esc(tNow('Page {n}', { n: p }))}"${p === page ? ' aria-current="page"' : ''}>${p.toLocaleString()}</button>` : '<span class="pgdots" aria-hidden="true">…</span>').join('')}
          <button type="button" class="pg" data-page="${page + 1}" aria-label="${esc(tNow('Next page'))}"${page >= pages ? ' disabled' : ''}>${htmlIcon('chev', 15)}</button>
        </nav>
        <select class="psize" data-r="psize" aria-label="${esc(tNow('Rows per page'))}">${PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${tNow('{n} per page', { n })}</option>`).join('')}</select>
      </div>` : '';
    $('rows').innerHTML = shown.slice(Math.max(0, from - 1), to).map((x, i) => {
      const st = ST[x.st], r = resolve(x), own = ownerFor(x, r);
      const acts = actionsFor(x).map(([l, c]) => chip(x, l, c)).join('') + reqBtn(x);
      const sub = x.gap ? cut(x.gap, 160) : x.fix ? `${tNow('Fix')}: ${cut(x.fix, 140)}` : '';
      const [abg, afg] = avatar(own.name);
      return `<tr data-c="${esc(x.c)}" class="${state.sel === 'O:' + x.c ? 'selrow' : ''}" style="--st:${st[2]};--stsoft:${st[3]}">
        <td class="tn">${(from + i).toLocaleString()}</td>
        <td><div class="treq"><span class="tico">${htmlIcon(x.st === 'MET' ? 'shieldcheck' : 'shieldalert', 15)}</span>
          <div class="ttext"><div class="ttitle" title="${esc(x.t)}"><span class="tcode">${esc(x.c)}</span>${esc(x.t)}</div>
          ${sub ? `<div class="tsub" title="${esc(x.gap || x.fix || '')}">${esc(sub)}</div>` : ''}
          ${acts ? `<div class="acts tacts">${acts}</div>` : ''}</div></div></td>
        <td><span class="tag ${st[1]}" title="${esc(tNow(MEANING[x.st]))}">${tNow(st[0])}</span></td>
        <td>${x.rk && x.rk !== 'None' ? `<span class="tag ${RK[x.rk]}">${tNow(x.rk)}</span>` : '<span class="sub">—</span>'}</td>
        <td>${own.name
          ? `<span class="towner"><span class="tav" style="background:${abg};color:${afg}" aria-hidden="true">${esc(initials(own.name))}</span><span class="townt"><b title="${esc(own.name)}">${esc(own.name)}</b><span class="sub">${esc(own.viaText)}</span></span></span>`
          : `<span class="sub">${tNow('Unassigned')}</span>`}</td>
        <td class="tnum">${counted(r.ctrls, 'shieldcheck')}</td>
        <td class="tnum">${counted([...new Set(x.by ?? [])], 'filetext')}</td>
        <td class="tgo">${htmlIcon('chev', 16)}</td></tr>`;
    }).join('') || `<tr><td colspan="8" class="tempty">${tNow('Nothing matches these filters.')}</td></tr>`;
  };

  // ---------- events (delegated, so re-renders need no re-binding) ----------
  const onClick = (ev: MouseEvent) => {
    const target = ev.target as Element;
    if (target.closest('[data-r="changereg"]') && opts.onRegulation) { opts.onRegulation('change'); return; }
    if (target.closest('[data-full]')) { setFull(!full); return; }
    const g = target.closest('.node') as SVGGElement | null;
    if (g) { onNode(g.dataset.id!); return; }
    // auditor view: ask the hospital for this duty's documents (before the row click below)
    const rbtn = target.closest('[data-reqdoc]') as HTMLElement | null;
    if (rbtn) {
      ev.stopPropagation();
      const x = findItem(rbtn.dataset.reqdoc!);
      if (x && opts.onRequestDocs) opts.onRequestDocs({ regId: reg.id, code: x.c, title: x.ob || x.t, codes: [...new Set(x.by ?? [])] });
      return;
    }
    // a remediation chip: open the page's drafting drawer (before the row click below)
    const dchip = target.closest('[data-draft]') as HTMLElement | null;
    if (dchip) {
      ev.stopPropagation();
      const x = findItem(dchip.dataset.code!);
      if (!x?.rid || !opts.onDraft) return;
      if (isOpen()) closePanel();
      opts.onDraft({ rid: x.rid, code: x.c, kind: dchip.dataset.draft as DraftKind, regId: reg.id,
        item: { t: x.t, gap: x.gap, fix: x.fix, why: x.why, st: x.st, rk: x.rk, ob: x.ob } });
      return;
    }
    // the summary table's pages
    const pg = target.closest('[data-page]') as HTMLButtonElement | null;
    if (pg) {
      if (!pg.disabled) { page = +pg.dataset.page!; table(); $('rows').closest('.tcard')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      return;
    }
    if (target.closest('[data-r="dr-close"], [data-r="drback"]')) { closePanel(); return; }
    const unitBtn = target.closest('[data-unit]') as HTMLElement | null;
    if (unitBtn) {
      state.scope = 'u:' + unitBtn.dataset.unit; scopeSel.value = state.scope; closePanel(); render();
      root.querySelector('.canvas')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    const oblBtn = target.closest('[data-oblfocus]') as HTMLElement | null;
    if (oblBtn) { showObl(oblBtn.dataset.oblfocus!); return; }
    const doc = target.closest('[data-doc]') as HTMLElement | null;
    if (doc) {
      const code = doc.dataset.doc!;
      const nid = nodeIdOf(code);
      if (nid && idx[nid]) select(nid);
      openDoc(code); return;
    }
    const copy = target.closest('[data-copy]') as HTMLElement | null;
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy!).then(() => toast(tNow('Path copied')), () => toast(tNow('Copy was blocked — select the path text instead')));
      return;
    }
    const nav = target.closest('[data-nav]') as HTMLElement | null;
    if (nav) { go(nav.dataset.nav!); return; }
    const sc = target.closest('[data-searchcode]') as HTMLElement | null;
    if (sc) {
      state.q = sc.dataset.searchcode!; state.st = new Set(['GAP', 'PARTIAL', 'NOT_COVERED', 'MET']); render();
      root.querySelector('.canvas')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
    }
    const stChip = target.closest('[data-st]') as HTMLElement | null;
    if (stChip) { const s = stChip.dataset.st as Status; if (state.st.has(s)) state.st.delete(s); else state.st.add(s); render(); return; }
    const rkChip = target.closest('[data-rk]') as HTMLElement | null;
    if (rkChip) { const k = rkChip.dataset.rk as Risk; if (state.rk.has(k)) state.rk.delete(k); else state.rk.add(k); render(); return; }
    if (target.closest('[data-r="qclear"]')) { state.q = ''; render(); return; }
    if (target.closest('[data-r="clear"]')) {
      state.q = ''; state.st = new Set(DEFAULT_ST); state.rk = new Set();
      state.scope = 'top'; scopeSel.value = 'top'; render(); return;
    }
    const row = target.closest('tr[data-c]') as HTMLElement | null;
    if (row) {
      showObl(row.dataset.c!);
      root.querySelector('.canvas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };
  // hover previews the paths through any box; leaving restores the pinned selection
  const onOver = (ev: MouseEvent) => {
    const n = (ev.target as Element).closest('.node') as SVGGElement | null;
    if (!n || n.dataset.id === 'REG') return;
    lightUp(pathsThrough(n.dataset.id!));
  };
  const onOut = (ev: MouseEvent) => {
    const n = (ev.target as Element).closest('.node');
    const to = (ev.relatedTarget as Element | null)?.closest?.('.node');
    if (n && n !== to) highlight();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { if (isOpen()) closePanel(); else if (full) setFull(false); return; }
    if (isOpen()) { trapTab($('drawer'), ev); return; }
    const g = (ev.target as Element).closest?.('.node') as SVGGElement | null;
    if (g && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); onNode(g.dataset.id!); }
  };
  // the page's KPI cards set the status / risk chips through this event
  const onFilter = (ev: Event) => {
    const d = (ev as CustomEvent<{ st?: Status[]; rk?: Risk[] }>).detail ?? {};
    state.st = new Set(d.st ?? DEFAULT_ST); state.rk = new Set(d.rk ?? []); render();
  };
  // the page pushes the drafts for this regulation and the local model's status
  const onDrafts = (ev: Event) => {
    const d = (ev as CustomEvent<{ drafts?: DraftSummary[]; llm?: LlmStatus | null }>).detail ?? {};
    drafts = latestDrafts(d.drafts ?? []);
    llm = d.llm ?? null;
    table();
    const box = root.querySelector('[data-r="oblacts"]') as HTMLElement | null;
    if (box && panelObl) { box.innerHTML = oblActsBody(panelObl); box.hidden = !box.innerHTML; }
  };
  // auditor view: the page pushes which obligations' documents were already asked for
  const onRequests = (ev: Event) => {
    requested = new Set((ev as CustomEvent<{ codes?: string[] }>).detail?.codes ?? []);
    table();
    const box = root.querySelector('[data-r="reqbox"]');
    if (box && panelObl) box.innerHTML = reqBtn(panelObl, true);
  };
  const onScope = () => { state.scope = scopeSel.value; render(); };
  const onChange = (ev: Event) => {
    const el = ev.target as HTMLSelectElement;
    if (el.matches('[data-r="psize"]')) { pageSize = +el.value; page = 1; table(); }
  };
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('pointerdown', mqHold);
  root.addEventListener('pointerup', mqHold);
  root.addEventListener('pointercancel', mqHold);
  mqRaf = requestAnimationFrame(mqTick);
  root.addEventListener('cc:filter', onFilter);
  root.addEventListener('cc:drafts', onDrafts);
  root.addEventListener('cc:requests', onRequests);
  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  document.addEventListener('keydown', onKey);
  scopeSel.addEventListener('change', onScope);
  render();

  return () => {
    disposed = true;
    flight?.cancel();
    if (full) leaveFull();
    ro.disconnect();
    vp.removeEventListener('wheel', onWheel);
    vp.removeEventListener('pointerdown', onDown);
    vp.removeEventListener('pointermove', onMove);
    vp.removeEventListener('pointerup', onUp);
    vp.removeEventListener('pointercancel', onUp);
    ztools.removeEventListener('click', onZoomBtn);
    mmap.removeEventListener('pointerdown', onMini);
    mmap.removeEventListener('pointermove', onMini);
    root.removeEventListener('click', onClick);
    root.removeEventListener('change', onChange);
    root.removeEventListener('pointerdown', mqHold);
    root.removeEventListener('pointerup', mqHold);
    root.removeEventListener('pointercancel', mqHold);
    cancelAnimationFrame(mqRaf);
    root.removeEventListener('cc:filter', onFilter);
    root.removeEventListener('cc:drafts', onDrafts);
    root.removeEventListener('cc:requests', onRequests);
    root.removeEventListener('mouseover', onOver);
    root.removeEventListener('mouseout', onOut);
    document.removeEventListener('keydown', onKey);
    scopeSel.removeEventListener('change', onScope);
    root.innerHTML = '';
  };
}
