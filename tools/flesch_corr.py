#!/usr/bin/env python3
"""生词率（词库锚定难度）vs 通用可读性公式（Flesch/FK/Dale-Chall）相关性报告。

方法：对每章调 LayerText CLI 跑质检（教师词库口径）取生词率，textstat 取三公式分，
算 Pearson r——回答"词库锚定难度与通用公式的相关程度"（论文素材：方法可复现，结论按分层公开原则不进公开仓）。

用法：python3 tools/flesch_corr.py <章节目录>... --vocab 词库.csv [--out 报告.md] [--label 标签]
依赖：pip3 install --user textstat；node dist/src/cli.js（先 npm run build）
"""
import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

import textstat

ROOT = Path(__file__).resolve().parent.parent


def qc_rate(md: Path, vocab: str) -> float:
    """调 CLI 跑质检，返回生词率%（词型口径，教师词库锚定）。"""
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        out = f.name
    try:
        subprocess.run(
            ['node', str(ROOT / 'dist/src/cli.js'), 'qc', str(md), '--vocab', vocab, '--out', out],
            check=True, capture_output=True,
        )
        r = json.loads(Path(out).read_text('utf-8'))
        v = r['②生词率(词型口径)']
        return float(v.rstrip('%')) if isinstance(v, str) else float(v)
    finally:
        Path(out).unlink(missing_ok=True)


def plain_text(md: Path) -> str:
    """剥章节标记/段标，取正文纯文本。"""
    t = md.read_text('utf-8')
    if '## Chapter' in t:
        t = t.split('## Chapter', 1)[1]
        t = t.split('## 词句卡', 1)[0]
    lines = [ln.strip() for ln in t.split('\n')]
    keep = []
    for ln in lines:
        if ln.startswith('[P') and ']' in ln:
            ln = ln.split(']', 1)[1]
        if ln.startswith('>'):
            ln = ln.lstrip('> ')
        if ln and not ln.startswith('#'):
            keep.append(ln)
    return ' '.join(keep)


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    cov = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    vx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    vy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return cov / (vx * vy) if vx and vy else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dirs', nargs='+')
    ap.add_argument('--vocab', required=True)
    ap.add_argument('--out', default=None)
    ap.add_argument('--label', default='')
    ap.add_argument('--pattern', default='*_简化_2026-09-09.md')
    a = ap.parse_args()

    mds = sorted(p for d in a.dirs for p in Path(d).glob(a.pattern))
    if not mds:
        sys.exit(f'没有匹配 {a.pattern} 的章节文件')
    rows = []
    for md in mds:
        rate = qc_rate(md, a.vocab)
        text = plain_text(md)
        rows.append({
            '章': md.parent.name + '/' + md.stem[-14:],
            '生词率%': rate,
            'Flesch': textstat.flesch_reading_ease(text),
            'FK年级': textstat.flesch_kincaid_grade(text),
            'DaleChall': textstat.dale_chall_readability_score(text),
        })
        print(f"{rows[-1]['章']}: 生词率 {rate}%  Flesch {rows[-1]['Flesch']:.1f}", file=sys.stderr)

    rates = [r['生词率%'] for r in rows]
    corr = {
        'Flesch（越高越易）': pearson(rates, [r['Flesch'] for r in rows]),
        'Flesch-Kincaid 年级': pearson(rates, [r['FK年级'] for r in rows]),
        'Dale-Chall（越高越难）': pearson(rates, [r['DaleChall'] for r in rows]),
    }

    label = a.label or '相关性报告'
    lines = [f'# 生词率 vs 通用可读性公式 · {label}', '',
             f'- 样本：{len(rows)} 章（{a.pattern}）｜词库：{Path(a.vocab).name}｜公式库：textstat（Python）',
             f'- 生词率=LayerText 词型口径（教师词库锚定，本班口径）；通用公式=全文词频/句长统计（与词库无关）', '',
             '| 章 | 生词率% | Flesch | FK年级 | Dale-Chall |', '|---|---|---|---|---|']
    for r in rows:
        lines.append(f"| {r['章']} | {r['生词率%']} | {r['Flesch']:.1f} | {r['FK年级']:.1f} | {r['DaleChall']:.2f} |")
    lines += ['', '## Pearson r（生词率 × 公式）', '', '| 公式 | r | 解读 |', '|---|---|---|']
    for k, v in corr.items():
        strength = '强' if abs(v) >= 0.7 else '中' if abs(v) >= 0.4 else '弱'
        direction = '正相关（词库难→公式也难）' if v > 0 else '负相关（词库难→公式分低=更难，Flesch 越高越易）'
        lines.append(f'| {k} | {v:.3f} | {strength}；{direction} |')
    lines += ['', '> 方法脚本 tools/flesch_corr.py（进公开仓，可复现）；本报告含班级口径数字，按分层公开原则不进公开仓。']
    out = a.out or (Path(a.dirs[0]).resolve().parent.parent / f'生词率与可读性公式相关性_{label}.md')
    Path(out).write_text('\n'.join(lines) + '\n', 'utf-8')
    print(f'\n报告已落盘: {out}')
    for k, v in corr.items():
        print(f'  r({k}) = {v:.3f}')


if __name__ == '__main__':
    main()
