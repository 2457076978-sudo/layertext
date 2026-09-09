#!/usr/bin/env python3
"""olp-en-cefrj 数据集 → assets/wordlists/cefrj_levels.txt（词→CEFR 等级，可复现转换）。

源：Open Language Profiles（cefrj-vocabulary-profile-1.5.csv + octanove-vocabulary-profile-c1c2-1.0.csv，CC BY-SA 4.0）
口径：同词多词性多等级取最早引入等级；只收单词条目（短语/含斜杠变体行不入）。
用法：python3 tools/convert_cefrj.py <olp目录> （数据下载：gh api repos/openlanguageprofiles/olp-en-cefrj/tarball）
"""
import csv
import sys
from pathlib import Path

LV = {'A1': 1, 'A2': 2, 'B1': 3, 'B2': 4, 'C1': 5, 'C2': 6}


def main(src_dir: str) -> None:
    files = [Path(src_dir) / 'cefrj-vocabulary-profile-1.5.csv', Path(src_dir) / 'octanove-vocabulary-profile-c1c2-1.0.csv']
    best: dict[str, str] = {}
    for fp in files:
        with open(fp, encoding='utf-8-sig') as f:
            for row in csv.DictReader(f):
                w = (row.get('headword') or '').strip().lower()
                c = (row.get('CEFR') or '').strip().upper()
                if not w or c not in LV or ' ' in w or '/' in w:
                    continue
                if w not in best or LV[c] < LV[best[w]]:
                    best[w] = c
    out = Path(__file__).resolve().parent.parent / 'assets' / 'wordlists' / 'cefrj_levels.txt'
    with open(out, 'w', encoding='utf-8') as f:
        f.write('# CEFR-J 词表（词→等级，显示用辅助维度——判定仍以课标1600+教师词库为锚）\n')
        f.write('# 源：Open Language Profiles olp-en-cefrj（cefrj-vocabulary-profile-1.5 + octanove C1/C2 1.0），CC BY-SA 4.0\n')
        f.write('# 转换：同词多等级取最早引入等级；只收单词条目；由 tools/convert_cefrj.py 生成可复现\n')
        for w in sorted(best):
            f.write(f'{w} {best[w]}\n')
    print(f'词条数: {len(best)} → {out}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '/tmp/ghref/olp')
