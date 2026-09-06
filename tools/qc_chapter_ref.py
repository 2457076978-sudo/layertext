#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LayerText M1 参照版 QC。

规则与原型 qc_chapter.py **逐行一致**（正则、豁免表、不规则表、计数次序全部照搬）。
与原版的差异仅限"配置层"（见各 # [配置化] 注释）：
  1) pandas → csv 标准库读取词库 CSV；
  2) AF 硬编码路径 / 专名表 / 术语表 / 锚点 → 命令行参数；
  3) 报告落盘路径可用 --out 指定（默认仍写到输入文件同目录）。

保真说明：原版中存在两处"死代码"，为保持行为一致此处同样保留——
  a) _CO 认知动词 lookbehind 表：原版定义了但**未参与** that 定从计数
     （宾从豁免实际由 that_relcl 的代词/时间名词先行词表承担）；
  b) IRR |= {'dying', 'children'}：原版在 known 合并之后执行，无实际效果。

用法：
  python3 tools/qc_chapter_ref.py <候选md> [--tier M] [--vocab a.csv]... \
      [--wordlist w.txt]... [--terms t.txt] [--proper p.txt] \
      [--anchor "短语"]... [--song-marker "Beasts of England"] \
      [--prop-exempt w]... [--prop-check w]... [--out report.json]
"""
import argparse, csv, json, os, re, sys


def read_words(path):
    out = set()
    with open(path, encoding='utf-8') as f:
        for l in f:
            m = re.match(r"^\s*([A-Za-z][A-Za-z'\-]*)", l)
            if m:
                out.add(m.group(1).lower())
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--tier', default='M')
    ap.add_argument('--vocab', action='append', default=[])
    ap.add_argument('--wordlist', action='append', default=[])
    ap.add_argument('--terms')
    ap.add_argument('--proper')
    ap.add_argument('--anchor', action='append', default=[])
    ap.add_argument('--song-marker', default='Beasts of England')
    ap.add_argument('--prop-exempt', action='append', default=[])
    ap.add_argument('--prop-check', action='append', default=[])
    ap.add_argument('--out')
    a = ap.parse_args()

    path, TIER = a.path, a.tier
    _chmap = {'一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10}
    CHNO = next((v for k, v in _chmap.items() if ('第' + k + '章') in path), None)
    md = open(path, encoding='utf-8').read()
    body = re.split(r'## Chapter \w+', md, 1)[1].split('## 词句卡', 1)[0]   # 正文区
    paras = re.findall(r'\[P\d+\](.*?)(?=\[P\d+\]|$)', body, re.S)

    # 语料：歌词计入正文（引语=文学锚点），但单独统计
    def sents_of(text, song=False):
        text = re.sub(r'[>—-]+', ' ', text)
        if song:
            parts = [p for p in text.split('\n') if re.search(r'[A-Za-z]{2,}', p)]
            parts = [q for p in parts for q in re.split(r'(?<=[.!?])\s+', p)]
        else:
            parts = re.split(r'(?<=[.!?\"] )', ' '.join(text.split()))
        return [p for p in parts if re.search(r'[A-Za-z]{2,}', p)]

    all_sents, song_sents = [], []
    for p in paras:
        is_song = a.song_marker in p   # [配置化] 原版硬编码 'Beasts of England'
        ss = sents_of(p, song=is_song)
        if is_song:
            song_sents += ss
        all_sents += ss

    # ---- 指标③④ 句长 ----
    lens = [len(s.split()) for s in all_sents]
    lens_narr = [l for s, l in zip(all_sents, lens) if s not in song_sents] or lens

    # ---- 指标⑤⑥⑦ 黑名单句法 ----
    txt = ' '.join(all_sents)
    txt_narr = ' '.join(s for s in all_sents if s not in song_sents)
    txt_narr = re.sub(r'"[^"]*"', ' ', txt_narr)   # 直接引语豁免（R08：引语只降词不降句式）
    for i, anc in enumerate(a.anchor):             # [配置化] 原版硬编码两条 AF 锚点
        txt_narr = txt_narr.replace(anc, 'REF-ANCHOR-%d' % i)
    _FAKE = r'(?!red\b|bed\b|shed\b|naked\b|need\b|indeed\b|feed\b|seed\b|wed\b|mixed\b|exhausted\b|interested\b)'

    def count_pat(pat, t):
        return len(re.findall(pat, t))

    # built：W1 评测集 eval03 发现漏检（was built by …），2026-09-06 补入（与 TS 版 PASSIVE_IRR 同步）
    # sung 等 22 词：MCP 冒烟测试发现同类漏检（was sung 未检出），2026-09-06 批量补入（与 TS 版同步）
    passive = count_pat(r'\b(was|were|is|are|be|been|being)\s+' + _FAKE + r'\w+ed\b', txt_narr) + count_pat(r'\b(was|were)\s+(driven|made|given|beaten|broken|taken|chosen|elected|seen|heard|told|taught|caught|fed|sent|set|put|cut|hit|built|sung|drawn|known|grown|thrown|shown|shaken|worn|won|torn|frozen|blown|bitten|hidden|spoken|drunk|struck|laid|lit|spun|lent|swept)\b', txt_narr)
    relcl = count_pat(r',?\s+(who|which)\s+\w+', txt_narr)
    # R12盲区修复：that+实义动词型定从（that fed/smelled/stayed类曾全部漏网）；宾从豁免=前词为认知动词
    _CO = r'(?<!said)(?<!agreed)(?<!knew)(?<!thought)(?<!believed)(?<!hoped)(?<!sure)(?<!afraid)(?<!explained)(?<!remembered)(?<!saw)(?<!heard)(?<!felt)(?<!found)(?<!meant)(?<!declared)(?<!announced)(?<!reported)(?<!cried)(?<!shouted)(?<!whispered)(?<!asked)(?<!wondered)(?<!learned)(?<!forgot)(?<!promised)(?<!noticed)(?<!watched)(?<!showed)(?<!proved)(?<!seemed)(?<!appeared)(?<!denied)(?<!doubted)(?<!knew)'
    that_relcl = count_pat(r'\b[a-z]+\s+that\s+(?!was\b|is\b|are\b|were\b|has\b|had\b|always\b|it\b|the\b|a\b|an\b|his\b|its\b|this\b|I\b|he\b|she\b|they\b|we\b|you\b|to\b|not\b|no\b|evening\b|morning\b|night\b|day\b|time\b|week\b|year\b|moment\b|season\b|thing\b|something\b|anything\b|nothing\b|everything\b|afternoon\b|summer\b|winter\b)[a-z]+(ed|s|ing)\b', txt_narr)
    relcl += that_relcl
    that_check = count_pat(r'\b\w+\s+that\s+\w+(s|ed|ing)?\b', txt_narr)
    _PART = r'(been|made|cut|drawn|built|bought|brought|caught|taught|sold|told|kept|left|lost|meant|met|paid|set|put|shut|hit|hurt|let|sung|drunk|eaten|fallen|felt|found|got|given|gone|come|seen|done|taken|grown|begun|forgotten|stood|understood|spoken|spent|slept|sat|run|risen|hidden|held|heard|flown|fed|driven|broken|become|beaten|bitten|blown|chosen|frozen|torn|thrown|woken|worn|won|written|awoken|lent|wept|struck|stuck|swept|spun|laid|led|lit|lain)'
    pastperf = count_pat(r'\bhad\s+(not\s+|never\s+|ever\s+|just\s+|already\s+|also\s+|really\s+)*' + _FAKE + r'(\w+ed)\b', txt_narr) + count_pat(r'\bhad\s+(not\s+|never\s+|ever\s+|just\s+|already\s+|also\s+|really\s+)*' + _PART + r'\b', txt_narr)
    # R12盲区修复：倒装过去完成（Never had the animals seen类）
    # R12-inv-case 修复（与原版唯一有意分歧）：触发词允许句首大写，原版仅小写会漏检
    # "Never/Hardly/No sooner had ..." 句首倒装（其注释示例恰为大写句首）；TS 引擎已同步。
    pastperf += count_pat(r'\b([Nn]ever|[Hh]ardly|[Ss]carcely|[Ss]eldom|[Nn]o sooner)\s+had\s+\w+\s+\w+(ed|en)\b', txt_narr)
    # R12盲区修复：过去分词+by被动后置定语（the life, lived by the pigs类）
    passive += count_pat(r',\s*\w+ed\s+by\s', txt_narr)

    # ---- 指标①② 覆盖率/生词率 ----
    known = set()
    pending_words = set()
    for vp in a.vocab:   # [配置化] 原版硬编码 AF 词库路径
        with open(vp, encoding='utf-8-sig', newline='') as f:
            for row in csv.DictReader(f):
                t = (row.get('类型') or '').strip()
                if t in ('单词', '课标词', '待定词'):
                    w = (row.get('词') or '').lower()
                    if w:
                        known.add(w)
                        if t == '待定词':
                            pending_words.add(w)
    for wl in a.wordlist:   # [配置化] 原版硬编码中考1600文件；兼容"1. word"编号与纯文本两种格式
        with open(wl, encoding='utf-8') as f:
            for l in f:
                m = re.match(r"^\d+\.\s+([A-Za-z][A-Za-z'\-]*)", l) or re.match(r"^\s*([A-Za-z][A-Za-z'\-]*)", l)
                if m:
                    known.add(m.group(1).lower())
    IRR = set('''was were been being am is are have has had do does did done shall should will would can could may might must
cost cost cut cut hit hit hurt hurt let let put put set set shut shut read read beat beat bet bet
arise arose arisen awake awoke awoken bear bore born beat beat beaten become became become begin began begun
bend bent bent bite bit bitten bleed bled bled blow blew blown break broke broken breed bred bred bring brought brought
build built built burn burnt burnt buy bought bought catch caught caught choose chose chosen come came come
dig dug dug draw drew drawn dream dreamt dreamt drink drank drunk drive drove driven eat ate eaten fall fell fallen
feed fed fed fight fought fought find found found fly flew flown forbid forbade forbidden forget forgot forgotten
freeze froze frozen get got got give gave given go went gone grow grew grown hang hung hung have had had
hear heard heard hide hid hidden hit hit hit hold held held hurt hurt hurt keep kept kept know knew known
lay laid laid lead led led lean leant leant learn learnt learnt leave left left lend lent lent lie lay lain
light lit lit lose lost lost make made made mean meant meant meet met met pay paid paid put put put
read read read ride rode ridden ring rang rung rise rose risen run ran run say said said see saw seen
sell sold sold send sent sent shake shook shaken shine shone shone shoot shot shot show showed shown
shut shut shut sing sang sung sink sank sunk sit sat sat sleep slept slept smell smelt smelt speak spoke spoken
spend spent spent spill spilt spilt stand stood stood steal stole stolen stick stuck stuck sweep swept swept
swim swam swum take took taken teach taught taught tear tore torn tell told told think thought thought
throw threw thrown understand understood understood wake woke woken wear wore worn win won won write wrote written
bad worse worst far farther farthest little less least much more most many more most good better best
old older oldest well better best badly worse worst'''.split())

    known |= IRR
    PROP = read_words(a.proper) if a.proper else set()   # [配置化] 原版硬编码 AF 专名表
    known |= PROP
    IRR |= {'dying', 'children'}   # 保真：原版在 known 合并后执行，无实际效果
    GLOSS_GLOBAL = read_words(a.terms) if a.terms else set()   # [配置化] 原版硬编码 AF 术语表
    known |= GLOSS_GLOBAL
    gloss = set()
    IRR_NOUN = {'men': 'man', 'sheep': 'sheep', 'beasts': 'beast', 'tidings': 'tiding', 'teeth': 'tooth', 'feet': 'foot', 'geese': 'goose', 'children': 'child'}

    def hit(tok):
        if tok in known:
            return True
        if tok in IRR_NOUN:
            return IRR_NOUN[tok] in known
        cands = [tok]
        if tok.endswith('s'):
            cands.append(tok[:-1])
        if tok.endswith('es'):
            cands.append(tok[:-2])
        if tok.endswith('ies'):
            cands.append(tok[:-3] + 'y')
        if tok.endswith('ed'):
            cands += [tok[:-1], tok[:-2], tok[:-2] + 'e']
        if tok.endswith('d') and not tok.endswith('ed'):
            cands.append(tok[:-1])
        if tok.endswith('ing'):
            cands += [tok[:-3], tok[:-3] + 'e']
        if tok.endswith('ied'):
            cands.append(tok[:-3] + 'y')
        if tok.endswith('ier'):
            cands.append(tok[:-3] + 'y')
        if tok.endswith('ed') and len(tok) > 5 and tok[-3] == tok[-4]:
            cands.append(tok[:-3])
        if tok.endswith('er'):
            cands += [tok[:-1], tok[:-2]]
        if tok.endswith('est'):
            cands += [tok[:-3], tok[:-2]]
        for c in cands:
            if c in known:
                return True
        return False

    card = md.split('## 词句卡')[1] if '## 词句卡' in md else ''
    for row in card.splitlines():
        if row.strip().startswith('|'):
            cell = row.strip().strip('|').split('|')[0].strip()
            m = re.match(r"([A-Za-z][A-Za-z'\-]*(?: [A-Za-z][A-Za-z'\-]*)?)", cell)
            if m:
                for w in m.group(1).split():
                    gloss.add(w.lower().rstrip('-'))
    known |= gloss
    toks = [re.sub(r"'s$", '', t.lower().strip("'-")) for t in re.findall(r"[A-Za-z][A-Za-z'\-]*", txt)]
    toks = [t for t in toks if t]

    def _pend_hit(tok):
        if tok in pending_words:
            return True
        c = [tok]
        if tok.endswith('s'):
            c.append(tok[:-1])
        if tok.endswith('es'):
            c.append(tok[:-2])
        if tok.endswith('ed'):
            c += [tok[:-1], tok[:-2], tok[:-2] + 'e']
        if tok.endswith('ing'):
            c += [tok[:-3], tok[:-3] + 'e']
        return any(x in pending_words for x in c)

    pending_hits = sum(1 for t in toks if _pend_hit(t)) if toks else 0
    oov = [t for t in toks if not hit(t) and len(t) > 1]
    cover = 1 - len(oov) / len(toks)
    newword_rate = len(set(oov)) / len(set(toks))

    # ---- 指标⑧ 专名一致性（正文专名 ⊆ 词句卡） ----
    prop_in_text = {w for w in a.prop_check if w in txt}   # [配置化] 原版硬编码 AF 专名清单
    prop_in_card = all(w in md.split('## 词句卡')[1] or w in a.prop_exempt for w in prop_in_text)

    passive_ok = (TIER != 'A') or (CHNO is None or CHNO >= 5)   # A层：第5章起被动解禁（U5已教，配脚注）
    relcl_ok = (TIER != 'A') or (CHNO is None or CHNO >= 8)      # A层：第8章起定从解禁（U7已教）
    res = {
        '层级': TIER, '章号': CHNO, '文件': os.path.basename(path),
        '段落ID数': len(paras), '句子总数': len(all_sents), '词符数': len(toks),
        '①词表覆盖率(注释后口径=含A层术语)': f'{cover * 100:.1f}%',
        '②生词率(词型口径)': f'{newword_rate * 100:.1f}%',
        '③平均句长(词)': round(sum(lens) / len(lens), 1),
        '③平均句长(去歌词)': round(sum(lens_narr) / len(lens_narr), 1),
        '④单句最长(词)': max(lens),
        '④超20词句数': sum(1 for l in lens if l > 20),
        '⑤被动式计数(叙事区)': passive, '⑥定语从句计数(叙事区)': relcl, '⑦过去完成计数(叙事区)': pastperf,
        '⑧专名-术语表一致': bool(prop_in_card), 'that从句待人工复核': that_check,
        '⑨待定词token命中(保守口径风险)': int(pending_hits),
        'OOV词(去重)': sorted(set(oov)),
    }
    print(json.dumps({k: v for k, v in res.items() if k != 'OOV词(去重)'}, ensure_ascii=False, indent=1))
    print('OOV:', sorted(set(oov))[:40])
    out = a.out or os.path.join(os.path.dirname(path), '质检报告_%s.json' % ('A' if 'A层' in path else ('v02' if 'v0.2' in path else 'v01')))
    json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    sys.stderr.write('报告已落盘: %s\n' % out)


if __name__ == '__main__':
    main()
