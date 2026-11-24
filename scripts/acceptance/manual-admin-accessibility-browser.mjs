/** Real Chromium accessibility regression for the authenticated manual-subscription
 * acceptance flow. Run via platform-browser.mjs with
 * YASEIR_ADMIN_BROWSER_MODULE=./scripts/acceptance/manual-admin-accessibility-browser.mjs.
 * Includes contrast; incomplete results remain recorded for human inspection.
 * This automated gate does not replace assistive-technology acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { adminBrowserAcceptance as nativeAcceptance } from './manual-admin-browser.mjs';

export async function adminBrowserAcceptance(args) {
  const results = [];
  const seen = new WeakSet();
  const axeSource = fs.readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
  const output = path.join(args.output, 'accessibility.json');
  const instrument = page => {
    if (seen.has(page)) return;
    seen.add(page);
    const screenshot = page.screenshot.bind(page);
    page.screenshot = async options => {
      await page.evaluate(axeSource);
      const result = await page.evaluate(async () => {
        const scan = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
        });
        return {
          url: location.pathname, direction: document.documentElement.dir,
          width: innerWidth, axe: scan.testEngine.version,
          violations: scan.violations.map(v => ({ id: v.id, impact: v.impact,
            nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })),
          incomplete: scan.incomplete.map(v => ({ id: v.id,
            nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })),
        };
      });
      results.push({ image: path.basename(options.path), ...result });
      fs.writeFileSync(output, JSON.stringify({ checks: results }, null, 2) + '\n');
      return screenshot(options);
    };
  };
  instrument(args.page);
  const newContext = args.browser.newContext.bind(args.browser);
  args.browser.newContext = async options => {
    const context = await newContext(options);
    context.on('page', instrument);
    return context;
  };
  try {
    await nativeAcceptance(args);
    assert(results.length > 0, 'No browser accessibility state was captured');
    const failures = results.flatMap(r => r.violations.map(v => `${r.image}:${v.id}:${v.nodes.length}`));
    assert.deepEqual(failures, [], 'Real browser accessibility findings require review');
    args.check(`Actual Chromium axe ${results[0]?.axe} scans passed on ${results.length} captured Arabic/English responsive states, including color contrast`);
  } finally {
    args.browser.newContext = newContext;
    fs.writeFileSync(output, JSON.stringify({ checks: results }, null, 2) + '\n');
  }
}
