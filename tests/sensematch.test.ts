/**
 * 词典多义项本地消歧 · 测试（Wayne 提案：词重叠匹配，不依赖 LLM）
 * 夹具 = macOS 系统词典真实词条原文（牛津英汉体例）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSenses, pickSense, leskScore } from '../src/core/sensematch.js';

const BAR =
  'bar | BrE bɑː, AmE bɑr | A. noun ① (strip of wood, metal) 长条 chángtiáo▸ the gate had a bar across it 大门上着门闩▸ behind bars 在狱中 ② (block) (of soap, chocolate etc.) 块 kuài▸ a bar of gold 一根金条 ③ (place for drinking) 酒吧 jiǔbǎ ④ (counter) 吧台 bātái ⑤ (obstacle) 障碍 zhàng\u0027ài▸ a bar on people coming here to live 人们来这里居住的障碍 B. transitive verb ① (fasten) 闩上 shuānshang ‹door›② (block) 阻挡 zǔdǎng ‹way›▸ the police barred the entrance 警察封锁了入口 ③ (exclude) 禁止 jìnzhǐ';
const PERCH = 'perch 1 | BrE pəːtʃ, AmE pərtʃ | noun plural perch or perches Zoology 鲈鱼 lúyú ';

test('parseSenses：词性分节+圈号义项+中文释义+例句提取', () => {
  const s = parseSenses(BAR);
  assert.ok(s.length >= 7, `义项数应 ≥7（实得 ${s.length}）`);
  assert.equal(s[0]!.pos, 'noun');
  assert.equal(s[0]!.zh, '长条');
  assert.equal(s[2]!.zh, '酒吧');
  assert.ok(
    s[0]!.examples.some((e) => e.includes('gate had a bar')),
    '例句是 Lesk 原料',
  );
  assert.ok(s[5]!.pos.startsWith('transitive'), '动词节切出');
});

test('pickSense：bars 在"农场大门"语境选中门闩义而非酒吧（例句重叠判别）', () => {
  const s = parseSenses(BAR);
  const r = pickSense('The animals burst through the bars of the gate and chased the men down the road.', s);
  assert.ok(r.sense, '应能决出义项');
  assert.notEqual(r.sense!.zh, '酒吧');
  assert.notEqual(r.sense!.zh, '吧台');
  assert.equal(r.sense!.zh, '长条', '命中"the gate had a bar across it"例句的 gate 重叠');
});

test('pickSense：语境无重叠=歧义不决（报教师，不硬选）', () => {
  const s = parseSenses(BAR);
  const r = pickSense('It was a very cold night.', s);
  assert.equal(r.ambiguous, true);
  assert.equal(r.sense, undefined);
});

test('pickSense：单义项词条直接采用（perch 系统词典只有鱼义——教师正本优先级在调用方）', () => {
  const s = parseSenses(PERCH);
  assert.equal(s.length, 1);
  const r = pickSense('The birds jumped on to their perches.', s);
  assert.equal(r.sense!.zh, '鲈鱼');
  assert.equal(r.ambiguous, false, '单义项机械采用（正本已由教师给栖木，轮不到这里）');
});

test('leskScore：‹›搭配词参与计分', () => {
  const s = parseSenses(BAR);
  const fasten = s.find((x) => x.zh === '闩上')!;
  assert.ok(leskScore('He barred the door with a heavy stick.', fasten) > 0, 'door 搭配命中');
});
