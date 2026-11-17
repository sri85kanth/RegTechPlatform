// ============================================================
// What to do with a file the customer drops on us.
//
// The important distinction is not "which parser" — it is what job
// the file is doing:
//
//   RECORDS   many rows → many entities        (CSV, Excel, a table in Word)
//   DOCUMENT  one file  → one entity + the attachment itself
//             (a policy PDF is not 40 records; it is one Policy plus
//              the artefact you would hand a regulator)
//
// Getting that wrong is how you end up shredding a policy document
// into meaningless fragments, or importing a control register as a
// single opaque attachment.
// ============================================================

export type Route = 'records' | 'document' | 'ocr' | 'unsupported';

export interface FileVerdict {
  route: Route;
  format: string;
  /** what will actually happen, in the customer's words */
  action: string;
  /** true when the platform can do this today, false when it needs the pipeline */
  readyNow: boolean;
  note?: string;
}

const EXT = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

export function routeFile(file: { name: string; type?: string; size?: number }): FileVerdict {
  const e = EXT(file.name);

  if (['csv', 'tsv', 'txt'].includes(e)) {
    return {
      route: 'records', format: 'Delimited text', readyNow: true,
      action: 'Each row becomes an entity. You map its columns to our fields on the next screen.',
    };
  }

  if (['xlsx', 'xls', 'xlsm'].includes(e)) {
    return {
      route: 'records', format: 'Excel workbook', readyNow: false,
      action: 'Each sheet is treated as one section, then rows become entities.',
      note: 'Excel parsing is not wired up yet. Save the sheet as CSV and upload that — the column mapping works the same way.',
    };
  }

  if (['doc', 'docx'].includes(e)) {
    return {
      route: 'document', format: 'Word document', readyNow: false,
      action: 'Stored as the source artefact, with headings and tables extracted into candidate records for review.',
      note: 'Word extraction runs in the ingestion pipeline, which needs the backend.',
    };
  }

  if (e === 'pdf') {
    return {
      route: 'document', format: 'PDF', readyNow: false,
      action: 'Stored as the source artefact. Text and clauses are extracted, and one record is proposed for the document itself.',
      note: 'Uses the same extraction path as regulatory PDFs — hash, text extract, clause parse. Needs the backend.',
    };
  }

  if (['png', 'jpg', 'jpeg', 'tif', 'tiff'].includes(e)) {
    return {
      route: 'ocr', format: 'Scanned image', readyNow: false,
      action: 'Routed to OCR before anything can be read from it.',
      note: 'OCR is proposed, not built. A scanned policy cannot be parsed until it runs.',
    };
  }

  if (['ppt', 'pptx'].includes(e)) {
    return {
      route: 'document', format: 'Slide deck', readyNow: false,
      action: 'Stored as supporting context.',
      note: 'Slides rarely contain register data — attach them, but expect to enter the records by hand.',
    };
  }

  if (['json', 'xml'].includes(e)) {
    return {
      route: 'records', format: e.toUpperCase(), readyNow: false,
      action: 'Structured export — mapped to entities once a schema is agreed.',
      note: 'Usually a system export. Tell us the shape and it becomes an adapter, like the regulator adapters.',
    };
  }

  return {
    route: 'unsupported', format: e ? e.toUpperCase() : 'Unknown', readyNow: false,
    action: 'Not something we can read.',
    note: 'Convert to CSV for records, or PDF for documents.',
  };
}

export const ROUTE_LABEL: Record<Route, string> = {
  records: 'Becomes records',
  document: 'Becomes a document',
  ocr: 'Needs OCR first',
  unsupported: 'Not supported',
};
