#!/usr/bin/env python3
"""AF 审校知识库提取：旧三版产物中的审校成果 → 知识文件/AF审校知识库_v1.csv

三个来源：
1. 旧三版产物 md 的 word（中文）注释对 —— 教师认可的"学生不会、保留+加注"词（最有价值的难词清单）
2. 变更日志 AI审核.csv 的修订对 —— 换词倾向（教师实际换掉的词）
3. 词级标记 json —— 难点词
输出 CSV（带 BOM）：类型,词,值,来源数   （类型 ∈ 加注词/换词倾向）
"""
import csv
import glob
import json
import os
import re
import shutil
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

# ── 项目配置：唯一入口（2026-09-10 修复：原先写死 Animal Farm 的绝对路径，换书即断）──
# 优先级：环境变量 LAYERTEXT_PROJECT → 当前目录向上找 调适项目_*.json → ~/.layertext.project
def _find_project():
    env = os.environ.get('LAYERTEXT_PROJECT')
    if env and Path(env).exists():
        return Path(env)
    cur = Path.cwd()
    for _ in range(5):
        hits = sorted(cur.glob('调适项目_*.json'))
        if hits:
            return hits[0]
        if cur.parent == cur:
            break
        cur = cur.parent
    pointer = Path.home() / '.layertext.project'
    if pointer.exists():
        p = Path(pointer.read_text(encoding='utf-8').strip())
        if p.exists():
            return p
    raise SystemExit(
        '找不到 调适项目_*.json。请设环境变量 LAYERTEXT_PROJECT，或在工作区目录下运行本脚本。'
    )


PROJECT = _find_project()
CFG = json.loads(PROJECT.read_text(encoding='utf-8'))
WS = CFG['调适工作区']
OUT = (CFG.get('书级') or {}).get('知识库') or str(Path(WS).parent / '知识文件' / '知识库.csv')
FORCE = '--force' in sys.argv   # --force = 允许条目缩水（默认禁止，见文末护栏）
print(f'项目配置：{PROJECT}\n调适工作区：{WS}\n知识库输出：{OUT}')

# ① 注释词对：word（中文）——旧三版产物全文扫
notes = Counter()
for f in glob.glob(f'{WS}/第*章/*候选版*.md'):
    t = open(f, encoding='utf-8').read()
    for w, zh in re.findall(r'([A-Za-z][A-Za-z\'-]*)（([^（）]{1,20})）', t):
        w = w.lower()
        if re.fullmatch(r"[a-z][a-z'-]+", w) and re.search(r'[\u4e00-\u9fff]', zh):
            notes[(w, zh)] += 1

# ② 换词倾向：变更日志修订对（前独有词→后独有词配对，频次计）
swaps = Counter()
for f in glob.glob(f'{WS}/第*章/变更日志_AI审核.csv'):
    lines = open(f, encoding='utf-8').read().split('\n')[1:]
    for line in lines:
        if not line.strip():
            continue
        cells, inq, cur = [], False, ''
        for ch in line:
            if ch == '"':
                inq = not inq
            elif ch == ',' and not inq:
                cells.append(cur)
                cur = ''
            else:
                cur += ch
        cells.append(cur)
        if len(cells) >= 7 and cells[5] and cells[6]:
            bw = set(re.findall(r"[a-z][a-z'-]{2,}", cells[5].lower()))
            aw = set(re.findall(r"[a-z][a-z'-]{2,}", cells[6].lower()))
            for w in bw - aw:
                swaps[w] += 1

# ③ 防毁库护栏（2026-09-10 加装）
#    来源①旧三版产物已按指令删除，现在 glob 到 0 个文件。原脚本毫无察觉、照样覆写 OUT，
#    会把加注词清零 —— 而三档生成要从这里读"必须加注"指引。下面三层保护：
#    继承历史条目 / 默认禁止缩水 / 写入前备份。
sr_products = glob.glob(f'{WS}/第*章/*候选版*.md')
print(f'来源：旧三版产物 {len(sr_products)} 个 / 变更日志 {len(glob.glob(f"{WS}/第*章/变更日志_AI审核.csv"))} 个')

existing_notes, existing_swaps = {}, {}
if os.path.exists(OUT):
    with open(OUT, encoding='utf-8-sig') as fh:
        for row in csv.reader(fh):
            if not row or row[0] == '类型' or len(row) < 3:
                continue
            if row[0] == '加注词' and row[2]:
                existing_notes[(row[1].lower(), row[2])] = int(row[3] or 0)
            elif row[0] == '换词倾向' and row[1]:
                existing_swaps[row[1]] = int(row[3] or 0)

carried_notes = carried_swaps = 0
if not notes and existing_notes:
    notes.update(existing_notes)
    carried_notes = len(existing_notes)
if not swaps and existing_swaps:
    swaps.update(existing_swaps)
    carried_swaps = len(existing_swaps)
if carried_notes or carried_swaps:
    print(f'⚠ 来源为空 —— 继承现有知识库：加注词 {carried_notes} 条、换词倾向 {carried_swaps} 词（绝不写空）')

if not notes and not swaps:
    sys.exit(f'✗ 两个来源都为空、也没有可继承的历史知识库 —— 拒绝写入 {OUT}（避免毁库）')

if not FORCE and (len(notes) < len(existing_notes) or len(swaps) < len(existing_swaps)):
    sys.exit(f'✗ 本次结果比现有知识库小（加注词 {len(notes)}<{len(existing_notes)} 或 '
             f'换词倾向 {len(swaps)}<{len(existing_swaps)}）—— 疑似来源缺失。确要缩水请显式加 --force')

if os.path.exists(OUT):
    # 备份进 _历史/，不和正本挤在一个目录（规范：历史版本进 _历史/）
    hist = Path(OUT).parent / '_历史'
    hist.mkdir(exist_ok=True)
    bak = hist / f'{Path(OUT).stem}.bak_{datetime.now():%Y%m%d_%H%M%S}.csv'
    shutil.copy2(OUT, bak)
    print(f'旧库已备份 → {bak}')

with open(OUT, 'w', newline='', encoding='utf-8-sig') as fh:
    w = csv.writer(fh)
    w.writerow(['类型', '词', '值', '来源数'])
    for (word, zh), n in notes.most_common():
        w.writerow(['加注词', word, zh, n])
    for word, n in swaps.most_common():
        w.writerow(['换词倾向', word, '', n])

print(f'加注词 {len(notes)} 对，换词倾向 {len(swaps)} 词 → {OUT}')
top = [f'{w}({z})' for (w, z), _ in notes.most_common(12)]
print('加注词样例:', ', '.join(top))
