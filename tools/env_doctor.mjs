#!/usr/bin/env node
/**
 * 环境自检 CLI（复盘方案 A3，2026-09-26）· 薄壳
 *
 * 逻辑唯一实现在 src/core/envdoctor.ts（本文件 import 其 dist 编译产物）。
 * 兜底：dist 也缺失时（磁盘清理后常见），dist 版报告拿不到——走下方与 core
 * 同步的精简检查表，至少把"npm ci + build"两条修复命令给人。
 * 改 src/core/envdoctor.ts 的检查项/文案须同步改这里的 FALLBACK。
 *
 * 用法：node tools/env_doctor.mjs --for-verify   （verify 链第一步，只查依赖件）
 *       node tools/env_doctor.mjs --full         （bin/lt doctor 全量，含 dist）
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const mode = process.argv.includes('--for-verify') ? 'verify' : 'full';
const exists = (p) => existsSync(join(repoRoot, p));

let report;
try {
  const { envChecks, renderEnvReport } = await import('../dist/src/core/envdoctor.js');
  report = renderEnvReport(envChecks(exists, repoRoot, mode), mode);
} catch {
  report = fallbackReport(exists, repoRoot);
}

// dist 缺失兜底（与 core/envdoctor.ts 保持同步；此路径下 dist 一并修）
function fallbackReport(exists, repoRoot) {
  const bad = [];
  if (!exists('node_modules/.bin/tsc')) {
    bad.push(`  · node_modules：挡住：测试、构建、类型检查、发版（tsc 编译器缺失）
    修复：cd ${repoRoot} && npm ci --no-audit --no-fund`);
  }
  if (!exists('app/node_modules')) {
    bad.push(`  · app/node_modules：挡住：App 前端类型检查与打包（vite / tauri 依赖缺失）
    修复：cd ${repoRoot}/app && npm ci --no-audit --no-fund`);
  }
  if (!exists('dist/src/cli.js')) {
    bad.push(`  · dist：挡住：CLI 体检与 AI 代理流水线（构建产物缺失）
    修复：cd ${repoRoot} && npm run build`);
  }
  if (bad.length === 0) {
    return { code: 0, text: '✓ 环境自检通过（兜底路径）：依赖与构建产物齐备。\n' };
  }
  return {
    code: 1,
    text: `✗ 环境缺失 ${bad.length} 项——逐条按修复命令粘贴执行即可恢复：\n${bad.join('\n')}\n`,
  };
}
process.stdout.write(report.text);
process.exitCode = report.code;
