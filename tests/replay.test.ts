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
 * ── 输入是**全份**冻下来的，没有精简 ────────────────────────────────────
 * 320KB：整份词库（219KB）+ 词典 + 专名表 + 知识库 + 一层的原文与三档产物。
 * 为什么不精简成"这一章用到的词"：那会引入一个"精简后是否等价"的问题，
 * 而那个问题得**永远**重新验证一遍。整份冻下来换的是"回放就是真的回放"。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { RiskItem } from '../src/core/riskqueue.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const FIXTURE = join(REPO, 'tests', 'fixtures', 'replay');

interface Frozen {
  schemaVersion: number;
  说明: string;
  冻结自: string;
  章: number[];
  层: string[];
  词表规模: { 已知: number };
  结论: {
    章节: Record<string, { 质检: Record<string, number | string>; 篇幅比: number; 超长句总数: number; 规则命中: Record<string, number> }>;
    定位两条轴: Record<string, { 阅读负荷下降: number; 理解支架覆盖率: number; 一句话: string }>;
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

/* ────────────────────── ① 引擎层结论：逐项复现 ────────────────────── */

test('★ 冻结的结论能逐项复现（引擎层）', () => {
  const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF冻结回放.mjs'), '--check'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_ENGINE: REPO },
    timeout: 120_000,
  });
  assert.equal(r.status, 0, `回放结论与冻结的不一致——**改动了什么就必须解释**：\n${r.stdout ?? ''}${r.stderr ?? ''}`);
});

/* ────────────────────── ② 端到端：项目自己的脚本跑真产物 ────────────────────── */

test('★ 端到端回放：真项目脚本在冻好的输入上跑出同一份风险队列', () => {
  const { root, json } = materialize();
  try {
    const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF风险队列.mjs'), '--tier', 'A', '--chapters', '1'], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
      timeout: 120_000,
    });
    assert.equal(r.status, 0, `风险队列没跑通：${r.stdout ?? ''}${r.stderr ?? ''}`);

    const qPath = join(root, '产物', '_运行', '风险队列_A层85.json');
    assert.equal(existsSync(qPath), true, `没生成队列 JSON：${r.stdout}`);
    const q = JSON.parse(readFileSync(qPath, 'utf-8')) as {
      摘要: { total: number; blockers: number; byRule: Record<string, number>; byCategory: Record<string, number>; estimatedMinutes: number };
      队列: { ruleId: string }[];
    };

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

test('★ 端到端回放：任务组压缩比不回归（70 条 → ≤25 组）', async () => {
  const { root, json } = materialize();
  try {
    const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF风险队列.mjs'), '--tier', 'A', '--chapters', '1'], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr ?? '');
    const q = JSON.parse(readFileSync(join(root, '产物', '_运行', '风险队列_A层85.json'), 'utf-8')) as {
      队列: RiskItem[];
    };
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
  assert.equal(f.schemaVersion, 1);
  assert.equal(f.冻结自.startsWith('调适项目_'), true, `要说清冻结自哪份项目配置，实得「${f.冻结自}」`);
  assert.equal(f.章.length > 0 && f.层.length > 0, true);
  assert.equal(f.词表规模.已知 > 1000, true, `词表规模看着不对：${f.词表规模.已知}`);
  // 三档都要在：只冻一层会让"M/B 层悄悄坏掉"没人发现
  for (const t of ['A', 'M', 'B']) {
    assert.ok(f.结论.章节[t]?.质检, `${t} 层的结论没冻下来`);
    assert.ok(f.结论.定位两条轴[t], `${t} 层的两条轴没冻下来`);
  }
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
});

test('★ 冻结的结论里不许出现本机绝对路径（换台机器跑必须一样）', () => {
  const raw = readFileSync(join(FIXTURE, '期望结论.json'), 'utf-8');
  for (const bad of ['/Users/', '/var/', '/tmp/']) {
    assert.equal(raw.includes(bad), false, `结论里混进了本机路径 ${bad}——换台机器就对不上了`);
  }
});
