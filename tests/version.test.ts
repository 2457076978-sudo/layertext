/**
 * 正文版本节点与「改正文」唯一事务 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 1）：
 *   「风险组、单句建议和确定性补注全部走同一个 `applyChange` 事务；
 *     事务写入 draft version、decision event、audit row，失败显示可行动原因并保持原卡片。」
 *   「任何门禁失败均不改变正文」「所有发布段可由 `sourceVersion + traceId` 重放」
 * 代码纪律 1：「任何写正文的函数必须同时接收 `baseVersion` 并返回新版本 ID；
 *   禁止隐式修改当前文件。」
 *
 * 每条用例都**先构造一个能触发旧缺陷的真实输入**，再断言新行为——
 * 只测正常路径的用例在这里没有价值（那正是 495 项全绿却仍带着 8 个真缺陷的原因）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyChange,
  applyChangeBatch,
  baseVersionOf,
  currentVersionOf,
  ledgerIsLive,
  latestVersion,
  parseVersionLog,
  provenanceOf,
  recordOnly,
  replayByTrace,
  replaySegment,
  stateOfChange,
  versionIdOf,
  type ChangeStep,
  type TxIo,
  type VersionNode,
} from '../src/core/version.js';
import { actionOf } from '../src/core/riskaction.js';
import { parseDecisionLog } from '../src/core/decision.js';

/* ────────────────────── 假 IO ────────────────────── */

interface FakeFs {
  files: Record<string, string>;
  /** 让某次写入失败（模拟磁盘满 / 权限 / 日志目录被删） */
  failWrite?: (path: string) => boolean;
  /** 备份调用记录 */
  backups: string[];
  io: TxIo;
}

function fakeFs(initial: Record<string, string>, failWrite?: (p: string) => boolean): FakeFs {
  const files: Record<string, string> = { ...initial };
  const backups: string[] = [];
  const io: TxIo = {
    read: (p) => (p in files ? Promise.resolve(files[p]!) : Promise.reject(new Error(`ENOENT ${p}`))),
    write: (p, c) => {
      if (failWrite?.(p)) return Promise.reject(new Error(`EACCES ${p}`));
      files[p] = c;
      return Promise.resolve();
    },
    backup: (p, c) => {
      backups.push(p);
      files[`${p}.bak`] = c;
      return Promise.resolve();
    },
    now: () => '2026-09-11T10:00:00.000Z',
  };
  return { files, failWrite, backups, io };
}

/* ────────────────────── 夹具 ────────────────────── */

const DOC = `# Animal Farm

## Chapter One

[P01] Mr Jones locked the hen-houses. (鸡舍)
[P02] The windmill was broken and the animals were very tired of working.

## 词句卡

- windmill（风车）
`;

const DOC_PATH = '/out/第一章/原文_A层85_2026-09-11.md';
const VER_PATH = '/work/_版本/A层85.jsonl';
const DEC_PATH = '/work/_决定/A层85.jsonl';

const ARGS = {
  runId: 'Animal Farm-v1-A层85-wayne-abc',
  baseVersion: baseVersionOf(DOC),
  docPath: DOC_PATH,
  versionPath: VER_PATH,
  decisionPath: DEC_PATH,
  teacherId: 'wayne',
  sourceVersion: 'sha-1',
  traceId: 'trace-abcd1234',
};

const target = (over: Partial<{ segId: string; word: string; ruleId: string; itemId: string }> = {}) => ({
  segId: 'P01',
  chapter: '第一章',
  word: undefined as string | undefined,
  ruleId: 'ANNO-01',
  itemId: '第一章#0:ANNO-01:windmill',
  ...over,
});

const readNodes = (fs: FakeFs): VersionNode[] => parseVersionLog(fs.files[VER_PATH] ?? '').nodes;

/* ────────────────────── ① 版本节点：写正文必出父版本 ────────────────────── */

test('★ 一次成功的改动：正文、版本节点、决定事件三者同时落盘且互为外键', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, {
    ...ARGS,
    target: target({ segId: 'P02', word: 'windmill' }),
    action: actionOf('ANNO-01'),
    word: 'windmill',
    zh: '风车',
  });

  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;
  assert.match(fs.files[DOC_PATH]!, /windmill（风车）/, '正文里该词已加注');

  const nodes = readNodes(fs);
  assert.equal(nodes.length, 1);
  const n = nodes[0]!;
  assert.equal(n.version, r.version, '返回的版本 ID 就是账上的版本 ID');
  assert.equal(n.parent, ARGS.baseVersion, '父版本 = 调用方基于的那一版');
  assert.equal(n.eventId, r.eventId, '版本节点记的事件 ID = 决定事件 ID');

  const ev = parseDecisionLog(fs.files[DEC_PATH]!).events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.eventId, r.eventId, '决定事件记的 ID = 事务返回的 ID');
  assert.equal(ev[0]!.version, r.version, '决定事件回指版本节点');
  assert.equal(ev[0]!.traceId, 'trace-abcd1234', 'traceId 落进事件，发布段可由此重放');
});

test('版本 ID 内容寻址：同一份正文同一个 ID；改一个字节就换 ID', () => {
  assert.equal(baseVersionOf(DOC), baseVersionOf(DOC));
  assert.notEqual(baseVersionOf(DOC), baseVersionOf(DOC + ' '));
  assert.notEqual(versionIdOf(1, DOC), versionIdOf(2, DOC), '序号不同则版本不同');
});

test('第二次改动挂在第一次的版本上（父 = 上一版），不是又挂回底稿', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const a1 = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  assert.equal(a1.status, 'applied');
  if (a1.status !== 'applied') return;

  const a2 = await applyChange(fs.io, {
    ...ARGS,
    baseVersion: a1.version,
    target: target({ segId: 'P01', word: 'hen-houses', ruleId: 'ANNO-01', itemId: '第一章#0:ANNO-01:hen-houses' }),
    action: actionOf('ANNO-01'),
    word: 'hen-houses',
    zh: '鸡舍',
  });
  assert.equal(a2.status, 'applied');
  if (a2.status !== 'applied') return;
  const nodes = readNodes(fs);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[1]!.parent, nodes[0]!.version, '第二个节点的父是第一个');
  assert.notEqual(a1.version, a2.version);
});

/* ────────────────────── ② 乐观并发：baseVersion 对不上就一个字符都不写 ────────────────────── */

test('★ baseVersion 对不上（别人先改过）→ 拒绝，正文一个字符都不动', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  // 先把正文改掉（模拟另一位教师/外部脚本已经写过了），但调用方还拿着旧版本
  const changed = DOC.replace('was broken', 'was smashed');
  fs.files[DOC_PATH] = changed;

  const r = await applyChange(fs.io, {
    ...ARGS,
    target: target({ segId: 'P02', word: 'windmill' }),
    action: actionOf('ANNO-01'),
    word: 'windmill',
    zh: '风车',
  });

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'stale');
  assert.equal(r.docTouched, false, '**一个字符都没写**');
  assert.equal(fs.files[DOC_PATH], changed, '正文与改前逐字节相等');
  assert.equal(readNodes(fs).length, 0, '没有产生任何版本节点');

  const ev = parseDecisionLog(fs.files[DEC_PATH]!).events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.decision, 'rejected', '失败留痕');
  assert.match(ev[0]!.reason, /稿件已经改过/);
});

test('★ 事务之外有人改过稿 → 当前版本自动降级为内容寻址的新底稿，账本不再算数', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;

  const nodes = readNodes(fs);
  assert.equal(ledgerIsLive(nodes, fs.files[DOC_PATH]!), true, '刚写完时账本对得上正文');

  // 有人在事务之外直接覆盖了正文（手工编辑 / 重新生成 / 外部脚本）
  const outside = fs.files[DOC_PATH]!.replace('[P01]', '[P01] Uncle ');
  assert.equal(ledgerIsLive(nodes, outside), false, '账本对不上了');
  assert.equal(currentVersionOf(nodes, outside), baseVersionOf(outside), '当前版本降级为这份内容自己的哈希——**外来的覆盖自动可见**，而不是被旧版本号盖住');
  assert.notEqual(currentVersionOf(nodes, outside), r.version);
});

/* ────────────────────── ③ 门禁闸：没过就不写正文 ────────────────────── */

test('★ 门禁失败不改变正文（阶段 1 验收原文）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' }, () => ({
    ok: false,
    reason: 'SENT-01 有 1 句超过本层 12 词上限',
  }));

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'blocked');
  assert.equal(r.docTouched, false);
  assert.equal(fs.files[DOC_PATH], DOC, '正文逐字节未变');
  assert.equal(readNodes(fs).length, 0, '被闸拦下不产生版本节点');
  assert.equal(stateOfChange(r), 'blocked', '三态里它是 blocked，不是 candidate');
  assert.match(parseDecisionLog(fs.files[DEC_PATH]!).events[0]!.reason, /SENT-01/);
});

test('闸看得到的是**改动之后**的正文，不是改动之前的', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  let seen = '';
  await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' }, (i) => {
    seen = i.nextDoc;
    return { ok: true };
  });
  assert.match(seen, /windmill（风车）/, '闸拿到的是候选稿');
  assert.equal(fs.files[DOC_PATH], seen, '闸放行后写进去的就是它看过的那份——**判的和写的必须是同一个字符串**');
});

/* ────────────────────── ④ 动作失败：留痕 + 卡片不消失 + 正文不动 ────────────────────── */

test('★ 找不到位置 → rejected 事件 + 正文不动（卡片留在待办里）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, {
    ...ARGS,
    target: target({ segId: 'P09', word: 'windmill' }),
    action: actionOf('ANNO-01'),
    word: 'windmill',
    zh: '风车',
  });
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'not-found');
  assert.equal(fs.files[DOC_PATH], DOC);
  const ev = parseDecisionLog(fs.files[DEC_PATH]!).events;
  assert.equal(ev[0]!.decision, 'rejected');
  assert.equal(ev[0]!.itemId, '第一章#0:ANNO-01:windmill', '留痕带 itemId —— 撤销与"重开还回到同一条"都靠它');
});

test('释义缺失 → missing-arg，不是"静默什么都不做"', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, {
    ...ARGS,
    target: target({ segId: 'P02', word: 'windmill' }),
    action: actionOf('ANNO-01'),
    word: 'windmill',
  });
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'missing-arg');
  assert.match(r.reason, /统一词典|释义/);
});

/* ────────────────────── ⑤ 账写不上 → 回滚正文 ────────────────────── */

test('★ 版本日志写失败 → 正文改回原样，且不写回滚节点（因为根本没落过账）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC }, (p) => p === VER_PATH);
  const r = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.docTouched, false, '回滚成功 = 正文没被改动过');
  assert.equal(fs.files[DOC_PATH], DOC, '正文逐字节回到改前');
  assert.equal(fs.backups.length, 1, '改之前先备份过——不可逆的操作有退路');
});

test('★ 决定日志写失败 → 正文改回原样 + 写一条回滚节点（**只有真回滚了才写**）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC }, (p) => p === DEC_PATH);
  const r = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });

  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(fs.files[DOC_PATH], DOC, '正文回到原样');
  const nodes = readNodes(fs);
  assert.equal(nodes.length, 2, '先是那条描述"改了"的节点，再是回滚节点');
  assert.equal(nodes[0]!.kind, 'apply');
  const rb = nodes[1]!;
  assert.equal(rb.kind, 'rollback');
  assert.equal(rb.rollsBack, nodes[0]!.version, '回滚节点指明它作废的是哪一条');
  assert.equal(rb.contentHash, nodes[0]!.parentHash, '回滚节点的"改后"就是原来的"改前"');
  // ★ 关键：回滚之后**有效链是空的**——"当前版本"回到内容寻址的底稿，
  //   而不是停在一条事实上没发生的改动上（否则账实不符）。
  assert.equal(latestVersion(nodes), null);
  assert.equal(currentVersionOf(nodes, fs.files[DOC_PATH]!), ARGS.baseVersion);
});

/* ────────────────────── ⑥ 重放 ────────────────────── */

test('★ 发布段可由 sourceVersion + traceId 重放（阶段 1 验收原文）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChange(fs.io, {
    ...ARGS,
    target: target({ segId: 'P02', word: 'windmill' }),
    action: actionOf('ANNO-01'),
    word: 'windmill',
    zh: '风车',
  });
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;

  const rep = replayByTrace(readNodes(fs), 'sha-1', 'trace-abcd1234');
  assert.equal(rep.found, true);
  assert.equal(rep.consistent, true);
  assert.equal(rep.text, 'The windmill（风车） was broken and the animals were very tired of working.');
  assert.equal(rep.node!.version, r.version, '重放给出的是哪一版');

  assert.equal(replayByTrace(readNodes(fs), 'sha-1', '不存在的-trace').found, false, '查不到就如实说查不到');
  assert.equal(replayByTrace(readNodes(fs), '别的源版本', 'trace-abcd1234').found, false, 'sourceVersion 也要对上');
});

test('★ 版本链断了（账本被裁剪/被动过）必须报出来，而不是照常给一个字符串', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const a1 = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  assert.equal(a1.status, 'applied');
  if (a1.status !== 'applied') return;
  await applyChange(fs.io, {
    ...ARGS,
    baseVersion: a1.version,
    target: target({ segId: 'P02', word: 'windmill', ruleId: 'ANNO-03', itemId: 'x:ANNO-03' }),
    action: actionOf('ANNO-03'),
    word: 'windmill',
    zh: '磨坊风车',
  });

  const nodes = readNodes(fs);
  assert.equal(replaySegment(nodes, 'P02').consistent, true, '正常时链条自洽');

  // 抽掉中间那条（模拟日志被裁剪）
  const holed = [nodes[0]!, { ...nodes[1]!, segBefore: '被人改过的文本' }];
  const rep = replaySegment(holed, 'P02');
  assert.equal(rep.consistent, false, '断链必须被检出');
  assert.equal(rep.brokenAt, holed[1]!.version);
  assert.match(provenanceOf(holed, 'P02'), /版本链断了/);
});

test('provenanceOf：一段现在这一版是哪来的（运行/规则/教师/时间/源版本/trace）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  const line = provenanceOf(readNodes(fs), 'P02');
  for (const bit of ['P02', 'v0001-', 'ANNO-01', 'wayne', 'sha-1', 'trace-abcd1234', '第 1 次改动']) {
    assert.equal(line.includes(bit), true, `provenance 缺「${bit}」：${line}`);
  }
  assert.match(provenanceOf(readNodes(fs), 'P07'), /没有改动过这一段/);
});

/* ────────────────────── ⑦ 不改正文的决定 ────────────────────── */

test('★ 只记录的决定**不产生版本节点**（正文没变就不该在正文的账上多一笔），但仍回答"当时是哪一版"', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await recordOnly(fs.io, {
    ...ARGS,
    target: target({ segId: 'P01', ruleId: 'FACT-01', itemId: '第一章#0:FACT-01:1911' }),
    action: actionOf('FACT-01'),
    decision: 'accept',
    reason: '记录决定，正文不变（数字删减由教师判断是否可接受）',
  });
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;
  assert.equal(r.version, ARGS.baseVersion, '返回的是未变的当前版本');
  assert.equal(fs.files[VER_PATH], undefined, '没有版本日志文件');
  assert.equal(fs.files[DOC_PATH], DOC, '正文未变');
  const ev = parseDecisionLog(fs.files[DEC_PATH]!).events;
  assert.equal(ev[0]!.version, ARGS.baseVersion, '事件回答"当时是哪一版"');
});

test('只记录的决定照样核对 baseVersion：稿件改过就拒', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC.replace('was broken', 'was smashed') });
  const r = await recordOnly(fs.io, {
    ...ARGS,
    target: target({ segId: 'P01', ruleId: 'FACT-01' }),
    action: actionOf('FACT-01'),
    decision: 'accept',
    reason: 'x',
  });
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'stale');
  assert.equal(parseDecisionLog(fs.files[DEC_PATH]!).events[0]!.decision, 'rejected');
});

/* ────────────────────── ⑧ 批量：同一个事务，一条路径 ────────────────────── */

const steps = (): ChangeStep[] => [
  { target: target({ segId: 'P02', word: 'windmill', itemId: 'a:ANNO-01' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' },
  { target: target({ segId: 'P01', word: 'hen-houses', itemId: 'b:ANNO-01' }), action: actionOf('ANNO-01'), word: 'hen-houses', zh: '鸡舍' },
];

test('★ 批量：一章只写一次盘、只出一条版本节点（kind=batch），事件逐条记', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChangeBatch(fs.io, { ...ARGS, steps: steps() });
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;
  assert.equal(r.applied, 2);
  assert.equal(r.rejected, 0);
  const nodes = readNodes(fs);
  assert.equal(nodes.length, 1, '一条节点代表这一章的一批改动');
  assert.equal(nodes[0]!.kind, 'batch');
  assert.match(fs.files[DOC_PATH]!, /windmill（风车）/);
  assert.match(fs.files[DOC_PATH]!, /hen-houses（鸡舍）/);
  assert.equal(parseDecisionLog(fs.files[DEC_PATH]!).events.length, 2, '每条改动一条事件');
});

test('★ 批量里有一条做不成：其余照做、那一条留 rejected、**不静默跳过**、最后如实报几成几败', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChangeBatch(fs.io, {
    ...ARGS,
    steps: [...steps(), { target: target({ segId: 'P02', word: '不存在的词', itemId: 'c:ANNO-01' }), action: actionOf('ANNO-01'), word: '不存在的词', zh: 'x' }],
  });
  assert.equal(r.status, 'applied');
  if (r.status !== 'applied') return;
  assert.equal(r.applied, 2);
  assert.equal(r.rejected, 1);
  assert.equal(r.rejectedItems[0]!.itemId, 'c:ANNO-01');
  const ev = parseDecisionLog(fs.files[DEC_PATH]!).events;
  assert.equal(ev.filter((e) => e.decision === 'rejected').length, 1, '失败的那条确实留了痕');
  assert.equal(ev.filter((e) => e.decision === 'accept').length, 2);
});

test('★ 批量整体被闸拦下 → 一条都不写，正文不动', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChangeBatch(fs.io, { ...ARGS, steps: steps() }, () => ({ ok: false, reason: 'ZH-01 正文混入中文' }));
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'blocked');
  assert.equal(fs.files[DOC_PATH], DOC);
  assert.equal(readNodes(fs).length, 0);
});

test('批量写正文失败 → 一条都没成，全部留 rejected（绝不显示成已办）', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC }, (p) => p === DOC_PATH);
  const r = await applyChangeBatch(fs.io, { ...ARGS, steps: steps() });
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'write-failed');
  assert.equal(parseDecisionLog(fs.files[DEC_PATH]!).events.filter((e) => e.decision === 'rejected').length, 2);
});

test('空批量不当成成功', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const r = await applyChangeBatch(fs.io, { ...ARGS, steps: [] });
  assert.equal(r.status, 'rejected');
  if (r.status !== 'rejected') return;
  assert.equal(r.kind, 'no-op');
});

/* ────────────────────── ⑨ 三态 ────────────────────── */

test('三态是**一条链路**上的三个位置，不是三个模块各自的说法', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  // 门禁没过 → blocked（候选本来就不合格）
  const blocked = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' }, () => ({
    ok: false,
    reason: 'SENT-01 超长句',
  }));
  assert.equal(stateOfChange(blocked), 'blocked');

  // 做不成（位置没了）→ candidate：它只是"这次没做成"，不是"候选不合格"
  const candidate = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P09' }), action: actionOf('ANNO-01'), word: 'w' });
  assert.equal(stateOfChange(candidate), 'candidate', '做不成 ≠ 被门禁拦');

  const applied = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  assert.equal(stateOfChange(applied), 'applied');
});

/* ────────────────────── ⑩ 两个版本日志互不干扰（并发教师） ────────────────────── */

test('两位教师各自的运行：版本号与父版本都在各自的账本里，不会互相当成父版本', async () => {
  const fs = fakeFs({ [DOC_PATH]: DOC });
  const other = '/work/_版本/A层85_teacher2.jsonl';
  const r1 = await applyChange(fs.io, { ...ARGS, target: target({ segId: 'P02', word: 'windmill' }), action: actionOf('ANNO-01'), word: 'windmill', zh: '风车' });
  assert.equal(r1.status, 'applied');
  if (r1.status !== 'applied') return;

  // 第二本账是空的 → 它的"当前版本"是正文的内容哈希，而不是第一本账的 v0001
  const fs2 = fakeFs({ [DOC_PATH]: fs.files[DOC_PATH]! });
  const base2 = currentVersionOf([], fs2.files[DOC_PATH]!);
  assert.equal(base2, baseVersionOf(fs.files[DOC_PATH]!), '空账本时当前版本 = 内容哈希');

  const r2 = await applyChange(fs2.io, {
    ...ARGS,
    baseVersion: base2,
    versionPath: other,
    target: target({ segId: 'P02', word: 'windmill', ruleId: 'ANNO-03', itemId: 'x:ANNO-03' }),
    action: actionOf('ANNO-03'),
    word: 'windmill',
    zh: '磨坊',
  });
  assert.equal(r2.status, 'applied');
  if (r2.status !== 'applied') return;
  assert.equal(r2.version, versionIdOf(1, fs2.files[DOC_PATH]!), '第二本账从 v0001 起，不接着第一本编');
  assert.equal(parseVersionLog(fs.files[other] ?? '').nodes.length, 0, '第二本账不写进第一本');
  assert.equal(readNodes(fs).length, 1, '第一本账仍然只有一条');
});
