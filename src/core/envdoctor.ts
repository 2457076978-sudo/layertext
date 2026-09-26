/**
 * 环境自检（复盘方案 A3，2026-09-26）· 唯一实现
 *
 * 动机：09-25 磁盘清理删掉 node_modules 后，verify 断在 typecheck 的
 * `sh: tsc: command not found`——机器话，不告诉人怎么办。本模块把
 * "环境缺什么 / 挡住什么 / 怎么修"变成第一行就是人话的报告；
 * verify 链第一步（--for-verify 模式）与 `bin/lt doctor`（full 模式）都消费这一份。
 * tools/env_doctor.mjs 在 dist 也缺失时有一份与下表同步的精简兜底——改这里须同步改那里。
 */

export interface EnvCheck {
  id: string;
  ok: boolean;
  /** 缺失时挡住什么（人话，仅在 !ok 时展示） */
  impact: string;
  /** 可粘贴的修复命令（repoRoot 由调用方注入，含中文路径可直接进 shell） */
  fix: string;
  /** verify 链是否因此项中断（dist 未建属正常：链内 npm test 会先 tsc 构建） */
  verifyFatal: boolean;
}

export type EnvDoctorMode = 'verify' | 'full';

/**
 * 环境检查表。exists 由调用方注入相对仓库根的路径判断（CLI 传真实 fs；测试传内存表）。
 * full 模式含 dist 产物（CLI/skill 流水线依赖）；verify 模式只查依赖件。
 */
export function envChecks(exists: (p: string) => boolean, repoRoot: string, mode: EnvDoctorMode): EnvCheck[] {
  const checks: EnvCheck[] = [
    {
      id: 'node_modules',
      ok: exists('node_modules/.bin/tsc'),
      impact: '挡住：测试、构建、类型检查、发版（tsc 编译器缺失）',
      fix: `cd ${repoRoot} && npm ci --no-audit --no-fund`,
      verifyFatal: true,
    },
    {
      id: 'app/node_modules',
      ok: exists('app/node_modules'),
      impact: '挡住：App 前端类型检查与打包（vite / tauri 依赖缺失）',
      fix: `cd ${repoRoot}/app && npm ci --no-audit --no-fund`,
      verifyFatal: true,
    },
    {
      id: 'dist',
      ok: exists('dist/src/cli.js'),
      impact: '挡住：CLI 体检与 AI 代理流水线（构建产物缺失）',
      fix: `cd ${repoRoot} && npm run build`,
      verifyFatal: false,
    },
  ];
  return mode === 'verify' ? checks.filter((c) => c.verifyFatal) : checks;
}

/** 渲染人话报告。code=0 全绿；verify 模式有 verifyFatal 缺失才非零。 */
export function renderEnvReport(checks: EnvCheck[], mode: EnvDoctorMode): { code: number; text: string } {
  const bad = checks.filter((c) => !c.ok);
  const fatal = bad.filter((c) => mode !== 'verify' || c.verifyFatal);
  if (bad.length === 0) {
    return { code: 0, text: '✓ 环境自检通过：依赖与构建产物齐备。\n' };
  }
  const lines = [`✗ 环境缺失 ${bad.length} 项——逐条按修复命令粘贴执行即可恢复：`];
  for (const c of bad) {
    lines.push(`  · ${c.id}：${c.impact}`);
    lines.push(`    修复：${c.fix}`);
  }
  if (fatal.length > 0) lines.push('（以上带"挡住"的项不修，后续步骤跑不了；先修再继续。）');
  return { code: fatal.length > 0 ? 1 : 0, text: lines.join('\n') + '\n' };
}
