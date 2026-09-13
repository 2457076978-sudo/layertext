#!/usr/bin/env node
/** AF 正本核对：原文里**教师正本登记过的词**，在产物里还在不在（确定性、零模型）。
 *
 * 为什么要有它（2026-09-13 本地模型试验的结论）：
 *   拿 2B 小模型当"裁判"扫整章时，它反复报同一类东西——`comrades→friends`、`cynical→unkind`、
 *   `hoofs→feet`、`gallons→large containers`。一开始被当成"模型在挑刺"打发了，回头看判据才发现
 *   它报得对：`AF注释词典_v1.csv` 里这几个词都有教师定的释义，`cynical/hoof/majestic/tremendous`
 *   还进了《审校知识库》的加注词，而 **R02（A层作品核心词保留原形＋术语表注释＋每章复现）** 与
 *   **标注政策 v0.2（保留＋标注优先 → 替换 → 删换）** 都要求"保留原词＋括号轻标注"，
 *   而不是一律换简单词。
 *
 *   也就是说：这件事**根本不需要模型**。判据是现成的词表，动作是字符串核对，
 *   模型只会把 100% 可复现的判定变成看运气的采样（实测同一段两遍结果就不一样）。
 *   模型该待的位置是给候选项写人话理由、对"换了但意思可能没丢"的模糊区出选项，不是判对错。
 *
 * 判定口径（可解释、可复现、不猜）：
 *   ① 原文该段出现的词，命中「注释词典」或「知识库加注词」→ 记为**正本词**（★=加注词）；
 *   ② 该正本词（含保守词形候选）若**在该段产物文本里一次都没出现** → 出一条候选；
 *   ③ 只报"消失了"，不判"换成了什么"——换成什么由人点选项时定，机器不猜（歧义即上报）。
 *
 * 用法：
 *   node LayerText_AF正本核对.mjs                          # 默认 A/M/B 三层 × 全书章节
 *   node LayerText_AF正本核对.mjs --tier A --chapters 1,7   # 只查 A 层，只看第 1、7 章
 *   node LayerText_AF正本核对.mjs --min-paras 2             # 只报"≥2 段都丢"的词（压掉过报）
 *
 * 产物：
 *   产物目录/正本核对_<日期>.md          —— 人看的清单（按"跨层跨章丢失面"排序，勾选式）
 *   产物目录/_运行/正本核对_<日期>.json  —— 机器格式（App 阅读器 / 离线汇总器读）
 *
 * 退出码：0（这是给人看的候选清单，不是门禁）。唯一例外：三层都没找到任何产物 → 2。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHARED = await import('./LayerText_AF词表与词典.mjs');
const { segmentList, loadDict, loadKbGloss } = SHARED;
const P = SHARED.loadProject();
const SRC_BASE = P.原文目录;
const OUT_BASE = P.产物目录;
const DATE = P.日期;
const CN = SHARED.chapterNames(P);

const TAGS = { A: 'A层85', M: 'M层75', B: 'B层60' };
const TIER_LABEL = { A: 'A 层（挑战）', M: 'M 层（中梯）', B: 'B 层（支架）' };

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const TIERS = String(arg('--tier', 'A,M,B'))
  .split(',')
  .map((t) =>
    t
      .trim()
      .replace(/^([AMB])层.*$/, '$1')
      .toUpperCase(),
  )
  .filter((t) => TAGS[t]);
const CH_IDS = String(arg('--chapters', ''))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= CN.length);
const MIN_PARAS = Number(arg('--min-paras', '1')) || 1;
const STAR_ONLY = argv.includes('--star-only');
const DICT_PATH = P.书级?.词典 ?? P.词典;
const KB_PATH = P.书级?.知识库 ?? P.知识库;

if (!TIERS.length) {
  console.error('✗ --tier 只能是 A / M / B 的组合');
  process.exit(2);
}

const DICT = loadDict(DICT_PATH);
const KB = loadKbGloss(KB_PATH);
if (!DICT.size) console.warn(`⚠ 注释词典为空或读不到：${DICT_PATH}`);

/** 保守词形候选：只收**不会把生词误判成已存在**的规则（与 expandForms 同一条纪律）。
 *  `-s/-es/-ies/-ed/-ing` 这几条在这里是安全的：用途是"产物里还有没有这个词"，
 *  放宽一点只会让候选变少（漏报），不会把别的词错认成它（项目口径：漏注比多注更伤，宁可人工复核）。 */
function forms(word) {
  const w = word.toLowerCase();
  const out = new Set([w]);
  if (w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es')) out.add(w.slice(0, -2));
  if (w.endsWith('s')) out.add(w.slice(0, -1));
  if (w.endsWith('ed')) {
    out.add(w.slice(0, -1));
    out.add(w.slice(0, -2));
  }
  if (w.endsWith('ing')) {
    out.add(w.slice(0, -3));
    out.add(`${w.slice(0, -3)}e`);
  }
  return out;
}

/** 产物文件名：`原文_<tag>_<日期>_工序化.md`（同目录可能有多份历史稿，取字典序最新的一份）。 */
function findProduct(dir, tag) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((f) => f.startsWith(`原文_${tag}_`) && f.endsWith('_工序化.md'))
    .sort()
    .pop();
  return hit ? join(dir, hit) : null;
}

console.log('════ AF 正本核对（确定性，零模型）════');
console.log(`项目：${P._meta?.名称 ?? '（未命名）'}｜书名：${P.书名}`);
console.log(`层级：${TIERS.join('/')}｜章节：${CH_IDS.length ? CH_IDS.join(',') : `1-${CN.length}`}｜词典 ${DICT.size} 条｜加注词 ${KB.size} 条`);

const rows = []; // {tier, chapter, para, word, zh, star}
const unreadable = [];
const scanned = { chapters: 0, pairs: 0 };

for (const tier of TIERS) {
  const tag = TAGS[tier];
  const ids = CH_IDS.length ? CH_IDS : CN.map((_, i) => i + 1).slice(0, Number(P.章数 ?? CN.length));
  for (const ci of ids) {
    const ch = CN[ci - 1];
    const srcPath = join(SRC_BASE, ch, '原文_规范化.md');
    const prodPath = findProduct(join(OUT_BASE, ch), tag);
    if (!existsSync(srcPath)) {
      unreadable.push(`${ch}/${tag}：缺规范化原文 ${srcPath}`);
      continue;
    }
    if (!prodPath) {
      unreadable.push(`${ch}/${tag}：缺 ${tag} 工序化产物（先去生成）`);
      continue;
    }
    const src = new Map(segmentList(readFileSync(srcPath, 'utf-8')).map((s) => [s.id, s.text]));
    const prod = new Map(segmentList(readFileSync(prodPath, 'utf-8')).map((s) => [s.id, s.text]));
    scanned.chapters += 1;
    for (const [pid, srcText] of src) {
      const prodText = prod.get(pid) ?? '';
      if (!prodText) {
        unreadable.push(`${ch}/${tag}/${pid}：产物缺该段（门禁占位或未收录）`);
        continue;
      }
      scanned.pairs += 1;
      const prodForms = new Set();
      for (const w of prodText.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) for (const f of forms(w)) prodForms.add(f);
      const seen = new Set();
      for (const w of srcText.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []) {
        if (seen.has(w)) continue;
        seen.add(w);
        const zh = DICT.get(w);
        const star = KB.get(w);
        if (!zh && !star) continue;
        const alive = [...forms(w)].some((f) => prodForms.has(f));
        if (alive) continue;
        rows.push({ tier, chapter: ch, para: pid, word: w, zh: zh ?? star?.zh ?? '', star: Boolean(star) });
      }
    }
  }
}

if (!scanned.chapters) {
  console.error('✗ 三层都没扫到任何"原文+产物"配对的章节。');
  for (const u of unreadable.slice(0, 10)) console.error(`  · ${u}`);
  process.exit(2);
}

/* 词级聚合：一个词在多少「章×层」里丢了。丢失面越大越可能是**系统性问题**
 * （例如 comrades 在第一章 A 层 6 个段全丢 = 不是某一句的手滑，是"核心词一律换掉"的口径问题）。 */
const byWord = new Map();
for (const r of rows) {
  const k = r.word;
  if (!byWord.has(k)) byWord.set(k, { word: k, zh: r.zh, star: r.star, hits: [] });
  byWord.get(k).hits.push(r);
}
const words = [...byWord.values()]
  .map((w) => {
    const cells = new Set(w.hits.map((h) => `${h.tier}/${h.chapter}`));
    const paras = new Set(w.hits.map((h) => `${h.tier}/${h.chapter}/${h.para}`));
    return { ...w, cells: cells.size, paras: paras.size };
  })
  .filter((w) => w.paras >= MIN_PARAS)
  .filter((w) => !STAR_ONLY || w.star)
  /* ★ 加注词排在前面：它们不是"可能有意见"，是《审校知识库》里教师已经定了"加注"这一动作的词
   * （标注政策 v0.2 第②类：tremendous / majestic / cynical 类），判据最短、最该先清。
   * 其余词典词只在"丢失面"大时才值得先看——丢 1 段的词很可能是正常删换，丢 20 段的是口径问题。 */
  .sort((a, b) => Number(b.star) - Number(a.star) || b.cells - a.cells || b.paras - a.paras || a.word.localeCompare(b.word));

const perCell = new Map();
for (const r of rows) {
  const k = `${r.tier}/${r.chapter}`;
  perCell.set(k, (perCell.get(k) ?? 0) + 1);
}

const L = [];
L.push(`# AF 正本核对（确定性·零模型）· ${DATE}`, '');
L.push('> **判据**：`AF注释词典_v1.csv`（教师正本释义）＋ `AF审校知识库_v1.csv`（★加注词）＋ 规则 **R02** ＋ 标注政策 **v0.2**。');
L.push('> **做了什么**：原文里命中正本的词，若在**同段产物**里一次都没出现 → 出一条候选。');
L.push('> **没做什么**：不判"换成了什么"、不判"该不该换"——那是人点选项的事（歧义即上报）。', '');
L.push(
  `扫描：${TIERS.map((t) => TIER_LABEL[t]).join(' / ')}｜${scanned.chapters} 组"章×层"｜${scanned.pairs} 段配对｜命中 **${rows.length}** 处，涉及 **${words.length}** 个正本词${MIN_PARAS > 1 ? `（已按 --min-paras ${MIN_PARAS} 过滤）` : ''}。`,
  '',
);
L.push('**怎么用**：★加注词是《审校知识库》里教师已经定了"加注"这一动作的词，判据最短、先清；');
L.push('其余词典词按"丢失面"排序——丢 1 段的多半是正常删换，丢十几段的才是口径问题。', '');
const starWords = words.filter((w) => w.star);
L.push('## 一、★加注词优先区', '');
L.push(`共 ${starWords.length} 个词、${starWords.reduce((n, w) => n + w.paras, 0)} 处。这些词按标注政策 v0.2 第②类应"保留原词＋括号轻标注"。`, '');
if (starWords.length) {
  L.push('| # | 正本词 | 教师正本释义 | 丢失段数 | 丢失位置（层 章 段） |');
  L.push('|---|---|---|---|---|');
  starWords.forEach((w, i) => {
    const where = [...new Set(w.hits.map((h) => `${h.tier}${h.chapter}${h.para}`))];
    L.push(`| ${i + 1} | **${w.word}** | ${w.zh} | ${w.paras} | ${where.slice(0, 12).join(' ')}${where.length > 12 ? ` …(+${where.length - 12})` : ''} |`);
  });
  L.push('');
}
L.push('## 二、丢失面最大的词（跨层/跨章）', '');
L.push('| # | 正本词 | 教师正本释义 | 性质 | 丢失的「层/章」数 | 丢失段数 |');
L.push('|---|---|---|---|---|---|');
words.slice(0, 40).forEach((w, i) => {
  L.push(`| ${i + 1} | **${w.word}** | ${w.zh} | ${w.star ? '★加注词' : '词典词'} | ${w.cells} | ${w.paras} |`);
});
if (words.length > 40) L.push(`| … | 其余 ${words.length - 40} 个词见 JSON | | | | |`);
L.push('');
L.push('## 三、逐条批改选项（只看这里，不用翻原文）', '');
L.push('每条两个互斥选项；选①就是 R02 / 标注政策 v0.2 的默认动作（保留原词＋首次出现处加注教师释义）。', '');
for (const w of words) {
  const cellList = [...new Set(w.hits.map((h) => `${TIER_LABEL[h.tier]} ${h.chapter} ${h.para}`))];
  L.push(`**${w.word}（${w.zh}）**${w.star ? ' ★' : ''} — 丢了 ${w.paras} 段：${cellList.join('、')}`);
  L.push(`- 选项① 保留原词 \`${w.word}\`，首次出现处加注（${w.zh}） ← 符合 R02 / 标注政策 v0.2`);
  L.push('- 选项② 确认是有意替换（写进决定事件并给理由，供跨章一致性复用）');
  L.push('');
}
L.push('## 四、按「章×层」的命中数', '');
L.push('| 层/章 | 命中 |');
L.push('|---|---|');
for (const [k, n] of [...perCell.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${k} | ${n} |`);
if (unreadable.length) {
  L.push('', '## 五、读不到/跳过的（不静默吞）', '');
  for (const u of unreadable.slice(0, 60)) L.push(`- ${u}`);
}
L.push(
  '',
  '---',
  'R02：A层作品核心词保留原形＋术语表注释＋每章复现。',
  '标注政策 v0.2：会被替换掉味道的词 → 保留原词＋句内括号轻标注，而不是一律换简单词；候选范围①AF核心词②中考边缘高频词（tremendous/majestic/cynical 类）③替换后语感受损处。',
);

mkdirSync(OUT_BASE, { recursive: true });
mkdirSync(join(OUT_BASE, '_运行'), { recursive: true });
const mdPath = join(OUT_BASE, `正本核对_${DATE}.md`);
const jsonPath = join(OUT_BASE, '_运行', `正本核对_${DATE}.json`);
writeFileSync(mdPath, `${L.join('\n')}\n`, 'utf-8');
writeFileSync(jsonPath, `${JSON.stringify({ date: DATE, scanned, dictSize: DICT.size, kbSize: KB.size, words, rows, unreadable }, null, 1)}\n`, 'utf-8');

console.log(`\n命中 ${rows.length} 处，涉及 ${words.length} 个正本词。`);
console.log('Top 10：');
for (const w of words.slice(0, 10)) console.log(`  ${w.star ? '★' : ' '} ${w.word.padEnd(14)} ${w.zh.padEnd(8)} 丢 ${w.cells} 个「层/章」、${w.paras} 段`);
if (unreadable.length) console.log(`\n⚠ 跳过 ${unreadable.length} 处（详见清单第四节）`);
console.log(`\n产物：\n  ${mdPath}\n  ${jsonPath}`);
