/**
 * 「AI 简化本章」回炉模式（项 1 验收 1b/1c/1e）——DI 直测 simplifyChapterCore：
 * chat 与 oovOf 都是注入位（生产路径用真 callChat 与 S.currentKnown），node 下不需要 mockIPC。
 * 断言三件事：①非红项段一字不动 ②过闸段被替换 ③AI 两次都不过闸的段保留原文并计数挂起。
 */
import './_dom_env.js'; // 必须第一个：uikit 等在顶层挂 window 事件
import test from 'node:test';
import assert from 'node:assert/strict';
/* app 模块一律动态 import（?raw 钩子在 _dom_env 求值时注册） */
const { simplifyChapterCore } = await import('../app/src/batch.js');

const MD = `# 测试书

## Chapter One

[P01] The animals worked hard and the farm moved on quietly.

[P02] The farmzxxx animals ran home fast today.

[P03] The animals worked and worked and the farm grew and the seasons turned and the years passed by slowly.
`;

/** 可控红词口径：farmzxxx / hardxxx 是生词（注释过的除外） */
const oovOf = (t: string): string[] => {
  const ann = new Set([...t.matchAll(/([A-Za-z][A-Za-z-]*)（[^）]*）/g)].map((m) => m[1].toLowerCase()));
  const out: string[] = [];
  for (const tok of t.replace(/（[^）]*）/g, ' ').match(/[A-Za-z]+/g) ?? []) {
    const w = tok.toLowerCase();
    if (w.length < 3) continue;
    if (ann.has(w)) continue;
    if (w === 'farmzxxx' || w === 'hardxxx') out.push(w);
  }
  return out;
};

test('1b/1e：回炉模式只改红项段——非红段一字不动，无红项时整章原样返回', async () => {
  const cleanMd = `# 干净书\n\n## Chapter One\n\n[P01] The animals worked hard.\n`;
  const r = await simplifyChapterCore(cleanMd, '', () => undefined, undefined, {
    mode: 'rework',
    chat: (() => {
      throw new Error('干净章不该发 AI');
    }) as never,
    oovOf,
  });
  assert.equal(r.md, cleanMd, '无红项段：产物与原文逐字节一致，零 AI 调用');
  assert.equal(r.rework?.redCount, 0);
});

test('1b/1c：红项段过闸替换、不过闸挂起保留原文——非红段一字不动', async () => {
  let calls = 0;
  const fakeChat = (async (_msgs: unknown, _n: number, _s: undefined, scene: string) => {
    calls++;
    assert.equal(scene, 'AI 简化本章·回炉');
    if (calls === 1) return { content: '[P02] The animals ran home fast today.', usage: '10 出' };
    // P03 两次都原样返回（修不动超长句）→ 挂起
    return { content: '[P03] The animals worked and worked and the farm grew and the seasons turned and the years passed by slowly.', usage: '10 出' };
  }) as never;
  const r = await simplifyChapterCore(MD, '', () => undefined, undefined, { mode: 'rework', chat: fakeChat, oovOf });
  const segs = r.md.split(/\n\s*\n/).filter((x) => x.startsWith('[P'));
  assert.equal(segs.length, 3);
  assert.equal(segs[0], '[P01] The animals worked hard and the farm moved on quietly.', '非红项段一字不动');
  assert.equal(segs[1], '[P02] The animals ran home fast today.', '过闸的红项段被替换');
  assert.equal(segs[2].startsWith('[P03] The animals worked and worked'), true, '挂起段保留原文');
  assert.equal(r.rework?.redCount, 2, 'P02（生词）+ P03（超长句）都是红项段');
  assert.equal(r.rework?.fixed, 1);
  assert.equal(r.rework?.hung.length, 1);
  assert.equal(r.rework?.hung[0].id, 'P03');
  assert.equal(r.rework?.hung[0].cls, '句长超线', JSON.stringify(r.rework?.hung[0]));
  assert.equal(calls, 3, 'P02 一次过闸 + P03 两次（重试一次）');
});

test('1c：注释不丢闸——修订版丢了已有注释会被拒（重试一次仍丢则挂起）', async () => {
  const md = `# 书\n\n## Chapter One\n\n[P01] The farmzxxx（某词） hardxxx animals ran home.\n`;
  let n = 0;
  const fakeChat = (async () => {
    n++;
    return { content: '[P01] The animals ran home.', usage: '1 出' }; // 每次都丢注释
  }) as never;
  const r = await simplifyChapterCore(md, '', () => undefined, undefined, { mode: 'rework', chat: fakeChat, oovOf });
  assert.ok(r.md.includes('farmzxxx（某词）'), '挂起段保留原文（含注释）');
  assert.equal(r.rework?.hung[0].cls, '注释丢失', JSON.stringify(r.rework?.hung[0])); // 红词 1→0 过了，卡在注释闸
  assert.equal(n, 2);
});
