/**
 * 词典锁 · 真并发（真开多个进程抢同一把锁）
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「**锁和原子提交**覆盖并发生成、并发审校和断点续跑」
 *
 * 为什么必须真开进程：原来的实现是
 *   `lockState(readLock())` → 判断 free → `writeFileSync(lockPath, …)`
 * ——这是一条 **TOCTOU**（检查与使用之间有窗口）：
 * 两个进程可以同时看到 free、同时写，于是**两个都以为自己拿到了锁**。
 * 单进程里怎么测都测不出来，因为它需要的是**真并发**。
 *
 * 判据不是"有没有报错"，而是**临界区有没有真的互斥**：
 * 每个进程进临界区时写 `BEGIN`、出去时写 `END`；
 * 互斥成立 ⟺ 读回来的序列恰好是 BEGIN END BEGIN END …（**绝不出现 BEGIN BEGIN**）。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = join(REPO, 'tools', 'af_pipeline', 'LayerText_AF词表与词典.mjs');

/** 一个只做一件事的工人：抢锁 → 记 BEGIN → 停一会 → 记 END → 放锁 */
const WORKER = `
// node -e "…" a b c 的 process.argv 是 [node, a, b, c]——没有脚本路径那一项
const [shared, lockPath, seqPath, tag, holdMs, waitMs] = process.argv.slice(1);
const { withLock } = await import(shared);
const { appendFileSync } = await import('node:fs');
await withLock(lockPath, async () => {
  appendFileSync(seqPath, 'BEGIN ' + tag + '\\n');
  await new Promise((r) => setTimeout(r, Number(holdMs)));
  appendFileSync(seqPath, 'END ' + tag + '\\n');
}, { waitMs: Number(waitMs ?? 60000), pollMs: 50 });
`;

function runWorker(lockPath: string, seqPath: string, tag: string, holdMs: number, waitMs = 60_000): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', WORKER, SHARED, lockPath, seqPath, tag, String(holdMs), String(waitMs)], {
      cwd: REPO,
      env: { ...process.env, LAYERTEXT_ENGINE: REPO },
    });
    let err = '';
    p.stderr.on('data', (d) => (err += String(d)));
    p.on('close', (code) => resolve({ code, err }));
  });
}

/* 对照实测（4 进程 × 60ms 临界区 × 6 轮）：
 *   改造前（读-判-写）：6/6 轮出现临界区重叠
 *   改造后（O_EXCL）  ：0/6
 * 也就是说这不是"理论上可能"，而是**每次都会**。 */
test('★ 四个进程抢同一把锁：临界区**真的互斥**（序列里绝不出现 BEGIN BEGIN）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-lock-'));
  const lockPath = join(root, '词典.csv.lock');
  const seqPath = join(root, 'seq.txt');
  writeFileSync(seqPath, '', 'utf-8');

  // 四个工人同时起跑，每人占锁 60ms —— 有重叠的窗口足够大，TOCTOU 一定暴露
  const results = await Promise.all([0, 1, 2, 3].map((i) => runWorker(lockPath, seqPath, `w${i}`, 60)));

  const failed = results.filter((r) => r.code !== 0);
  assert.equal(failed.length, 0, `四个工人都该跑完，实得 ${failed.length} 个失败：${failed.map((f) => f.err).join('|')}`);

  const lines = readFileSync(seqPath, 'utf-8').split('\n').filter(Boolean);
  assert.equal(lines.length, 8, `四个 BEGIN + 四个 END，实得 ${lines.length} 行：${lines.join(' ')}`);

  /* ★ 核心断言：把祖先括号当成锁的判据。
   * 只要出现「BEGIN 之后还没 END 就又 BEGIN」，就说明两个进程同时进了临界区。 */
  const stack: string[] = [];
  for (const line of lines) {
    const [kind, tag] = line.split(' ');
    if (kind === 'BEGIN') {
      assert.equal(stack.length, 0, `临界区重叠了：${tag} 进入时 ${stack.join(',')} 还没出去——锁没起作用`);
      stack.push(tag!);
    } else {
      assert.equal(stack.pop(), tag, `END 与 BEGIN 对不上：${line}`);
    }
  }
  assert.equal(stack.length, 0, '收尾时不该还有人在临界区里');
  // 锁文件用完要收干净（否则下一次运行会被自己的残留挡住）
  assert.equal(existsSync(lockPath), false, '跑完要把锁文件删掉');

  rmSync(root, { recursive: true, force: true });
});

test('★ 陈旧锁（进程已死）能被夺过来，不会把整条流水线卡死', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-lock-stale-'));
  const lockPath = join(root, '词典.csv.lock');
  const seqPath = join(root, 'seq.txt');
  writeFileSync(seqPath, '', 'utf-8');
  // 造一把"持有者早就没了"的锁：pid 用一个几乎不可能存在的值
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, host: 'other', at: new Date().toISOString() }), 'utf-8');

  const r = await runWorker(lockPath, seqPath, 'w0', 10);
  assert.equal(r.code, 0, `陈旧锁应当被夺过来继续跑，实得 ${r.code}：${r.err}`);
  const lines = readFileSync(seqPath, 'utf-8').split('\n').filter(Boolean);
  assert.deepEqual(lines, ['BEGIN w0', 'END w0']);

  rmSync(root, { recursive: true, force: true });
});

test('★ 活锁（持有者还在）会被挡住并**说清是谁占着**，而不是静默继续', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lt-lock-held-'));
  const lockPath = join(root, '词典.csv.lock');
  const seqPath = join(root, 'seq.txt');
  writeFileSync(seqPath, '', 'utf-8');
  // 持有者 = 本进程（`process.kill(pid,0)` 对这个 pid 一定返回"活着"）
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, host: 'here', at: new Date().toISOString() }), 'utf-8');

  const r = await runWorker(lockPath, seqPath, 'w0', 10, 800);
  assert.notEqual(r.code, 0, '持有者还活着时不该放行');
  assert.match(r.err, /等锁超时/, '活锁等不到就要超时退出，而不是永远等下去');
  assert.match(r.err, /词典\.csv\.lock/, '要把锁文件路径说出来，人才能去处理');
  assert.match(r.err, /占着/, '要说清是谁占着（pid/host/时间）');
  assert.match(r.err, /等它跑完/, '要给出可行动的下一步');
  const lines = readFileSync(seqPath, 'utf-8').split('\n').filter(Boolean);
  assert.deepEqual(lines, [], '**没能进临界区就一个字都不该写**');

  rmSync(root, { recursive: true, force: true });
});
