/**
 * P0 集成验收：《LayerText 项目审查报告（2026-09-11）》要求 ——
 *   「构造一个永远超长的 mock 响应，断言输出目录没有"完成"标记且进程退出码为 1。」
 *
 * 这里跑的是**真实的** tools/af_pipeline/LayerText_AF会话改写.mjs（子进程），
 * 只把模型换成确定性的假响应（LAYERTEXT_FAKE_LLM）：
 *   long  = 一段 120 词的超长句（必不过门禁）
 *   exact = 按目标词数精确回放原文（必过门禁，用来证明"通过路径确实写了完成标记"）
 *
 * 两个方向都要测：只会拦、不会放的门禁是坏的；只会放、不会拦的门禁是**危险的**。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'tools', 'af_pipeline', 'LayerText_AF会话改写.mjs');
const DATE = '2026-01-01';
const TAG = 'A层85';
const SUFFIX = '_自检';
/** 全部词都在自检词库里 → 该段没有任何超纲词，门禁只管篇幅/句长/中文 */
const SOURCE = '[P01] The boy ran to the red barn and saw a small dog.';

function makeProject(): { root: string; json: string } {
  const root = mkdtempSync(join(tmpdir(), 'lt-gate-'));
  const w = (...p: string[]): string => join(root, ...p);
  mkdirSync(w('原文', '第一章'), { recursive: true });
  mkdirSync(w('调适', '_会话'), { recursive: true });
  mkdirSync(w('产物'), { recursive: true });
  writeFileSync(
    w('原文', '第一章', '原文_规范化.md'),
    `## Chapter One\n\n${SOURCE}\n`,
    'utf-8',
  );
  writeFileSync(
    w('词库.csv'),
    // 类型必须是「单词/课标词/待定词」才计入 known（lexicon.ts 的口径），
    // 写成 n/v 之类会让这些词全被判成 OOV —— 第一版自检就踩了这个坑。
    ['词,类型', ...['the', 'boy', 'ran', 'to', 'red', 'barn', 'and', 'saw', 'a', 'small', 'dog'].map((x) => `${x},单词`)].join('\n') + '\n',
    'utf-8',
  );
  writeFileSync(w('专名表.txt'), '# 专名\n', 'utf-8');
  writeFileSync(w('知识库.csv'), '类型,词,值,次数\n', 'utf-8');
  writeFileSync(w('词典.csv'), '词,释义,来源\n', 'utf-8');
  const json = w('调适项目_自检.json');
  writeFileSync(
    json,
    JSON.stringify({
      书名: '门禁自检',
      工作区: root,
      调适工作区: w('调适'),
      原文目录: w('原文'),
      产物目录: w('产物'),
      词库: w('词库.csv'),
      书级: { 专名表: w('专名表.txt'), 知识库: w('知识库.csv'), 词典: w('词典.csv') },
      日期: DATE,
      章数: 1,
      引擎目录: REPO,
    }, null, 2),
    'utf-8',
  );
  return { root, json };
}

function run(fake: string, project: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '自检'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: fake, LAYERTEXT_PROJECT: project, LAYERTEXT_ENGINE: REPO },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('P0 验收：永远超长的 mock 响应 → 输出目录没有完成标记、坏产物不进正文、退出码 1', () => {
  const { root, json } = makeProject();
  const r = run('long', json);
  const done = join(root, '产物', '_运行', `${TAG}${SUFFIX}.完成.json`);
  const review = join(root, '产物', '_运行', `${TAG}${SUFFIX}.待复核.json`);
  const outFile = join(root, '产物', '第一章', `原文_${TAG}_${DATE}${SUFFIX}.md`);

  // ① 进程必须非零退出（否则管线会以为这层跑完了）
  assert.equal(r.status, 1, `期望退出码 1，实得 ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);

  // ② 输出目录不能有"完成"标记
  assert.equal(existsSync(done), false, '未通过时绝不能写完成标记');

  // ③ 未通过的产物不得进入正文
  if (existsSync(outFile)) {
    const out = readFileSync(outFile, 'utf-8');
    assert.equal(out.includes('word0'), false, '门禁未通过的内容绝不能落进正式产物');
  }

  // ④ 必须留下失败清单与隔离副本（不能只是"没写"，还得让人能接着处理）
  assert.equal(existsSync(review), true, '必须写待复核失败清单');
  const list = JSON.parse(readFileSync(review, 'utf-8')) as {
    待复核: number;
    层级: string;
    待复核明细: { 位置: string; 规则: string[] }[];
  };
  assert.equal(list.层级, 'A');
  assert.equal(list.待复核, 1);
  assert.equal(list.待复核明细[0].位置, '第一章 第1段');
  assert.equal(list.待复核明细[0].规则.includes('LEN-01'), true);
  assert.equal(list.待复核明细[0].规则.includes('SENT-01'), true);
  assert.equal(existsSync(join(root, '产物', '_待复核', `${TAG}${SUFFIX}`, '第一章_第1段.md')), true);
  assert.equal(existsSync(join(root, '产物', '_待复核', `${TAG}${SUFFIX}`, '第一章_第1段.json')), true);

  // ⑤ stderr 必须把问题喊出来（静默是最坏的失败方式）
  assert.match(r.stderr, /复检未通过/);
});

test('P0 反向：通过的段确实写正文与完成标记、退出码 0（门禁不能只会拦）', () => {
  const { root, json } = makeProject();
  const r = run('exact', json);
  const done = join(root, '产物', '_运行', `${TAG}${SUFFIX}.完成.json`);
  const outFile = join(root, '产物', '第一章', `原文_${TAG}_${DATE}${SUFFIX}.md`);

  assert.equal(r.status, 0, `期望退出码 0，实得 ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(existsSync(done), true, '全部通过时必须写完成标记');
  assert.equal(readFileSync(outFile, 'utf-8').includes('red barn'), true, '通过的段必须落进正文');
  assert.equal(existsSync(join(root, '产物', '_运行', `${TAG}${SUFFIX}.待复核.json`)), false);

  const summary = JSON.parse(readFileSync(done, 'utf-8')) as {
    已完成: number;
    待复核: number;
    提示词版本: string;
    用量: { calls: number };
  };
  assert.equal(summary.已完成, 1);
  assert.equal(summary.待复核, 0);
  assert.match(summary.提示词版本, /^session-v/, '运行清单必须记下提示词版本（复现失败段落时要用）');
});

test('P0 续跑语义：未通过的段不进 done，--resume 会重跑它而不是跳过', () => {
  const { root, json } = makeProject();
  assert.equal(run('long', json).status, 1);

  // 第一轮留下的会话日志里，done 事件数必须是 0（未通过 = 没完成）
  const log = readFileSync(join(root, '调适', '_会话', `${TAG}${SUFFIX}.jsonl`), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string });
  const doneEvents = log.filter((o) => o.t === 'done');
  const reviewEvents = log.filter((o) => o.t === 'review');
  assert.equal(doneEvents.length, 0, '未通过的段绝不能写 done 事件');
  assert.equal(reviewEvents.length, 1, '未通过的段必须写 review 事件');

  // 换成能过的假模型续跑 → 必须真的重跑并完成
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '自检', '--resume'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'exact', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r2.status, 0, `续跑应能完成，实得 ${r2.status}\n${r2.stderr}`);
  assert.equal(existsSync(join(root, '产物', '_运行', `${TAG}${SUFFIX}.完成.json`)), true);
});

test('P0 旧标记作废：同一层的上一轮成功标记必须被本轮失败作废', () => {
  const { root, json } = makeProject();
  assert.equal(run('exact', json).status, 0);
  const done = join(root, '产物', '_运行', `${TAG}${SUFFIX}.完成.json`);
  assert.equal(existsSync(done), true, '先决条件：上一轮留下了完成标记');

  // 清掉会话日志 = 全新一轮（done 为空），换成必不过的假模型
  writeFileSync(join(root, '调适', '_会话', `${TAG}${SUFFIX}.jsonl`), '', 'utf-8');
  assert.equal(run('long', json).status, 1);
  assert.equal(existsSync(done), false, '本轮没完成 → 上一轮的成功标记必须作废，否则旧标记会掩盖新失败');
  assert.equal(existsSync(join(root, '产物', '_运行', `${TAG}${SUFFIX}.待复核.json`)), true);
});
