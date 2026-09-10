#!/usr/bin/env python3
"""导出 wordfreq 英文 zipf 词频表 → assets/wordfreq/en_zipf.tsv

调研〇-3 第一级 zipf 分诊的数据源（rspeer/wordfreq，CC-BY-SA 4.0 数据许可）。
运行时纯离线：本脚本只在构建期跑一次，TS 侧只读静态 TSV。

行格式：word\t zipf*100 的整数（4.72 → 472）；只导 zipf ≥ 3.0 的词
（更低频的分诊上归"低频·真生词"，不携带数据即可判定，省 2/3 体积）。
"""
import re
from pathlib import Path

from wordfreq import iter_wordlist, zipf_frequency

OUT = Path(__file__).resolve().parent.parent / "assets" / "wordfreq" / "en_zipf.tsv"
MIN_ZIPF = 3.0
WORD_RE = re.compile(r"^[a-z][a-z'-]*$")


def main() -> None:
    rows = []
    for w in iter_wordlist("en"):
        if not WORD_RE.match(w):
            continue
        z = zipf_frequency(w, "en")
        if z < MIN_ZIPF:
            break  # iter_wordlist 按频率降序，首个跌破即可停
        rows.append((w, round(z * 100)))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("".join(f"{w}\t{z}\n" for w, z in rows), encoding="utf-8")
    n40 = sum(1 for _, z in rows if z >= 400)
    print(f"{OUT}: {len(rows)} 词（zipf≥{MIN_ZIPF}），其中 zipf≥4.0 共 {n40} 词")


if __name__ == "__main__":
    main()
