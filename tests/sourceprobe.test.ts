/**
 * 源完整性探针（src/core/sourceprobe.ts）——项 4 验收 4a。
 * ch10 型残缺（词数骤降 + 断章）与词表碎片混入是两次真实事故的形态；
 * 正常章（含歌词段）不许误杀——探针是过程闸门，宁漏勿误杀。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeChapterSource } from '../src/core/sourceprobe.js';

/** 造一章"正常"文本：指定词数量级、以句号收尾 */
function normalCh(n: number, words = 40): string {
  const paras: string[] = [];
  for (let p = 0; p < n; p++) {
    const sents: string[] = [];
    for (let s = 0; s < Math.ceil(words / 8); s++) sents.push('The animals worked hard and the farm moved on quietly that year.');
    paras.push(`[P${String(p + 1).padStart(2, '0')}] ${sents.join(' ')}`);
  }
  return paras.join('\n\n');
}

test('①词数骤降：ch10 型残缺（词数不足相邻章一半）被点名，两侧正常章不误报', () => {
  const r = probeChapterSource([
    { name: '九', text: normalCh(10) },
    { name: '十', text: normalCh(1) }, // 只有 ~1 段，词数远小于九章
    { name: '十一', text: normalCh(10) },
  ]);
  assert.equal(r[1].ok, false, '残缺章必须被点名');
  assert.ok(
    r[1].suspects.some((s) => s.probe === '词数骤降'),
    JSON.stringify(r[1].suspects),
  );
  assert.equal(r[0].ok, true, '正常章不许误报');
  assert.equal(r[2].ok, true, '正常章不许误报');
});

test('②章末无收束：断在句中（逗号收尾）被点名', () => {
  const text = normalCh(3) + '\n\n[P04] Then the animals saw the great horse lying in the field, and the';
  const r = probeChapterSource([{ name: '一', text }]);
  const s = r[0].suspects.find((x) => x.probe === '章末无收束');
  assert.ok(s, '断章必须被点名');
  assert.match(s!.message, /收尾/);
});

test('②章末无收束：悬垂连词（that）收尾被点名', () => {
  const text = normalCh(2) + '\n\n[P03] The pigs announced a new rule that changed everything on the farm and everyone believed';
  const r = probeChapterSource([{ name: '一', text }]);
  assert.ok(
    r[0].suspects.some((x) => x.probe === '章末无收束'),
    JSON.stringify(r[0].suspects),
  );
});

test('②章末无收束：以句号/引语正常收尾的章不报（含曲引号收尾）', () => {
  const ok1 = probeChapterSource([{ name: '一', text: normalCh(3) }]);
  assert.equal(ok1[0].suspects.filter((x) => x.probe === '章末无收束').length, 0);
  const ok2 = probeChapterSource([{ name: '一', text: normalCh(2) + '\n\n[P03] “All animals are equal,” said Napoleon, and nobody argued again.”' }]);
  assert.equal(ok2[0].suspects.filter((x) => x.probe === '章末无收束').length, 0, JSON.stringify(ok2[0].suspects));
});

test('③碎片残留：连续孤词行（课题词表碎片形态）被点名，单行/两行不报', () => {
  const frag = normalCh(2) + '\n\nElaborate\nExpound\nElucidate\nAmbiguous\n' + normalCh(1).slice(5);
  const r = probeChapterSource([{ name: '三', text: frag }]);
  const s = r[0].suspects.find((x) => x.probe === '碎片残留');
  assert.ok(s, '4 连孤词行必须被点名');
  assert.match(s!.message, /4 行/);
  // 只有两行 → 不报（阈值 ≥3，宁漏勿误杀）
  const frag2 = normalCh(2) + '\n\nElaborate\nExpound\n' + normalCh(1).slice(5);
  const r2 = probeChapterSource([{ name: '三', text: frag2 }]);
  assert.equal(r2[0].suspects.filter((x) => x.probe === '碎片残留').length, 0);
});

test('③碎片残留：歌词行（带逗号/句号）不误杀', () => {
  const song = normalCh(1) + '\n\n[P02] Beasts of England, beasts of Ireland,\nBeasts of every land and clime,\nHearken to my joyful tiding,\nOf the golden future time.';
  const r = probeChapterSource([{ name: '七', text: song }]);
  assert.equal(r[0].suspects.filter((x) => x.probe === '碎片残留').length, 0, JSON.stringify(r[0].suspects));
});

test('正常的一组章：零疑点（整本 ok）', () => {
  const r = probeChapterSource([
    { name: '一', text: normalCh(5) },
    { name: '二', text: normalCh(5) },
    { name: '三', text: normalCh(4) },
  ]);
  assert.deepEqual(
    r.map((x) => x.ok),
    [true, true, true],
    JSON.stringify(r.flatMap((x) => x.suspects)),
  );
});
