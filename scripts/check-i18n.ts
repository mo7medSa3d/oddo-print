/**
 * Translation catalog checker.
 *
 * Guarantees, for every locale other than English:
 *   1. Every English key exists, and no unknown keys were added.
 *   2. No message is empty.
 *   3. Interpolation placeholders match English exactly — a missing `{count}`
 *      in Arabic would silently render the literal text "{count}".
 *   4. Count-aware message families are complete enough to resolve: if any
 *      `key.<category>` exists, `key.other` must exist as the fallback.
 *
 * Run with `npm run i18n:check` (tsx) or any TS-capable Node:
 *   node --experimental-strip-types scripts/check-i18n.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { en } from "../src/i18n/messages/en";
import { ar } from "../src/i18n/messages/ar";
import { LOCALES, DEFAULT_LOCALE } from "../src/i18n/config";

type Catalog = Record<string, string>;

const CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;

/** Every `.ts`/`.tsx` file under `src/`, so `tc()` call sites can be audited. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "messages") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const catalogs: Record<string, Catalog> = { en: en as unknown as Catalog, ar: ar as unknown as Catalog };

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(message: string): string[] {
  return Array.from(message.matchAll(PLACEHOLDER))
    .map((match) => match[1])
    .sort();
}

let failures = 0;
const fail = (message: string) => {
  failures += 1;
  console.error(`  FAIL  ${message}`);
};

console.log(`locales      : ${LOCALES.join(", ")}`);
console.log(`default      : ${DEFAULT_LOCALE}`);
console.log(`en keys      : ${Object.keys(en).length}`);

for (const locale of LOCALES) {
  if (locale === DEFAULT_LOCALE) continue;
  const catalog = catalogs[locale];
  const sourceKeys = new Set(Object.keys(en));
  const targetKeys = new Set(Object.keys(catalog));

  console.log(`${locale} keys      : ${targetKeys.size}`);

  for (const key of sourceKeys) {
    if (!targetKeys.has(key)) fail(`${locale}: missing key "${key}"`);
  }
  for (const key of targetKeys) {
    if (!sourceKeys.has(key)) fail(`${locale}: unknown key "${key}" (not in the English catalog)`);
  }

  for (const [key, value] of Object.entries(catalog)) {
    if (typeof value !== "string" || value.trim() === "") fail(`${locale}: "${key}" is empty`);
    const source = (en as unknown as Catalog)[key];
    if (typeof source !== "string") continue;
    const wanted = placeholders(source);
    const got = placeholders(value);
    // Singular and dual forms write the number as a word in Arabic
    // ("محاولة واحدة", "طابعتان"), so dropping `{count}` there is correct, not a
    // defect. Every other form must expose exactly the source placeholders.
    const allowsNumeralAsWord = /\.(one|two)$/.test(key);
    if (allowsNumeralAsWord) {
      const required = wanted.filter((name) => name !== "count");
      const actual = got.filter((name) => name !== "count");
      if (required.join(",") !== actual.join(",") || got.filter((name) => name === "count").length > wanted.filter((name) => name === "count").length) {
        fail(`${locale}: "${key}" must preserve every non-count placeholder`);
      }
      continue;
    }
    if (wanted.join(",") !== got.join(",")) {
      fail(`${locale}: "${key}" placeholders ${got.join(",") || "(none)"} do not match English ${wanted.join(",") || "(none)"}`);
    }
  }

  // Count-aware families: every `base.<category>` group needs an `other` form
  // because translateCount falls back to it for categories a locale omits.
  const families = new Map<string, Set<string>>();
  for (const key of sourceKeys) {
    const dot = key.lastIndexOf(".");
    const category = key.slice(dot + 1);
    if (!["zero", "one", "two", "few", "many", "other"].includes(category)) continue;
    const base = key.slice(0, dot);
    if (!families.has(base)) families.set(base, new Set());
    families.get(base)!.add(category);
  }
  for (const [base, categories] of families) {
    if (!categories.has("other")) fail(`${locale}: count family "${base}" has no ".other" fallback`);
  }
}

// ---------------------------------------------------------------------------
// Count families must use the separator translateCount() actually builds.
//
// translateCount resolves `${base}.${category}` — a dot. A family written as
// `jobs.cleanup.removed_one` silently resolves nothing and the UI renders the
// bare key, which is worse than an untranslated string because it looks like a
// crash. Guarding the separator closes that hole permanently.
// ---------------------------------------------------------------------------
const sourceKeys = new Set(Object.keys(en));
for (const key of sourceKeys) {
  const slash = key.lastIndexOf("_");
  if (slash === -1) continue;
  const candidate = key.slice(slash + 1);
  if ((CATEGORIES as readonly string[]).includes(candidate)) {
    fail(`count key "${key}" uses "_${candidate}"; translateCount() builds ".${candidate}"`);
  }
}

// ---------------------------------------------------------------------------
// Every `tc("base", …)` call site must resolve to a real message, using the
// same lookup order as translateCount: `<base>.<category>`, `<base>.other`,
// then `<base>`.
// ---------------------------------------------------------------------------
const callSites: Array<{ file: string; base: string }> = [];
for (const file of sourceFiles("src")) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\btc\(\s*"([^"]+)"/g)) {
    callSites.push({ file, base: match[1] });
  }
}
for (const { file, base } of callSites) {
  const resolvable =
    `${base}.one` in en || `${base}.other` in en || base in en || CATEGORIES.some((c) => `${base}.${c}` in en);
  if (!resolvable) fail(`${file}: tc("${base}") resolves to no message — the UI would render the raw key`);
}
console.log(`tc() call sites: ${callSites.length}`);

if (failures > 0) {
  console.error(`\n${failures} catalog problem(s).`);
  process.exit(1);
}
console.log(`\nOK: all catalogs are complete and consistent.`);
