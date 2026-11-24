#!/usr/bin/env node
// Small, bounded regression for CVE-2026-93749. The oversized offset is only
// passed to the constructor: never serialize a huge untrusted generated map.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const rtlcssRoot = path.resolve(process.argv[2] || "/usr/local/lib/node_modules/rtlcss");
const { SourceMapConsumer, SourceMapGenerator } = require(path.join(rtlcssRoot, "node_modules/source-map-js"));
const rtlcss = require(rtlcssRoot);
const flat = () => ({ version: 3, sources: ["input.css"], names: [], mappings: "AAAA" });
const indexed = (line, map = flat()) => ({ version: 3, sections: [{ offset: { line, column: 0 }, map }] });

for (const line of [-1, 1.5, "12", NaN, Infinity]) {
  test(`rejects invalid section line ${String(line)}`, () => {
    assert.throws(() => new SourceMapConsumer(indexed(line)), /non-negative integers/);
  });
}
test("refuses excessive section offsets before any generating loop", () => {
  assert.throws(() => new SourceMapConsumer(indexed(10_000_001)), /must not exceed/);
});
test("refuses excessive summed nested offsets", () => {
  assert.throws(() => new SourceMapConsumer(indexed(6_000_000, indexed(6_000_000))), /including offsets of nested sections/);
});
test("retains ordinary indexed source-map lookup and generation", () => {
  const consumer = new SourceMapConsumer(indexed(2));
  assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 1 }), {
    source: "input.css", line: 1, column: 0, name: null,
  });
  assert.equal(SourceMapGenerator.fromSourceMap(new SourceMapConsumer(flat())).toJSON().mappings, "AAAA");
});
test("retains rtlcss direction conversion and Arabic text", () => {
  const result = rtlcss.process('.receipt { margin-left: 4px; text-align: left; } .label::after { content: "مرحبا"; }');
  assert.match(result, /margin-right: 4px/);
  assert.match(result, /text-align: right/);
  assert.match(result, /مرحبا/);
});
