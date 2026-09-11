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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AF = join(REPO, 'tools', 'af_pipeline');
const DATE = '2026-01-01';
const TAG = 'A层85';

/** 建一个自检项目，并把它推到"已建清单 + 已产出 A 层第一章 + 已刷状态"的状态 */
function makeProject(): { root: string; json: string; runId: string; product: string } {
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

  const init = run('LayerText_AF清单.mjs', ['--new', '--tier', 'A', '--chapters', '1', '--layout', 'run', '--teacher', 'wayne']);
  assert.equal(init.status, 0, init.out);
  const runId = /运行 ID：(\S+)/.exec(init.out)?.[1] ?? '';
  assert.notEqual(runId, '', `没拿到运行 ID：${init.out}`);

  const product = w('产物', '_运行', runId, '正文', '第一章', `原文_${TAG}_${DATE}.md`);
  mkdirSync(dirname(product), { recursive: true });
  writeFileSync(product, `## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n`, 'utf-8');
  assert.equal(run('LayerText_AF对照台账.mjs', ['--tier', 'A', '--chapters', '1']).status, 0);
  assert.equal(run('LayerText_AF清单.mjs', ['--stamp', '--step', '台账']).status, 0);

  return { root, json, runId, product };
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
  const { root, json } = makeProject();
  // 删掉指针与清单，模拟"没建过清单"
  const runDir = join(root, '产物', '_运行');
  for (const f of ['清单_最新.json']) writeFileSync(join(runDir, f), '{}', 'utf-8');
  const r = runBundle(json, []);
  assert.notEqual(r.status, 0, `没有清单不该成功：${r.out}`);
  assert.match(r.out, /没有运行清单|没有清单/);
  assert.match(r.out, /哪次运行|模型|词库/);
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
