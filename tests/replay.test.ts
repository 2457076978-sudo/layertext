/**
 * 真项目回放层 · 测试
 *
 * 来源：《LayerText 工程优化总计划》「最关键的代码纪律」第 5 条 ——
 *   「测试分成纯函数、事务故障、**真项目回放**三层；495 项全绿是底线，不是产品完成标准。」
 *
 * ── 这一层在守什么 ──────────────────────────────────────────────────────
 * 前两层（纯函数、事务故障）问的是"这段代码对不对"；它们**回答不了**
 * "我们报给教师的那些数还对不对"。而项目里到处写着的那些数——
 * A 层第一章 SENT-01 = 19 句、阅读负荷下降 28%、理解支架覆盖率 96%、
 * 风险队列 70 条压成 19 组——**此前没有任何东西在守着它们**。
 * 一次重构让覆盖率悄悄从 96% 变成 93%，没人会发现，直到有人拿它去写论文。
 *
 * 所以这一层做的事很朴素：**把真项目的一份输入冻下来、把从它算出来的结论也冻下来**，
 * 每次跑测试都重算一遍、逐个对数。数变了就必须有人解释。
 *
 * ── 为什么守的是全书，不是"我们愿意看的那一章" ──────────────────────────
 * 第一版只冻了第一章，而项目的真实事故**恰好不在第一章**：A 层第七/八/九章一度只有
 * 2%/3%/1% 的加注覆盖率，很久没人发现——因为报表只统计"加了多少注"，
 * **没统计"本该加多少注"**。于是出事的那三章正好是没被守的那三章。
 * 现在 10 章 × 3 档的 `应注词型 / 已注词型 / 加注覆盖率` 全部进样本，
 * 并且"事故章"有单独的守卫（覆盖率掉到个位数当场失败）。
 *
 * ── 输入是**全份**冻下来的，没有精简 ────────────────────────────────────
 * 约 1.0MB：整份词库（219KB）+ 词典 + 专名表 + 知识库 + 10 章原文与 30 份产物。
 * 为什么不精简成"这几章用到的词"：那会引入一个"精简后是否等价"的问题，
 * 而那个问题得**永远**重新验证一遍。更实际的一条：**要守的东西就在正文里**——
 * 漏注一个词，是"正文里少了一对括号"这件事，把正文剪掉就等于把守卫剪掉。
 *
 * ── 快慢分层（常驻子集 vs 全书穷尽） ────────────────────────────────────
 * 常驻（`npm test` 就跑到，约 2 秒）：引擎层**全书 10 章 × 3 档**逐项重算对账 +
 * 第一章与第七章各跑一次项目自己的风险队列 + 一次反证 + 一次只读校验。
 * 慢测（`LAYERTEXT_REPLAY_FULL=1 node --test dist/tests/replay.test.js`）：
 * 三档风险队列各跑一遍**全书十章**（约 1.3 秒，是常驻子集的十倍量级），
 * 断言每一章都在队列里露面——防止"某一章悄悄退出队列"这种静默失效。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RiskItem } from '../src/core/riskqueue.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/* 引擎的编译产物目录 = **本测试自己所在的那一份**。tsconfig 允许把整个仓库编到自己的
 * outDir（"多人/多 agent 并行时谁都不许写共享 dist/"），这时测试跑在 `dist-a/tests/` 下；
 * 若 spawn 出去的工具还去读共享 `dist/`，测的就是**别人的构建**。
 * 把 LAYERTEXT_DIST 钉到本测试的 outDir，两边就一定是同一份代码。 */
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const FIXTURE = join(REPO, 'tests', 'fixtures', 'replay');
const ENV = { ...process.env, LAYERTEXT_ENGINE: REPO, LAYERTEXT_DIST: DIST };

/** 一章的冻结结论。**应注词型（分母）与已注词型（分子）必须成对出现**——
 *  只留分子就是上一轮事故的报表。 */
interface 章结论 {
  质检: {
    章: string;
    段数: number;
    应注词型: number;
    已注词型: number;
    漏注词型: number;
    加注覆盖率: number;
    原文生词率: number;
    生词率: number;
    超长句: number;
  };
  篇幅比: number;
  规则命中: Record<string, number>;
  超长句总数: number;
  段: { 章: string; 段号: string; 状态: string; 规则: string[] }[];
}

interface 两条轴 {
  阅读负荷下降: number;
  理解支架覆盖率: number;
  一句话: string;
}

interface Frozen {
  schemaVersion: number;
  说明: string;
  冻结自: string;
  章: string[];
  层: string[];
  词表规模: { 已知: number };
  项目树指纹: { 文件数: number; 指纹: string };
  缺输入: { 章: string; 层: string; 缺: string }[];
  结论: {
    口径: string;
    章节: Record<string, { 质检: 章结论['质检']; 篇幅比: number; 超长句总数: number; 规则命中: Record<string, number> }>;
    分章: Record<string, Record<string, 章结论>>;
    定位两条轴: Record<string, 两条轴>;
    分章定位: Record<string, Record<string, 两条轴>>;
    全书定位: Record<string, 两条轴 & { 章数: number; 应注词型: number; 已注词型: number }>;
    覆盖: { 章: string[]; 层: string[]; 组合数: number; 段数: number; 缺失: { 章: string; 层: string; 缺: string }[] };
  };
}

const frozen = (): Frozen => JSON.parse(readFileSync(join(FIXTURE, '期望结论.json'), 'utf-8')) as Frozen;

/** 把冻好的输入摆成一个可跑的项目（路径改成临时的绝对路径） */
function materialize(): { root: string; json: string } {
  const root = mkdtempSync(join(tmpdir(), 'lt-replay-'));
  cpSync(join(FIXTURE, '输入'), root, { recursive: true });
  const json = join(root, '调适项目_回放.json');
  const cfg = JSON.parse(readFileSync(json, 'utf-8')) as Record<string, unknown> & { 书级: Record<string, string> };
  cfg.引擎目录 = REPO;
  for (const k of ['原文目录', '产物目录', '调适工作区', '词库']) cfg[k] = join(root, cfg[k] as string);
  for (const k of Object.keys(cfg.书级)) cfg.书级[k] = join(root, cfg.书级[k]!);
  writeFileSync(json, JSON.stringify(cfg, null, 2), 'utf-8');
  return { root, json };
}

/** 整棵树的逐文件 sha256——用来独立地验"没人动过它"（不信工具自己的自证） */
function treeHashes(root: string): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) m.set(relative(root, p), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return m;
}

/** 在冻好的输入上真跑一次项目自己的风险队列，把机器格式读回来 */
function runQueue(
  root: string,
  tier: string,
  chapters?: string,
): { 摘要: { total: number; blockers: number; byRule: Record<string, number>; byCategory: Record<string, number> }; 队列: (RiskItem & { chapter: string })[] } {
  const args = [join(AF, 'LayerText_AF风险队列.mjs'), '--tier', tier];
  if (chapters) args.push('--chapters', chapters);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...ENV, LAYERTEXT_PROJECT: join(root, '调适项目_回放.json') },
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `风险队列没跑通：${r.stdout ?? ''}${r.stderr ?? ''}`);
  const tag = tier === 'A' ? 'A层85' : tier === 'M' ? 'M层75' : 'B层60';
  const qPath = join(root, '产物', '_运行', `风险队列_${tag}.json`);
  assert.equal(existsSync(qPath), true, `没生成队列 JSON：${r.stdout}`);
  return JSON.parse(readFileSync(qPath, 'utf-8'));
}

/* ────────────────────── ① 引擎层结论：全书逐项复现 ────────────────────── */

test('★ 冻结的结论能逐项复现（引擎层 · 全书每一章 × 三档）', () => {
  /* 这一条守的是**全书**：10 章 × A/M/B，每章自己的段级规则命中、质检、两条轴都要重算对上。
   * 只守第一章的版本里，第七/八/九章掉到 2%/3%/1% 谁也不知道——
   * "守一个我们愿意看的样本"和"不守"在事故面前没有区别。 */
  const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF冻结回放.mjs'), '--check'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: ENV,
    timeout: 300_000,
  });
  assert.equal(r.status, 0, `回放结论与冻结的不一致——**改动了什么就必须解释**：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
});

/* ────────────────────── ② 端到端：项目自己的脚本跑真产物 ────────────────────── */

test('★ 端到端回放：真项目脚本在冻好的输入上跑出同一份风险队列', () => {
  const { root } = materialize();
  try {
    const q = runQueue(root, 'A', '1');

    /* 这五个数是**真项目报出来的那一份**（不只是"能跑出个数"）：
     * 冻结自 Animal Farm A 层第一章，与用户在项目里看到的完全一致。
     * 它们变了一定有原因——规则改了、词库换了、产物改了——而那正是要被解释的事。 */
    assert.deepEqual(q.摘要.byRule, { 'FACT-02': 2, 'ANNO-01': 44, 'SENT-01': 19, 'LEN-01': 4, 'ANNO-02': 1 }, '按规则的条数变了——先确认是不是规则本身改了');
    assert.equal(q.摘要.total, 70, '队列总数变了');
    assert.equal(q.摘要.blockers, 67);
    assert.deepEqual(q.摘要.byCategory, { 事实: 2, 加注: 45, 语言: 23 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('★ 端到端回放：**第七章**（当年掉到 2% 的那一章）也要跑出冻结的那一份', () => {
  /* 第一章跑通只证明"脚本没坏"；出事的是第七章。
   * 那一次的形态是"注没加够"，报表上却是个不小的数——所以这里特意把
   * `加注` 一类的条数单独钉住（244 条都是**漏注**），它是"本该加多少"在队列里的那一面。 */
  const { root } = materialize();
  try {
    const q = runQueue(root, 'A', '7');
    assert.deepEqual(q.摘要.byRule, { 'FACT-01': 3, 'FACT-02': 12, 'ANNO-01': 244, 'SENT-01': 63, 'LEN-01': 7 }, '第七章按规则的条数变了——它在样本里就是为"漏注"这件事站岗的');
    assert.equal(q.摘要.total, 329);
    assert.equal(q.摘要.byCategory.加注, 244, '加注类的条数变了：这正是"该加没加"的那一类');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('★ 端到端回放：任务组压缩比不回归（70 条 → ≤25 组）', async () => {
  const { root } = materialize();
  try {
    const q = runQueue(root, 'A', '1');
    const { groupQueue } = await import('../src/core/riskqueue.js');
    const groups = groupQueue(q.队列, { mutatingRules: ['ANNO-01', 'ANNO-02', 'ANNO-03', 'AST-02'] });
    assert.equal(groups.length <= 25, true, `阶段 2 的验收是"70 条至少压缩到 25 组以内"，实得 ${groups.length} 组——` + `这个数一旦回去，教师又要一条一条翻卡片`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ────────────────────── ③ 样本自身不许被偷偷改 ────────────────────── */

test('★ 回放样本本身有出处记录：没人能悄悄改掉它来"让测试通过"', () => {
  const f = frozen();
  assert.equal(f.schemaVersion, 2, 'schemaVersion 2 起覆盖面是全书每一章；掉回 1 意味着只剩第一章');
  assert.equal(f.冻结自.startsWith('调适项目_'), true, `要说清冻结自哪份项目配置，实得「${f.冻结自}」`);
  assert.equal(f.章.length > 0 && f.层.length > 0, true);
  assert.equal(f.词表规模.已知 > 1000, true, `词表规模看着不对：${f.词表规模.已知}`);
  assert.match(f.结论.口径, /第一章/, '要说清"章节[t] 是第一章口径"，否则读者会把它当成全书的数');
  /* 冻结**当时**项目里输入不齐的（章 × 层）。现在是空的——10 章 × 3 层一组不缺。
   * 一旦不空，说明样本本来就少东西：那必须有人解释，而不是让它悄悄过去。
   * `结论.覆盖.缺失` 守不了这件事，它只看得见"样本里被删了什么"，看不见"当时就少"。 */
  assert.deepEqual(f.缺输入, [], `冻结时项目里就有输入不齐的组合：${JSON.stringify(f.缺输入)}——样本少了几章**有出处**，别让它悄悄过去`);
  // 三档都要在：只冻一层会让"M/B 层悄悄坏掉"没人发现
  for (const t of ['A', 'M', 'B']) {
    assert.ok(f.结论.章节[t]?.质检, `${t} 层的结论没冻下来`);
    assert.ok(f.结论.定位两条轴[t], `${t} 层的两条轴没冻下来`);
  }
});

test('★ 覆盖不许缩水：每一章 × 每一层要么有结论、要么在缺失清单里（棘轮）', () => {
  /* 这一条是给"重新冻结"上的一道棘轮。冻结这个动作本身是**不会失败**的：
   * 少冻一章，测试照样全绿——"这一章没人守"就成了一件没有痕迹的事。
   * 所以 10 章 / 30 组 / 段数 这些下界写死在用例里：想降下来，必须改这份文件，
   * 而改这份文件是要在 code review 里被看见的。 */
  const f = frozen();
  assert.ok(f.结论.覆盖, '样本里没有覆盖清单——那就无从判断"是不是少冻了几章"');
  assert.equal(f.结论.覆盖.章.length >= 10, true, `冻结的章节数只剩 ${f.结论.覆盖.章.length} 章（下限 10）：重新冻结不许悄悄少章`);
  assert.equal(f.结论.覆盖.组合数 >= 30, true, `（章 × 层）组合只剩 ${f.结论.覆盖.组合数} 组（下限 30）`);
  assert.equal(f.结论.覆盖.段数 >= 225, true, `样本里的段落总数只剩 ${f.结论.覆盖.段数} 段（下限 225）——正文被剪掉过？`);

  for (const t of f.层) {
    for (const ch of f.结论.覆盖.章) {
      const has = Boolean(f.结论.分章[t]?.[ch]);
      const listed = f.结论.覆盖.缺失.some((m) => m.章 === ch && m.层 === t);
      assert.equal(has || listed, true, `${t} 层 ${ch} 既没有结论、也没写进缺失清单——这是**静默跳过**，最坏的一种：样本里少一章而测试全绿`);
    }
  }
  // 反向也要成立：写进缺失清单的组合，结论里必须真的没有（否则清单会变成一句空话）
  for (const m of f.结论.覆盖.缺失) {
    assert.equal(Boolean(f.结论.分章[m.层]?.[m.章]), false, `缺失清单说 ${m.章}/${m.层} 没冻，可是结论里有它`);
    assert.equal(m.缺.length > 0, true, `缺失清单必须说清**缺的是什么文件**，实得「${m.缺}」`);
  }
});

test('★ 事故章有单独的守卫：A 层第七/八/九章的加注覆盖率不许掉回个位数', () => {
  /* 这三章就是那次事故的现场：2% / 3% / 1%，而且**报表上看不出来**——
   * 因为当时只报"加了多少注"。现在它们各有一条自己的线：
   * 95% 以下当场失败，不管是谁重新冻的样本。 */
  const f = frozen();
  for (const ch of ['第七章', '第八章', '第九章']) {
    const r = f.结论.分章.A?.[ch];
    assert.ok(r, `A 层 ${ch} 没进样本——正是这三章当年掉到 2%/3%/1% 而没人发现`);
    assert.equal(r.质检.加注覆盖率 >= 95, true, `A 层 ${ch} 的加注覆盖率只有 ${r.质检.加注覆盖率}%（${r.质检.已注词型}/${r.质检.应注词型}）——低于 95% 必须有人解释`);
  }
});

test('★ 每一章都记着"本该加多少"：分子与分母成对出现，覆盖率不许低于 80%', () => {
  /* "只统计加了多少注"正是事故的成因。所以分母（应注词型）是**必填项**：
   * 缺了分母，覆盖率就退化成一个孤立的大数字，看不出任何问题。 */
  const f = frozen();
  let 最低 = 100;
  let 最低处 = '';
  for (const t of f.层) {
    for (const ch of f.结论.覆盖.章) {
      const q = f.结论.分章[t]?.[ch]?.质检;
      assert.ok(q, `${t} 层 ${ch} 没有质检结论——覆盖率算不出来`);
      assert.equal(typeof q.应注词型, 'number', `${t} 层 ${ch} 没记"应注词型"（分母）`);
      assert.equal(q.已注词型 + q.漏注词型, q.应注词型, `${t} 层 ${ch} 的分子分母对不上：${q.已注词型}+${q.漏注词型}≠${q.应注词型}`);
      assert.equal(q.段数 > 0, true, `${t} 层 ${ch} 的段数是 0——这一章其实是空的`);
      if (q.加注覆盖率 < 最低) {
        最低 = q.加注覆盖率;
        最低处 = `${t} 层 ${ch}`;
      }
    }
  }
  assert.equal(最低 >= 80, true, `最低的加注覆盖率出现在 ${最低处}：${最低}%——低于 80% 就是事故级，必须有人解释`);
});

test('★ 两条轴分开报、不合成（阶段 4 验收原文）', () => {
  const f = frozen();
  for (const t of ['A', 'M', 'B']) {
    const axes = f.结论.定位两条轴[t]!;
    assert.equal(typeof axes.阅读负荷下降, 'number');
    assert.equal(typeof axes.理解支架覆盖率, 'number');
    assert.equal(
      Object.keys(axes).some((k) => /综合|得分|总分|score|composite/i.test(k)),
      false,
      '**禁止综合分数替代**——两条轴合起来算一个数就没法拿它做判断了',
    );
    assert.match(axes.一句话, /阅读负荷下降/);
    assert.match(axes.一句话, /理解支架覆盖率/);
  }
  // A 层几乎全是"加支架"而不是"降负荷"——这个区别在任何合成指标里都会被抹平
  assert.equal(f.结论.定位两条轴.A!.理解支架覆盖率 > f.结论.定位两条轴.A!.阅读负荷下降, true);
  /* 第一章口径与全书口径**是两个数**（A 层 28%/96% vs 全书 23%/97%）。
   * 分开存是为了不再犯 README 那个错：把一章的数当全书的数写出去。
   * 真出现"有人把一章的数冒充全书"的改动时，`--check` 对不上，这条也会失败。 */
  const 全书 = f.结论.全书定位.A!;
  assert.equal(全书.章数, f.结论.覆盖.章.length, '全书轴必须真的把每一章都算进去');
  assert.notEqual(全书.一句话, f.结论.定位两条轴.A!.一句话, '全书口径和第一章口径不该是同一句话');
});

test('★ 冻结的结论里不许出现本机绝对路径（换台机器跑必须一样）', () => {
  const raw = readFileSync(join(FIXTURE, '期望结论.json'), 'utf-8');
  for (const bad of ['/Users/', '/var/', '/tmp/']) {
    assert.equal(raw.includes(bad), false, `结论里混进了本机路径 ${bad}——换台机器就对不上了`);
  }
});

/* ────────────────────── ④ 文档里的数也要有人守 ────────────────────── */

test('★ README 里报给用户的数，必须与可复现的冻样本一致', () => {
  /* 这条用例是有来由的：README 原来写着"A 层阅读负荷下降 **30%**、理解支架覆盖率 **94%**；
   * M 层 **43%** / **93%**"，而用当前代码在**当前产物**上重算，得到的是
   * A 28% / 96%、M 45% / 98%——那三个数是 2026-09-10 词表口径修复**之前**留下的，
   * 之后就再没人对过。README 是潜在用户和另一位老师最先看到的东西，
   * 它上面写着一个复现不出来的性能数字，比不写更糟。
   *
   * 现在把它**绑到冻样本上**：想改 README 里的数，就得先重新冻结样本
   * （也就是真的在真项目上重算一遍）。这比"写的时候仔细一点"可靠。 */
  const f = frozen();
  const readme = readFileSync(join(REPO, 'README.md'), 'utf-8');
  for (const t of ['A', 'M', 'B'] as const) {
    const a = f.结论.定位两条轴[t]!;
    const 应含 = `${t} 层`;
    assert.equal(readme.includes(应含), true, `README 里没提 ${t} 层`);
    const line = `阅读负荷下降 ${a.阅读负荷下降}%、理解支架覆盖率 ${a.理解支架覆盖率}%`;
    if (t === 'A') {
      assert.equal(readme.includes(line), true, `README 的 A 层数字对不上可复现样本：应含「${line}」`);
    } else {
      assert.equal(readme.includes(`${a.阅读负荷下降}% / ${a.理解支架覆盖率}%`), true, `README 的 ${t} 层数字对不上：应为 ${a.阅读负荷下降}% / ${a.理解支架覆盖率}%`);
    }
  }
  assert.equal(readme.includes('tests/fixtures/replay'), true, 'README 要说清这几个数**怎么复现**，否则读者只能选择相信');
});

/* ────────────────────── ⑤ 反证：守卫真的会响 ────────────────────── */

test('★ 反证：抹掉第七章的注，对账必须当场失败（守的是全书，不是第一章）', () => {
  /* 一个从不为真的守卫等于没有守卫。这里在**副本**上重演那次事故的形态：
   * 第七章 A 层产物里的中文注全抹掉（覆盖率塌到接近 0），
   * 然后只对第七章做一次对账——必须红，而且必须指名到"第七章"。
   * 全部在临时目录里做，不动真样本。 */
  const root = mkdtempSync(join(tmpdir(), 'lt-perturb-'));
  try {
    cpSync(FIXTURE, root, { recursive: true });
    const victim = join(root, '输入', '产物', '第七章', '原文_A层85_2026-09-10.md');
    assert.equal(existsSync(victim), true, '样本里根本没有第七章的 A 层产物——守卫压根没盖到出事的那一章');
    const before = readFileSync(victim, 'utf-8');
    const after = before.replace(/（[^）]*）/g, '');
    assert.notEqual(after, before, '第七章 A 层产物里一个中文注都没有？那这条反证什么也没改');
    writeFileSync(victim, after, 'utf-8');

    const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF冻结回放.mjs'), '--check', '--root', root, '--chapters', '7'], {
      cwd: REPO,
      encoding: 'utf-8',
      env: ENV,
      timeout: 120_000,
    });
    assert.equal(r.status, 1, `把第七章的注全抹掉之后对账居然还是绿的：${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stdout ?? '', /第七章/, '失败信息必须指到**哪一章**变了；只说"某个数变了"等于没说');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('★ 冻结工具对项目**只读**：整棵树指纹冻结前后逐字节一致', () => {
  /* 这个工具唯一的对外承诺是"不碰真项目"。承诺要当场验：
   *   ① 工具自己冻结前后各拍一次整棵树的指纹，不一致就 exit 3；
   *   ② 这里再用测试自己的哈希**独立**验一遍（不信工具的自证）；
   *   ③ 顺带证明"从冻好的输入重新冻结 → 结论逐字段相同"，否则回放就是假的。
   * 跑的是样本摆成的项目，不是真项目——测试不该依赖某台机器上的某本书。 */
  const { root, json } = materialize();
  const out = mkdtempSync(join(tmpdir(), 'lt-refreeze-'));
  try {
    const 冻结前 = treeHashes(root);
    const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF冻结回放.mjs'), '--project', json, '--out', out], {
      cwd: REPO,
      encoding: 'utf-8',
      env: ENV,
      timeout: 300_000,
    });
    assert.equal(r.status, 0, `冻结没跑通：${r.stdout ?? ''}${r.stderr ?? ''}`);
    assert.match(r.stdout ?? '', /一个字节都没写回真项目/, '冻结工具必须当场自证只读，而不是嘴上保证');
    assert.match(r.stdout ?? '', /输入齐全：10 章 × 3 层 = 30 组/, '冻结时必须报清"冻了哪些组合"，缺的更要报');

    const 冻结后 = treeHashes(root);
    assert.deepEqual([...冻结后.entries()].sort(), [...冻结前.entries()].sort(), '冻结过程动了项目树——这个工具的硬约束被破坏了');

    const 重冻 = JSON.parse(readFileSync(join(out, '期望结论.json'), 'utf-8')) as Frozen;
    assert.deepEqual(重冻.结论, frozen().结论, '从冻好的输入重新冻结，结论居然不一样——那"回放"两个字就不成立');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

/* ────────────────────── ⑥ 慢测：全书端到端（默认不跑） ────────────────────── */

const FULL = process.env.LAYERTEXT_REPLAY_FULL === '1';

test('★ 全书端到端（慢测）：三档风险队列都要盖到每一章，一章都不许消失', { skip: FULL ? false : '慢测：设 LAYERTEXT_REPLAY_FULL=1 才跑（三档各跑一遍全书十章，比常驻子集慢一个量级）' }, () => {
  /* 常驻子集只跑第一章与第七章的队列；这一条把三档**全书十章**都跑一遍。
   * 它守的是"静默失效"：某一章因为改名、缺文件、被排除而**从队列里消失**时，
   * 队列照样生成、摘要照样好看，只是少了那一章的那几千条。 */
  const f = frozen();
  const 期望总条数: Record<string, number> = { A: 2511, M: 3210, B: 3616 };
  const { root } = materialize();
  try {
    for (const t of f.层) {
      const q = runQueue(root, t);
      assert.equal(q.队列.length, q.摘要.total, `${t} 层：队列条数与摘要总数对不上`);
      assert.equal(q.摘要.total, 期望总条数[t], `${t} 层全书队列总数变了（冻结时是 ${期望总条数[t]} 条）`);
      for (const ch of f.结论.覆盖.章) {
        const n = q.队列.filter((it) => it.chapter === ch).length;
        assert.equal(n > 0, true, `${t} 层 ${ch} 在队列里一条都没有——这一章悄悄退出了队列，而摘要上看不出来`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
