/**
 * B1 批次③ · 端到端对撞（验收 D/E/F，2026-09-26）
 *
 * D：同一合成项目、同一组 mock AI 回复，CLI 路径（spawn 两轮调适.mjs --round2，
 *     AI 指向本地 mock HTTP 服务）与 App 路径（r2run.runRound2ForSession，AI 走
 *     mockIPC plugin-http 配方）跑出的**终稿与调适报告逐字节一致**。
 * E：第三轮拒绝——R2 完成后两端再跑都拒绝（CLI 打印"两轮已用完"，App gate.ok=false
 *     且按钮条件 disabled）。
 * F：进度 JSON 新旧形状互读——R1 代形状 {done,texts,round:1} 与 R2 代形状
 *     {round:2,done,feedback,boundaryNote} 在 core 闸门与 App 按钮预检下都读得对。
 *
 * mockIPC 协议知识沿自 tests/wordsimpl.test.ts（2026-09-16 活探针）：
 * plugin:http|fetch → rid；fetch_send → {status,url,headers,rid}；
 * fetch_read_body → 数据块 […字节,0] + 终止块 [1]。
 */

import './_dom_env.js'; // 必须第一个：DOM 骨架 + ?raw 钩子注册先于 app 模块动态 import
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url)); // dist/tests/r2e2e.test.js → 仓库根（'..' 消文件名层）

/* ── mock AI 回复：按调用序吐段（两端共用同一序列——AI 文本是唯一变量，对撞才有意义） ── */
const REPLIES = [
  '[P01] The boy went to the big house fast and he saw a strange thing there.',
  '[P02] "We must work hard," he said, "and never forget the big dog."',
  '[P03] The sun came up. The birds sang. It was a good day for everyone.',
  '[P04] Later the animals came to the barn to hear the plan and all said yes to the rules.',
];

const FEEDBACK = '词汇太难，句子有些绕，情节可以'; // 无幅度词 → 不触发折算，两端口径最小化

function synthProject(root: string): { cfg: string; r1: string; final: string; report: string } {
  mkdirSync(join(root, '原文/第一章'), { recursive: true });
  mkdirSync(join(root, '产物/第一章'), { recursive: true });
  mkdirSync(join(root, '产物/_运行'), { recursive: true });
  writeFileSync(
    join(root, '原文/第一章/原文_规范化.md'),
    '# Test Book\n\n## Chapter One\n\n[P01] The boy zzxqvw quickly to the big house and he saw a mmbvplk that was very qwertyuiop strange indeed my friend because the old farm had been abandoned.\n[P02] "We must work zzxqvw," he said, "and never forget the mmbvplk."\n[P03] The sun rose. Birds sang. It was a good day.\n[P04] Later the animals gathered around the barn to hear the plan about the future of the farm and everyone agreed.\n',
  );
  writeFileSync(
    join(root, '产物/第一章/原文_A层85_2026-09-26_R1.md'),
    '# Test Book\n\n## Chapter One\n\n[P01] The boy zzxqvw ran to the big house and he saw a mmbvplk that was very qwertyuiop strange indeed my friend because the old farm had been abandoned.\n[P02] "We must work zzxqvw," he said, "and never forget the mmbvplk."\n[P03] The sun came up. Birds sang. It was a good day.\n[P04] Later the animals came to the barn to hear the plan about the farm and all agreed to follow the rules.\n',
  );
  writeFileSync(
    join(root, '词库.csv'),
    '词,类型\nthe,单词\nboy,单词\nran,单词\nhouse,单词\nsaid,单词\nwork,单词\nsun,单词\nbirds,单词\ngood,单词\nday,单词\nfarm,单词\nrules,单词\nanimals,单词\nbarn,单词\nplan,单词\n',
  );
  const cfg = join(root, '调适项目_e2e.json');
  writeFileSync(
    cfg,
    JSON.stringify(
      {
        书名: 'TestBook',
        工作区: root,
        调适工作区: root,
        原文目录: join(root, '原文'),
        产物目录: join(root, '产物'),
        词库: join(root, '词库.csv'),
        引擎目录: REPO.replace(/\/$/, ''),
        日期: '2026-09-26',
      },
      null,
      2,
    ),
  );
  return {
    cfg,
    r1: join(root, '产物/第一章/原文_A层85_2026-09-26_R1.md'),
    final: join(root, '产物/第一章/原文_A层85_2026-09-26.md'),
    report: join(root, '产物/调适报告_A层85_第一章_2026-09-26.md'),
  };
}

/* ── CLI 侧：本地 mock OpenAI 服务 + spawn ── */

function startMockServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    let i = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const reply = REPLIES[i++ % REPLIES.length];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

/** 异步 spawn（不能用 spawnSync：mock 服务器住在测试进程里，同步阻塞会冻结事件循环、
 * 子进程的 HTTP 请求永远无人应答——2026-09-26 实测挂死的原因）。 */
function runCli(cfg: string, port: number): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(REPO, 'tools/af_pipeline/LayerText_AF两轮调适.mjs'), 'A', '1', '--round2', '--feedback', FEEDBACK], {
      env: { ...process.env, LAYERTEXT_PROJECT: cfg, LAYERTEXT_AI_BASE_URL: `http://127.0.0.1:${port}/v1`, LAYERTEXT_AI_KEY: 'test-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    const timer = setTimeout(() => p.kill('SIGTERM'), 120000);
    p.on('close', (code, sig) => {
      clearTimeout(timer);
      resolve({ status: sig ? -1 : (code ?? -1), stdout: out });
    });
  });
}

/* ── App 侧：mockIPC 后端（真文件系统 + 有序 mock AI） ── */

function installAppBackend(root: string, replies: string[]): void {
  let idx = 0;
  let bodySent = false;
  let nextBody = '';
  const enc = new TextEncoder();
  mockIPC((cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case 'load_api_key':
        return 'test-key';
      case 'read_text_file':
        return readFileSync(args.path as string, 'utf8');
      case 'write_text_file': {
        const p = args.path as string;
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, args.content as string);
        return null;
      }
      case 'describe_path': {
        statSync(args.path as string);
        return { path: args.path };
      }
      case 'list_dir': {
        const dir = args.dir as string;
        const exts = (args.exts as string[] | undefined) ?? undefined;
        return readdirSync(dir)
          .filter((f) => !exts || exts.some((e) => f.endsWith(e)))
          .map((f) => join(dir, f));
      }
      case 'plugin:http|fetch': {
        const reply = replies[idx++ % replies.length];
        nextBody = JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
        bodySent = false;
        return 1;
      }
      case 'plugin:http|fetch_send':
        return { status: 200, statusText: 'OK', url: 'https://mock/v1/chat/completions', headers: [['content-type', 'application/json']], rid: 2 };
      case 'plugin:http|fetch_read_body': {
        const bytes = Array.from(enc.encode(nextBody));
        if (!bodySent) {
          bodySent = true;
          return [...bytes, 0];
        }
        return [1];
      }
      default:
        return null;
    }
  });
}

/* 夹具：CLI 与 App 各一份同构项目（配置内嵌绝对路径，必须分别生成） */
const dirA = mkdtempSync(join(tmpdir(), 'lt-e2e-cli-'));
const dirB = mkdtempSync(join(tmpdir(), 'lt-e2e-app-'));
const projA = synthProject(dirA);
const projB = synthProject(dirB);

test('验收D+E：App 路径与 CLI 路径产物逐字节一致；两端第三轮都拒绝', async (t) => {
  const { server, port } = await startMockServer();
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  /* CLI 路径 */
  const cli1 = await runCli(projA.cfg, port);
  assert.equal(cli1.status, 0, `CLI 首轮失败：\n${cli1.stdout.slice(-800)}`);
  assert.ok(existsSync(projA.final), 'CLI 终稿没写出');
  assert.ok(existsSync(projA.report), 'CLI 报告没写出');

  /* App 路径（mockIPC 后端真文件系统） */
  installAppBackend(dirB, REPLIES);
  const { S } = await import('../app/src/state.js');
  S.appConfig = { baseUrl: 'https://mock/v1', model: 'mock' } as typeof S.appConfig;
  /* 任务单+反馈（CLI --feedback 自动落单；App 硬闸要求确认态——按 App 反馈框的落盘形状造） */
  const { planRevisionTask } = await import('../src/core/adaptcheck.js');
  writeFileSync(
    projB.cfg.replace(/调适项目_e2e\.json$/, '产物/_运行/调适任务单_A层85_第一章.json'),
    JSON.stringify({ task: planRevisionTask('第一章', 'R1', FEEDBACK), expectedSegments: null, confirmed: true, confirmedAt: '2026-09-26T00:00:00.000Z' }, null, 2),
  );
  writeFileSync(projB.cfg.replace(/调适项目_e2e\.json$/, '产物/_运行/调适反馈_A层85_第一章.json'), JSON.stringify({ text: FEEDBACK, at: '2026-09-26T00:00:00.000Z' }, null, 2));
  const { runRound2ForSession, gatherR2ButtonConds } = await import('../app/src/r2run.js');
  const r2 = await runRound2ForSession({ sourcePath: projB.r1 } as never);
  assert.equal(r2.ok, true, 'App 路径执行失败（见上方状态行）');
  assert.ok(existsSync(projB.final), 'App 终稿没写出');
  assert.ok(existsSync(projB.report), 'App 报告没写出');

  /* D：逐字节对撞 */
  assert.deepEqual(readFileSync(projA.final), readFileSync(projB.final), '终稿不一致');
  assert.deepEqual(readFileSync(projA.report), readFileSync(projB.report), '调适报告不一致');

  /* E：第三轮拒绝——两端 */
  const cli2 = await runCli(projA.cfg, port);
  assert.equal(cli2.status, 0);
  assert.match(cli2.stdout, /两轮已用完/);
  const again = await runRound2ForSession({ sourcePath: projB.r1 } as never);
  assert.equal(again.ok, false, 'App 第三轮应拒绝');
  const conds = await gatherR2ButtonConds(projB.r1, true);
  assert.equal(conds.gateOk, false);
  assert.match(conds.gateReason, /两轮已用完/);

  clearMocks();
});

test('验收F：进度 JSON 新旧形状互读（R1 代 {done,texts,round} / R2 代 {round,done,feedback}）', async () => {
  const { planRound2 } = await import('../src/core/round2.js');
  const mk = (progressText: string | null, hasFinal: boolean) =>
    planRound2({ progressText, hasFinal, feedbackRaw: FEEDBACK, findings: [], srcSegs: [], r1Segs: [], progressSet: false, ladder: null, isKnownWord: () => true });
  /* R1 代形状（round1 写出：done/texts 键在前） */
  assert.equal(mk(JSON.stringify({ done: [0, 1], texts: {}, round: 1, at: '2026-09-12T00:00:00.000Z' }), false).gate.ok, true);
  /* R2 代形状（round2 写出：round 在前、带 feedback/boundaryNote） */
  const g2 = mk(JSON.stringify({ round: 2, done: [0, 1], feedback: FEEDBACK, boundaryNote: '', at: '2026-09-26T00:00:00.000Z' }), true);
  assert.equal(g2.gate.ok, false);
  assert.match(g2.gate.reason, /两轮已用完/);
  /* 坏 JSON → 当没有（旧字段缺失不影响闸门读数） */
  assert.equal(mk('{oops', true).gate.ok, true);
  clearMocks();
});
