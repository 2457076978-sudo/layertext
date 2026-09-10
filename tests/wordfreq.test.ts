/**
 * zipf 词频先验测试（调研〇-3 第一级"疑似漏收"分诊）：
 * 解析/词形家族查询/三档分诊/真实资产表接入 layer_qc。
 * 红线回归：分诊不改变判定——有无 zipfTable，OOV 清单与全部指标一致。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lexiconFromWords } from '../src/core/lexicon.js';
import { buildMcpLexicon, toolQcText } from '../src/core/mcpTools.js';
import { aoaOf, MID_ZIPF, parseZipfTable, SUSPECT_ZIPF, triageOov, TRIAGE_RANK, zipfOf } from '../src/core/wordfreq.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSV = readFileSync(join(ROOT, 'assets', 'wordfreq', 'en_zipf.tsv'), 'utf-8');

test('parseZipfTable：word→zipf×100；空行与缺数值行跳过', () => {
  const t = parseZipfTable('the\t773\n\ngovernment\t557\nbroken\nx\tabc\n');
  assert.equal(t.size, 2);
  assert.equal(t.get('the'), 773);
  assert.equal(t.get('government'), 557);
});

test('zipfOf：直查、词形家族还原（与 hit 同一候选序）、查无返回 null', () => {
  const t = parseZipfTable('story\t545\nthe\t773\n');
  assert.equal(zipfOf('story', t), 5.45);
  assert.equal(zipfOf('stories', t), 5.45); // 剥 s 回查 story
  assert.equal(zipfOf('storied', t), 5.45); // 剥 ed 回查 story
  assert.equal(zipfOf('nowhere', t), null);
});

test('triageOov：三档判定与教研语言标签', () => {
  const t = parseZipfTable(TSV);
  // 漏词史三例（调研〇-3）：v0.3→v0.6 补录的高频词，分诊应全部亮"疑似漏收"
  for (const w of ['bike', 'flood', 'onto', 'government']) {
    const r = triageOov(w, t);
    assert.equal(r.triage, 'suspect', `${w} zipf=${r.zipf}`);
    assert.match(r.label, /疑似漏收/);
  }
  assert.equal(triageOov('tortoise', t).triage, 'mid'); // 3.26 中频带
  assert.match(triageOov('tortoise', t).label, /中频/);
  const rare = triageOov('zxqvj', t); // 查无（<3.0）
  assert.equal(rare.triage, 'rare');
  assert.equal(rare.zipf, null);
  assert.match(rare.label, /真生词/);
});

test('AoA 双信号分诊（Kuperman 2012 常模）：高频且在常模内才亮疑似漏收，常模外专名降级降噪', () => {
  const zt = parseZipfTable(TSV);
  const aoaPath = join(ROOT, 'assets', 'wordfreq', 'en_aoa.tsv');
  const at = parseZipfTable(readFileSync(aoaPath, 'utf-8'));
  // aoaOf：家族兜底（running→run 在常模）
  assert.notEqual(aoaOf('running', at), null);
  // 双确认：government zipf 5.6 + AoA 8.5 在常模 → suspect 且 label 带习得年龄
  const gov = triageOov('government', zt, at);
  assert.equal(gov.triage, 'suspect');
  assert.ok(gov.aoa !== null && Math.abs(gov.aoa - 8.5) < 0.2, `aoa=${gov.aoa}`);
  assert.match(gov.label, /岁习得/);
  // 降噪：harry zipf 4.7 但常模查无（人名不在 30k 实词常模）→ 降级 mid'高频·常模外'
  const harry = triageOov('harry', zt, at);
  assert.equal(harry.triage, 'mid', `harry zipf=${harry.zipf} aoa=${harry.aoa}`);
  assert.equal(harry.aoa, null);
  assert.match(harry.label, /常模外/);
  // 向后兼容：未提供 AoA 表时维持单信号（harry 仍 suspect——旧口径不回归）
  assert.equal(triageOov('harry', zt).triage, 'suspect');
});

test('阈值与档位序常量：suspect ≥ 4.0 > mid ≥ 3.0，档位递增', () => {
  assert.equal(SUSPECT_ZIPF, 4.0);
  assert.equal(MID_ZIPF, 3.0);
  assert.ok(TRIAGE_RANK.suspect < TRIAGE_RANK.mid && TRIAGE_RANK.mid < TRIAGE_RANK.rare);
});

test('layer_qc 接入真实资产表：OOV 清单逐词带 zipf 与分诊；不接表时保持旧 schema', () => {
  const bundled = [
    readFileSync(join(ROOT, 'assets', 'wordlists', 'curriculum_2022_level3_1600.txt'), 'utf-8'),
    readFileSync(join(ROOT, 'assets', 'wordlists', 'curriculum_2022_amendment.txt'), 'utf-8'),
  ];
  const lex = buildMcpLexicon({}, bundled);
  const md = readFileSync(join(ROOT, 'examples', 'evals', 'eval01_the_rematch', 'source.md'), 'utf-8');
  const table = parseZipfTable(TSV);

  const withTable = toolQcText(md, lex, 50, undefined, table);
  const items = withTable.OOV清单前N as { word: string; zipf: number | null; 分诊: string }[];
  const tortoise = items.find((x) => x.word === 'tortoise');
  assert.ok(tortoise, 'eval01 的 tortoise 应在 OOV 清单');
  assert.equal(tortoise.zipf, 3.26);
  assert.match(tortoise.分诊, /中频/);
  assert.ok(String(withTable.OOV分诊口径).includes('疑似漏收'));

  const noTable = toolQcText(md, lex, 50, undefined, undefined);
  assert.equal(noTable.OOV分诊口径, undefined); // 未注表 → 无分诊字段
  // 红线回归：分诊不碰判定——两个版本的指标与 OOV 词完全一致
  assert.deepEqual(
    (withTable.OOV清单前N as { word: string }[]).map((x) => x.word),
    (noTable.OOV清单前N as { word: string }[]).map((x) => x.word),
  );
  assert.equal(withTable['②生词率(词型口径)'], noTable['②生词率(词型口径)']);
});

test('纯构造表：高频未收即疑似漏收候选（判定仍以词库表为准）', () => {
  const lex = lexiconFromWords([]); // 空词库：government 判 OOV
  const table = parseZipfTable('government\t557\n');
  const r = toolQcText('The government made a plan.', lex, 10, undefined, table);
  const gov = (r.OOV清单前N as { word: string; triage?: string; 分诊?: string }[]).find((x) => x.word === 'government');
  assert.ok(gov);
  assert.match(gov.分诊!, /疑似漏收/); // 只出候选：教师核对后由「学生已学过」入库，判定不动
});
