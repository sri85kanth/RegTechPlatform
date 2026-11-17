#!/usr/bin/env node
/**
 * Collect every English string the interface translates, into src/i18n/en.json.
 *
 *   node scripts/i18n-extract.mjs           write en.json and report coverage
 *   node scripts/i18n-extract.mjs --check   report coverage only (exit 1 if a locale is missing keys)
 *
 * Sources:
 *   1. the first argument of t(...) / tr(...) / tx(...) / tNow(...) — every string literal in it, so
 *      t(cond ? 'A' : 'B') and t(label ?? 'Back') both count;
 *   2. labels the shared components translate when they draw them: `label:`,
 *      `title:`, `subtitle:`, `sub:`, `hint:`, `entityNoun:` and `pluralNoun:`
 *      in object literals, and title= / subtitle= / backLabel= / breadcrumb= /
 *      label= / hint= JSX attributes (page headers, tabs, table columns, nav).
 *
 * Extra keys are harmless (an unused entry is never shown); a missing key just
 * shows English. en.json is the master list the language files are checked against.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const out = path.join(src, 'i18n', 'en.json');
const localesDir = path.join(src, 'i18n', 'locales');
const checkOnly = process.argv.includes('--check');

// src/i18n is scanned too: the language picker's own labels go through t()
const SKIP_DIRS = new Set(['__fixtures__', 'locales', 'glossary']);
function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), acc); }
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) acc.push(path.join(dir, e.name));
  }
  return acc;
}

/** Read a JS string literal starting at s[i] (a quote). Returns [value, endIndex]. */
function readString(s, i) {
  const q = s[i];
  let j = i + 1, v = '';
  while (j < s.length && s[j] !== q) {
    if (s[j] === '\\') { const n = s[j + 1]; v += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; continue; }
    v += s[j++];
  }
  return [v, j];
}

/** String literals in the first argument of a call whose '(' is at s[open]. */
function firstArgStrings(s, open) {
  const found = [];
  let depth = 0;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    // comments inside a list may hold apostrophes; skip them whole
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
    if (c === "'" || c === '"') {
      const [v, end] = readString(s, i);
      found.push(v);
      i = end;
    } else if (c === '`') {
      // template literals are dynamic; skip to the closing backtick
      i++;
      while (i < s.length && s[i] !== '`') { if (s[i] === '\\') i++; i++; }
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
  }
  return found;
}

const keep = (v) => {
  const s = v.trim();
  if (!s || s.length < 2) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  if (/^[a-z0-9_./:-]+$/.test(s) && !s.includes(' ') && s === s.toLowerCase() && s.length < 4) return false;
  if (/^(https?:|\/|#|@\/|\.\/)/.test(s)) return false;     // urls, routes, imports
  if (s.includes('${')) return false;                        // pieces of HTML template strings
  if (/^[A-Z0-9_]+$/.test(s) && s.length > 3) return false;  // ENUM_VALUES
  if (/^[a-z]+[A-Z][A-Za-z]*$/.test(s)) return false;        // camelCase identifiers / icon names
  if (/^[A-Z][a-z]+[A-Z][A-Za-z]*$/.test(s)) return false;   // PascalCase icon names (FileText)
  if (/^(bg|text|border|ring|from|to|via|h|w|p|px|py|pt|pb|m|mt|mb|ml|mr|mx|my|gap|grid|flex|font|leading|line|rounded|shadow|inline|block)-/.test(s)) return false; // css classes
  if (/^[a-z0-9:[\]./-]+( [a-z0-9:[\]./-]+){2,}$/.test(s) && /-/.test(s)) return false;  // "mt-0.5 font-bold text-ink"
  return true;
};

const keys = new Set();
const CALL = /(?<![\w$.])(t|tr|tx|txList|tNow)\(/g;
const PROP = /(?<![\w$])(label|title|subtitle|sub|hint|description|reason|note|entityNoun|pluralNoun|noun|backLabel|shareLabel)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g;
const ATTR = /\s(title|subtitle|backLabel|breadcrumb|label|hint|noun|ariaLabel)=(['"])((?:\\.|(?!\2).)*)\2/g;

for (const file of walk(src)) {
  const s = fs.readFileSync(file, 'utf8');
  for (const m of s.matchAll(CALL)) {
    for (const v of firstArgStrings(s, m.index + m[0].length - 1)) if (keep(v)) keys.add(v);
  }
  for (const m of s.matchAll(PROP)) if (keep(m[3])) keys.add(m[3].replace(/\\(.)/g, '$1'));
  for (const m of s.matchAll(ATTR)) if (keep(m[3])) keys.add(m[3].replace(/\\(.)/g, '$1'));
}

// Values that reach t() from the API or from computed text, listed by hand.
const EXTRA = [
  // roles, as the account menu shows them
  'Viewer', 'Reviewer', 'Compliance manager', 'Admin', 'Auditor', 'Platform admin',
  // risk bands
  'Critical', 'High', 'Medium', 'Low',
  // dashboard greeting
  'Good morning', 'Good afternoon', 'Good evening',
  // page-header sections (Topbar sectionFor) and sidebar groups (Sidebar SECTIONS `name:`)
  'Company', 'Onboarding', 'Regulatory', 'Compliance', 'Platform', 'Hospital records',
  // deadline kinds from /api/home (api_home.py: "Comes into force", "<frequency> reporting", "Licence expiry")
  'Comes into force', 'Licence expiry', 'Annual reporting', 'Half yearly reporting', 'Quarterly reporting',
  'Monthly reporting', 'Weekly reporting', 'Daily reporting',
  // short words the filters above would drop
  'due',
  // why an authority applies (applicabilityProfile.ts AuthorityMatch.basis)
  'Licence', 'Sector', 'Activity', 'Size', 'Universal',
];
EXTRA.forEach((k) => keys.add(k));

// Status and type codes from the server, shown through readable()/words() and
// translated with t(readable(code)). Collected from the live database's
// enum-like columns; refresh when the server gains new codes.
const serverValues = path.join(root, 'scripts', 'i18n-server-values.txt');
if (fs.existsSync(serverValues)) {
  for (const line of fs.readFileSync(serverValues, 'utf8').split('\n')) {
    const v = line.trim();
    if (v && !v.startsWith('#')) keys.add(v);
  }
}

const sorted = [...keys].sort((a, b) => a.localeCompare(b));
if (!checkOnly) {
  fs.writeFileSync(out, JSON.stringify(Object.fromEntries(sorted.map((k) => [k, k])), null, 2) + '\n');
  console.log(`en.json: ${sorted.length} strings`);
}

let missingAny = false;
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir).filter((x) => x.endsWith('.json')).sort()) {
    const dict = JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'));
    const missing = sorted.filter((k) => !dict[k]);
    const badVars = sorted.filter((k) => dict[k] && (k.match(/\{\w+\}/g) ?? []).sort().join() !== (dict[k].match(/\{\w+\}/g) ?? []).sort().join());
    if (missing.length || badVars.length) missingAny = true;
    console.log(`${f}: ${sorted.length - missing.length}/${sorted.length} translated` +
      (missing.length ? `, ${missing.length} missing` : '') +
      (badVars.length ? `, ${badVars.length} with wrong {placeholders}: ${badVars.slice(0, 3).map((k) => JSON.stringify(k)).join(', ')}` : ''));
  }
}
if (checkOnly && missingAny) process.exit(1);
