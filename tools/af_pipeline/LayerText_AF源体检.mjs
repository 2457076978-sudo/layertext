/**
 * LayerText · 源体检（R0 备料第一步，2026-09-18 第一梯队项 4）——喂管线之前先查源文本身
 * 动机：ch10 残缺（736 词、无终局、断点夹词表碎片）烧掉过一次全书重跑；R0 此前只查词表碎片。
 * 三类探针（判定唯一实现在 src/core/sourceprobe.ts，本脚本不自写第二份）：
 *   ①词数骤降（本章词数 < 相邻章中位数 × 0.5）②章末无收束（断章）③碎片残留（课题词表行混入）
 * 用法：node LayerText_AF源体检.mjs
 *   项目配置解析与其它脚本同口径：LAYERTEXT_PROJECT / cwd 向上找 调适项目_*.json / 上次指针。
 * 命中疑点 → 逐章点名 + exit 2（R0 拒绝把残源喂进生成）；全干净 → exit 0。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { loadProject, distOf, chapterNames } = SHARED;
const { probeChapterSource } = await import(`${distOf()}/src/core/sourceprobe.js`);

const P = loadProject(process.env.LAYERTEXT_PROJECT);
const SRC = P.原文目录;
if (!SRC || !existsSync(SRC)) {
  console.error(`✗ 项目配置里没有可用的 原文目录（${SRC ?? '未配置'}）——先在 调适项目_*.json 里配好再跑`);
  process.exit(2);
}

const chapters = [];
const missing = [];
for (const ch of chapterNames(P)) {
  // chapterNames 返回完整章名（如「第一章」），直接拼目录，别再包一层「第…章」
  const dir = join(SRC, ch);
  if (!existsSync(dir)) {
    missing.push(ch);
    continue;
  }
  let picked = null;
  for (const f of readdirSync(dir)) {
    if (/原文_规范化.*\.md$/.test(f) && !f.includes('坏头')) {
      const md = readFileSync(join(dir, f), 'utf-8');
      if (md.includes('[P')) {
        picked = { name: ch, text: md };
        break; // 与其它脚本同口径：第一个含 [P 的规范化文件即正本
      }
    }
  }
  if (picked) chapters.push(picked);
  else missing.push(`${ch}（目录在但无 原文_规范化*.md 含 [P 段）`);
}
if (!chapters.length) {
  console.error(`✗ 原文目录 ${SRC} 下没有可读的 原文_规范化*.md 章——什么都体检不了`);
  process.exit(2);
}

const results = probeChapterSource(chapters);
let bad = 0;
for (const r of results) {
  if (r.ok) {
    console.log(`✓ ${r.name}（${r.words} 词）`);
  } else {
    bad++;
    console.log(`✗ ${r.name}（${r.words} 词）：`);
    for (const s of r.suspects) console.log(`    [${s.probe}] ${s.message}`);
  }
}
if (missing.length) console.log(`⚠ ${missing.length} 章缺源（不计入骤降比较）：${missing.join('、')}`);
if (bad) {
  console.log(`\n源体检未过：${bad}/${results.length} 章有疑点——R0 应拒绝把这份源喂进生成（先补源或显式声明 partial 再跑）`);
  process.exit(2);
}
console.log(`\n源体检通过：${results.length} 章零疑点`);
