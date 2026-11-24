import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

/** Execute the actual response-wait call sites in a separate Node process.
 * Only the external browser is substituted: its response rejects while a click
 * is still pending. The timeout must remain an error and reach outer cleanup. */
function declarations(file, target, variable = false) {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  let operation, observer = "";
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "waitForResponse") observer = node.getText(source);
    if (variable && ts.isVariableDeclaration(node) && node.name.getText(source) === target) operation = node.initializer.getText(source);
    if (!variable && ts.isFunctionDeclaration(node) && node.name?.text === target) operation = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source); assert.ok(operation, "The tested browser call site must exist");
  return { operation, observer };
}

for (const realm of ["platform", "workspace"]) {
  test(realm + " response timeout remains an error and reaches cleanup when it rejects before the awaited click", () => {
    const file = fileURLToPath(new URL("../scripts/acceptance/" + realm + "-browser.mjs", import.meta.url));
    const { operation, observer } = declarations(file, "passwordLogin");
    const assignment = operation + "\nglobalThis.operation = passwordLogin;";
    const child = [
      "import assert from 'node:assert/strict';",
      "import { runInNewContext } from 'node:vm';",
      "const timeout = 'synthetic expected browser response timeout';",
      "const delay = () => new Promise(resolve => setTimeout(resolve, 30));",
      "const context = { page: {",
      "  waitForResponse: () => new Promise((_, reject) => setTimeout(() => reject(new Error(timeout)), 0)),",
      "  goto: async () => {}, locator: () => ({ fill: async () => {}, click: delay }), getByRole: () => ({ click: delay })",
      "}, origin: 'https://synthetic.invalid', password: 'synthetic-password', exactPassword: 'synthetic-password', email: 'browser@example.invalid', assert, api: async () => ({ status: 401 }) };",
      "runInNewContext(" + JSON.stringify(observer + "\n" + assignment) + ", context);",
      "let caught = false;",
      "try {",
      "  await context.operation(context.origin);",
      "  throw new Error('The timeout was incorrectly converted into success');",
      "} catch (error) { assert.equal(error.message, timeout); caught = true; }",
      "finally { process.stdout.write('CLEANUP_EXECUTED\\n'); }",
      "assert.equal(caught, true); process.stdout.write('TIMEOUT_PROPAGATED\\n');",
    ].join("\n");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
      encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, "The actual " + realm + " wait call site must retain cleanup.\n" + result.stderr);
    assert.match(result.stdout, /CLEANUP_EXECUTED/); assert.match(result.stdout, /TIMEOUT_PROPAGATED/);
  });
}
