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

/** 造一个两章的项目：`barn` 是超纲词，两章都出现。
 *  用来验证「一个词全篇只注一次」这条规则**不会**把后来章节判成漏注——
 *  提示词说"已经注过的绝不要再注"，门禁要是还要求注，模型永远过不了关。 */
function makeTwoChapterProject(): { root: string; json: string } {
  const { root, json } = makeProject();
  mkdirSync(join(root, '原文', '第二章'), { recursive: true });
  writeFileSync(
    join(root, '原文', '第二章', '原文_规范化.md'),
    '## Chapter Two\n\n[P01] The barn was old and the boy ran to it.\n',
    'utf-8',
  );
  // 词库里去掉 barn → barn 在两章都是超纲词
  writeFileSync(
    join(root, '词库.csv'),
    ['词,类型', ...['the', 'boy', 'ran', 'to', 'red', 'and', 'saw', 'a', 'small', 'dog', 'old', 'it', 'was', 'barn'].filter((w) => w !== 'barn').map((x) => `${x},单词`)].join('\n') + '\n',
    'utf-8',
  );
  return { root, json };
}

/** 多段项目：验证会话滚动窗口（报告 §二：「一本书一条无限增长会话」不应是唯一模式） */
function makeManySegmentProject(n: number): { root: string; json: string } {
  const { root, json } = makeProject();
  const segs = Array.from({ length: n }, (_, i) => `[P${String(i + 1).padStart(2, '0')}] The boy ran to the red barn and saw a small dog.`).join(' ');
  writeFileSync(join(root, '原文', '第一章', '原文_规范化.md'), `## Chapter One\n\n${segs}\n`, 'utf-8');
  return { root, json };
}

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


test('跨章不重复注：第 1 章注过的词，第 2 章不再注也**不算漏注**（提示词与门禁不能打架）', () => {
  const { root, json } = makeTwoChapterProject();
  // 先只跑第 1 章：产物里会把 barn 注出来
  const r1 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '两章'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r1.status, 0, `第 1 章应通过，实得 ${r1.status}\n${r1.stderr}`);
  const ch1 = readFileSync(join(root, '产物', '第一章', `原文_${TAG}_${DATE}_两章.md`), 'utf-8');
  assert.match(ch1, /barn（/, '第 1 章应把 barn 注出（首次出现处）');

  // 再跑第 2 章：同一个 barn 已被第 1 章注过 → 本段不该再被要求注
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '2', '--out', '两章'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'exact', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r2.status, 0, `第 2 章不该因"没有重复注 barn"而被判漏注，实得 ${r2.status}\n${r2.stderr}`);
});

test('本地去重：模型在后面的章节里重复注同一个词，会被本地清掉（保首次）', () => {
  const { root, json } = makeTwoChapterProject();
  const run1 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '去重'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(run1.status, 0, run1.stderr);
  const run2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '2', '--out', '去重'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(run2.status, 0, run2.stderr);
  const ch2 = readFileSync(join(root, '产物', '第二章', `原文_${TAG}_${DATE}_去重.md`), 'utf-8');
  assert.equal(/barn（/.test(ch2), false, '第 2 章的重复注释必须被本地去掉（一个词全篇只注一次）');
  assert.match(ch2, /barn/, '去掉的只是注释，正文的词还在');
});

test('查词走严格 schema 的 tool call：往返成功、事件日志留下 tool 记录', () => {
  const { root, json } = makeTwoChapterProject();   // barn 在词库外 → 会走一次真实查词
  const r = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '工具'], {
    cwd: REPO,
    encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'tool', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r.status, 0, `工具往返后应通过，实得 ${r.status}\n${r.stderr}`);
  const log = readFileSync(join(root, '调适', '_会话', `${TAG}_工具.jsonl`), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; words?: string[]; role?: string; tool_call_id?: string });
  const toolEvents = log.filter((o) => o.t === 'tool');
  assert.equal(toolEvents.length >= 1, true, '「查词」必须留下 tool 事件（回放时能看到模型问过什么）');
  assert.deepEqual(toolEvents[0].words, ['barn']);
  // 工具协议要求回一条 role:'tool' 的消息（带 tool_call_id），否则下一次调用是非法的；
  // 而且它必须**写进事件日志**——否则 --resume 重建会话时会缺这一条，API 直接拒。
  const msgs = log.filter((o) => o.t === 'msg') as unknown as { role?: string; tool_call_id?: string; tool_calls?: unknown[] }[];
  assert.equal(msgs.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1'), true, '工具回复必须带 tool_call_id 且进日志');
  assert.equal(msgs.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls)), true, '带 tool_calls 的助手回合也要进日志');
  assert.match(readFileSync(join(root, '产物', '第一章', `原文_${TAG}_${DATE}_工具.md`), 'utf-8'), /barn（/);
});

test('会话滚动窗口：超出窗口就归档历史、只结转结构化状态，且这一轮照样跑完', () => {
  const { root, json } = makeManySegmentProject(6);
  const r = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '滚动', '--window', '1'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'exact', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(root, '调适', '_会话', `${TAG}_滚动.jsonl`), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const wins = log.filter((o) => o.t === 'window');
  assert.equal(wins.length >= 1, true, '超出窗口必须留下 window 事件（否则无从知道历史被归档过）');
  assert.match(String(wins[0].carry), /结转上下文/);
  assert.match(String(wins[0].carry), /全篇只注一次/, '结转里必须带"已注词"这条约束');
  assert.equal(log.filter((o) => o.t === 'done').length, 6, '六段都要完成');

  // 续跑：必须重放同样的裁剪，重建出合法会话（否则等于"同一份日志两种上下文"）
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '滚动', '--window', '1', '--resume'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'exact', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r2.status, 0, `滚动后的续跑必须能跑通，实得 ${r2.status}\n${r2.stderr}`);
});

test('不滚动（--window 0）时行为与从前一致：不留 window 事件', () => {
  const { root, json } = makeManySegmentProject(4);
  const r = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '不滚', '--window', '0'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'exact', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(r.status, 0, r.stderr);
  const log = readFileSync(join(root, '调适', '_会话', `${TAG}_不滚.jsonl`), 'utf-8');
  assert.equal(log.includes('"t":"window"'), false);
});
/* ────────────────── 路径布局：第二个人/第二次运行不许撞名（报告 §三） ────────────────── */

function initManifest(root: string, json: string, layout: string, teacher: string): { status: number | null; stdout: string } {
  const r = spawnSync(
    process.execPath,
    [join(REPO, 'tools', 'af_pipeline', 'LayerText_AF清单.mjs'), '--new', '--tier', 'A', '--chapters', '1', '--layout', layout, '--teacher', teacher],
    { cwd: REPO, encoding: 'utf-8', env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO } },
  );
  void root;
  return { status: r.status, stdout: r.stdout ?? '' };
}

test('run 布局：产物收进运行私有目录，两位教师各跑一次互不影响', () => {
  const { root, json } = makeProject();
  const a = initManifest(root, json, 'run', 'wayne');
  assert.equal(a.status, 0, a.stdout);
  const ridA = /运行 ID：(\S+)/.exec(a.stdout)?.[1];
  assert.ok(ridA, `没拿到运行 ID：${a.stdout}`);

  const run1 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(run1.status, 0, run1.stderr);
  const runDirA = join(root, '产物', '_运行', ridA!);
  assert.equal(existsSync(join(runDirA, '正文', '第一章', `原文_${TAG}_${DATE}.md`)), true, '正文必须落在运行私有目录里');
  assert.equal(existsSync(join(runDirA, '完成.json')), true);
  assert.equal(existsSync(join(runDirA, '会话', `${TAG}.jsonl`)), true, '会话日志也要跟运行走，否则两人并行会串上下文');
  // legacy 的老路径不该再被写（否则就是"两套路径并存"，比撞名更难查）
  assert.equal(existsSync(join(root, '产物', '第一章', `原文_${TAG}_${DATE}.md`)), false);
  assert.equal(existsSync(join(root, '产物', '_运行', `${TAG}.完成.json`)), false);

  // 第二位教师：另一个运行 ID，另一套产物目录，且两边的产物都在
  const b = initManifest(root, json, 'run', 'li');
  const ridB = /运行 ID：(\S+)/.exec(b.stdout)?.[1];
  assert.ok(ridB);
  assert.notEqual(ridA, ridB, '不同教师必须是不同的运行 ID');

  const run2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(run2.status, 0, run2.stderr);
  const runDirB = join(root, '产物', '_运行', ridB!);
  assert.equal(existsSync(join(runDirB, '正文', '第一章', `原文_${TAG}_${DATE}.md`)), true);
  assert.equal(existsSync(join(runDirA, '正文', '第一章', `原文_${TAG}_${DATE}.md`)), true, '前一位教师的产物一个字都没被动');
});

test('legacy 布局（默认）：路径与从前逐字符一致，教师已有工作流不受影响', () => {
  const { root, json } = makeProject();
  const a = initManifest(root, json, 'legacy', 'wayne');
  assert.equal(a.status, 0, a.stdout);
  const run1 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1'], {
    cwd: REPO, encoding: 'utf-8',
    env: { ...process.env, LAYERTEXT_FAKE_LLM: 'annotate', LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(run1.status, 0, run1.stderr);
  assert.equal(existsSync(join(root, '产物', '第一章', `原文_${TAG}_${DATE}.md`)), true);
  assert.equal(existsSync(join(root, '产物', '_运行', `${TAG}.完成.json`)), true);
  assert.equal(existsSync(join(root, '调适', '_会话', `${TAG}.jsonl`)), true);
});

/* ────────────────── 统一词典：增量 + 显式合并（报告 §三 点名的并发写入） ────────────────── */

const MERGE_SCRIPT = join(REPO, 'tools', 'af_pipeline', 'LayerText_AF词典合并.mjs');
const withFake = (fake: string, json: string) => ({
  cwd: REPO,
  encoding: 'utf-8' as const,
  env: { ...process.env, LAYERTEXT_FAKE_LLM: fake, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
});

test('统一词典：生成阶段只写运行私有增量，不动共享词典（并发写入不再互相覆盖）', () => {
  const { root, json } = makeTwoChapterProject();   // barn 超纲 → 会走一次真实「查词 + 配释义」
  const dictPath = join(root, '词典.csv');
  const before = readFileSync(dictPath, 'utf-8');

  const run1 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '词'], {
    ...withFake('tool', json),
  });
  assert.equal(run1.status, 0, `${run1.stdout}\n${run1.stderr}`);

  // 增量落在运行私有文件里，共享词典一个字节都没动
  const delta = join(root, '产物', '_运行', `${TAG}_词.词典增量.json`);
  assert.equal(existsSync(delta), true, '必须写运行私有增量（否则并行跑就会互相覆盖）');
  const deltaJson = JSON.parse(readFileSync(delta, 'utf-8')) as { entries: { word: string; zh: string }[] };
  assert.equal(deltaJson.entries.some((e) => e.word === 'barn'), true);
  assert.equal(readFileSync(dictPath, 'utf-8'), before, '生成阶段不该直接改共享词典');

  // 合并是显式的一步
  const merge = spawnSync(process.execPath, [MERGE_SCRIPT], { cwd: REPO, encoding: 'utf-8', env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO } });
  assert.equal(merge.status, 0, merge.stderr);
  const after = readFileSync(dictPath, 'utf-8');
  assert.match(after, /barn,风车/, '合并后共享词典应有该词');
  assert.match(merge.stdout, /新增 1/);

  // 幂等：再合一次不重复加
  const merge2 = spawnSync(process.execPath, [MERGE_SCRIPT], { cwd: REPO, encoding: 'utf-8', env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO } });
  assert.equal(merge2.status, 0);
  assert.match(merge2.stdout, /无变化 1/);
  assert.equal(readFileSync(dictPath, 'utf-8'), after);
});

test('统一词典：合并过的词下次不再问一遍（原来会被并行运行覆盖掉）', () => {
  const { root, json } = makeTwoChapterProject();
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '词A'], withFake('tool', json)).status, 0);
  assert.equal(spawnSync(process.execPath, [MERGE_SCRIPT], { cwd: REPO, encoding: 'utf-8', env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO } }).status, 0);

  // 第二次跑：词典里已经有 barn 的释义 → 不该再产生一条"新配"
  const r2 = spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1', '--out', '词B'], withFake('tool', json));
  assert.equal(r2.status, 0, r2.stderr);
  const delta2 = join(root, '产物', '_运行', `${TAG}_词B.词典增量.json`);
  const entries = existsSync(delta2) ? (JSON.parse(readFileSync(delta2, 'utf-8')) as { entries: unknown[] }).entries : [];
  assert.equal(entries.length, 0, '词典里已有的词不该再被新配一次');
  assert.match(readFileSync(join(root, '词典.csv'), 'utf-8'), /barn,风车/);
});

test('run 布局：风险队列也写进运行私有目录（App 面板按同一套解析才找得到）', () => {
  const { root, json } = makeProject();
  const a = initManifest(root, json, 'run', 'wayne');
  const rid = /运行 ID：(\S+)/.exec(a.stdout)?.[1];
  assert.ok(rid);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--tier', 'A', '--chapters', '1'], withFake('annotate', json)).status, 0);

  const rq = spawnSync(process.execPath, [join(REPO, 'tools', 'af_pipeline', 'LayerText_AF风险队列.mjs'), '--tier', 'A', '--chapters', '1'], {
    cwd: REPO, encoding: 'utf-8', env: { ...process.env, LAYERTEXT_PROJECT: json, LAYERTEXT_ENGINE: REPO },
  });
  assert.equal(rq.status, 0, `${rq.stdout}\n${rq.stderr}`);
  const runDir = join(root, '产物', '_运行', rid!);
  assert.equal(existsSync(join(runDir, '风险队列.json')), true, '队列 JSON 必须在运行私有目录里（面板去那儿找）');
  assert.equal(existsSync(join(root, '产物', '_运行', `风险队列_${TAG}.json`)), false, '不该同时写 legacy 路径（两套路径并存比撞名更难查）');

  // 面板用引擎的解析器算出来的路径，必须与脚本写的一致
  const parsed = JSON.parse(readFileSync(join(runDir, '风险队列.json'), 'utf-8')) as { 层级: string[] };
  assert.deepEqual(parsed.层级, ['A']);
});
