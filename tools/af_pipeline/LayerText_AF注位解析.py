#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LayerText · 注位解析 v1（2026-09-17 · Wayne 任务①规格）
正则搬移的替代：本地依存句法（spaCy）决定每个注释的挂载位置。零 API。

规则：
 1. 注挂在被注短语的末尾内容词后；
 2. 不插在修饰语与中心词之间（unsteady（不平稳的） way → unsteady way（不平稳地））；
 3. 不挂功能词后（in/to/and/that/of/the…）——功能词后挂注→向前找内容短语挂其尾；
 4. 合并注保持列表结构（and 非边界），注在列表末尾内容词后；
 5. 连字符词整词处理；
 6. 歌词诗段按注册表放行（只校验同步，不做注位修正）。

挂起策略：解析失败/歧义/跨句 → 挂起并输出上下文；禁止正则兜底（正则只用于碎片检查与格式）。

用法：
  python3 LayerText_AF注位解析.py --goldens                  # 回归金样（必须 100%）
  python3 LayerText_AF注位解析.py <产物.md>... [--audit-only] # 注位修正/审计
产出：修正后文本（备份 .注位解析前.bak）+ 注位报告_*.md + 挂起清单 + 注位审计.json（供验收脚本对接）
"""
import json, os, re, sys, hashlib

AF = '/Users/wayne/Desktop/工作文档库/01-教学工作/名著阅读工作区_AnimalFarm'
KV = f'{AF}/知识文件'
REG_POEM = f'{KV}/歌词诗段表_v1.json'

FUNC_POS = {'ADP', 'CCONJ', 'SCONJ', 'DET', 'AUX', 'PART', 'PRON', 'PUNCT', 'NUM'}
MOD_DEPS = {'amod', 'advmod', 'compound', 'nmod', 'nummod', 'poss'}  # 修饰在前中心在后的常见依存

_nlp = None
def nlp():
    global _nlp
    if _nlp is None:
        import spacy
        for name in ('en_core_web_md', 'en_core_web_sm'):
            try:
                _nlp = spacy.load(name); break
            except Exception:
                continue
        if _nlp is None:
            sys.exit('✗ spaCy 模型不可用（en_core_web_md/sm 均未装）——挂起，不用正则兜底')
    return _nlp

def load_poems():
    try:
        return json.load(open(REG_POEM)).get('段', [])
    except Exception:
        return []

def is_poem_seg(poems, ch, pid, tier):
    for p in poems:
        if p.get('章') == ch and p.get('段') == pid and tier in (p.get('层') or ['A', 'M', 'B']):
            return p
    return None

FRAG_RE = re.compile(r'[a-z][A-Z][a-z]+')  # 粘连词（碎片铁证）——碎片检查允许正则
NOTE_RE = re.compile(r'（([^）]*)）')

def process_segment(text, report, suspends, tag):
    """text: 单段原文（含注）；返回修正后的段文本。report/suspends: 收集器。"""
    # 剥注（记录原始偏移与前置词）
    notes = []
    stripped = []
    last = 0
    for m in NOTE_RE.finditer(text):
        pre = text[last:m.start()]
        stripped.append(pre)
        wm = None
        for w in re.finditer(r'([A-Za-z][A-Za-z-]*)\s*$', pre):
            wm = w
        notes.append({'gloss': m.group(1), 'pre_word': wm.group(1) if wm else None,
                      'stripped_end': sum(len(s) for s in stripped)})
        last = m.end()
    stripped.append(text[last:])
    bare = ''.join(stripped)
    if FRAG_RE.search(bare):
        suspends.append((tag, '词表碎片/粘连词，不做注位解析', text[:60]))
        return text
    if not notes:
        return text
    doc = nlp()(bare)
    # 索引：字符偏移 → token
    def tok_at(off):
        for t in doc:
            if t.idx <= off < t.idx + len(t.text):
                return t
        return None
    # 句子范围
    sents = [(s.start_char, s.end_char) for s in doc.sents]
    def sent_of(off):
        for i, (a, b) in enumerate(sents):
            if a <= off < b:
                return i
        return None
    # 名词短语右缘（供挂载）
    chunk_right = {}
    for c in doc.noun_chunks:
        for t in c:
            chunk_right[t.i] = c.end
    moves, keep = [], []
    for i, n in enumerate(notes):
        # 在 stripped 里定位 pre_word 的最后一次出现（贴近注位）
        pw = n['pre_word']
        off = None
        if pw:
            for m in re.finditer(r'(?<![A-Za-z-])' + re.escape(pw) + r'(?![A-Za-z-])', bare):
                if m.start() < n['stripped_end'] + 4:
                    off = m.start()
        if off is None:
            suspends.append((tag, f'注#{i} 前置词 {pw!r} 未定位', text[:60]))
            keep.append((i, None)); continue
        t = tok_at(off)
        if t is None:
            suspends.append((tag, f'注#{i} 前置词 {pw!r} 无 token', text[:60]))
            keep.append((i, None)); continue
        # 规则 3：功能词宿主 → 向前找同句内容短语尾
        if t.pos_ in FUNC_POS or t.text.lower() in ('and', 'or', 'but', 'the', 'a', 'an', 'of', 'to', 'in', 'at', 'for', 'that'):
            cand = None
            for c in doc.noun_chunks:
                if c.start_char > t.idx and sent_of(c.start_char) == sent_of(t.idx):
                    cand = c; break
            if cand is None:
                suspends.append((tag, f'注#{i} 功能词 {t.text!r} 后无同句内容短语', text[:60]))
                keep.append((i, None)); continue
            host = cand[-1]
            gloss = n['gloss']
            if host.text.lower() in ('way', 'ways') and gloss.endswith('的'):
                gloss = gloss[:-1] + '地'
            n['new_gloss'] = gloss
            moves.append((i, host.idx + len(host.text), host.text, '功能词→短语尾'))
            continue
        # 规则 1/2：内容词宿主——若为中心词在后的修饰成分，挂到短语末尾内容词
        mount_tok = t
        moved = False
        if t.dep_ in MOD_DEPS and t.head.idx > t.idx:
            right = chunk_right.get(t.head.i)
            if right is not None and right - 1 > t.i:
                # 短语内最后一个内容词
                for j in range(right - 1, t.i, -1):
                    if doc[j].pos_ not in FUNC_POS:
                        mount_tok = doc[j]; moved = True; break
        # of 短语中的名词（the pack of dogs）挂名词短语尾
        if not moved and chunk_right.get(t.i) and doc[chunk_right[t.i] - 1].i > t.i and doc[chunk_right[t.i] - 1].pos_ not in FUNC_POS:
            mount_tok = doc[chunk_right[t.i] - 1]; moved = True
        # 跨句检查：挂载点与宿主不同句 → 挂起
        if sent_of(off) != sent_of(mount_tok.idx):
            suspends.append((tag, f'注#{i} 宿主 {t.text!r} 跨句挂载候选', text[:60]))
            keep.append((i, None)); continue
        if moved:
            gloss = n['gloss']
            # 的→地：挂到 "… way" 类副词化短语尾
            phr = bare[t.idx:mount_tok.idx + len(mount_tok.text)]
            if mount_tok.text.lower() in ('way', 'ways') and gloss.endswith('的'):
                gloss = gloss[:-1] + '地'
            moves.append((i, mount_tok.idx + len(mount_tok.text), mount_tok.text, f'短语尾（{t.text}→{mount_tok.text}）'))
            notes[i]['new_gloss'] = gloss
        else:
            keep.append((i, t.idx + len(t.text)))
    # 列表合并（规则 4）：同句内连续名词注、其间仅逗号/and/or → 合并挂列表尾
    # （简版：相邻两注宿主为 conj 关系或同 head）
    # 列表合并（规则 4）：同句同 conj 链的名词注 → 合并挂最右成员
    groups = {}
    for gi, (i, pos) in enumerate([k for k in keep if k[1] is not None]):
        pass
    import collections
    uf = {}
    def find(x):
        while uf.get(x, x) != x: x = uf[x] = uf.get(uf[x], uf[x])
        return x
    def union(a, b): uf[find(a)] = find(b)
    for t in doc:
        for c in doc:
            if c.i > t.i and c.dep_ == 'conj' and c.head.i == t.i and t.pos_ in ('NOUN', 'PROPN') and c.pos_ in ('NOUN', 'PROPN'):
                union(t.i, c.i)
                # 链式：c 的 conj 子链也并入
                for c2 in doc:
                    if c2.dep_ == 'conj' and c2.head.i == c.i and c2.pos_ in ('NOUN', 'PROPN'):
                        union(c.i, c2.i)
    keyed = [k for k in keep if k[1] is not None]
    anchors = {}
    for (i, pos) in keyed:
        off2 = pos
        # 找该注宿主 token（挂载点= token 尾）
        for t in doc:
            if t.idx + len(t.text) == pos:
                anchors[i] = t
                break
    merged_away = set()
    by_group = collections.defaultdict(list)
    for (i, pos) in keyed:
        t = anchors.get(i)
        if t is not None and t.pos_ in ('NOUN', 'PROPN'):
            by_group[(sent_of(t.idx), find(t.i))].append((i, t.i))
    for key, members in by_group.items():
        if len(members) > 1:
            members.sort(key=lambda x: x[1])
            last_i = members[-1][0]
            glosses = []
            for (i, pos) in members:
                glosses.append(notes[i]['gloss'])
                if i != last_i: merged_away.add(i)
            notes[last_i]['new_gloss'] = '、'.join(glosses)
    keep = [k for k in keep if k[0] not in merged_away]
    # 重放：从裸文本按挂载偏移插入（同一偏移多注→合并为 ）
    inserts = {}
    for i, pos in keep:
        if pos is None:  # 挂起的注：原地保留（按 stripped 对位重放）
            pos = notes[i]['stripped_end'] - (len(notes[i]['pre_word']) if notes[i]['pre_word'] else 0)
            pos = max(pos, 0)
        inserts.setdefault(pos, []).append(notes[i].get('new_gloss') or notes[i]['gloss'])
    for i, pos, _w, _why in moves:
        inserts.setdefault(pos, []).append(notes[i].get('new_gloss') or notes[i]['gloss'])
    out, last = [], 0
    for pos in sorted(inserts):
        out.append(bare[last:pos])
        out.append('（' + '、'.join(inserts[pos]) + '）')
        last = pos
    out.append(bare[last:])
    new_text = ''.join(out)
    if new_text != text:
        report.append((tag, f'{len(moves)} 处移动、{len([k for k in keep if k[1] is None])} 处挂起、{len(inserts)} 个挂载点'))
    return new_text

def run_file(path, audit_only=False):
    poems = load_poems()
    tier = 'A' if 'A层' in path else 'M' if 'M层' in path else 'B'
    chm = re.search(r'第(.)章', path)
    ch = chm.group(1) if chm else '?'
    text = open(path).read()
    report, suspends, released = [], [], []
    blocks = re.split(r'(\n\s*\n)', text)
    for i in range(0, len(blocks), 2):
        b = blocks[i]
        pm = re.match(r'\[P(\d+)\]', b)
        if not pm:
            continue
        pid = 'P' + pm.group(1)
        reg = is_poem_seg(poems, ch, pid, tier)
        if reg:
            n_notes = len(NOTE_RE.findall(b))
            released.append((f'{ch}/{tier}/{pid}', f'注册段放行（{reg.get("类型","")}，{n_notes} 注）'))
            if n_notes > 4:
                suspends.append((f'{ch}/{tier}/{pid}', f'注册段注数 {n_notes}>4，不同步', b[:60]))
            continue
        blocks[i] = process_segment(b, report, suspends, f'{ch}/{tier}/{pid}')
    new_text = ''.join(blocks)
    if not audit_only and new_text != text:
        bak = path + '.注位解析前.bak'
        if not os.path.exists(bak):
            open(bak, 'w').write(text)
        open(path, 'w').write(new_text)
    return report, suspends, released, text != new_text

# ── 回归金样 ──
GOLDENS = [
    ('修饰语中间注', 'in an unsteady（不平稳的） way across the yard.', 'in an unsteady way（不平稳地） across the yard.'),
    ('功能词后挂注', 'in（不平稳的） an unsteady way across the yard.', 'in an unsteady way（不平稳地） across the yard.'),
    ('合并注列表', 'wheat and barley（大麦）, oats（燕麦） and hay（干草） grew tall.', None),  # 期望保持/合并，见 run_goldens
    ('跨句反例', 'He stood silently（默默地）. The dogs cried it.', 'He stood silently（默默地）. The dogs cried it.'),
    ('单词注不动', 'They stood foolishly（愚蠢地） and looked.', 'They stood foolishly（愚蠢地） and looked.'),
]

def run_goldens():
    ok = 0
    for name, src, exp in GOLDENS:
        rep, sus = [], []
        out = process_segment(src, rep, sus, f'金样/{name}')
        if name == '合并注列表':
            exp = 'wheat and barley, oats and hay（大麦、燕麦、干草） grew tall.'
        passed = (out == exp) and not sus
        print(('✓' if passed else '✗'), name, '→', out, ('' if passed else f'｜期望 {exp}｜挂起 {sus}'))
        ok += passed
    print(f'金样 {ok}/{len(GOLDENS)}')
    return ok == len(GOLDENS)

def main():
    args = sys.argv[1:]
    if '--goldens' in args:
        sys.exit(0 if run_goldens() else 1)
    files = [a for a in args if a.endswith('.md')]
    audit_only = '--audit-only' in args
    all_rep, all_sus, all_rel, changed = [], [], [], 0
    for f in files:
        rep, sus, rel, ch = run_file(f, audit_only)
        all_rep += rep; all_sus += sus; all_rel += rel; changed += ch
        print(f'{os.path.basename(f)}: {len(rep)} 段有改动记录' if rep else f'{os.path.basename(f)}: 无改动', f'｜挂起 {len(sus)}' if sus else '')
    audit = {'files': [os.path.basename(f) for f in files], 'suspends': len(all_sus), 'changed_files': changed,
             'detail': [{'tag': t, 'reason': r} for t, r, *_ in all_sus]}
    open(f'{os.path.dirname(files[0]) if files else "."}/注位审计.json', 'w').write(json.dumps(audit, ensure_ascii=False, indent=1))
    md = ['# 注位报告（句法解析版）\n', f'改动记录 {len(all_rep)}｜挂起 {len(all_sus)}｜放行 {len(all_rel)}\n', '\n## 挂起清单\n']
    md += [f'- {t}: {r}' for t, r in [(s[0], s[1]) for s in all_sus]] or ['- 无']
    md += ['\n## 注册段放行\n'] + [f'- {t}: {r}' for t, r in all_rel] or ['- 无']
    out_md = (f'{os.path.dirname(files[0])}/注位报告_2026-09-17.md' if files else '/tmp/注位报告.md')
    open(out_md, 'w').write('\n'.join(md))
    print('报告:', out_md)

if __name__ == '__main__':
    main()
