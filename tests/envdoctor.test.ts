/**
 * 环境自检 · 单测（复盘方案 A3，2026-09-26）
 *
 * 锁两件事：①检查表口径——verify 模式只拦依赖件（dist 未建属正常，
 * 链内 npm test 会先 tsc 构建），full 模式含 dist；②报告契约——
 * 任何缺失项必须成对给出"挡住：…"与"修复：<可粘贴命令>"，
 * 这是把 `sh: tsc not found` 事故（09-25 磁盘清理误删 node_modules 实发）
 * 转成人话的验收线。tools/env_doctor.mjs 的兜底表与此同步。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { envChecks, renderEnvReport } from '../src/core/envdoctor.js';

const R = '/repo'; // 注入假仓库根，命令里的路径断言用

test('全绿：两种模式都 0 退出、无缺失项', () => {
  const all = () => true;
  for (const mode of ['verify', 'full'] as const) {
    const r = renderEnvReport(envChecks(all, R, mode), mode);
    assert.equal(r.code, 0);
    assert.ok(r.text.includes('✓'));
    assert.ok(!r.text.includes('挡住'));
  }
});

test('node_modules 缺失：verify 拦截，报告含可粘贴修复命令', () => {
  const exists = (p: string) => p !== 'node_modules/.bin/tsc';
  const checks = envChecks(exists, R, 'verify');
  const r = renderEnvReport(checks, 'verify');
  assert.equal(r.code, 1);
  assert.ok(r.text.includes('✗'));
  assert.ok(r.text.includes(`cd ${R} && npm ci --no-audit --no-fund`));
});

test('报告契约：每个缺失项"挡住/修复"成对出现', () => {
  const none = () => false;
  const r = renderEnvReport(envChecks(none, R, 'full'), 'full');
  const impact = (r.text.match(/挡住：/g) ?? []).length;
  const fix = (r.text.match(/修复：/g) ?? []).length;
  assert.equal(impact, 3);
  assert.equal(fix, 3);
});

test('verify 模式不含 dist 项；full 模式含', () => {
  const none = () => false;
  const v = envChecks(none, R, 'verify').map((c) => c.id);
  const f = envChecks(none, R, 'full').map((c) => c.id);
  assert.ok(!v.includes('dist'));
  assert.ok(f.includes('dist'));
});

test('full 模式仅缺 dist：doctor 提示但 code=0 语义留给调用方渲染', () => {
  const exists = (p: string) => p !== 'dist/src/cli.js';
  const r = renderEnvReport(envChecks(exists, R, 'full'), 'full');
  assert.ok(r.text.includes('npm run build'));
  // full 模式任何缺失都算待修——doctor 输出全量清单，退出码非零
  assert.equal(r.code, 1);
});
