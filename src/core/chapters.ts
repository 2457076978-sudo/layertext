// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 章号与章节名
 *
 * 来源：《LayerText 工程优化总计划》阶段 3 验收 ——
 *   「**第二本书只需新建 manifest，不复制脚本**。」
 *
 * ── 为什么值得单独一个模块 ──────────────────────────────────────────────
 * 项目里有 **10 个管线脚本**各自抄了一份：
 *     const CN = ['一','二','三','四','五','六','七','八','九','十'];
 * 然后靠 `第${CN[i-1]}章` 拼章节名。抄十份本身就够糟了，更要命的是它**写死了"十章"**：
 * 换成一本 12 章的书（或章节名不叫"第X章"的书），`CN[10]` 是 `undefined`，
 * `第undefined章` 会一路拼进路径、拼进报表，而脚本照常报成功。
 *
 * 这件事在真项目上没暴露，只因为 Animal Farm 恰好是十章——**又一个"换本书才炸"的坑**。
 *
 * 本模块把"这本书有哪些章、按什么顺序"变成**可推导、可配置、可测试**的一件事：
 *   ① 配置里显式写了章节名 → 用它（最明确的意图）；
 *   ② 否则从原文目录**扫出来**（目录名就是事实）；
 *   ③ 都没有才退回"第N章 × 章数"（旧行为，逐字符不变）。
 *
 * 纯逻辑：不读盘。扫描结果由调用方传进来。
 */

/** 中文章号 → 整数。解析不出来返回 `null`（**不猜**）。 */
export function chineseNumeralToInt(s: string): number | null {
  const t = String(s).trim();
  if (!t) return null;
  const D: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (t === '十') return 10;
  const i = t.indexOf('十');
  if (i >= 0) {
    const head = t.slice(0, i);
    const tail = t.slice(i + 1);
    // 「十X」的十位缺省是 1；「X十」的个位缺省是 0。两者缺省值不同，不能混。
    const tens = head === '' ? 1 : (D[head] ?? null);
    const ones = tail === '' ? 0 : (D[tail] ?? null);
    if (tens === null || ones === null) return null;
    // 「十十」「二十十」这类不合法的写法一律拒绝，而不是硬凑一个数出来
    if (head.length > 1 || tail.length > 1) return null;
    return tens * 10 + ones;
  }
  return D[t] ?? null;
}

/** 整数 → 中文章号（1 → 一 … 99 → 九十九）。超出范围返回 `null`。 */
export function chapterNameOf(n: number): string | null {
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  const D = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n < 10) return D[n]!;
  if (n === 10) return '十';
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : D[tens]}十${ones ? D[ones] : ''}`;
}

/** 章节名的形状：`第一章`、`第1章`。**故意收得很窄**——宽了会把 `第一幕`、`第3节` 也当成章。 */
const CHAPTER_RE = /^第([0-9]+|[一二两三四五六七八九十]+)章$/;

/** 一个名字的章号（阿拉伯数字与中文都认）；认不出来返回 `null`。 */
export function chapterNumberOf(name: string): number | null {
  const m = CHAPTER_RE.exec(String(name).trim());
  if (!m) return null;
  const raw = m[1]!;
  return /^\d+$/.test(raw) ? Number(raw) : chineseNumeralToInt(raw);
}

/**
 * 从一批目录名里挑出章节名，**按章号排序**。
 *
 * 为什么不按字典序排：`第一章`、`第二章`、`第十章` 的字典序是 一、三、九、二、五、八、六、十、四、七——
 * 用它排序会让"第十章"排到第二位。这类错非常安静：顺序一乱，台账与汇总的行序跟着乱，
 * 而对不上号的对照表长得跟正常表一模一样。
 */
export function chapterNamesFrom(entries: Iterable<string>): string[] {
  const seen = new Map<number, string>();
  for (const e of entries) {
    const n = chapterNumberOf(e);
    if (n === null) continue;
    if (!seen.has(n)) seen.set(n, String(e).trim());
  }
  return [...seen.keys()].sort((a, b) => a - b).map((n) => seen.get(n)!);
}

export type ChapterNamesSource = '配置' | '原文目录' | '默认（第N章 × 章数）';

export interface ChapterNamesResult {
  names: string[];
  /** 这批章名是从哪儿来的——**进日志**，让"这本书到底几章、谁说了算"当场可查 */
  source: ChapterNamesSource;
  /** 如实报告的问题（配置不合法、目录扫不出章、章号不连续…）——**不静默** */
  warnings: string[];
}

/**
 * 决定"这本书有哪些章"。
 *
 * 优先级是刻意的：**显式配置 > 目录事实 > 默认**。
 * 目录事实比默认更可信——目录里真有什么章，就是有什么章；
 * 而"第N章 × 章数"是旧行为，只在既没有配置、也扫不出目录时才用（它逐字符复现旧结果，
 * 于是**没有配置、也没有可扫目录的老项目行为一个字都不变**）。
 */
export function resolveChapterNames(input: { configured?: unknown; dirEntries?: string[]; count?: number }): ChapterNamesResult {
  const warnings: string[] = [];

  /* ① 显式配置。允许两种写法：`["第一章","第二章"]` 或 `[1,2,3]`。 */
  if (input.configured !== undefined && input.configured !== null) {
    const raw = Array.isArray(input.configured) ? input.configured : null;
    if (!raw || !raw.length) {
      warnings.push('配置里的章节名是空的——按"没有配置"处理');
    } else {
      const names: string[] = [];
      const bad: string[] = [];
      for (const x of raw) {
        if (typeof x === 'number' && Number.isInteger(x)) {
          const n = chapterNameOf(x);
          if (n) names.push(`第${n}章`);
          else bad.push(String(x));
        } else if (typeof x === 'string' && x.trim()) {
          names.push(x.trim());
        } else bad.push(String(x));
      }
      if (bad.length) warnings.push(`配置里的章节名有 ${bad.length} 项不合法：${bad.slice(0, 5).join('、')}`);
      if (names.length) return { names, source: '配置', warnings };
    }
  }

  /* ② 目录事实。 */
  const fromDir = chapterNamesFrom(input.dirEntries ?? []);
  if (fromDir.length) {
    const nums = fromDir.map(chapterNumberOf).filter((n): n is number => n !== null);
    const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
    const gaps = expected.filter((n) => !nums.includes(n));
    if (gaps.length) {
      // 章号不连续：**说出来**。"第 5 章不见了"和"这本书只有 X 章"是两件事
      warnings.push(`原文目录里的章号不连续，缺：${gaps.map((n) => `第${chapterNameOf(n)}章`).join('、')}——按实际存在的章继续，但请确认不是漏读`);
    }
    return { names: fromDir, source: '原文目录', warnings };
  }

  /* ③ 旧行为：第N章 × 章数。逐字符复现，所以老项目不受影响。 */
  const count = Number(input.count ?? 10);
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 10;
  if (input.dirEntries?.length && !fromDir.length) {
    warnings.push(`原文目录里 ${input.dirEntries.length} 个条目没有一个像章节名（形如「第一章」）——退回按章数生成，请确认目录结构`);
  }
  return { names: Array.from({ length: n }, (_, i) => `第${chapterNameOf(i + 1) ?? i + 1}章`), source: '默认（第N章 × 章数）', warnings };
}
