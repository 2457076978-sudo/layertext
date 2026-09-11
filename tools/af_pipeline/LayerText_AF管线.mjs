#!/usr/bin/env node
/** AF 调适管线 · 一条命令跑完全流程
 *
 * 把原先要手动串的 5 个脚本合成一条命令，并保证顺序正确：
 *   生成 → 精修 → 修复 → 复核 → 台账
 *
 * 用法：
 *   node LayerText_AF管线.mjs                      # 跑全流程（全层全章）
 *   node LayerText_AF管线.mjs --tier A,M --chapters 1,2
 *   node LayerText_AF管线.mjs --from 修复            # 从某一步开始
 *   node LayerText_AF管线.mjs --only 复核            # 只跑某一步
 *   node LayerText_AF管线.mjs --dry                 # 只打印计划
 *   node LayerText_AF管线.mjs --project ../x/调适项目_别的书.json
 *   node LayerText_AF管线.mjs --no-manifest             # 不建运行清单（不推荐：会丢掉"这次跑的是什么"的记录）
 *   node LayerText_AF管线.mjs --teacher wayne           # 运行清单里的教师 ID
 *
 * 项目配置（路径/词库/书级配置/教材进度）全部从 调适项目_*.json 读，脚本内不写死。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

if (has('--project')) process.env.LAYERTEXT_PROJECT = arg('--project');
const { loadProject, loadTextbookLearned } = await import('./LayerText_AF词表与词典.mjs');
const P = loadProject();

const tiers = (arg('--tier', 'A,M,B')).split(',').map((s) => s.trim()).filter(Boolean);
const chapters = arg('--chapters', '');
const tierArg = tiers.join(',') === 'A,M,B' ? 'ALL' : tiers.join(',');

/** 步骤定义：顺序敏感，不要调整 */
const STEPS = [
  {
    id: '规范化', script: 'LayerText_AF重制_预处理与规则.mjs',
    args: [],
    note: '原文 → [P##] 分段 md（含缺空格/OCR 章节名残留修补；无 API）',
    needsApi: false,
  },
  {
    id: '生成', script: 'LayerText_AF三档生成.mjs',
    args: [tierArg, ...(chapters ? [chapters] : [])],
    note: '逐段改写（守恒）+ 修剪轮 + 知识库注入（**消耗 API 额度**）',
    needsApi: true,
  },
  {
    id: '精修', script: 'LayerText_AF三档精修.mjs',
    args: [tierArg, ...(chapters ? [chapters] : [])],
    note: '注释轮（查词典→缺的才问模型）+ 信号修复（**消耗 API 额度**）',
    needsApi: true,
  },
  {
    id: '补注', script: 'LayerText_AF补注.mjs',
    args: [tierArg, ...(chapters ? [chapters] : [])],
    note: '加注补齐：QC 的 OOV → 查词典 → 缺的才问模型 → 首次出现处插入（**消耗 API 额度**，词典命中多则很省）',
    needsApi: true,
  },
  {
    id: '修复', script: 'LayerText_AF修复_20260910.mjs',
    args: ['--tier', tierArg, ...(chapters ? ['--chapters', chapters] : [])],
    note: '确定性清理：专名误注 / 字面 [P##] / 嵌套注释 / 同词多义 / 缺空格（幂等，无 API）',
    needsApi: false,
  },
  {
    id: '复核', script: 'LayerText_AF三档复核.mjs',
    args: ['--tier', tierArg, ...(chapters ? ['--chapters', chapters] : [])],
    note: '按各层句长上限重算 QC 汇总',
    needsApi: false,
  },
  {
    id: '台账', script: 'LayerText_AF对照台账.mjs',
    args: ['--tier', tierArg, ...(chapters ? ['--chapters', chapters] : [])],
    note: '逐句对照台账（保留/改写/删句/数字专名缺失）',
    needsApi: false,
  },
  {
    id: '风险队列', script: 'LayerText_AF风险队列.mjs',
    args: ['--tier', tierArg, ...(chapters ? ['--chapters', chapters] : [])],
    note: '按 风险=概率×后果 排的段级人工队列（事实置顶）+ 一小时最短路径 + 未完成段落清单',
    needsApi: false,
  },
  {
    id: '决定汇总', script: 'LayerText_AF决定汇总.mjs',
    args: ['--tier', tierArg],
    note: '把教师在风险队列上的决定汇总成**待人工确认的**入库提议（词典/词表例外/改写模板）；本步只提议不入库',
    needsApi: false,
  },
];

const only = arg('--only', null);
const from = arg('--from', null);
let plan = STEPS;
if (only) plan = STEPS.filter((s) => s.id === only);
else if (from) {
  const i = STEPS.findIndex((s) => s.id === from);
  if (i < 0) { console.error(`✗ 未知步骤「${from}」，可选：${STEPS.map((s) => s.id).join('/')}`); process.exit(2); }
  plan = STEPS.slice(i);
}
if (!plan.length) { console.error(`✗ 未知步骤，可选：${STEPS.map((s) => s.id).join('/')}`); process.exit(2); }

const learned = loadTextbookLearned(P);

console.log('════ AF 调适管线 ════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书名：${P.书名}`);
console.log(`产物目录：${P.产物目录}`);
console.log(`层级：${tiers.join('/')}${chapters ? '｜章节：' + chapters : '｜章节：全部'}`);
console.log(`教材进度：${P.教材进度 ? JSON.stringify(P.教材进度) + `（${learned?.size ?? 0} 个已学词将作为 QC 口径）` : '未设置（沿用整册词库口径）'}`);
console.log(`引擎：${P.引擎目录}`);
console.log('\n计划：');
plan.forEach((s, i) => console.log(`  ${i + 1}. ${s.id}  —  ${s.note}`));

if (has('--dry')) { console.log('\n（--dry，未执行）'); process.exit(0); }

/** 清单脚本：一次运行的全部身份信息与产物状态都记在它下面（审查报告 §三的"只能重构一处"）。
 *  run() 只负责起进程；每步跑完都回清单里盖一个章——这样"跑成功了吗"只有一个答案来源。 */
const tierArgOf = () => ['--tier', tiers.join(','), ...(chapters ? ['--chapters', chapters] : [])];
const runScript = (script, args) => spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit', env: process.env });

if (!has('--no-manifest')) {
  console.log('\n──────── 清单（建） ────────');
  const m = runScript('LayerText_AF清单.mjs', ['--new', ...tierArgOf(), '--teacher', arg('--teacher', process.env.LAYERTEXT_TEACHER ?? process.env.USER ?? 'unknown')]);
  if (m.status !== 0) { console.error('\n✗ 清单建立失败，管线中止（没有清单就没有"这次跑的是什么"的记录）。'); process.exit(1); }
}

const results = [];
const stamp = (id, ok, sec) => {
  if (has('--no-manifest')) return;
  runScript('LayerText_AF清单.mjs', ['--stamp', ...tierArgOf(), '--step', id, '--sec', String(sec), '--ok', ok ? '1' : '0']);
};
for (const s of plan) {
  const path = join(HERE, s.script);
  if (!existsSync(path)) { console.error(`\n✗ 缺脚本：${s.script}`); process.exit(1); }
  // 补注脚本用 --tier/--chapters（与生成/精修的 A,M 位置参数不同），在这里转换
  const stepArgs = ['补注', '修复', '复核', '台账', '风险队列', '决定汇总'].includes(s.id)
    ? tierArgOf()
    : s.args;
  console.log(`\n──────── ${s.id} ────────`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path, ...stepArgs], { stdio: 'inherit', env: process.env });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const ok = r.status === 0;
  results.push({ id: s.id, ok, sec });
  stamp(s.id, ok, sec);
  if (!ok) {
    console.error(`\n✗ ${s.id} 失败（退出码 ${r.status}），管线中止。`);
    break;
  }
  console.log(`✓ ${s.id} 完成（${sec}s）`);
}

console.log('\n════ 汇总 ════');
results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.id}  ${r.sec}s`));
const failed = results.filter((r) => !r.ok).length;
if (failed) {
  console.log(`\n✗ ${failed} 步失败`);
  process.exit(1);
}

// 收尾校验：产物齐不齐、输入有没有变过、有没有未完成段落——**一次运行只有一个结论**
if (!has('--no-manifest')) {
  console.log('\n──────── 清单（校验） ────────');
  const v = runScript('LayerText_AF清单.mjs', ['--verify', ...tierArgOf()]);
  if (v.status !== 0) { console.error('\n✗ 清单校验未通过：产物不可当完成品（详见上面的硬问题）。'); process.exit(1); }
}
console.log(`\n✓ 全部 ${results.length} 步完成`);
process.exit(0);
