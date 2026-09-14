/**
 * 书文件域（WP-F 拆分）：本书配置（_LayerText项目.json 保存与自动加载）/ 导出 Word（含词句卡）/
 * 朗读音频导出 / 书级改写规则（确定性替换+视角注入） —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType } from 'docx';
import { S, esc, globalInstructionsCaptured, globalInstructionsValue, rememberGlobalInstructions } from './state.js';
import { readTextChecked } from './fsx.js';
import { $, setStatus } from './uikit.js';
import { activeSession, persistEdit } from './main.js';
import { renderReader, sidebarHandlers } from './reader.js';
import { attachInlineSuggestions } from './aiflow.js';
import { renderSidebar } from './review.js';
import { splitChapter, extractParas, sentsOf } from '../../src/core/textpipe.js';
import { runQc } from '../../src/core/qc.js';
import { ankiCsv, ankiRowsOf, extractZhNotes, reinforceQueueCsv, applyRewriteTo } from './pure.js';
import { buildLexiconNow } from './lexicon.js';
import { readReviewJson } from './report.js';
import { tocChapters } from './shelf.js';
import { cefrOf, parseCefrLevels, type CefrLevel } from '../../src/core/cefr.js';
import bundledCefr from '../../assets/wordlists/cefrj_levels.txt?raw';

/* ---------- 本书配置：词库/术语/专名/约定 随书稿文件夹保存与自动加载 ---------- */

const BOOK_CONFIG = '_LayerText项目.json';

export async function saveBookConfig(): Promise<void> {
  const s = activeSession();
  if (!s?.sourcePath) {
    setStatus('先打开本书的一个章节文件，配置会保存在它旁边', 'err');
    return;
  }
  const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  const cfg = {
    说明: 'LayerText 本书配置——放在书稿文件夹里，打开同文件夹任何章节自动生效',
    vocabCsv: S.vocabCsvText ?? null,
    vocabName: S.vocabName,
    terms: S.termsText ?? null,
    proper: S.properRows.length ? S.properRows : null,
    instructions: S.appConfig.instructions ?? null,
    rewrite: S.rewriteRules.replacements.length || S.rewriteRules.viewpoint !== 'keep' || S.rewriteRules.extra ? S.rewriteRules : null,
    savedAt: new Date().toLocaleString('zh-CN'),
  };
  try {
    await invoke('write_text_file', { path: `${dir}/${BOOK_CONFIG}`, content: JSON.stringify(cfg, null, 1) });
    setStatus(`已保存为本书配置：${dir}/${BOOK_CONFIG}——这本书后续章节打开即自动带上词库与约定`, 'saved');
    void invoke('reveal_path', { path: `${dir}/${BOOK_CONFIG}` });
  } catch (e) {
    setStatus('保存失败：' + e, 'err');
  }
}

/** 上一次 `loadBookConfig` 作用在哪个书目录。**只有换书才清空**：
 *  同一本书里翻下一章也会重跑本函数（`main.ts` 打开新章节那条路），
 *  而教师刚从界面导入的词库/专名表还没"保存为本书配置"——那种内存里的当前值
 *  不该因为他翻了一页就消失。跨书残留才是要修的：换目录说明换了一本书。 */
let lastBookConfigDir: string | null = null;

/** 本书配置管辖的字段，退回默认值。**换书时必须在应用本书配置之前先清干净**：
 *  下面每一条都是 `if (cfg.X)` 的守卫式赋值（那是为了不把 `null` 当成"清空"），
 *  守卫式赋值本身没问题，问题是**上一本书的值不会被请走**——
 *  打开一本没有配置的书（或配置里没有某一项），上一本书的词库/术语/专名/改写规则
 *  会原封不动继续生效，而界面上没有任何迹象。 */
function resetBookScope(): void {
  S.vocabCsvText = null;
  S.vocabName = '';
  S.termsText = null;
  S.properRows = [];
  S.rewriteRules = { replacements: [], viewpoint: 'keep', viewpointName: '', extra: '' };
  if (globalInstructionsCaptured()) S.appConfig.instructions = globalInstructionsValue();
}

/** 换书时清空本书作用域；同一本书内重入则保留界面上还没保存的当前值。 */
function resetBookScopeIfNew(dir: string): void {
  if (lastBookConfigDir === dir) return;
  resetBookScope();
}

/** 读一个可选文件：**只有确实不存在**才返回 null；"在但读不出来"抛出去。
 *  两种情况原先共用一个 catch（注释写的是"有意兜底，风险写明"）——现在用
 *  `fsx.readTextChecked` 问清楚：不存在＝这一项没有；读不了＝必须让教师知道。 */
async function readIfExists(path: string): Promise<string | null> {
  const r = await readTextChecked(path);
  if (r.kind === 'ok') return r.text;
  if (r.kind === 'missing') return null;
  throw new Error(`${path} 读不出来：${r.error}`);
}

/** 书目录里的 `_词库.csv`（词库编辑器的落盘位置）——有它就以它为准。 */
function applyVocabCsv(csv: string | null): void {
  if (!csv || !csv.trim()) return;
  S.vocabCsvText = csv;
  S.vocabName = '_词库.csv';
}

export async function loadBookConfig(dir: string): Promise<boolean> {
  rememberGlobalInstructions();
  /* 2026-09-14：**先读同目录的 `_词库.csv`**。词库编辑器那个「完成」按钮写的就是这个文件
   * （`pipew.ts` 的 `saveVocab`），设置页也写着"词库以书目录 _词库.csv 为准"，
   * 可是全仓**没有任何地方把它读回来**：教师编辑完、重启 App、再打开这本书，
   * 词库当作没配过——一个"保存成功"的按钮，存下来的东西谁也读不回来。
   * 顺序放在 JSON 配置之前读、之后应用，让 `_词库.csv` 覆盖 JSON 里那份 `vocabCsv`（与设置页口径一致）。 */
  let vocabCsv: string | null = null;
  try {
    vocabCsv = await readIfExists(`${dir}/_词库.csv`);
  } catch (e) {
    /* 文件**在**却读不出来：不能当成"这本书没有词库"（那会让教师以为词库丢了，
     * 更坏的是他再保存一次就会把读不出来的那份覆盖掉）。说出口，本次不加载它。 */
    setStatus(`${e instanceof Error ? e.message : String(e)}——本次按"这本书没有词库"打开；**没有覆盖它**，请先确认该文件`, 'err');
  }
  /* `readTextChecked` 自己把 invoke 的失败收进返回值的三态里，**不 reject**——不用再套一层 catch。 */
  const bookCfg = await readTextChecked(`${dir}/${BOOK_CONFIG}`);
  if (bookCfg.kind === 'missing') {
    /* 这本书没有配置＝绝大多数书的常态。但**换书时必须先把上一本书的配置清掉**——
     * 否则"没有本书配置"会变成"沿用上一本书的配置"。 */
    resetBookScopeIfNew(dir);
    lastBookConfigDir = dir;
    applyVocabCsv(vocabCsv);
    return Boolean(vocabCsv);
  }
  if (bookCfg.kind === 'unreadable') {
    /* 2026-09-14：**读不出来必须与"没配过"分开**（`fsx` 把这件事问清楚了）。
     * 原先两者共用一句 catch，于是"文件在、但读不出来"被静默当成"这本书没有配置"——
     * 教师明明配过词库与改写规则，打开书却什么都没生效，且一个字都不提示。
     * 现在说出口，并按"没有本书配置"处理（换书已清，不会残留上一本）。 */
    resetBookScopeIfNew(dir);
    lastBookConfigDir = dir;
    applyVocabCsv(vocabCsv);
    setStatus(`这本书的配置读不出来（${bookCfg.error.slice(0, 80)}）：${dir}/${BOOK_CONFIG}——本次按"没有本书配置"打开，且**没有覆盖它**，请检查该文件`, 'err');
    return Boolean(vocabCsv);
  }
  try {
    const cfg = JSON.parse(bookCfg.text) as {
      vocabCsv?: string | null;
      vocabName?: string;
      terms?: string | null;
      proper?: string[] | null;
      instructions?: string | null;
      rewrite?: typeof S.rewriteRules;
    };
    resetBookScopeIfNew(dir);
    lastBookConfigDir = dir;
    if (cfg.vocabCsv) {
      S.vocabCsvText = cfg.vocabCsv;
      S.vocabName = cfg.vocabName ?? '本书词库';
    }
    applyVocabCsv(vocabCsv);
    if (cfg.terms) S.termsText = cfg.terms;
    /* 相邻字段都有守卫，只有这条没有——而 `saveBookConfig` 在没有专名表时写的正是 `null`。
     * 后果：教师刚导入的专名表会在下一次打开同目录任一章节时被**静默清空**，
     * ⑧专名一致性检查与 aiflow 的 properNames 一起失效（2026-09-14）。 */
    if (cfg.proper) S.properRows = cfg.proper;
    if (cfg.instructions) S.appConfig.instructions = cfg.instructions;
    if (cfg.rewrite)
      S.rewriteRules = { replacements: cfg.rewrite.replacements ?? [], viewpoint: cfg.rewrite.viewpoint ?? 'keep', viewpointName: cfg.rewrite.viewpointName ?? '', extra: cfg.rewrite.extra ?? '' };
    return Boolean(cfg.vocabCsv || vocabCsv || cfg.terms || cfg.proper?.length || cfg.rewrite);
  } catch (e) {
    /* JSON **语法**坏了（文件读到了、解析不了）：同样说出口，并按"没有本书配置"处理。
     * `_词库.csv` 是独立的另一份，仍然应用它。 */
    resetBookScopeIfNew(dir);
    lastBookConfigDir = dir;
    applyVocabCsv(vocabCsv);
    setStatus(`这本书的配置解析不了（${String(e).slice(0, 60)}）：${dir}/${BOOK_CONFIG}——本次按"没有本书配置"打开，且**没有覆盖它**，请检查该文件`, 'err');
    return Boolean(vocabCsv);
  }
}

/* ---------- 导出 Word（学生用，含章末词句卡） ---------- */

export function bufToB64(buf: ArrayBuffer): string {
  const bin = new Uint8Array(buf);
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bin.length; i += CHUNK) s += String.fromCharCode(...bin.subarray(i, i + CHUNK));
  return btoa(s);
}

export async function exportDocx(): Promise<void> {
  const s = activeSession();
  if (!s) {
    setStatus('请先打开要导出的章节', 'err');
    return;
  }
  try {
    const body = splitChapter(s.md).body;
    const card = splitChapter(s.md).card;
    const paras = extractParas(body);
    const children: (Paragraph | Table)[] = [new Paragraph({ text: s.fileName.replace(/\.(md|txt|markdown)$/i, ''), heading: HeadingLevel.HEADING_1 })];
    for (let i = 0; i < paras.length; i++) {
      const text = applyRewrite(sentsOf(paras[i], false).join(' ').replace(/\s+/g, ' ').trim());
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, size: 22, font: 'Georgia' })], spacing: { after: 100, line: 300, lineRule: 'auto' } }));
    }
    const rows = card.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[\s:-]+\|$/.test(l.trim()));
    if (rows.length >= 2) {
      children.push(new Paragraph({ text: '词句卡', heading: HeadingLevel.HEADING_2, pageBreakBefore: true }));
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((r) => {
            const cells = r
              .trim()
              .replace(/^\|+|\|+$/g, '')
              .split('|')
              .map((c) => c.trim());
            return new TableRow({
              children: cells.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, size: 20 })] })] })),
            });
          }),
        }),
      );
    }
    const doc = new Document({
      sections: [
        {
          children,
          properties: {
            // 紧凑默认版式：A4 上下 1.5cm 左右 1.8cm，正文 11pt、1.25 倍行距、段后 5pt——打印省纸，屏读不挤
            page: { margin: { top: 850, bottom: 850, left: 1021, right: 1021 } },
          },
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    /* 2026-09-14 修（**会覆盖教师原件**）：目标路径原先就是 `<源目录>/<同基名>.docx`。
     * 两种情况会**正好命中源文件本身**：① 这一章本来就是从 `第一章.docx` 打开的
     * （`fileName` 就是原名）；② 会话是 `第一章.md`，而同目录另有教师自己的 `第一章.docx`。
     * 而写入走的是 `write_file_base64` → Rust 的 `std::fs::write`：**不查存在、不备份、非原子**，
     * 也不经 `persistEdit`（所以 `_原始备份.md` 那套完全不生效）。结果是原件被一份 App 生成的
     * 纯文本 docx 原地替换、排版图片全丢、无法撤销——而界面上只显示一条"已导出 Word 版"的成功提示。
     * 现在：目标若已存在（含等于源文件）就**另起一个带 `_LayerText导出` 的名字**，绝不覆盖。 */
    const base = s.fileName.replace(/\.(md|txt|markdown|docx|aiff|mp3)$/i, '');
    const dir = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) : await invoke<string>('reports_dir');
    let out = `${dir}/${base}.docx`;
    if (s.sourcePath) {
      let taken = out === s.sourcePath;
      if (!taken) {
        try {
          await invoke<string>('read_text_file', { path: out });
          taken = true;
        } catch {
          /* 有意兜底：读不到＝这个路径还没有文件，可以安全写（缺失文件本来就是报错的） */
        }
      }
      if (taken) out = `${dir}/${base}_LayerText导出.docx`;
    }
    await invoke('write_file_base64', { path: out, b64: bufToB64((buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength)) });
    setStatus('已导出 Word 版：' + out, 'saved');
    void invoke('reveal_path', { path: out });
  } catch (e) {
    setStatus('导出失败：' + e, 'err');
  }
}

/* ---------- 朗读音频导出（macOS 系统语音） ---------- */

export async function exportTts(): Promise<void> {
  const s = activeSession();
  if (!s) {
    setStatus('请先打开章节', 'err');
    return;
  }
  try {
    const text = applyRewrite(
      extractParas(splitChapter(s.md).body)
        .map((p) => sentsOf(p, false).join(' '))
        .join('\n')
        .replace(/\[[P\d\s]*?\]/g, '')
        .trim(),
    );
    if (!text) throw new Error('正文为空');
    const base = s.sourcePath ? s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/')) + '/' + s.fileName.replace(/\.(md|txt|markdown)$/i, '') : (await invoke<string>('reports_dir')) + '/示例朗读';
    const out = base + '.aiff';
    setStatus('正在生成朗读音频（几分钟文本约需几十秒）…');
    await invoke('export_tts', { text, path: out, voice: 'Samantha' });
    setStatus('已导出朗读音频：' + out, 'saved');
    void invoke('reveal_path', { path: out });
  } catch (e) {
    setStatus('导出失败：' + e, 'err');
  }
}

/* ---------- 书级改写规则：确定性替换（机器做，零遗漏） + 视角与全局规则（注入 AI） ---------- */

const rewritePop = $('rewrite-pop');

export function applyRewrite(text: string): string {
  return applyRewriteTo(text, S.rewriteRules.replacements);
}

/** 规则文本（注入每次 AI 请求） */
/** 校验：替换残留与视角代词密度（机器核对，不靠 AI 自觉） */
function rewriteCheck(): string {
  const s = activeSession();
  if (!s) return '先打开章节';
  const out: string[] = [];
  let body: string;
  try {
    body = splitChapter(s.md).body;
  } catch {
    return '正文解析失败';
  }
  for (const r of S.rewriteRules.replacements) {
    if (!r.from) continue;
    const esc = r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const left = (body.match(new RegExp(`\\b${esc}\\b`, 'g')) ?? []).length;
    const used = (body.match(new RegExp(`\\b${r.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) ?? []).length;
    out.push(left === 0 ? `✓ "${r.from}" → "${r.to}"：无残留（新词出现 ${used} 次）` : `✗ "${r.from}" 仍有 ${left} 处未替换（新词 "${r.to}" 出现 ${used} 次）——可点下方"对当前章节执行替换"由机器补齐`);
  }
  if (S.rewriteRules.viewpoint === 'first') {
    const he = (body.match(/\b(he|his|him|she|her)\b/gi) ?? []).length;
    const I = (body.match(/\b(I|my|me)\b/g) ?? []).length;
    out.push(`视角（第一人称）：第三人称代词 ${he} 处 / 第一人称 ${I} 处${he > I * 2 ? ' ⚠︎ 第一人称占比偏低，建议用「整章改写」按规则重写' : ''}`);
  }
  return out.length ? out.join('\n') : '尚未设置规则';
}

function saveRewriteToBook(): void {
  void (async () => {
    const s = activeSession();
    if (!s?.sourcePath) {
      setStatus('规则随本书保存——先打开本书章节', 'err');
      return;
    }
    const dir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
    try {
      const raw = await invoke<string>('read_text_file', { path: `${dir}/${BOOK_CONFIG}` });
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      cfg.rewrite = S.rewriteRules;
      cfg.savedAt = new Date().toLocaleString('zh-CN');
      await invoke('write_text_file', { path: `${dir}/${BOOK_CONFIG}`, content: JSON.stringify(cfg, null, 1) });
      setStatus('书级改写规则已保存（随本书配置，每章自动生效）', 'saved');
    } catch {
      setStatus('保存失败：请先执行过「保存为本书配置」', 'err');
    }
  })();
}

export function showRewritePop(): void {
  rewritePop.innerHTML = `
    <div class="pop-h">书级改写规则 —— 全书一致的大改动</div>
    <p class="dim" style="margin:4px 0 8px">两类规则：<b>人名/词汇替换</b>由机器确定性执行（不会漏）；<b>叙事视角与全局要求</b>注入每次 AI 请求并自动校验。规则随本书保存，每章生效。</p>
    <div id="rw-rows"></div>
    <button id="rw-add" style="font-size:12px">＋ 添加替换（如 Napoleon → 大猪拿破仑 / Jim → I）</button>
    <div class="fld" style="margin-top:10px"><label>叙事视角</label>
      <select id="rw-view">
        <option value="keep">保持原叙事（默认）</option>
        <option value="first">全书改为第一人称"I"叙述</option>
      </select>
      <input id="rw-name" placeholder="主角名（第一人称时的叙述者，如 Napoleon）" style="margin-top:6px" /></div>
    <div class="fld"><label>其他全局要求（注入每次 AI 请求）</label>
      <textarea id="rw-extra" style="width:100%;height:48px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;resize:vertical;" placeholder="如：所有对话保留原话不改写；年代背景改为当代中国校园"></textarea></div>
    <div class="row-btns">
      <button id="rw-save" class="primary">保存规则（随本书）</button>
      <button id="rw-check">检查当前章节</button>
      <button id="rw-apply">对当前章节执行替换</button>
      <button id="rw-close">关闭</button>
    </div>
    <pre id="rw-out" style="white-space:pre-wrap;font-size:12px;color:var(--muted);margin-top:8px;max-height:160px;overflow:auto"></pre>`;
  rewritePop.classList.add('open');

  const rows = () => rewritePop.querySelector('#rw-rows')!;
  const addRow = (from = '', to = '') => {
    const div = document.createElement('div');
    div.className = 'rw-row';
    div.innerHTML = `<input class="rw-from" value="${esc(from)}" placeholder="原文词" /> → <input class="rw-to" value="${esc(to)}" placeholder="替换为" /><button class="x">×</button>`;
    div.querySelector('.x')!.addEventListener('click', () => div.remove());
    rows().appendChild(div);
  };
  const collect = () => {
    S.rewriteRules.replacements = [...rewritePop.querySelectorAll('.rw-row')]
      .map((r) => ({
        from: (r.querySelector('.rw-from') as HTMLInputElement).value.trim(),
        to: (r.querySelector('.rw-to') as HTMLInputElement).value.trim(),
      }))
      .filter((r) => r.from);
    S.rewriteRules.viewpoint = ($('rw-view') as HTMLSelectElement).value as 'keep' | 'first';
    S.rewriteRules.viewpointName = ($('rw-name') as HTMLInputElement).value.trim();
    S.rewriteRules.extra = ($('rw-extra') as HTMLTextAreaElement).value.trim();
  };
  for (const r of S.rewriteRules.replacements) addRow(r.from, r.to);
  if (!S.rewriteRules.replacements.length) addRow();
  ($('rw-view') as HTMLSelectElement).value = S.rewriteRules.viewpoint;
  ($('rw-name') as HTMLInputElement).value = S.rewriteRules.viewpointName;
  ($('rw-extra') as HTMLTextAreaElement).value = S.rewriteRules.extra;

  $('rw-add').addEventListener('click', () => addRow());
  $('rw-close').addEventListener('click', () => rewritePop.classList.remove('open'));
  $('rw-save').addEventListener('click', () => {
    collect();
    saveRewriteToBook();
  });
  $('rw-check').addEventListener('click', () => {
    collect();
    $('rw-out').textContent = rewriteCheck();
  });
  $('rw-apply').addEventListener('click', () => {
    collect();
    const s = activeSession();
    if (!s) return;
    const before = s.md;
    /* 2026-09-14：**先算出来，别急着写回 `s.md`**。原先这里是
     *   `s.md = applyRewrite(s.md); … persistEdit(s, s.md)`
     * ——两个实参是同一个引用，于是 `persistEdit` 里 `newMd !== s.md` 恒为 false：
     * ① 不 push 撤销快照（这条路径 ⌘Z 撤不回来）；
     * ② 更要命的是它写 `<章>_原始备份.md` 时用的正是 `s.md`，也就是**改写后**的正文——
     *    教师想"整体还原"会还原成被替换的版本，备份本身是废的。
     * 等到 `persistEdit` 成功之后再赋值，备份与快照拿到的才是真正的"改前"。 */
    const next = applyRewrite(s.md);
    if (next === before) {
      $('rw-out').textContent = '无可替换内容（或原词已清零）';
      return;
    }
    void (async () => {
      try {
        const savedTo = await persistEdit(s, next);
        s.md = next;
        renderReader(s);
        attachInlineSuggestions();
        renderSidebar(s, sidebarHandlers);
        $('rw-out').textContent = rewriteCheck();
        setStatus(`替换已执行并写入 ${savedTo}${savedTo === s.sourcePath ? '（已自动备份原始版）' : ''}`, 'saved');
      } catch (e) {
        setStatus('写入失败：' + e, 'err');
      }
    })();
  });
}
document.addEventListener('mousedown', (e) => {
  if (rewritePop.classList.contains('open') && !(e.target as HTMLElement).closest('#rewrite-pop')) rewritePop.classList.remove('open');
});

/* ================= 生词卡导出（Anki + 复现队列，与 FSRS 复习闭环） ================= */

let cefrMapCache: Map<string, CefrLevel> | null = null;
const cefrOfWord = (w: string): string => {
  cefrMapCache ??= parseCefrLevels(bundledCefr);
  const lv = cefrOf(w, cefrMapCache);
  return lv ?? '';
};

/** 组一章的词源：OOV（词表外生词）∪ zh/anchor 标记词（教师点过的教学词） */
function chapterWords(md: string, marks: { level?: string; type?: string; word?: string }[] | undefined): string[] {
  const oov = (() => {
    try {
      return runQc(md, buildLexiconNow(), { tier: 'M', fileName: '' }).oov;
    } catch (e) {
      /* 算不出来就给空表，但**必须记一笔**：这一章的"词表外生词"凭空没了，
       * 导出预览上只会看到总词数变少，没人知道是谁少了。 */
      ankiMisses.push(`本章生词算不出来（${String(e).slice(0, 60)}）`);
      return [];
    }
  })();
  const marked = (marks ?? []).filter((m) => (m.type === 'zh' || m.type === 'anchor') && m.word).map((m) => m.word!);
  return [...new Set([...oov, ...marked])];
}

/** 生词卡导出过程中"没读到/没算出来"的账：导出前在预览里、导出后在状态行里一并说出来。
 *  这是"少给了"型错误——不记下来，界面上只会显示一个偏小的词数。 */
let ankiMisses: string[] = [];

export async function showAnkiExport(): Promise<void> {
  ankiMisses = [];
  const s = activeSession();
  if (!s) {
    setStatus('先打开一个章节（词源=本章生词+已标记词）；全书导出需要从书架进入这本书', 'err');
    return;
  }
  // ① 组数据：当前章 = 本章 md+标记；全书 = 目录各章 md+各自标记文件
  const chapters: { from: string; md: string; words: string[] }[] = [];
  let bookDir = '';
  if (s.sourcePath) bookDir = s.sourcePath.slice(0, s.sourcePath.lastIndexOf('/'));
  chapters.push({ from: s.fileName, md: s.md, words: chapterWords(s.md, s.review.marks) });
  const wholeFiles = S.currentBookDir ? await tocChapters() : [];
  for (const f of wholeFiles) {
    if (f === s.sourcePath) continue;
    try {
      const md = await invoke<string>('read_text_file', { path: f });
      const rv = await readReviewJson(f);
      chapters.push({ from: f.slice(f.lastIndexOf('/') + 1), md, words: chapterWords(md, rv?.marks as { level?: string; type?: string; word?: string }[] | undefined) });
    } catch (e) {
      /* 跳过的章要**点名**：不然导出的词表少了一截，而状态行上写着"（N 词）"，
       * 谁也看不出 N 本来该更大。 */
      ankiMisses.push(`${f.slice(f.lastIndexOf('/') + 1)} 读不到（${String(e).slice(0, 60)}）`);
    }
  }
  if (bookDir === '' && S.currentBookDir) bookDir = S.currentBookDir;
  const zhNotes = extractZhNotes(chapters.map((c) => c.md).join('\n'));
  const needDict = [...new Set(chapters.flatMap((c) => c.words))].filter((w) => !zhNotes[w]);
  const dictZh: Record<string, string> = {};
  if (needDict.length) {
    try {
      const local = await invoke<(string | null)[]>('dict_lookup_zh', { words: needDict });
      needDict.forEach((w, i) => {
        if (local[i]) dictZh[w] = local[i]!;
      });
    } catch {
      /* 有意兜底：系统词典（macOS 自带）不可用时释义留空——
       * 这件事**在预览里看得见**（"N 个无释义（留空，导入 Anki 后可补）"），不是偷偷少一列。 */
    }
  }
  const rows = ankiRowsOf(chapters, zhNotes, dictZh, cefrOfWord);
  const missZh = rows.filter((r) => !r.zh).length;

  // ② 预览确认（导出前看清单：词数、释义缺失——缺失的留空列，教师可后补）
  let panel = document.getElementById('anki-pop');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'anki-pop';
    document.body.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="pop-h">导出生词卡 · Anki + 复现队列</div>
    <p class="dim" style="font-size:12px;line-height:1.8;margin:4px 0 8px">
      词源 = 各章词表外生词 ∪ 你标记的「加中文标注/复现锚点」词（共 <b>${rows.length}</b> 词，去重）。
      释义优先用正文已有注释，其次系统词典${missZh ? `，<b>${missZh} 个无释义（留空，导入 Anki 后可补）</b>` : '，全部有释义'}。
      ${ankiMisses.length ? `<b style="color:var(--danger)">⚠ ${ankiMisses.length} 处没能读到/算出来，词表会不全</b>：${ankiMisses.slice(0, 3).map(esc).join('；')}。<br/>` : ''}
      将写入：<code>${esc(bookDir || '示例目录')}/生词卡_Anki_日期.csv</code>（词/CEFR/释义/例句/出处）与 <code>复现队列_日期.csv</code>（词,hits——可用 <code>node dist/src/cli.js fsrs</code> 看 FSRS 间隔建议）。
    </p>
    <div style="max-height:200px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:4px">
      <table class="sgtable"><tr><th>词</th><th>CEFR</th><th>释义</th><th>例句</th></tr>
      ${rows
        .slice(0, 60)
        .map(
          (r) => `<tr><td>${esc(r.word)}</td><td>${esc(r.cefr)}</td><td>${esc(r.zh) || '<span class="dim">—</span>'}</td><td class="dim" title="${esc(r.sent)}">${esc(r.sent.slice(0, 40))}</td></tr>`,
        )
        .join('')}
      </table>
      ${rows.length > 60 ? `<div class="dim" style="padding:4px">（预览前 60 词，共 ${rows.length}）</div>` : ''}
    </div>
    <div class="row-btns" style="margin-top:8px">
      <button id="anki-save" class="primary">导出 CSV</button>
      <button id="anki-close">取消</button>
    </div>`;
  panel.classList.add('open');
  panel.querySelector('#anki-close')?.addEventListener('click', () => panel.classList.remove('open'));
  panel.querySelector('#anki-save')?.addEventListener('click', async () => {
    const dir = bookDir || (await invoke<string>('reports_dir'));
    const date = new Date().toLocaleDateString('sv-SE');
    try {
      await invoke('write_text_file', { path: `${dir}/生词卡_Anki_${date}.csv`, content: ankiCsv(rows) });
      await invoke('write_text_file', { path: `${dir}/复现队列_${date}.csv`, content: reinforceQueueCsv(rows) });
      panel.classList.remove('open');
      setStatus(
        `生词卡已导出（${rows.length} 词，含复现队列）：${dir}/生词卡_Anki_${date}.csv——Anki 直接导入（逗号分隔）；复现队列可用 fsrs 命令看间隔建议` +
          (ankiMisses.length ? `｜⚠ ${ankiMisses.length} 处没读到/算出来，词表不全：${ankiMisses.slice(0, 3).join('；')}` : ''),
        ankiMisses.length ? 'dirty' : 'saved',
      );
      void invoke('reveal_path', { path: `${dir}/生词卡_Anki_${date}.csv` });
    } catch (e) {
      setStatus('生词卡导出失败：' + e, 'err');
    }
  });
}
