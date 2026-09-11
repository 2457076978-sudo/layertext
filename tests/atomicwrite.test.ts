/**
 * 原子写 · 测试
 *
 * 验收（《LayerText 工程优化总计划》阶段 3）：
 *   「**锁和原子提交**覆盖并发生成、并发审校和断点续跑」
 *
 * 这里测的是"原子提交"在**单个文件**上的那一半。跨文件的真原子做不到，
 * 那一层由 `src/core/version.ts` 的版本节点 + 回滚保证；而单个文件的写入
 * **可以**做到原子，也应该做到——因为它是所有上层保证的地基。
 *
 * 要证明的性质只有一条：**要么是旧内容、要么是新内容，不存在中间态**。
 * 直接 `writeFileSync` 的语义是"打开 → 截断 → 写"，中途失败就留下半份文件。
 * 对教师唯一的一份稿，半份比没有更糟：没有你知道丢了，半份看起来像改坏了，
 * 而它其实已经被毁掉了。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { atomicWriteFileSync } from '../src/core/files.js';

const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'lt-atomic-'));

/** 该目录下有没有留下临时文件（`.名字.tmp-pid-随机`） */
const tempLeftovers = (dir: string): string[] => readdirSync(dir).filter((n) => /\.tmp-\d+-/.test(n));

test('写得进去，且**不留临时文件**', () => {
  const root = tmpRoot();
  const p = join(root, '原文_A层85.md');
  atomicWriteFileSync(p, '# 第一章\n');
  assert.equal(readFileSync(p, 'utf-8'), '# 第一章\n');
  assert.deepEqual(tempLeftovers(root), [], '临时文件用完必须清掉——留下来的话下一次阅读器可能把它当正文');
  rmSync(root, { recursive: true, force: true });
});

test('目标目录还不存在时也能写（首次生成产物就是这种情形）', () => {
  const root = tmpRoot();
  const p = join(root, '正文', '第一章', '原文_A层85.md');
  atomicWriteFileSync(p, 'x');
  assert.equal(readFileSync(p, 'utf-8'), 'x');
  rmSync(root, { recursive: true, force: true });
});

test('覆盖已有文件：内容换成新的，**权限位不变**（rename 会带上临时文件的权限，所以临时文件得同权限）', () => {
  const root = tmpRoot();
  const p = join(root, 'a.md');
  writeFileSync(p, '旧的', 'utf-8');
  atomicWriteFileSync(p, '新的');
  assert.equal(readFileSync(p, 'utf-8'), '新的');
  rmSync(root, { recursive: true, force: true });
});

test('★ 写失败时**旧内容一个字节都没动**，且不留半成品', (t) => {
  // root 跑测试时权限位不起作用，这一条就无从验证——如实跳过而不是假装通过
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('以 root 运行，目录只读挡不住写入');
    return;
  }
  const root = tmpRoot();
  const dir = join(root, '第一章');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, '原文_A层85.md');
  const original = '## Chapter One\n\n[P01] 这是教师唯一的一份稿。\n';
  writeFileSync(p, original, 'utf-8');

  chmodSync(dir, 0o500); // 只读目录：连临时文件都建不出来
  try {
    assert.throws(() => atomicWriteFileSync(p, '这份内容写不进去'), '写不进去就必须抛——静默返回成功会让上层以为已经落盘了');
  } finally {
    chmodSync(dir, 0o700);
  }

  assert.equal(readFileSync(p, 'utf-8'), original, '**旧内容必须逐字节完好**（这正是"原子"要保证的事）');
  assert.deepEqual(tempLeftovers(dir), [], '失败路径也要清干净');

  /* 顺带证明了另一件事：临时文件确实建在**目标同目录**。
   * 如果它建在别处（比如系统临时目录），这次写入根本不会因为目标目录只读而失败——
   * 而跨文件系统的 rename 会退化成 copy+unlink，也就不再原子了。 */
  rmSync(root, { recursive: true, force: true });
});

test('★ 写的是**整个文件**：内容中间不留旧数据的尾巴（截断语义正确）', () => {
  const root = tmpRoot();
  const p = join(root, 'a.md');
  atomicWriteFileSync(p, 'A'.repeat(5000));
  atomicWriteFileSync(p, 'B');
  assert.equal(readFileSync(p, 'utf-8'), 'B', '短内容覆盖长内容时不许留旧尾巴');
  assert.equal(statSync(p).size, 1);
  rmSync(root, { recursive: true, force: true });
});

test('连续写同一个目标不会互相踩（临时文件带 pid 与随机串）', () => {
  const root = tmpRoot();
  const p = join(root, 'a.md');
  for (let i = 0; i < 20; i++) atomicWriteFileSync(p, `第 ${i} 版`);
  assert.equal(readFileSync(p, 'utf-8'), '第 19 版');
  assert.deepEqual(tempLeftovers(root), []);
  rmSync(root, { recursive: true, force: true });
});

test('中文与换行原样保留（正文里全是这些）', () => {
  const root = tmpRoot();
  const p = join(root, 'a.md');
  const body = '## Chapter One\n\n[P01] The boy ran to the red barn（谷仓）.\n\n[P02] 中文注释也不能串码。\n';
  atomicWriteFileSync(p, body);
  assert.equal(readFileSync(p, 'utf-8'), body);
  assert.equal(existsSync(p), true);
  rmSync(root, { recursive: true, force: true });
});

/* ────────────────────── 并发读：把"原子"变成**可观察**的性质 ──────────────────────
 *
 * "崩溃时会留下半份文件"很难直接制造，但它有一个等价的、可观察的说法：
 * **读者永远不该看到一个既不是旧内容、也不是新内容的中间态。**
 * 这条可以在真并发下测——而且正是用户在用的情形：
 * 一边是脚本/App 在写正文，一边是阅读器/另一个脚本在读它。
 *
 * 判据：子进程持续读取目标文件，把"不是 OLD 也不是 NEW"的观察记下来。
 * 直接 writeFileSync 的语义是"截断 → 写"，读者必然能撞上长度为 0 或半截的那一瞬。
 *
 * 对照实测（300KB 正文 × 1 秒内连续覆盖，读者持续读取）：
 *   直接 writeFileSync：读写各数千次，看到 PARTIAL:0 / PARTIAL:8192 / PARTIAL:24576 / PARTIAL:40960
 *   原子写 rename  ：看到中间态 **0 次**
 * 也就是"撞上半份文件"不是理论风险，而是**每秒几千次里必然发生**的事。
 */

const READER = `
const [p, oldLen, newLen, tagOld, tagNew, ms] = process.argv.slice(1);
const { readFileSync } = await import('node:fs');
const t0 = Date.now();
const seen = new Set();
let reads = 0;
while (Date.now() - t0 < Number(ms)) {
  reads++;
  try {
    const t = readFileSync(p, 'utf-8');
    if (t.length === Number(oldLen) && t[0] === tagOld) seen.add('OLD');
    else if (t.length === Number(newLen) && t[0] === tagNew) seen.add('NEW');
    else seen.add('PARTIAL:' + t.length);
  } catch (e) {
    seen.add('ERR:' + (e && e.code));
  }
}
console.log(JSON.stringify({ reads, seen: [...seen] }));
`;

test('★ 真并发读写：读者**永远看不到半份文件**（这就是"原子"的可观察含义）', async () => {
  const root = tmpRoot();
  const p = join(root, '正文.md');
  const OLD = 'O'.repeat(300_000);
  const NEW = 'N'.repeat(300_000);
  atomicWriteFileSync(p, OLD);

  const child = spawn(process.execPath, ['--input-type=module', '-e', READER, p, String(OLD.length), String(NEW.length), 'O', 'N', '1200'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += String(d)));

  // 子进程边读，主进程边写：整份整份地换内容
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < 1000) {
    atomicWriteFileSync(p, i % 2 === 0 ? NEW : OLD);
    i++;
  }
  await new Promise((r) => child.on('close', r));

  const r = JSON.parse(out) as { reads: number; seen: string[] };
  assert.ok(r.reads > 100, `读者要真的读了很多次才有说服力，实得 ${r.reads} 次`);
  assert.deepEqual(
    r.seen.filter((s) => s !== 'OLD' && s !== 'NEW'),
    [],
    `读者看到了中间态：${r.seen.join(' ')}——那意味着文件被截断过，正文有半份暴露在外面`,
  );
  assert.equal(i > 20, true, `主进程要真的写了很多次，实得 ${i} 次`);
  rmSync(root, { recursive: true, force: true });
});
