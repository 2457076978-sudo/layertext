// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 学生版
 *
 * 来源：《LayerText 工程优化总计划》「商业化产品边界」——
 *   「第一版应卖一个清晰的闭环：导入文本、选择层级、生成候选、教师快速审校、
 *     **发布学生版**、查看质量与变更记录。」
 *
 * ── 这一环此前**完全没有** ──────────────────────────────────────────────
 * 管线产出的那份 Markdown 是**教师的工作稿**，不是给学生读的东西。它里面有三类
 * 学生不该看见的内容，而且它们混在正文里、没有任何标记区分：
 *
 *   ① 文件头的**内部制作说明**——「# AF 第一章 原文基线（清理对齐版 v0.1）」、
 *      「> 来源：7月重建稿128句…」「> 段落ID [P01]-[P14] 为稳定锚」；
 *   ② **段标记 `[P##]`**——它是段落对齐的稳定 ID（台账、风险队列全靠它配对），
 *      对读者来说是一串噪音；
 *   ③ 门禁未通过时留下的**占位注释**（`<!-- 本段未通过复检 … -->`）。
 *
 * ①② 只是难看不该发；③ 是**不能发**。
 *
 * ── ③ 为什么不能发，值得单独说 ─────────────────────────────────────────
 * 占位段是"这一段没通过门禁、被隔离了"的记录。如果学生版把它默默删掉，
 * 拿到书的人看到的是**一个读得通的段落序列**——而中间少了一整段这件事，
 * 在成品里长得跟"这一段本来就没有"一模一样。
 * 这正是本项目一路上在治的那类缺陷：**不报错，结果错**。
 * 所以这里的选择是：**发现占位段就拒绝发布**，并说清是第几段。
 *
 * 纯逻辑：不读盘、不写盘。
 */

export const STUDENT_VERSION_SCHEMA_VERSION = 1;

/** 默认要去掉的内部小节（它们在产物里是**给教师/管线看的**） */
export const DEFAULT_DROP_SECTIONS = ['词句卡'];

export interface StudentVersionOptions {
  /** 学生版最上面放什么标题。**不给就不放**——不猜：
   *  按产物第一行猜出来的标题十有八九是「…原文基线（清理对齐版 v0.1）」这种内部版本号。 */
  title?: string;
  /** 额外要去掉的内部小节名（不带 `##`） */
  dropSections?: string[];
}

export interface StudentVersionRemoved {
  /** 丢掉的**文件头行数**（内部制作说明）——**报数**，不静默丢 */
  frontMatterLines: number;
  /** 丢掉的段标记个数 */
  markers: number;
  /** 丢掉的 HTML 注释个数（含占位段） */
  comments: number;
  /** 丢掉的小节名 */
  sections: string[];
}

export interface StudentVersionResult {
  /** 学生版正文 */
  text: string;
  removed: StudentVersionRemoved;
  /** **不能发布**的原因（空数组 = 可以发）。有内容时 `text` 仍然给出，供人查看，但**不该发出去** */
  blockers: string[];
  /** 人读一行（进日志与复核报告） */
  summary: string;
}

const CHAPTER_HEADING_RE = /^##\s+\S/m;
const SECTION_RE = /^##\s+(.+?)\s*$/;
const MARKER_RE = /\[P\d+\]\s?/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
/** 占位段的特征：门禁未通过时留下的注释。**只认这一种**，不用"看起来像不像正文"去猜。 */
const PLACEHOLDER_RE = /<!--\s*本段未通过复检/;

/**
 * 从教师的产物生成**学生版**。
 *
 * 规则是"减法"，而且每一刀都要**报出来**：
 *   · 章节标题之前的一切 → 丢掉（那里是内部制作说明），**报行数**；
 *   · `[P##]` 段标记 → 去掉，**报个数**；
 *   · HTML 注释 → 去掉，**报个数**；其中若是占位段 → **进 blockers**；
 *   · 指定的小节（默认「词句卡」）→ 从该小节起丢掉，**报小节名**。
 *
 * 保留的是正文与 `词（释义）` 里的释义——**那正是这份产品要给学生的东西**
 * （理解支架），不能顺手一起清掉。
 */
export function studentVersionOf(md: string, opts: StudentVersionOptions = {}): StudentVersionResult {
  const drop = [...DEFAULT_DROP_SECTIONS, ...(opts.dropSections ?? [])];
  const lines = String(md).split('\n');

  /* ── ① 找章节标题：它之前的一切都是内部说明 ── */
  const chapterAt = lines.findIndex((l) => CHAPTER_HEADING_RE.test(l));
  if (chapterAt < 0) {
    return {
      text: '',
      removed: { frontMatterLines: lines.length, markers: 0, comments: 0, sections: [] },
      blockers: ['正文里找不到章节标题（形如 `## Chapter One`）——不知道从哪儿开始才是给学生读的内容，**不发**'],
      summary: '没有生成学生版：找不到章节标题',
    };
  }
  const frontMatter = lines.slice(0, chapterAt);
  const bodyLines = lines.slice(chapterAt);

  /* ── ② 去掉内部小节（默认词句卡）：从该小节标题起、到下一个同级标题之前 ── */
  const kept: string[] = [];
  const droppedSections: string[] = [];
  let skipping = false;
  for (const l of bodyLines) {
    const m = SECTION_RE.exec(l);
    if (m) {
      const name = m[1]!.trim();
      if (drop.includes(name)) {
        skipping = true;
        droppedSections.push(name);
        continue;
      }
      skipping = false; // 遇到别的小节就恢复
    }
    if (skipping) continue;
    kept.push(l);
  }

  /* ── ③ 注释与占位段：先数，再删 ── */
  const body = kept.join('\n');
  const comments = body.match(COMMENT_RE) ?? [];
  /* 占位段的**段号在注释前面那个 `[P##]` 上**，不在注释里——
   * 注释文本是 `<!-- 本段未通过复检（ANNO-01）… -->`，里面并没有段号。
   * 第一版就是从注释文本里正则找 `[P##]`，结果永远找不到、只能报"（段号未知）"，
   * 而"少了一段却不知道少了哪段"等于没说。所以按**行**取：哪一行有占位注释，
   * 就看那一行上的段标记。 */
  const placeholders = kept
    .filter((l) => PLACEHOLDER_RE.test(l))
    .map((l) => ({ comment: (COMMENT_RE.exec(l) ?? [''])[0], segId: /\[(P\d+)\]/.exec(l)?.[1] ?? null }));

  /* ── ④ 段标记 ── */
  let markers = 0;
  let clean = body.replace(MARKER_RE, (mm) => {
    markers++;
    return '';
  });
  clean = clean.replace(COMMENT_RE, '');

  // 去标记之后可能留下行首空白；再压掉多余空行（三行以上连着）
  clean = clean
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const head = opts.title ? `# ${opts.title}\n\n` : '';
  const text = `${head}${clean}\n`;

  const blockers: string[] = [];
  if (placeholders.length) {
    /* **不能默默删掉**。学生版里少一段，在成品里长得跟"这一段本来就没有"一模一样。 */
    const where = placeholders
      .map((p) => p.segId ?? '（段号未知）')
      .slice(0, 8);
    blockers.push(
      `这一章有 ${placeholders.length} 段没通过门禁（${where.join('、')}${placeholders.length > 8 ? ' 等' : ''}）——` +
        `学生版**不能发**：删掉它们之后，学生看到的是一段读得通的序列，而中间少了整整一段，` +
        `在成品里长得跟"这一段本来就没有"一模一样。先把这些段补过关，再发。`,
    );
  }
  /* 「只剩标题」也算空。一张只有 `## Chapter One`、没有任何正文的"学生版"，
   * 发给学生比不发更糟：它看起来像一份成品。 */
  const withoutHeadings = clean
    .split('\n')
    .filter((l) => !/^#{1,6}\s/.test(l.trim()))
    .join('')
    .trim();
  if (!withoutHeadings) blockers.push('去掉内部说明之后没有正文了（只剩标题）——不发');

  const removed: StudentVersionRemoved = {
    frontMatterLines: frontMatter.length,
    markers,
    comments: comments.length,
    sections: droppedSections,
  };
  const bits = [
    `去内部说明 ${removed.frontMatterLines} 行`,
    `去段标记 ${removed.markers} 个`,
    `去注释 ${removed.comments} 条`,
  ];
  if (removed.sections.length) bits.push(`去小节「${removed.sections.join('、')}」`);
  const summary = blockers.length ? `${bits.join('｜')}｜⚠ ${blockers.length} 个原因不能发布` : bits.join('｜');

  return { text, removed, blockers, summary };
}

/** 这批学生版能不能发（空 blockers = 能） */
export const isPublishable = (r: StudentVersionResult): boolean => r.blockers.length === 0;
