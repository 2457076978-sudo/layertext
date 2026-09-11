/**
 * 发布包 CLI · 端到端（真跑子进程）
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「导入导出通过 manifest」·「发布包默认不含画像、成绩和个人信息」
 *   「任意发布文件可查询『由哪次运行、哪个模型、哪版词库生成，谁在何时做了哪条决定』」
 *
 * `src/core/bundle.ts` 的单测（`tests/bundle.test.ts`）证明的是**判定逻辑**；
 * 这一组证明的是**接线**：脚本真的按清单解析路径、真的把该出的出、该拦的拦。
 * 只测库不测接线，就会出现"函数是对的、脚本没用它"这种最尴尬的状态。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const DATE = '2026-01-01';
const TAG = 'A层85';

/** 建一个自检项目，并把它推到"已建清单 + 已产出 A 层第一章 + 已刷状态"的状态。
 *  tiers 传多层（如 `'A,M,B'`）时每层各写一份正文；台账与 stamp 仍走 A 层（发布只要求清单非空）。 */
function makeProject(
  tiers: string = 'A',
): { root: string; json: string; runId: string; product: string; run: (script: string, args: string[]) => { status: number | null; out: string } } {
  const root = mkdtempSync(join(tmpdir(), 'lt-bun-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('调适'), { recursive: true });
  mkdirSync(w('产物'), { recursive: true });
  writeFileSync(w('原文', '第一章', '原文_规范化.md'), '## Chapter One\n\n[P01] The boy ran to the red barn.\n', 'utf-8');
  writeFileSync(w('词库.csv'), ['词,类型', ...['the', 'boy', 'ran', 'to', 'red', 'barn', 'and', 'saw', 'a', 'small', 'dog'].map((x) => `${x},单词`)].join('\n') + '\n', 'utf-8');
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自检.json');
  writeFileSync(
    json,
    JSON.stringify(
      {
        书名: '发布包自检',
        工作区: root,
        调适工作区: w('调适'),
        原文目录: w('原文'),
        产物目录: w('产物'),
        词库: w('词库.csv'),
        书级: { 专名表: w('专名表.txt'), 知识库: w('知识库.csv'), 词典: w('词典.csv') },
        日期: DATE,
        章数: 1,
        引擎目录: REPO,
      },
      null,
      2,
    ),
    'utf-8',
  );

  const env = { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO };
  const run = (script: string, args: string[] = []): { status: number | null; out: string } => {
    const r = spawnSync(process.execPath, [join(AF, script), ...args], { cwd: REPO, encoding: 'utf-8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };

  const init = run('LayerText_AF清单.mjs', ['--new', '--tier', tiers, '--chapters', '1', '--layout', 'run', '--teacher', 'wayne']);
  assert.equal(init.status, 0, init.out);
  const runId = /运行 ID：(\S+)/.exec(init.out)?.[1] ?? '';
  assert.notEqual(runId, '', `没拿到运行 ID：${init.out}`);

  const TIER_TAG: Record<string, string> = { A: 'A层85', M: 'M层75', B: 'B层60' };
  let product = '';
  for (const t of tiers.split(',')) {
    product = w('产物', '_运行', runId, '正文', '第一章', `原文_${TIER_TAG[t] ?? t}_${DATE}.md`);
    mkdirSync(dirname(product), { recursive: true });
    writeFileSync(product, `## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n`, 'utf-8');
  }
  assert.equal(run('LayerText_AF对照台账.mjs', ['--tier', 'A', '--chapters', '1']).status, 0);
  assert.equal(run('LayerText_AF清单.mjs', ['--stamp', '--step', '台账']).status, 0);

  return { root, json, runId, product, run };
}

const runBundle = (json: string, args: string[]) => {
  const r = spawnSync(process.execPath, [join(AF, 'LayerText_AF发布包.mjs'), ...args], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

test('★ 导出：按清单把产物收成一个包，并写一份带「哪次运行/哪个模型/哪版词库」的描述', () => {
  const { root, json, runId, product } = makeProject();
  const r = runBundle(json, []);
  assert.equal(r.status, 0, r.out);

  const dir = join(root, '产物', '_运行', runId, `发布包_${runId}`);
  const descPath = join(dir, '发布包.json');
  assert.equal(existsSync(descPath), true, `要写出包描述：${r.out}`);
  const b = JSON.parse(readFileSync(descPath, 'utf-8')) as {
    run: { runId: string; book: string };
    model: { name: string; promptVersion: string };
    lexicon: { version: string };
    teacher: string;
    entries: { path: string; kind: string; hash: string }[];
    excluded: { path: string; reason: string }[];
  };
  assert.equal(b.run.runId, runId);
  assert.equal(b.run.book, '发布包自检');
  assert.equal(b.model.name, 'deepseek-chat');
  assert.equal(b.model.promptVersion, 'session-v3-20260911');
  assert.notEqual(b.lexicon.version, '', '词库版本不能是空的——那是"哪版词库"的唯一答案');
  assert.equal(b.teacher, 'wayne');
  assert.equal(
    b.entries.some((e) => e.kind === '正文'),
    true,
    '正文要入包',
  );
  assert.equal(
    b.entries.some((e) => e.kind === '台账'),
    true,
    '台账要入包',
  );
  // 包描述说入包的文件，包里真的要有
  for (const e of b.entries) {
    assert.equal(existsSync(join(dir, e.path)), true, `包里缺 ${e.path}`);
  }
  assert.equal(readFileSync(join(dir, b.entries.find((e) => e.kind === '正文')!.path), 'utf-8').includes('barn（谷仓）'), true);
  void product;
});

test('★ 导出：没有清单就**不发包**，并说清为什么（没有清单答不了"哪次运行"）', () => {
  const { root, json, runId } = makeProject();
  // 连清单本体、分片指针、全局指针一起删——模拟"没建过清单"，而不是只弄坏其中一份
  const runDir = join(root, '产物', '_运行');
  for (const f of ['清单_最新.json', `清单_${runId}.json`, '清单_wayne_A层85.json']) rmSync(join(runDir, f), { force: true });
  const r = runBundle(json, []);
  assert.notEqual(r.status, 0, `没有清单不该成功：${r.out}`);
  assert.match(r.out, /身份定不下来|无清单/);
  assert.match(r.out, /--run|--new/);
});

test('★ 核对：收到的包完好 → 通过；内容被动过 → 逐件报出来', () => {
  const { root, json, runId } = makeProject();
  assert.equal(runBundle(json, []).status, 0);
  const dir = join(root, '产物', '_运行', runId, `发布包_${runId}`);

  const ok = runBundle(json, ['--check', dir]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /核对通过/);
  assert.match(ok.out, /没有夹带学生数据/);

  // 改动包里的正文 → 必须报哈希不符，并以非 0 退出（"大概没问题"不是核对）
  const b = JSON.parse(readFileSync(join(dir, '发布包.json'), 'utf-8')) as { entries: { kind: string; path: string }[] };
  const body = join(dir, b.entries.find((e) => e.kind === '正文')!.path);
  writeFileSync(body, readFileSync(body, 'utf-8') + '被谁加了一句。', 'utf-8');
  const bad = runBundle(json, ['--check', dir]);
  assert.notEqual(bad.status, 0, bad.out);
  assert.match(bad.out, /hash-mismatch/);
  assert.match(bad.out, /内容与清单不符/);
});

test('★ 核对：包里夹带了学生数据 → 认出来并以非 0 退出', () => {
  const { root, json, runId } = makeProject();
  assert.equal(runBundle(json, []).status, 0);
  const dir = join(root, '产物', '_运行', runId, `发布包_${runId}`);
  // 对方"顺手"多塞了一份分层名单
  writeFileSync(join(dir, '顺手带的_分层_九3.json'), '{"九3":["A","B"]}', 'utf-8');
  const r = runBundle(json, ['--check', dir]);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /student-data|不该出包|学生数据/);
});

test('★ 溯源：查得到「哪次运行 / 哪个模型 / 哪版词库 / 谁」，查不到就如实说查不到', () => {
  const { root, json, runId } = makeProject();
  const target = `_运行/${runId}/正文/第一章/原文_${TAG}_${DATE}.md`;

  const hit = runBundle(json, ['--where', target]);
  assert.equal(hit.status, 0, hit.out);
  for (const bit of [runId, 'deepseek-chat', 'session-v3-20260911', 'wayne', '内容与清单一致', '之后没有任何决定']) {
    assert.equal(hit.out.includes(bit), true, `溯源缺「${bit}」：${hit.out}`);
  }

  const miss = runBundle(json, ['--where', '根本不存在的文件.md']);
  assert.notEqual(miss.status, 0, '查不到应当以非 0 退出（而不是假装成功）');
  assert.match(miss.out, /查不到/);
  assert.match(miss.out, /不编一个出处/);
  void root;
});

test('★ 包描述里**排除项是显式列出的**：静默丢弃和静默收录一样危险', () => {
  const { json } = makeProject();
  const r = runBundle(json, []);
  assert.equal(r.status, 0, r.out);
  // 本次没有学生数据可排除时，也必须**明确说"排除 0 件"**，而不是什么都不打印
  assert.match(r.out, /排除 0 件|排除 \d+ 件/);
  assert.match(r.out, /发布包默认不含|列出来，不静默丢弃|没有学生数据迹象/);
});

/* ────────────────── 第七轮质检：身份与完整性闸门 ────────────────── */

test('★ 并发双教师：被串线的一方不带 --run 必须拒绝；带 --run 各自导出**自己的**包（P0-②）', () => {
  const { root, json, run, runId: wayneRun } = makeProject();
  // ada 在同一项目开自己的运行并产出（后跑，全局"最近一次"指针从此指向她）
  const ada = run('LayerText_AF清单.mjs', ['--new', '--tier', 'A', '--chapters', '1', '--layout', 'run', '--teacher', 'ada']);
  assert.equal(ada.status, 0, ada.out);
  const adaRun = /运行 ID：(\S+)/.exec(ada.out)?.[1] ?? '';
  assert.notEqual(adaRun, '', `没拿到 ada 的运行 ID：${ada.out}`);
  const adaProduct = join(root, '产物', '_运行', adaRun, '正文', '第一章', `原文_${TAG}_${DATE}.md`);
  mkdirSync(dirname(adaProduct), { recursive: true });
  writeFileSync(adaProduct, `## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n`, 'utf-8');
  assert.equal(run('LayerText_AF对照台账.mjs', ['--tier', 'A', '--chapters', '1', '--teacher', 'ada']).status, 0);
  assert.equal(run('LayerText_AF清单.mjs', ['--stamp', '--step', '台账', '--teacher', 'ada']).status, 0);

  // wayne 此刻不带 --run：全局指针指向 ada，教师对不上 → 身份退 legacy → 发布必须拒绝，不许猜
  const crossed = runBundle(json, ['--teacher', 'wayne']);
  assert.notEqual(crossed.status, 0, '被串线的一方不带 --run 不该发成功');
  assert.match(crossed.out, /--run/);

  // 带 --run：各自导出自己的包，包内 runId 与 teacher 都要对得上
  const w = runBundle(json, ['--teacher', 'wayne', '--run', wayneRun]);
  assert.equal(w.status, 0, w.out);
  const wb = JSON.parse(readFileSync(join(root, '产物', '_运行', wayneRun, `发布包_${wayneRun}`, '发布包.json'), 'utf-8')) as { run: { runId: string }; teacher: string };
  assert.equal(wb.run.runId, wayneRun);
  assert.equal(wb.teacher, 'wayne');

  const a = runBundle(json, ['--teacher', 'ada', '--run', adaRun]);
  assert.equal(a.status, 0, a.out);
  const ab = JSON.parse(readFileSync(join(root, '产物', '_运行', adaRun, `发布包_${adaRun}`, '发布包.json'), 'utf-8')) as { run: { runId: string }; teacher: string; entries: { kind: string }[] };
  assert.equal(ab.run.runId, adaRun);
  assert.equal(ab.teacher, 'ada');
  assert.equal(ab.entries.some((e) => e.kind === '正文'), true, 'ada 的包里要有她自己的产物');
});

test('★ 缺件即拒：清单登记的产物不在盘上 → 不写任何文件、exit 1、点名是哪一件（P0-③）', () => {
  const { root, json, runId, product } = makeProject();
  rmSync(product); // 正文被清理（比如磁盘整理动过产物目录）
  const dir = join(root, '产物', '_运行', runId, `发布包_${runId}`);
  const r = runBundle(json, []);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /拒绝导出部分包|不在盘上/);
  assert.match(r.out, /art-/, '要点名是哪一件（产物身份，不只是路径）');
  assert.equal(existsSync(dir), false, '目标目录不许有任何新文件——部分包看起来就像完整的包');
});

test('★ 重复导出：旧目录整个让位，目录内容严格等于本次清单（P1-④）', () => {
  const { root, json, runId } = makeProject();
  assert.equal(runBundle(json, []).status, 0);
  const dir = join(root, '产物', '_运行', runId, `发布包_${runId}`);
  // 模拟"上一次导出留下的多余文件"（旧清单登记过、这次已删的产物）
  writeFileSync(join(dir, '上一轮残留_分层_九3.json'), '{}', 'utf-8');
  const r = runBundle(json, []);
  assert.equal(r.status, 0, r.out);
  assert.equal(existsSync(join(dir, '上一轮残留_分层_九3.json')), false, '旧的多余文件必须消失——收件人拿到的目录内容等于本次清单');
  // 收件人核对也应通过：旧文件混进 --check 的视野会被报成"夹带"，那就是一次假警报
  assert.equal(runBundle(json, ['--check', dir]).status, 0);
});

test('★ 决定条数：三层各一条决定 → decisionCount = 3，层键与层级标签是同一个口径（P1-⑤）', () => {
  const { root, json, runId } = makeProject('A,M,B');
  // 写日志的一侧用**层级标签**命名（A层85.jsonl）；发布包手里是清单里的**裸层键**（'A'）——
  // 两种写法必须解析到同一个文件，否则决定条数永远数成 0
  const TIER_TAG: Record<string, string> = { A: 'A层85', M: 'M层75', B: 'B层60' };
  const decisionDir = join(root, '产物', '_运行', runId, '决定');
  mkdirSync(decisionDir, { recursive: true });
  for (const t of ['A', 'M', 'B']) {
    const ev = { schemaVersion: 1, itemId: `第一章#1:TEST-${t}`, decision: 'accept', before: 'x', after: 'y', reason: '第七轮验收用', ruleIds: [], teacherId: 'wayne', timestamp: '2026-01-01T00:00:00.000Z' };
    writeFileSync(join(decisionDir, `${TIER_TAG[t]}.jsonl`), `${JSON.stringify(ev)}\n`, 'utf-8');
  }

  const r = runBundle(json, []);
  assert.equal(r.status, 0, r.out);
  const desc = JSON.parse(readFileSync(join(root, '产物', '_运行', runId, `发布包_${runId}`, '发布包.json'), 'utf-8')) as { decisionCount: number };
  assert.equal(desc.decisionCount, 3, `三层各一条决定要数成 3（每一层都计入），实得 ${desc.decisionCount}`);
});
