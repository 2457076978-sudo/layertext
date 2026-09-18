/**
 * 书册只读扫描（2026-09-18 词画卷项 2/项 3 的公共装载器）：把当前书的各章各层文本收上来，
 * 喂 `src/core/concordance.ts` 建图。**零写调用**（纪律扫描锁——画卷是视图，只读正文）。
 *
 * 两种书布局都支持：
 *  · 平铺：书目录里一个文件=一章（App 主模型，`list_dir` 直接列）；
 *  · 章目录：书根下 `第X章/` 每目录一章（AF 布局）——`list_dir` 只回文件不回目录，
 *    用受控探针（describe_path 按章号 1..30 两种写法探测，连缺 3 个即停）找兄弟章目录。
 * 每章每层取**字典序最新**一版（与 propagate.descendantTierFiles 同一约定——旧版本不进画卷）。
 */

import { invoke } from '@tauri-apps/api/core';
import { baseName } from './pure.js';
import { readTextChecked } from './fsx.js';
import type { FileSession } from './types.js';
import { chapterNameOf } from '../../src/core/chapters.js';
import { tierTagOfFilename } from '../../src/core/propagate.js';

export interface BookChapterText {
  name: string;
  tier: string;
  path: string;
  text: string;
}

export interface BookScanResult {
  chapters: BookChapterText[];
  /** 覆盖说明（扫到几章几文件；跳过的点名——不静默） */
  coverage: string;
}

const MAX_FILES = 80;
const MAX_BYTES = 2 * 1024 * 1024;

/** 文件名 → (层标签, 版本序)：产物命名「原文_<层标签>_日期…」认层；不认层的文件 tier=''（原稿/单层书）。 */
export function tierOfFile(name: string, naming: Record<string, string>): string {
  return tierTagOfFilename(name, naming) ?? '';
}

/** 同层多版本取字典序最新（纯函数，测试锁）：给一组文件名，返回每层该进画卷的那一个。 */
export function latestPerTier(names: string[], naming: Record<string, string>): string[] {
  const best = new Map<string, string>();
  for (const n of [...names].sort()) {
    const t = tierOfFile(n, naming);
    if (t === '') continue; // 无层标签的（原稿/词表/报告）不进画卷正文集
    if (!best.has(t)) best.set(t, n); // sort 后第一个即字典序最新
  }
  return [...best.values()];
}

/** 平铺布局的章节文件筛选：一个文件=一章；产物/版本/备份不进画卷（纯函数，测试锁）。 */
export function flatChapterFiles(names: string[]): string[] {
  return names.filter((f) => /\.(md|txt|markdown)$/i.test(f) && !/(?:_简化_|_回炉_|_工序化|_工作稿|原始备份|_LayerText)/.test(f));
}

/** 章目录布局的受控探针（纯函数部分：生成候选章名）。
 *  chapterNameOf 返回裸章名（如「一」），目录习惯是包裹形——三种形态都探、去重。 */
export function probeChapterNames(): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 30; i++) {
    const cn = chapterNameOf(i);
    if (cn) out.push(cn, `第${cn}章`);
    out.push(`第${i}章`);
  }
  return [...new Set(out)];
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await invoke<string>('describe_path', { path: p })) === 'exists';
  } catch {
    /* 有意兜底：describe_path 失败按「不存在」处理——探针只负责找章目录，找不到的章
     * 不进画卷，覆盖说明里如实反映（缺章不是错误：书可能就这么短）。 */
    return false;
  }
}

/** 扫当前书的全部章层文本。只读；文件数/单文件大小有上限，扫到哪儿如实报。 */
export async function loadBookChapters(s: FileSession, naming: Record<string, string>): Promise<BookScanResult> {
  if (!s.sourcePath) return { chapters: [], coverage: '当前会话没有磁盘文件（示例文本）——画卷需要书稿文件' };
  const chapterDir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  const isChapterDirLayout = /^第.+章$/.test(baseName(chapterDir));
  const skipped: string[] = [];
  const out: BookChapterText[] = [];

  const readTierFiles = async (dir: string, chapterName: string): Promise<void> => {
    let files: string[];
    try {
      files = await invoke<string[]>('list_dir', { dir });
    } catch (e) {
      skipped.push(`${chapterName}（目录读不出来：${String(e).slice(0, 50)}）`);
      return;
    }
    const picked = latestPerTier(files.map(baseName), naming);
    for (const f of picked) {
      if (out.length >= MAX_FILES) {
        skipped.push(`已达扫描上限 ${MAX_FILES} 文件——更后面的章没进画卷，换小书或调上限`);
        return;
      }
      const path = `${dir}/${f}`;
      const r = await readTextChecked(path);
      if (r.kind !== 'ok') {
        skipped.push(`${chapterName}/${f}（${r.kind === 'missing' ? '不存在' : `读不出来：${r.error.slice(0, 40)}`}）`);
        continue;
      }
      if (r.text.length > MAX_BYTES) {
        skipped.push(`${chapterName}/${f}（超过 2MB 上限，没进画卷）`);
        continue;
      }
      out.push({ name: chapterName, tier: tierOfFile(f, naming), path, text: r.text });
    }
  };

  if (isChapterDirLayout) {
    const bookRoot = chapterDir.slice(0, chapterDir.lastIndexOf('/'));
    let gap = 0;
    for (const name of probeChapterNames()) {
      const dir = `${bookRoot}/${name}`;
      if (await dirExists(dir)) {
        gap = 0;
        await readTierFiles(dir, name);
      } else if (++gap >= 3 && out.length) break; // 连缺 3 个章目录即停（受控探针）
      if (out.length >= MAX_FILES) break;
    }
  } else {
    /* 平铺布局：一个文件=一章（App 主模型）；层标签从文件名认（通常无层=原稿单层书）。
     * 产物/版本文件（简化/回炉/工序化/工作稿/备份）不进画卷——画卷看的是"这本书有什么"。 */
    let files: string[] = [];
    try {
      files = (await invoke<string[]>('list_dir', { dir: chapterDir })).map(baseName);
    } catch (e) {
      skipped.push(`目录读不出来：${String(e).slice(0, 50)}`);
    }
    for (const f of flatChapterFiles(files)) {
      if (out.length >= MAX_FILES) {
        skipped.push(`已达扫描上限 ${MAX_FILES} 文件——更后面的章没进画卷`);
        break;
      }
      const path = `${chapterDir}/${f}`;
      const r = await readTextChecked(path);
      if (r.kind !== 'ok') {
        skipped.push(`${f}（${r.kind === 'missing' ? '不存在' : `读不出来：${r.error.slice(0, 40)}`}）`);
        continue;
      }
      if (r.text.length > MAX_BYTES) {
        skipped.push(`${f}（超过 2MB 上限，没进画卷）`);
        continue;
      }
      out.push({ name: f.replace(/\.(md|txt|markdown)$/i, ''), tier: tierOfFile(f, naming), path, text: r.text });
    }
  }
  const chapters = [...new Set(out.map((x) => x.name))].length;
  return {
    chapters: out,
    coverage: `扫到 ${chapters} 章、${out.length} 份层文本${skipped.length ? `；跳过 ${skipped.length} 项：${skipped.slice(0, 3).join('、')}${skipped.length > 3 ? ' 等' : ''}` : ''}`,
  };
}
