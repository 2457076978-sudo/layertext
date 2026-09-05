#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""课标 2022 三级词汇表存档 → LayerText 内置纯文本词表（一行一词）。

用法：python3 tools/convert_wordlist.py <存档txt> <输出txt>

存档条目含 "a/an *"、"actor / actress"、"ad (=advertisement)"、
"according (to)" 等复合形式；本脚本按行提取全部英文词并去重（保持首次出现顺序），
即复合条目自动展开为独立词条。输出文件头部的 # 注释行会被引擎的词表加载器跳过。
"""
import re
import sys


def main():
    if len(sys.argv) != 3:
        sys.exit('用法: python3 tools/convert_wordlist.py <存档txt> <输出txt>')
    src, dst = sys.argv[1], sys.argv[2]
    words, seen = [], set()
    with open(src, encoding='utf-8') as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith('#'):
                continue
            for w in re.findall(r"[A-Za-z][A-Za-z'\-]*", s):
                w = w.lower()
                if w not in seen:
                    seen.add(w)
                    words.append(w)
    header = [
        '# LayerText 内置词表：义务教育英语课程标准（2022年版）三级词汇表（1600 词）',
        '# 源存档：课标2022三级词汇表_1600_存档.txt（2026-09 自课标原文转载版抓取存档）',
        '# 由 tools/convert_wordlist.py 自动展开为"一行一词"格式；复合条目（a/an、',
        '# actor / actress、ad (=advertisement) 等）已展开为独立词条，词条数为 %d。' % len(words),
    ]
    with open(dst, 'w', encoding='utf-8') as f:
        f.write('\n'.join(header + words) + '\n')
    print('%d words written to %s' % (len(words), dst))


if __name__ == '__main__':
    main()
