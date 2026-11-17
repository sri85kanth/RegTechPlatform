"""
Render the NABH 6th Edition gap assessment as a single HTML page (data inlined).

    python nabh6_report.py <hosp6.json> <hosp6_gap.json> <out.html>
"""
from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

TEMPLATE = r"""<title>NABH 6th Edition Gap Register</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: assessor's register — summary strip, chapter coverage, then the filterable element list */
:root{
  --bg:#f5f7f8; --panel:#ffffff; --ink:#18242b; --muted:#5b6b74; --line:#dde4e8; --accent:#0e6b74;
  --met:#1f7a4d; --met-bg:#e3f2ea; --partial:#a36a00; --partial-bg:#fbf0d9; --gap:#c0392b; --gap-bg:#f9e3e0;
  --nc:#6a4bb0; --nc-bg:#ece6f7; --crit:#b3261e; --high:#d1560e; --med:#b88400; --low:#4a6b85; --none:#7d8b93;
  --display:"IBM Plex Sans Condensed","Arial Narrow",system-ui,sans-serif;
  --body:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,"SFMono-Regular",Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0f1619; --panel:#162126; --ink:#e3eaee; --muted:#93a4ad; --line:#26353c; --accent:#4fb3bc;
  --met:#5cc28f; --met-bg:#173226; --partial:#e2a83a; --partial-bg:#33280f; --gap:#ef7b6e; --gap-bg:#3a1c19;
  --nc:#a98ce8; --nc-bg:#261e3a; --crit:#ff7a70; --high:#ff9a57; --med:#e8bd45; --low:#8fb2cf; --none:#8a989f; color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0f1619; --panel:#162126; --ink:#e3eaee; --muted:#93a4ad; --line:#26353c; --accent:#4fb3bc;
  --met:#5cc28f; --met-bg:#173226; --partial:#e2a83a; --partial-bg:#33280f; --gap:#ef7b6e; --gap-bg:#3a1c19;
  --nc:#a98ce8; --nc-bg:#261e3a; --crit:#ff7a70; --high:#ff9a57; --med:#e8bd45; --low:#8fb2cf; --none:#8a989f; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--bg);color:var(--ink);font:15px/1.5 var(--body);margin:0}
.wrap{max-width:1180px;margin:0 auto;padding-inline:20px;padding-block:28px 64px;display:grid;gap:28px}
h1,h2{font-family:var(--display);text-wrap:balance;margin:0;letter-spacing:.005em}
h1{font-size:clamp(26px,4vw,36px);font-weight:700}
h2{font-size:20px;font-weight:600}
.eyebrow{font:500 12px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
.lede{color:var(--muted);max-width:72ch;margin:6px 0 0}
header{display:grid;gap:8px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:13px}
.meta b{color:var(--ink);font-weight:600}
.strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.kpi{background:var(--panel);padding:14px 16px;display:grid;gap:2px;min-width:0}
.kpi .n{font:600 28px/1.1 var(--display);font-variant-numeric:tabular-nums}
.kpi .l{font-size:12px;color:var(--muted);letter-spacing:.03em}
.kpi.met .n{color:var(--met)} .kpi.partial .n{color:var(--partial)} .kpi.gap .n{color:var(--gap)} .kpi.nc .n{color:var(--nc)}
.kpi.crit .n{color:var(--crit)} .kpi.high .n{color:var(--high)}
section{display:grid;gap:12px}
.note{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;color:var(--muted);font-size:14px;display:grid;gap:6px}
.note b{color:var(--ink)}
.chapters{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:10px}
table{border-collapse:collapse;width:100%}
.chapters th,.chapters td{padding:9px 14px;text-align:left;border-bottom:1px solid var(--line);font-size:13.5px;white-space:nowrap}
.chapters tr:last-child td{border-bottom:0}
.chapters th{font:500 11.5px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.num{font-variant-numeric:tabular-nums;text-align:right!important}
.bar{display:flex;height:10px;border-radius:5px;overflow:hidden;min-width:200px;background:var(--line)}
.bar i{display:block;height:100%}
.bar .met{background:var(--met)} .bar .partial{background:var(--partial)} .bar .gap{background:var(--gap)} .bar .nc{background:var(--nc)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px;color:var(--muted)}
.legend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px;background:var(--c)}
.chname{font-weight:500}
.chname small{color:var(--muted);font:400 12px var(--mono);margin-right:6px}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;position:sticky;top:env(safe-area-inset-top,0px);z-index:2;background:var(--bg);padding-block:10px;border-bottom:1px solid var(--line)}
.filters select,.filters input{font:inherit;font-size:14px;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:7px 10px;min-width:0}
.filters input{flex:1 1 220px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font:500 12.5px/1 var(--body);border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:999px;padding:7px 11px;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chip:focus-visible,.row summary:focus-visible,select:focus-visible,input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.count{font-size:13px;color:var(--muted);margin-left:auto}
.list{display:grid;gap:8px}
.row{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--sev);border-radius:8px}
.row summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:92px 1fr auto;gap:6px 14px;padding:11px 14px;align-items:start}
.row summary::-webkit-details-marker{display:none}
.code{font:500 13px var(--mono);color:var(--ink)}
.cat{display:block;font:500 10.5px/1.6 var(--mono);letter-spacing:.06em;color:var(--muted)}
.cat.core{color:var(--crit);font-weight:600}
.text{min-width:0}
.text .nabh{margin:0}
.text .gapline{margin:4px 0 0;color:var(--muted);font-size:13.5px}
.tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.st,.rk{font:600 11px/1 var(--mono);letter-spacing:.05em;padding:5px 8px;border-radius:5px;white-space:nowrap}
.st.MET{background:var(--met-bg);color:var(--met)} .st.PARTIAL{background:var(--partial-bg);color:var(--partial)}
.st.GAP{background:var(--gap-bg);color:var(--gap)} .st.NOT_COVERED{background:var(--nc-bg);color:var(--nc)}
.rk{border:1px solid currentColor;background:transparent}
.rk.Critical{color:var(--crit)} .rk.High{color:var(--high)} .rk.Medium{color:var(--med)} .rk.Low{color:var(--low)} .rk.None{color:var(--none)}
.detail{padding:4px 14px 16px 120px;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.detail div{min-width:0}
.detail h4{margin:0 0 3px;font:500 11px/1.2 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.detail p{margin:0;font-size:14px}
.docs{font-family:var(--mono);font-size:13px}
.empty{padding:30px;text-align:center;color:var(--muted);background:var(--panel);border:1px dashed var(--line);border-radius:10px}
@media (max-width:640px){
  .row summary{grid-template-columns:1fr;}
  .tags{justify-content:flex-start}
  .detail{padding-left:14px}
}
@media (prefers-reduced-motion:no-preference){.row{transition:border-color .15s}}
</style>

<div class="wrap">
  <header>
    <div class="eyebrow">Document-based gap assessment</div>
    <h1>NABH Accreditation Standards for Hospitals, 6th Edition</h1>
    <p class="lede" id="lede"></p>
    <div class="meta" id="meta"></div>
  </header>

  <div class="strip" id="strip"></div>

  <div class="note" id="method"></div>

  <section>
    <h2>Coverage by chapter</h2>
    <div class="legend">
      <span style="--c:var(--met)">Met</span><span style="--c:var(--partial)">Partial</span>
      <span style="--c:var(--gap)">Gap</span><span style="--c:var(--nc)">Not covered by any document</span>
    </div>
    <div class="chapters"><table id="chapters"></table></div>
  </section>

  <section>
    <h2>Objective elements</h2>
    <div class="filters">
      <select id="f-chapter" aria-label="Chapter"></select>
      <div class="chips" id="f-status" role="group" aria-label="Status"></div>
      <div class="chips" id="f-risk" role="group" aria-label="Risk"></div>
      <input id="f-q" type="search" placeholder="Search code, text, document (e.g. HR-SOP-11)" aria-label="Search">
      <span class="count" id="count"></span>
    </div>
    <div class="list" id="list"></div>
  </section>
</div>

<script>
const DATA = __DATA__;
const STATUS = [["MET","Met"],["PARTIAL","Partial"],["GAP","Gap"],["NOT_COVERED","Not covered"]];
const RISKS = ["Critical","High","Medium","Low"];
const SEV = {Critical:"var(--crit)",High:"var(--high)",Medium:"var(--med)",Low:"var(--low)",None:"var(--met)"};
const els = DATA.elements;
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const cnt = (arr, f) => arr.filter(f).length;

document.getElementById("lede").textContent =
  `${DATA.company}: each of the ${DATA.total} objective elements has been checked against the hospital's own policies, SOPs, forms and control register. Status is decided by reading the matching provisions, not by keyword overlap. Risk follows the NABH category of the element.`;
document.getElementById("meta").innerHTML =
  `<span>Assessed <b>${DATA.assessed}</b> of <b>${DATA.total}</b> elements (${DATA.stdAssessed}/100 standards)</span>` +
  `<span>Documents: <b>${esc(DATA.docs)}</b></span><span>Run: <b>${esc(DATA.date)}</b></span>`;

const unmet = e => e.status !== "MET";
const k = [
  ["", DATA.assessed, "elements assessed"],
  ["met", cnt(els, e => e.status==="MET"), "met"],
  ["partial", cnt(els, e => e.status==="PARTIAL"), "partial"],
  ["gap", cnt(els, e => e.status==="GAP"), "gap in a documented area"],
  ["nc", cnt(els, e => e.status==="NOT_COVERED"), "no document covers it"],
  ["crit", cnt(els, e => e.risk==="Critical"), "critical risks (unmet CORE)"],
  ["high", cnt(els, e => e.risk==="High"), "high risks"],
];
document.getElementById("strip").innerHTML = k.map(([c,n,l]) => `<div class="kpi ${c}"><span class="n">${n}</span><span class="l">${l}</span></div>`).join("");

document.getElementById("method").innerHTML =
  `<div><b>How to read this.</b> <b>Met</b>: a provision, procedure step, control or form satisfies the element. <b>Partial</b>: something relevant exists but a stated part is missing. <b>Gap</b>: the area is documented but this requirement is not addressed. <b>Not covered</b>: the element sits in an area for which no document was supplied (${esc(DATA.notSupplied)}).</div>` +
  `<div><b>Risk rule.</b> An unmet CORE element is Critical, since CORE non-compliance blocks accreditation. Unmet Commitment is High, Achievement Medium, Excellence Low. Partial is one band lower. Every verdict is marked for human review in the app.</div>`;

// chapter table
const chapters = DATA.chapters;
document.getElementById("chapters").innerHTML =
  `<thead><tr><th>Chapter</th><th>Coverage</th><th class="num">Met</th><th class="num">Partial</th><th class="num">Gap</th><th class="num">Not covered</th><th class="num">Critical</th></tr></thead><tbody>` +
  chapters.map(ch => {
    const xs = els.filter(e => e.chapter === ch.code);
    const n = xs.length || 1;
    const c = s => cnt(xs, e => e.status === s);
    const seg = (cls, v) => v ? `<i class="${cls}" style="width:${(100*v/n).toFixed(1)}%"></i>` : "";
    return `<tr><td class="chname"><small>${ch.code}</small>${esc(ch.name)}</td>
      <td><div class="bar" title="${xs.length} elements assessed">${seg("met",c("MET"))}${seg("partial",c("PARTIAL"))}${seg("gap",c("GAP"))}${seg("nc",c("NOT_COVERED"))}</div></td>
      <td class="num">${c("MET")}</td><td class="num">${c("PARTIAL")}</td><td class="num">${c("GAP")}</td><td class="num">${c("NOT_COVERED")}</td>
      <td class="num" style="color:var(--crit);font-weight:600">${cnt(xs, e => e.risk==="Critical") || ""}</td></tr>`;
  }).join("") + `</tbody>`;

// filters
const state = {chapter:"", status:new Set(["PARTIAL","GAP","NOT_COVERED"]), risk:new Set(), q:""};
try { const s = JSON.parse(localStorage.getItem("nabh6-filters")||"null"); if (s) { state.chapter=s.chapter||""; state.status=new Set(s.status||[]); state.risk=new Set(s.risk||[]); } } catch(e) {}
const save = () => { try { localStorage.setItem("nabh6-filters", JSON.stringify({chapter:state.chapter,status:[...state.status],risk:[...state.risk]})); } catch(e) {} };

const fch = document.getElementById("f-chapter");
fch.innerHTML = `<option value="">All chapters</option>` + chapters.map(c => `<option value="${c.code}">${c.code} · ${esc(c.name)}</option>`).join("");
fch.value = state.chapter;
fch.onchange = () => { state.chapter = fch.value; save(); render(); };

function chips(id, items, set) {
  const box = document.getElementById(id);
  box.innerHTML = items.map(([v,l]) => `<button class="chip" type="button" data-v="${v}" aria-pressed="${set.has(v)}">${l}</button>`).join("");
  box.onclick = ev => {
    const b = ev.target.closest(".chip"); if (!b) return;
    const v = b.dataset.v; set.has(v) ? set.delete(v) : set.add(v);
    b.setAttribute("aria-pressed", set.has(v)); save(); render();
  };
}
chips("f-status", STATUS, state.status);
chips("f-risk", RISKS.map(r => [r, r]), state.risk);
const fq = document.getElementById("f-q");
fq.oninput = () => { state.q = fq.value.trim().toLowerCase(); render(); };

const ORDER = {Critical:0,High:1,Medium:2,Low:3,None:4};
function render() {
  const xs = els.filter(e =>
    (!state.chapter || e.chapter === state.chapter) &&
    (!state.status.size || state.status.has(e.status)) &&
    (!state.risk.size || state.risk.has(e.risk)) &&
    (!state.q || e.search.includes(state.q)));
  xs.sort((a,b) => ORDER[a.risk]-ORDER[b.risk] || a.order-b.order);
  document.getElementById("count").textContent = `${xs.length} of ${els.length} shown`;
  const list = document.getElementById("list");
  if (!xs.length) { list.innerHTML = `<div class="empty">No elements match these filters. Clear a status or risk chip to see more.</div>`; return; }
  list.innerHTML = xs.map(e => `
  <details class="row" style="--sev:${SEV[e.risk]}">
    <summary>
      <div><span class="code">${e.code}</span><span class="cat ${e.category==="CORE"?"core":""}">${e.category}${e.doc?" · DOC":""}</span></div>
      <div class="text"><p class="nabh">${esc(e.text)}</p>${e.gap?`<p class="gapline">${esc(e.gap)}</p>`:""}</div>
      <div class="tags"><span class="st ${e.status}">${e.status.replace("_"," ")}</span><span class="rk ${e.risk}">${e.risk==="None"?"No risk":e.risk}</span></div>
    </summary>
    <div class="detail">
      <div><h4>Obligation</h4><p>${esc(e.obligation)}</p></div>
      <div><h4>Testable requirement</h4><p>${esc(e.requirement)}</p></div>
      <div><h4>Covered by</h4><p class="docs">${e.by.length?esc(e.by.join(", ")):"Nothing in the supplied documents"}</p></div>
      <div><h4>Owner · frequency</h4><p>${esc(e.who||"—")} · ${esc(e.freq||"—")}</p></div>
      ${e.gap?`<div><h4>What is missing</h4><p>${esc(e.gap)}</p></div>`:""}
      ${e.fix?`<div><h4>Recommended action</h4><p>${esc(e.fix)}</p></div>`:""}
      ${e.why && e.status!=="MET"?`<div><h4>If not fixed</h4><p>${esc(e.why)}</p></div>`:""}
      <div><h4>Standard</h4><p>${esc(e.std)}</p></div>
    </div>
  </details>`).join("");
}
render();
</script>
"""


def main() -> None:
    stds = json.loads(Path(sys.argv[1]).read_text())["standards"]
    gaps = json.loads(Path(sys.argv[2]).read_text())
    out = Path(sys.argv[3])
    elements = []
    order = 0
    chapters = []
    for s in stds:
        if s["chapter"] not in [c["code"] for c in chapters]:
            chapters.append({"code": s["chapter"], "name": s["chapter_name"]})
        g = gaps.get(s["code"])
        if not g:
            continue
        for e in g["elements"]:
            order += 1
            elements.append({
                "code": e["code"].rstrip("."), "chapter": s["chapter"], "category": e["category"],
                "doc": e["documentation_required"], "text": e["text"], "status": e["status"], "risk": e["risk"],
                "obligation": e["obligation"], "requirement": e["requirement"], "who": e["responsible"],
                "freq": e["frequency"], "by": e["satisfied_by"], "gap": e["gap"], "fix": e["action"],
                "why": e["consequence"], "std": f"{s['code'].rstrip('.')} {s['statement']}", "order": order,
                "search": " ".join([e["code"], e["text"], e["obligation"], e["requirement"], e["gap"], e["action"],
                                    " ".join(e["satisfied_by"]), e["responsible"]]).lower(),
            })
    data = {
        "company": "Premier Hospitals Pvt. Ltd.",
        "total": sum(len(s["elements"]) for s in stds), "assessed": len(elements),
        "stdAssessed": sum(1 for s in stds if s["code"] in gaps),
        "docs": "HR, Nursing and Biomedical Engineering manuals, forms packs, and risk-control register",
        "notSupplied": "laboratory, imaging, pharmacy, infection control, quality, facility and fire safety, IT and medical records, hospital governance",
        "date": date.today().isoformat(), "chapters": chapters, "elements": elements,
    }
    out.write_text(TEMPLATE.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")),
                   encoding="utf8")
    print(f"wrote {out} · {len(elements)} elements")


if __name__ == "__main__":
    main()
