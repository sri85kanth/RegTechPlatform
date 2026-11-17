# Telugu (te) glossary: Company Brain UI

Core terms fixed before translation and used across all strings in `locales/te.json`.
Register: formal (మీరు). "Us/our" (the user's own company) is rendered inclusively as మన / మనకు.
Kept in Latin script: Company Brain, NABH, SEBI, DPDP, SOP, CSV, PDF, API, AI, OCR, ID, URL, CIN, Excel/Word/Markdown, ₹, Cr, %.

| English | Telugu | Note |
|---|---|---|
| Compliance | నిబంధనల పాటన | Literally "adherence to regulations". సమ్మతి was rejected because in Telugu it means *consent*, which collides with DPDP consent. Built on the Regulation term on purpose. |
| Regulation (instrument) | నిబంధన (pl. నిబంధనలు) | Usual Telugu media and government usage for RBI/SEBI "regulations". "Regulatory" is rendered as the genitive నిబంధనల (e.g. నిబంధనల మార్పులు). |
| Regulator | నియంత్రణ సంస్థ | Fixed compound ("regulatory body"), as in బీమా నియంత్రణ సంస్థ. |
| Rule | నియమం | Generic "rules". |
| Control (internal control) | నియంత్రణ (pl. నియంత్రణలు) | Free for this sense because Regulation uses నిబంధన. Regulator always carries సంస్థ, so the two do not collide. |
| Requirement | ఆవశ్యకత | Formal "requirement". అవసరం (need) is used only in ordinary phrases such as "OCR అవసరం". |
| Obligation | బాధ్యత | Legal obligation. Not used for "responsible" (see below). |
| Duty | విధి (pl. విధులు) | The app uses "duty" alongside "obligation", so it gets a separate word. |
| Evidence | సాక్ష్యం | Legal evidence (cf. Bharatiya Sakshya Adhiniyam). The verb "proves" is రుజువు చేయు. |
| Applicability | వర్తింపు | "Applies" = వర్తిస్తుంది, "Does not apply / Not applicable" = వర్తించదు. |
| Applies to us | మనకు వర్తిస్తుంది | "Apply to us" (count label) = మనకు వర్తించేవి. |
| Conditional / Applies · conditional | షరతులతో / షరతులతో వర్తిస్తుంది | May apply, subject to conditions not yet confirmed. |
| Gap | లోపం (pl. లోపాలు) | A shortfall: a document exists but does not meet the requirement. "Close gaps" = లోపాలను సరిదిద్దండి. |
| Partial | పాక్షికం | |
| Met | నెరవేరింది | "Not met" = నెరవేరలేదు. |
| Documented | పత్రబద్ధం | A document covers the requirement. This is not "implemented". |
| Covered / Not covered | కవర్ అయింది / కవర్ కాలేదు | "Not covered" means no document addresses it. Loanword chosen because the native option పరిధిలో collides with Scope (పరిధి) and would read as "out of scope". |
| Finding (audit) | పరిశీలన (pl. పరిశీలనలు) | As in audit "observations". |
| Owner | యజమాని (ownership = యాజమాన్యం) | Standard software term. Reviewer: if this reads as "proprietor", an alternative is జవాబుదారు. |
| Responsible / Accountable | బాధ్యులు / జవాబుదారీ | Kept apart from Obligation (బాధ్యత). |
| Department | విభాగం | Document "sections" are భాగం so they never collide with departments. |
| Policy | విధానం | "Procedure" is నిర్వహణ పద్ధతి, which avoids the Policy word. |
| SOP | SOP | Kept as is. |
| Auditor | ఆడిటర్ | Loanword, as used in practice. |
| Dashboard | డాష్‌బోర్డ్ | Loanword. |
| Impact / Impact cascade | ప్రభావం / ప్రభావ శ్రేణి | "Cascade" on its own = శ్రేణి. |
| Risk | ముప్పు | Reviewer: రిస్క్ is the common loanword if preferred. |
| Critical / High / Medium / Low | అతి తీవ్రం / అధికం / మధ్యస్థం / తక్కువ | Severity bands. "Critical Functions" (business-critical) = కీలక కార్యాలు, which is a different sense. |
| Verify / Verification | ధృవీకరించండి / ధృవీకరణ | Authentication (sign-in, two-factor) = ప్రామాణీకరణ. |
| Approve | ఆమోదించండి | Approver = ఆమోదకులు. |
| Review | సమీక్ష / సమీక్షించండి | Reviewer = సమీక్షకులు. |
| Confirm | నిర్ధారించండి | |
| Assessment / Assessed | మదింపు / మదింపు చేసినవి | |
| Document / Record | పత్రం / రికార్డు | Kept distinct. |
| Filed (sorted into a department) | దాఖలు అయింది | "Not filed yet" = ఇంకా దాఖలు కాలేదు. |
| Licence / Registration | లైసెన్సు / రిజిస్ట్రేషన్ | |
| Clause / Chapter / Section | ఖండం / అధ్యాయం / భాగం | "provisions" = నిబంధనాంశాలు. |
| Delegation | అధికార బదలాయింపు | |
| Entity (graph record) / Legal entity | ఎంటిటీ / చట్టపరమైన సంస్థ | |
| Open / Closed (status) | తెరిచి ఉంది / మూసివేయబడింది | |
| Undone / Revoked / Withdrawn | వెనక్కి తీసుకోబడింది / రద్దు చేయబడింది / ఉపసంహరించబడింది | Three separate actions, kept distinct. |

## For the reviewer

- **"Effective"** is one key with two meanings: it is a date column ("Effective" date of a regulation or document), and it is also the control-effectiveness status (Effective / Partially effective / Ineffective). It is rendered as అమలులో ("in effect"), a compromise that fits both. Splitting it in code (e.g. "Effective date") would let the effectiveness status read ప్రభావవంతం.
- **"Open"** is translated as a status (తెరిచి ఉంది). It also appears as a screen-reader-only column header for row-open buttons.
- **"Area"** (topic or chapter filter) = విషయం, and **"Domain"** = క్షేత్రం.

## Terms added with the full UI translation

| English | Telugu | Note |
|---|---|---|
| Compliant / Partially compliant / Non-compliant | నిబంధనలకు అనుగుణం / నిబంధనలకు పాక్షికంగా అనుగుణం / నిబంధనలకు అనుగుణంగా లేదు | Built on the Regulation term, like Compliance. |
| Shall / Must / Should | చేయాలి / తప్పనిసరిగా చేయాలి / చేయడం మంచిది | Obligation, strict obligation, recommendation. |
| May / Permission / Permitted | చేయవచ్చు / అనుమతి / అనుమతించబడింది | Permission. |
| Shall not / Must not / May not / Prohibited | చేయరాదు / ఎట్టి పరిస్థితిలోనూ చేయరాదు / చేయడానికి అనుమతి లేదు / నిషేధించబడింది | Prohibition; each modal keeps its own wording. |
| Unless / Subject to / Provided that | అయితే తప్ప / లోబడి / పరంతుకం | Clause-condition labels. పరంతుకం is the proviso term used in Telugu statute texts. |
| Except in / Except where / In case of / In case where / At the time of / When / Where | సందర్భంలో తప్ప / చోట తప్ప / సందర్భంలో / అయిన సందర్భంలో / సమయంలో / ఎప్పుడు / ఎక్కడైతే | Clause-condition labels. "When" is also a time column header, so it is the plain question word. |
| Exemption / Exception | మినహాయింపు / మినహాయింపు సందర్భం | Kept distinct. |
| Preventive / Detective / Corrective (control type) | నివారణ / గుర్తింపు / దిద్దుబాటు | |
| NABH Core / Commitment / Achievement / Excellence | కోర్ / నిబద్ధత / సాధన / శ్రేష్ఠత | Standard levels. |
| Direction / Master Direction (RBI) | ఆదేశం / మాస్టర్ ఆదేశం | Instrument types. |
| Employer | ఉద్యోగదాత | Not యజమాని, which is Owner. |
| Owns (relationship) / Delegate for | యజమానిగా ఉన్నారు / తరఫున ప్రతినిధి | Graph edge labels. |
| Penalty exposure | జరిమానా భారం | Not బాధ్యత, which is Obligation. "Company limited by shares" is likewise షేర్ల ద్వారా పరిమితమైన కంపెనీ. |
| Responsibilities of Management (NABH chapter) | మేనేజ్‌మెంట్ కర్తవ్యాలు | Avoids బాధ్యత (Obligation) and యాజమాన్యం (Ownership). |
| Infection control | సంక్రమణ నియంత్రణ | Fixed clinical phrase. Like the names Pollution Control Board and Drugs (Prices Control) Order, it is not an internal control. |
| Unresolved | అపరిష్కృతం | Kept apart from Not addressed (పరిష్కరించబడలేదు). |
| Legend (chart) | చిహ్నాల వివరణ | సూచిక is reserved for the search index. |
