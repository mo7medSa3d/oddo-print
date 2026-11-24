# Unified typography system

One typography system for the **Desktop Manager**, the **Web console** and the
**Odoo print add-on**.

The system is defined **once**, in [`typography/tokens.css`](typography/tokens.css),
and consumed three times. Nothing in a component, template or stylesheet may
hardcode a font family or a font size — reference the tokens.

## Font families

| Role | Family |
|---|---|
| Arabic | IBM Plex Sans Arabic |
| Latin | IBM Plex Sans |
| Fallback | Noto Sans Arabic, Noto Sans, Tahoma, Arial, sans-serif |

Both faces carry Latin glyphs, so the **order of the stack decides which one
renders English text**. It follows the reading direction, not a fixed list:

```css
--typo-font-stack-latin:  Latin face first   /* LTR documents */
--typo-font-stack-arabic: Arabic face first  /* RTL documents */
```

A single `--typo-font-stack` (the specified stack, Arabic first) is available
for contexts that declare no direction.

### Font files

| Consumer | Files | How they load |
|---|---|---|
| Web | `src/app/fonts/*.woff2` | `next/font/local` emits `@font-face` with `font-display: block` |
| Desktop | `src/app/fonts/*.ttf` | `@font-face` in `src/desktop/theme-light.css`; Vite bundles the files into the installer, so the app never depends on system-installed fonts |
| Odoo | `odoo_addons/print_gateway/static/fonts/*.ttf` | `@font-face` in `static/src/css/typography_fonts.css`, addressed by module URL so the server's PDF engine can fetch them |

The WOFF2 payloads are generated from the pinned TTF sources by
`scripts/build-web-fonts.py` and are committed; the results are pinned by
digest in `tests/font-assets.node.test.mjs`. The TTF sources stay in the
repository because the Desktop app and the Odoo add-on serve them.

Weights: 400, 500, 600, 700 for both families. The Latin file is a variable
font covering 100–700.

`font-display: block` is deliberate everywhere: a print-critical page must
never be laid out with a fallback face, because the fallback's line boxes
would be the ones that get measured, rasterized or converted to PDF. The web
faces are served from the app's own origin, so the block costs nothing.

## Type scale

Print-first. Sizes are declared in **pt**; the screen equivalent (pt × 1.333)
sits next to each one. Never go below 8pt in printed output.

| Role | Print | Screen | Weight |
|---|---|---|---|
| Display / document title | 20pt | 26.667px | 700 |
| Section heading | 14pt | 18.667px | 600 |
| Emphasis / totals | 11pt | 14.667px | 600 |
| Body / line items | 10.5pt | 14px | 400 |
| Labels / metadata | 8.5pt | 11.333px | 500 |
| Footer / fine print | 8pt | 10.667px | 400 |

Bold is reserved for titles, totals and key values. A page carries at most
three weights.

## Line height and spacing

| Context | Line height |
|---|---|
| Arabic | 1.6 |
| Latin | 1.4 |
| Mixed | 1.5 |

Table rows keep at least 4pt of padding above and below the cell.

## Contrast

Primary text `#111827` on white; secondary text `#4B5563` (at least 7:1
against white).

## RTL

Documents set `dir="rtl"`. The family order follows the direction, and
numerals, currency and English codes inside an Arabic sentence are isolated
with `unicode-bidi: isolate; direction: ltr` so they keep their own direction
and stay readable.

## Printable output

- **Web** — `@media print` in `src/app/globals.css` applies the print scale.
- **Desktop** — the same rules, inherited from the shared `globals.css`.
- **Odoo** — a report opts in with the `yaseir-typography` class, which
  `static/src/css/typography_fonts.css` binds to the shared tokens. Odoo's own
  reports are left untouched.

### Documented exception: the Odoo POS receipt

`static/src/css/receipt_raster.css` does **not** use the document scale, and
that is deliberate:

- the receipt is a **fixed-dot canvas**, not a document — its size is chosen
  by the printer's dot budget, not by a typographic scale;
- its metrics are pinned by the measured geometry fixture
  (`agent/internal/printer/testdata/receipt-geometry.jpg`);
- the capture runs with font embedding **disabled** (`skipFonts`), so the
  receipt must never depend on a web font.

Its values are declared once as tokens in place and referenced, and they
render exactly as before.

## Keeping the three copies in sync

The Odoo add-on is installed as a standalone module and cannot import a file
from outside the module, so it ships a copy of the token file. The copy must
be byte-identical:

```bash
npm run typography:check
```

`scripts/check-typography-tokens.py` fails closed on any drift, on a missing
or altered font file, and on a change to the specified values themselves — the
scale, the families, the line heights and the contrast colours are a
specification, not a preference.

The check runs in CI (`.github/workflows/ci.yml`) and the invariants are also
asserted in `tests/typography-system.test.ts`.
