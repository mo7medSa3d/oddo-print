import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Source-integrity guard for the desktop app's barrel module.
//
// `src/desktop/lib/printers.ts` re-exports shared vocabulary helpers so the
// desktop screens import them from one place. When a helper is added to that
// barrel's import list in a screen but not to the barrel itself, the app
// compiles fine under the offline harness (nothing resolves the import) and
// only fails at `next build` / `vite build` typecheck time — which is exactly
// how `agentLiveView` shipped broken once. This walks the real source and
// fails here instead, with no framework dependencies.

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const HAS_EXPORT_STAR = /^\s*export\s+\*/m;

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (SOURCE_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf(".")))) files.push(full);
  }
  return files;
}

async function resolveModule(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]) {
    try {
      await readFile(candidate, "utf8");
      return candidate;
    } catch {
      // try the next shape
    }
  }
  return null;
}

function exportedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(
    /export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const withoutType = trimmed.startsWith("type ") ? trimmed.slice(5).trim() : trimmed;
      names.add(withoutType.split(/\s+as\s+/).pop().trim());
    }
  }
  return names;
}

test("every named import inside src/ resolves to an export in its target module", async () => {
  const files = await sourceFiles(join(root, "src"));
  assert.ok(files.length > 100, `expected the source tree, found ${files.length} files`);

  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
      const specifier = match[2];
      const target = await resolveModule(file, specifier);
      if (!target) continue;
      const targetSource = await readFile(target, "utf8");
      if (HAS_EXPORT_STAR.test(targetSource) || /export\s+default/.test(targetSource)) continue;
      const exported = exportedNames(targetSource);
      for (const entry of match[1].split(",")) {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        const name = trimmed.startsWith("type ") ? trimmed.slice(5).trim() : trimmed;
        const imported = name.split(/\s+as\s+/)[0].trim();
        if (!exported.has(imported)) {
          offenders.push(
            `${file.slice(root.length + 1)} imports "${imported}" from ${specifier} — not exported by ${target.slice(root.length + 1)}`,
          );
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `unresolved named imports:\n${offenders.join("\n")}`);
});

test("the desktop barrel re-exports the vocabulary the desktop screens import", async () => {
  const barrel = join(root, "src/desktop/lib/printers.ts");
  const source = await readFile(barrel, "utf8");
  const exported = exportedNames(source);
  for (const name of ["agentLiveView", "printerTone", "deriveOutcome", "printerLabel"]) {
    assert.ok(exported.has(name), `src/desktop/lib/printers.ts must re-export ${name}`);
  }
});
