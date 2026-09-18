// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// © 2026 Wayne（LayerText 作者）。本文件为判定引擎核心，本仓库已部署版权验证体系，细节不予公开（docs/版权与授权.md）。
/**
 * LayerText · 源完整性探针（R0 备料第一步，2026-09-18 第一梯队项 4）
 *
 * 存在的理由：ch10 残缺（736 词、无终局、断点还夹着课题词表碎片）烧掉过一次全书重跑——
 * R0 此前只查**词表**碎片，没人查**源文本身**。三类探针都是"喂管线之前"的过程闸门：
 *   ① 词数骤降——本章词数 < 相邻章中位数 × 0.5（半阈值是宽松线：正常章间波动远小于 2 倍；
 *      只标骤降的那一章，不标显长的那章）
 *   ② 章末无收束——末段 < 5 词，或以逗号/分号/破折号/悬垂连词收尾（残缺源最常见的形态：
 *      断在句中）
 *   ③ 碎片残留——连续 ≥3 行"孤词/词表行"（≤3 个英文词、无任何句读标点）。带逗号的歌词行
 *      天然被排除，不为诗歌开注册表——这是探针不是验收，宁漏勿误杀。
 *
 * 纯函数、零 IO：输入整本书的章文本，输出每章疑点。脚本（R0 源体检）、MCP
 * （layer_source_probe）共用这一份，不许各写一套。
 */

import { wordCount } from './segmentgate.js';

export interface SourceChapterInput {
  name: string;
  text: string;
}

export type ProbeKind = '词数骤降' | '章末无收束' | '碎片残留';

export interface SourceSuspect {
  probe: ProbeKind;
  message: string;
}

export interface ChapterProbeResult {
  name: string;
  words: number;
  ok: boolean;
  suspects: SourceSuspect[];
}

/** 悬垂连词：一章以此收尾几乎必然是断章（刻意排除介词——"...afraid of." 结尾虽怪但合法） */
const DANGLING_CONJ = new Set(['and', 'but', 'or', 'because', 'when', 'while', 'then', 'that', 'which', 'who', 'so', 'if']);

/** 章词数骤降阈值：相邻章中位数的这一比例之下才算"骤降"（0.5 = 掉了一半以上） */
export const WORD_DROP_RATIO = 0.5;

/** 非空段（按空行切；去标题行与 [P##] 标记——标记是结构不是内容） */
function contentParas(text: string): string[] {
  return text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\[P\d+\]/g, ' ').trim())
    .filter((p) => p && !/^#/.test(p));
}

/** 碎片行：≤3 个英文词、无句读标点（. ! ? , ; ： ——歌词行多带逗号，天然不中） */
function isFragmentLine(line: string): boolean {
  const l = line.replace(/\[P\d+\]/g, ' ').trim();
  if (!l || l.startsWith('#')) return false;
  if (/[.!?,;：:]/.test(l)) return false;
  return wordCount(l) <= 3;
}

export function probeChapterSource(chapters: SourceChapterInput[]): ChapterProbeResult[] {
  const words = chapters.map((c) => wordCount(c.text));
  return chapters.map((c, i) => {
    const suspects: SourceSuspect[] = [];

    // ① 词数骤降（只标小的一侧；首尾章只有一个邻居，单章书无邻居不判）
    const neighborLens = [words[i - 1], words[i + 1]].filter((w): w is number => w !== undefined);
    if (neighborLens.length) {
      const median = neighborLens.length === 2 ? (neighborLens[0] + neighborLens[1]) / 2 : neighborLens[0];
      if (words[i] < median * WORD_DROP_RATIO) {
        suspects.push({
          probe: '词数骤降',
          message: `本章 ${words[i]} 词，不足相邻章中位数（${Math.round(median)}）的一半——疑似残缺或选段错配`,
        });
      }
    }

    // ② 章末无收束
    const paras = contentParas(c.text);
    const last = paras[paras.length - 1];
    if (last) {
      const tail = last.trimEnd().replace(/["”')\]]+$/, '');
      const lastWord = (tail.match(/[A-Za-z]+$/)?.[1] ?? '').toLowerCase();
      /* 短末段只有**同时缺句读收尾**才算断章——`Long live Animal Farm!"` 这类 4 词戏剧性
       * 完整短句是真结尾（2026-09-18 真项目清扫后实测命中过的误报）。 */
      if (wordCount(last) < 5 && !/[.!?”"]$/.test(tail)) {
        suspects.push({ probe: '章末无收束', message: `末段只有 ${wordCount(last)} 词且无句读收尾：${last.slice(0, 60)}` });
      } else if (/[,:;—–]$/.test(tail)) {
        suspects.push({ probe: '章末无收束', message: `末段以「${tail.slice(-1)}」收尾——疑似断章：…${tail.slice(-60)}` });
      } else if (!/[.!?”"]$/.test(tail) || DANGLING_CONJ.has(lastWord)) {
        suspects.push({ probe: '章末无收束', message: `末段无句读收尾（止于「${lastWord || tail.slice(-3)}」）——疑似断章：…${tail.slice(-60)}` });
      }
    } else {
      suspects.push({ probe: '章末无收束', message: '全章没有可识别的正文段落' });
    }

    // ③ 碎片残留（连续 ≥3 行孤词/词表行）
    const lines = c.text.replace(/\r/g, '').split('\n');
    let run: string[] = [];
    let runStart = 0;
    const flush = (endExclusive: number): void => {
      if (run.length >= 3) {
        suspects.push({
          probe: '碎片残留',
          message: `第 ${runStart + 1}–${endExclusive} 行是连续 ${run.length} 行孤词/词表形态（疑似课题词表碎片混入）：${run.slice(0, 3).join(' / ')}`,
        });
      }
      run = [];
    };
    lines.forEach((line, idx) => {
      if (line.trim() === '') {
        flush(idx);
        return;
      }
      if (isFragmentLine(line)) {
        if (!run.length) runStart = idx;
        run.push(line.trim());
      } else {
        flush(idx);
      }
    });
    flush(lines.length);

    return { name: c.name, words: words[i], ok: suspects.length === 0, suspects };
  });
}
