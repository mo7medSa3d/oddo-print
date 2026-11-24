import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import nextPlugin from "@next/eslint-plugin-next";
import hooks from "eslint-plugin-react-hooks";

const fixtures = [
  ["react/display-name", "import React from 'react'; const X = React.memo(() => <div/>);"],
  ["react/jsx-key", "const X = items.map(x => <span>{x}</span>);"],
  ["react/jsx-no-comment-textnodes", "const X = <div>// a comment</div>;"],
  ["react/jsx-no-duplicate-props", "const X = <div id='a' id='b' />;"],
  ["react/jsx-no-undef", "const X = <UndefinedComponent />;"],
  ["react/no-children-prop", "const X = <div children='x'/>;"],
  ["react/no-danger-with-children", "const X = <div dangerouslySetInnerHTML={{__html:'x'}}>child</div>;"],
  ["react/no-direct-mutation-state", "class X extends React.Component { f() { this.state.x=1; } render(){return null;} }"],
  ["react/no-find-dom-node", "ReactDOM.findDOMNode(node);"],
  ["react/no-is-mounted", "class X extends React.Component { f(){return this.isMounted();} render(){return null;} }"],
  ["react/no-render-return-value", "const instance = ReactDOM.render(element, root);"],
  ["react/no-string-refs", "class X extends React.Component { render(){return <div ref='legacy'/>;} }"],
  ["react/no-unescaped-entities", "const X = <div>unescaped ' text</div>;"],
  ["react/require-render-return", "class X extends React.Component { render() { const x=1; } }"],
  ["import/no-anonymous-default-export", "export default {};"],
  ["jsx-a11y/alt-text", "const X = <img src='x.png'/>; const Y=<Image src='x.png'/>;"],
  ["jsx-a11y/aria-props", "const X = <div aria-invalid-name='true'/>;"],
  ["jsx-a11y/aria-proptypes", "const X = <div aria-hidden='invalid'/>;"],
  ["jsx-a11y/aria-unsupported-elements", "const X = <meta aria-hidden='true'/>;"],
  ["jsx-a11y/role-has-required-aria-props", "const X = <div role='checkbox'/>;"],
  ["jsx-a11y/role-supports-aria-props", "const X = <div role='checkbox' aria-level='2'/>;"],
];

test("every migrated React, accessibility and import rule diagnoses an unsafe fixture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yaseir-lint-"));
  try {
    for (let i=0; i<fixtures.length; i++) await writeFile(join(dir, `case-${i}.jsx`), fixtures[i][1]);
    await writeFile(join(dir, "valid.jsx"), "import React from 'react'; export function Example(){return <img src='x.png' alt='Description'/>;}");
    const result = spawnSync(process.execPath, [resolve("node_modules/oxlint/bin/oxlint"), "--threads", "2", "-c", resolve(".oxlintrc.json"), "-f", "json", dir], {encoding:"utf8"});
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    const missing = [];
    for (let i=0; i<fixtures.length; i++) {
      const [rule] = fixtures[i];
      const short = rule.split("/")[1];
      if (!report.diagnostics.some((d) => d.filename?.endsWith(`case-${i}.jsx`) && d.code?.includes(short))) missing.push(rule);
    }
    assert.deepEqual(missing, [], `Migrated rules lost lint coverage: ${missing.join(", ")}`);
    assert.equal(report.diagnostics.filter(d => d.filename?.endsWith("case-15.jsx") && d.code?.includes("alt-text")).length, 2, "both native img and Next Image require alt text");
    assert.equal(report.diagnostics.filter(d => d.filename?.endsWith("valid.jsx")).length, 0);
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test("original Next and React Hook rule names and severities remain active", async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile("src/app/page.tsx");
  for (const [name,value] of Object.entries({...nextPlugin.configs["core-web-vitals"].rules,...hooks.configs.recommended.rules})) {
    const severity = Array.isArray(value) ? value[0] : value;
    assert.equal(config.rules[name][0], severity === "error" ? 2 : severity === "warn" ? 1 : 0, name);
  }
  const odoo = await eslint.calculateConfigForFile("odoo_addons/print_gateway/static/src/js/pos_print_router.js");
  assert.equal(odoo.rules["no-undef"][0], 2);
  assert.equal(odoo.rules["no-unused-vars"][0], 2);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  assert.match(manifest.scripts.lint, /eslint/);
  assert.match(manifest.scripts.lint, /oxlint/);
});

test("Next Core Web Vitals retains its original global CommonJS coverage", async () => {
  const eslint = new ESLint();
  const [result] = await eslint.lintText("var module = {};", { filePath: "review.cjs" });
  assert.ok(result.messages.some(message => message.ruleId === "@next/next/no-assign-module-variable" && message.severity === 2));
});
