#!/usr/bin/env python3
"""导出 Kuperman 2012 AoA 常模 → assets/wordfreq/en_aoa.tsv

调研〇-3 第二先验（与 zipf 互补）：AoA=母语者习得年龄。双信号分诊用——
zipf≥4 且 AoA 在常模内 → 疑似漏收（高频+基础词）；zipf≥4 但 AoA 查无（多为专名/衍生词）→ 降噪降级。
数据源：OSF osf.io/d7x6q（Kuperman, Stadthagen-Gonzalez & Brysbaert 2012, BRM 44:978-990，
Rating.Mean 列，30,121 实词）。下载：https://osf.io/download/vb9je/
行格式：word\t aoa*10 的整数（7.3 → 73）；仅导纯字母词（tokenize 口径），AoA 3~20 有效带。
"""
import io
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/aoa_kuperman.xlsx")
OUT = Path(__file__).resolve().parent.parent / "assets" / "wordfreq" / "en_aoa.tsv"
WORD_RE = re.compile(r"^[a-z][a-z'-]*$")


def rows_of(z: zipfile.ZipFile, sheet: str = "xl/worksheets/sheet1.xml") -> list[list[str]]:
    """极简 xlsx 读取：sharedStrings + sheet1 行列（本文件单表纯数据，足够，免装 openpyxl）"""
    ss: list[str] = []
    try:
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root:
            ss.append("".join(t.text or "" for t in si.iter() if t.tag.endswith("}t")))
    except KeyError:
        pass
    rows: list[list[str]] = []
    for _, el in ET.iterparse(io.TextIOWrapper(io.BytesIO(z.read(sheet)), encoding="utf-8"), events=["end"]):
        if el.tag.endswith("}row"):
            cells: list[str] = []
            for c in el:
                v = c.find("{*}v")
                if v is None:
                    cells.append("")
                elif c.get("t") == "s":
                    cells.append(ss[int(v.text)])
                else:
                    cells.append(v.text or "")
            rows.append(cells)
            el.clear()
    return rows


def main() -> None:
    rows = rows_of(zipfile.ZipFile(SRC))
    header = [h.strip().lower() for h in rows[0]]
    iw, ir = header.index("word"), header.index("rating.mean")
    out_lines = []
    for r in rows[1:]:
        w = (r[iw] if iw < len(r) else "").strip().lower()
        raw = (r[ir] if ir < len(r) else "").strip()
        if not WORD_RE.match(w) or not raw:
            continue
        try:
            aoa = float(raw)
        except ValueError:
            continue
        if 3.0 <= aoa <= 20.0:
            out_lines.append(f"{w}\t{round(aoa * 10)}")
    OUT.write_text("".join(l + "\n" for l in out_lines), encoding="utf-8")
    print(f"{OUT}: {len(out_lines)} 词（AoA 3-20 有效带）")


if __name__ == "__main__":
    main()
