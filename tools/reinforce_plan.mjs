#!/usr/bin/env node
/**
 * reinforce_plan.mjs —— 复现注入规划器（feature/reinforce，通用工具，零学生数据）
 *
 * 输入：下一章 md + 已学词 CSV（首列=词；通常来自班级画像 --due --top 8 导出）
 * 输出：注入计划——
 *   ① 本篇已自然复现的队列词（带词次）
 *   ② 缺席词=本篇需定向注入的清单
 *   ③ 可直接粘进 AI 简化约束的注入指令片段（中文）
 *
 * 用法：node tools/reinforce_plan.mjs <章节md> <已学词.csv> [--each N]
 * 说明：本工具为启发式规划（简单词形匹配）；注入后的验收以 CLI qc --reinforce 的⑩指标为准。
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const mdPath = argv[0],
  csvPath = argv[1];
if (!mdPath || !csvPath) {
  console.error('用法: node tools/reinforce_plan.mjs <章节md> <已学词.csv> [--each N]');
  process.exit(2);
}
const eachIdx = argv.indexOf('--each');
const each = eachIdx >= 0 ? parseInt(argv[eachIdx + 1], 10) || 2 : 2;

const words = readFileSync(csvPath, 'utf-8')
  .replace(/^\uFEFF/, '')
  .split('\n')
  .map((l) => l.split(',')[0].trim().toLowerCase())
  .filter((w) => w && w !== '词' && w !== 'word' && /^[a-z][a-z'\- ]*$/.test(w));

const md = readFileSync(mdPath, 'utf-8').toLowerCase();
const toks = new Set(md.match(/[a-z][a-z'-]*/g) || []);
// 简单词形族：word / word+s / word+ed / word+ing / 双写末字母+ing|ed（care→caring）
const family = (w) => [w, w + 's', w + 'es', w + 'ed', w + 'ing', w.replace(/([^aeiou])e$/, '$1') + 'ing', w + w.at(-1) + 'ing', w + w.at(-1) + 'ed'];

const present = [],
  absent = [];
for (const w of [...new Set(words)]) {
  const hitForms = family(w).filter((f) => toks.has(f));
  (hitForms.length ? present : absent).push({ word: w, forms: hitForms });
}

console.log(`复现注入计划（${mdPath}）`);
console.log(`队列 ${words.length} 词 | 已自然复现 ${present.length} | 需注入 ${absent.length}\n`);
if (present.length) {
  console.log('① 本篇已自然复现（无需注入）：');
  for (const p of present) console.log(`   ${p.word}  (${p.forms.join(', ')})`);
}
if (absent.length) {
  console.log(`\n② 需定向注入 ${absent.length} 词：`);
  console.log('   ' + absent.map((a) => a.word).join(', '));
  console.log(`\n③ AI 简化注入指令（贴进改写约束；每词自然出现 ${each} 次左右，不改情节、不生硬，词形可按语境变化）：`);
  console.log('---');
  console.log(
    `【复现词约束】以下 ${absent.length} 个词是学生上一章刚学过的已学词，请在改写中让每个词自然出现约 ${each} 次（可用其词形变化，如过去式/-ing），融入情节与对话，不得为了塞词改写情节：${absent.map((a) => a.word).join(' / ')}`,
  );
  console.log('---');
}
console.log('\n验收：改写后运行 node dist/src/cli.js qc <改写稿> --vocab <词库> --reinforce <全量已学词.csv>，⑩复现命中应 ≥ 注入词数。');
