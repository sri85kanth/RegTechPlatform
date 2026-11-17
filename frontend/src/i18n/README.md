# Translating the interface

The interface can be shown in English and eight Indian languages (`index.ts`, `LANGUAGES`).
English text is the key; `locales/<lang>.json` maps it to each language, and anything
missing falls back to English. Only the interface is translated — regulation text and
company records from the API stay as they are.

After changing text, run `node scripts/i18n-extract.mjs` to refresh `en.json` (the master
list) and see which languages are missing strings.

## Rules

1. **Hook.** In each React component that draws text: `const t = useT();` (from `@/i18n`),
   then `t('Save changes')`. If the component already has a variable named `t`, call it
   `tr`. The extractor recognises only `t(`, `tr(`, `tx(` and `tNow(` with a literal string.
2. **Whole sentences, with placeholders.** `t('{n} requirements need an owner', { n })`.
   Never build a sentence by joining translated pieces — Indian languages put words in a
   different order. Format numbers before passing them: `{ n: count.toLocaleString() }`.
3. **Plurals.** When singular reads differently, use two keys:
   `n === 1 ? t('1 requirement') : t('{n} requirements', { n })`.
4. **Inline markup.** For `Showing <b>{a}</b> of <b>{b}</b>`, prefer one `t()` with
   placeholders and drop the inner `<b>`; or split into a translated label plus a data
   value: `{t('Owner')}: <b>{name}</b>`.
5. **Constants outside components** (status-label maps, option lists, tab or column
   definitions): wrap the English literal in `tx('…')` so it is collected, and translate
   where it is drawn: `t(STATUS_LABEL[s])`. Object properties named `label`, `title`,
   `subtitle`, `sub`, `hint` and `description` with a literal string are collected
   automatically, but must still be drawn through `t()`.
6. **Helpers that are not components** (`renderRow()`, column builders): take
   `t: TFunction` as a parameter. Never call `useT()` inside loops, conditions, callbacks
   or plain functions.
7. **HTML built as strings** (e.g. `cascade/renderCascade.ts`): use `tNow('…')`, and make
   the React wrapper redraw when the language changes: `const lang = useLang();` and add
   `lang` to the effect's dependencies.
8. **Dates.** Replace hard-coded `'en-GB'` / `'en-IN'` / `undefined` locales with
   `const locale = useDateLocale();` → `d.toLocaleDateString(locale, …)`. Leave numbers alone.
9. **Translate:** visible JSX text, headings, buttons and links, empty, loading and error
   messages, `placeholder`, `title` (tooltips), `aria-label`, `alt`, `window.confirm` /
   `alert` text, toasts, `<option>` labels, legend and chart labels.
10. **Do not translate:** data from the API (titles, names, free text), enum values used in
    logic or sent to the server, CSS classes, routes, URLs, query keys, ids, console
    messages, file names, the product name "Company Brain", and acronyms on their own
    (NABH, RBI, SOP, CSV, PDF). When code maps an enum to an English label, translate the
    label where it is drawn.
11. **Shared components already translate what they are given:** `Topbar` (title,
    subtitle, backLabel, breadcrumb, meta labels), `TabStrip` and `SegmentedControl`
    (string labels), `DataTable` (column labels, noun), `Sidebar`. Pass them English.
12. **Change nothing else:** same behaviour, markup and styling; no refactors, renamed
    props or new dependencies. If a string is also used in logic (compared, used as a key),
    translate only where it is displayed.
