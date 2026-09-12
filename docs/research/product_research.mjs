#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
const root = process.env.LT_ASSET ?? '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm';
const out = 'docs/research/product_research_summary.json';
const dir = join(root, '调适工作区/重制三版');
const files = [];
function walk(d) {
  for (const n of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, n.name);
    if (n.isDirectory()) walk(p);
    else if (/\.(md|jsonl|csv|json)$/.test(n.name)) files.push(p);
  }
}
walk(dir);
const words = (s) => (s.match(/[A-Za-z][A-Za-z'-]*/g) || []).map((x) => x.toLowerCase());
const notes = (s) => (s.match(/[A-Za-z][A-Za-z'-]*（[^）]*）/g) || []).length;
const rows = [];
for (const f of files) {
  const s = readFileSync(f, 'utf8');
  if (/学生版|R1|工序化|R2/.test(basename(f)))
    rows.push({ file: f.replace(root + '/', ''), words: words(s).length, unique: new Set(words(s)).size, notes: notes(s), sentences: (s.match(/[.!?]+/g) || []).length });
}
const feedback = files.filter((f) => /调适反馈|任务单|决定/.test(f)).map((f) => ({ file: f.replace(root + '/', ''), bytes: readFileSync(f).length }));
mkdirSync('docs/research', { recursive: true });
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), files: rows, feedback }, null, 2));
console.log(JSON.stringify({ files: rows.length, feedback: feedback.length, out }, null, 2));
