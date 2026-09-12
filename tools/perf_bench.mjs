#!/usr/bin/env node
/** Deterministic core benchmark. It measures hot-path QC without API/network/files. */
import { performance } from 'node:perf_hooks';
import { lexiconFromWords } from '../dist/src/core/lexicon.js';
import { runQc } from '../dist/src/core/qc.js';
const n = Number(process.env.LAYERTEXT_BENCH_REPS ?? 30);
const para = '[P01] The animals gathered in the barn because the storm was coming. They discussed the windmill and planned their work.';
const text = `## Chapter One\n\n${Array.from({ length: 250 }, (_, i) => para.replace('P01', `P${String(i + 1).padStart(2, '0')}`)).join('\n\n')}`;
const lex = lexiconFromWords('the animals gathered in barn because storm was coming they discussed windmill and planned their work'.split(' '));
const opts = { tier: 'A', chno: 1, fileName: 'bench.md' };
for (let i = 0; i < 3; i++) runQc(text, lex, opts);
const t0 = performance.now();
let result;
for (let i = 0; i < n; i++) result = runQc(text, lex, opts);
const elapsed = performance.now() - t0;
const ms = elapsed / n;
console.log(JSON.stringify({ name: 'qc-250-paragraphs', repetitions: n, averageMs: Number(ms.toFixed(2)), paragraphs: result.paraCount, tokens: result.tokenCount }, null, 2));
const max = Number(process.env.LAYERTEXT_BENCH_MAX_MS ?? 250);
if (ms > max) {
  console.error(`✗ benchmark regression: ${ms.toFixed(2)}ms > ${max}ms`);
  process.exit(1);
}
