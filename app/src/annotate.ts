/**
 * 待确认面板 + 侧栏横幅：把「机器筛出来的、该你拍板的地方」放到教师看得见的地方。
 *
 * ## 为什么要有这个面板（2026-09-13 教师反馈："我怎么也没看到那个生成的候选项"）
 *
 * 第一版把它埋在「检 → 补注」视图里——教师习惯看的是**右边那栏**，于是根本找不到。
 * 现在两处入口：
 *   ① 右栏顶部一条横幅「待确认 N 条 ▸ 去看」（打开一章就有，看得见）
 *   ② 「检 → 待确认」视图（整章的完整列表）
 *
 * ## 这张表里有什么（两路合并，见 `src/core/pendingqueue.ts`）
 *
 *   【★正本】教师知识库标了★加注词，产物里却找不到它了   ← 判据最硬
 *   【正本】 教师词典登记过这个词，产物里却找不到它了
 *   【补注】 这个词在学生已知词库外，引擎给不出注释支持（中文候选由本地模型带句填）
 *
 * ## 三个键（沿用管线里既有的三选一）
 *
 *   ① 补注/保留加注 —— 打 `zh` 标记（标记≠改稿，「按标记修改」才落文档）＋ 记台账
 *   ② 换写          —— 不值得留，生成时换掉（记台账，不改正文）
 *   ③ 说明保留      —— 有意不加注（记台账，下次不再问同一个词）
 *
 * 三个键**都进校准台账**（append-only 正本，`source: human`）——换版本由 `replayInto` 放回来。
 */

import { invoke } from '@tauri-apps/api/core';
import { locateWord, scopeFromChapterPath, type CalibrationScope } from '../../src/core/calibration.js';
import {
  FACET_LABELS,
  matchFacet,
  pendingCountOf,
  pendingProgressOf,
  sortPending,
  wordSpreadOf,
  type PendingFacet,
  type PendingItem,
  type PendingQueue,
  type PendingSort,
} from '../../src/core/pendingqueue.js';
import { newMarkId, type FileSession, type Mark } from './types.js';
import { recordCalibration } from './calibrationio.js';
import { teacherIdOf } from '../../src/core/teachers.js';
import { S } from './state.js';

/**
 * 面板 IO（照 `risk.ts: setRiskIo` 的成例）：读队列 / 写队列 / 切视图都能在测试里替换。
 * 这样"面板到底渲染出来没有"是**能测的**——2026-09-13 的教训正是"候选项做出来了却没人看得见"，
 * 看不见就没法验证，所以先把 IO 抽出来。
 */
export interface AnnotateIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  switchTo(view: string): void;
  session(): FileSession | null;
  /** 打标记（① 补注用）。默认实现**动态** import reader —— 静态 import 会把整个 main 拖进来，
   *  连带 ai.ts 的 Vite `?raw` 导入，node 里就没法给这个面板写 DOM 测试了。 */
  addMark(session: FileSession, mark: Mark): void;
}
let io: AnnotateIo = {
  read: (path) => invoke<string>('read_text_file', { path }),
  write: (path, content) => invoke('write_text_file', { path, content }),
  /* 生产环境三件套都由 main 启动时注入（见 main.ts 的 setAnnotateIo）。
     这里给"没注入"的默认值，行为是"当作没有打开的章节"——面板显示引导文案，不炸。
     **刻意不写 `import('./main.js')`**：动态 import 同样会被 tsc 解析，会把 main → ai.ts
     的 Vite `?raw` 导入拖进 node 端的编译，于是这个面板再也写不了 DOM 测试
     ——而"看不见"正是它上一轮出的事故，必须能测。 */
  switchTo: () => undefined,
  session: () => null,
  addMark: () => undefined,
};
export function setAnnotateIo(next: Partial<AnnotateIo>): void {
  io = { ...io, ...next };
}

/** 队列落在产物根的 `_运行/待确认队列_<层>.json`（管线 `LayerText_AF待确认队列.mjs` 的产物）。 */
function queuePathOf(sourcePath: string, scope: CalibrationScope): string {
  const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
  const outRoot = dir.slice(0, dir.lastIndexOf('/'));
  return `${outRoot}/_运行/待确认队列_${scope.tier}.json`;
}

async function readQueue(session: FileSession): Promise<{ path: string; queue: PendingQueue } | null> {
  if (!session.sourcePath) return null;
  const scope = scopeFromChapterPath(session.sourcePath);
  if (!scope) return null;
  const path = queuePathOf(session.sourcePath, scope);
  try {
    const queue = JSON.parse(await io.read(path)) as PendingQueue;
    if (!Array.isArray(queue?.items)) return null;
    return { path, queue };
  } catch {
    /* 有意兜底：队列还不存在＝这一层还没跑「待确认队列」，不是错误，面板给一句怎么办就好。 */
    return null;
  }
}

async function saveQueue(path: string, queue: PendingQueue): Promise<void> {
  queue.updatedAt = new Date().toISOString();
  await io.write(path, JSON.stringify(queue, null, 1));
}

const teacherOf = (): string => teacherIdOf((S.appConfig as { teacherId?: string })?.teacherId ?? 'unknown');

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 判据显示标签：★加注词最硬，其次引擎客观项，再是教师词典，最后是引擎的缺口报告。 */
function badgeOf(it: PendingItem): { label: string; cls: string } {
  if (it.star) return { label: '★正本加注词', cls: 'pk-star' };
  if (it.kind === 'engine') return { label: `引擎·${it.ruleId ?? ''}`, cls: 'pk-engine' };
  return it.kind === 'restore' ? { label: '正本', cls: 'pk-canon' } : { label: '补注', cls: 'pk-anno' };
}

/* ────────────────────────── 右栏横幅（教师真正看得见的地方） ────────────────────────── */

/**
 * 打开一章就在右栏顶部挂一条「待确认 N 条 ▸ 去看」。
 * 这是 2026-09-13 教师反馈的直接对策：候选项做出来了却没人找得到，等于没做。
 */
export async function refreshPendingBanner(): Promise<void> {
  const host = document.getElementById('side-review');
  if (!host) return;
  document.getElementById('pending-banner')?.remove();
  const s = io.session();
  if (!s?.sourcePath) return;
  const found = await readQueue(s);
  if (!found) return;
  const chapter = scopeFromChapterPath(s.sourcePath)?.chapter ?? '';
  const n = pendingCountOf(found.queue.items, chapter);
  if (!n) return;
  const banner = document.createElement('div');
  banner.id = 'pending-banner';
  banner.className = 'pending-banner';
  /* 一行放得下就一行（原来是四段自由换行，侧栏 248px 里折成三行方块）。
     正文拆成"主句 + 提示"，提示挤不下由 CSS 省略，按钮永远在最右不换行。 */
  banner.innerHTML = `<span class="pb-txt">待确认 <b>${n}</b> 条<span class="pb-hint"> · 你拍板</span></span><button id="pending-go">去看 ▸</button>`;
  /* 走唯一入口切视图（main 导出），免得"当前视图"这个状态被写两份 */
  banner.querySelector('#pending-go')?.addEventListener('click', () => io.switchTo('annotate'));
  host.prepend(banner);
}

/* ────────────────────────── 整章列表 ────────────────────────── */

/** 面板筛选（模块级：重渲染后保持教师选的那一档）。
 *  为什么不默认只显示★：教师上一轮的原话是"我怎么也没看到候选项"——
 *  默认藏东西是把同一个问题换个花样犯。默认全给，筛选用按钮。
 *
 *  2026-09-13 细分（Wayne："大章没细分——第八章 214 条，只有 ★/正本/补注 三个筛子"）：
 *  再加「跨章复现 / 仅本章」一档（判据是这个词出现在几**章**，见 wordSpreadOf），
 *  以及"词频优先"的排序——同一个词在 6 个段落全丢是**一条口径问题**，不该被当成 6 次手滑。 */
type PaneFilter = PendingFacet;
let paneFilter: PaneFilter = 'all';
let paneSort: PendingSort = 'judge';
export function setPaneFilter(f: PaneFilter): void {
  paneFilter = f;
}

export async function renderAnnotatePane(): Promise<void> {
  const host = document.getElementById('pane-annotate');
  if (!host) return;
  const s = io.session();
  if (!s?.sourcePath) {
    host.innerHTML = '<div class="empty">从书架进入一章后，这里列出<b>机器筛出来、要你拍板的地方</b>：★正本词被换掉、教师词典词被换掉、未支持难词。每条给出处句与中文候选，你点一下就行。</div>';
    return;
  }
  const found = await readQueue(s);
  if (!found) {
    const tier = scopeFromChapterPath(s.sourcePath)?.tier[0] ?? 'A';
    host.innerHTML = `<div class="empty"><b>这一层还没有待确认队列</b><br />在管线里跑：<code>node tools/af_pipeline/LayerText_AF待确认队列.mjs --tier ${tier}</code><br /><span style="font-size:var(--fs-sm)">它把「正本核对」与「补注候选」两路合成一张表，落在 <code>_运行/待确认队列_&lt;层&gt;.json</code>。</span></div>`;
    return;
  }
  const { path, queue } = found;
  const chapter = scopeFromChapterPath(s.sourcePath)!.chapter;
  const todo = queue.items.filter((i) => i.chapter === chapter && !i.status);
  const done = queue.items.filter((i) => i.chapter === chapter && i.status).length;
  /* 词分布按**全队列**算（不是只算本章）：跨章复现的判据本来就跨章 */
  const spread = wordSpreadOf(queue.items);
  const chaptersWithTodo = pendingProgressOf(queue.items).chapters.filter((c) => c.todo > 0).length;
  if (!todo.length) {
    host.innerHTML = `<div class="empty"><b>${esc(chapter)}·${esc(queue.tier)} 都处理完了</b>（已处理 ${done} 条）<br />重新跑管线会补进新出现的缺口。</div>`;
    return;
  }
  const count = (f: PaneFilter) => todo.filter((i) => matchFacet(i, f, spread)).length;
  const shown = sortPending(
    todo.filter((i) => matchFacet(i, paneFilter, spread)),
    paneSort,
    spread,
  );
  const chips = (['all', 'star', 'engine', 'canon', 'anno', 'recur', 'single'] as PaneFilter[])
    .map((f) => `<button class="pk-chip${paneFilter === f ? ' active' : ''}" data-pk-filter="${f}">${FACET_LABELS[f]} <span class="pk-count">${count(f)}</span></button>`)
    .join('');
  const rows = shown
    .map((it, i) => {
      const b = badgeOf(it);
      const sp = spread.get(it.word.toLowerCase());
      const recur =
        sp && sp.chapters > 1 ? `<span class="pk-recur" title="这个词在全层 ${sp.chapters} 章里都有条目（共 ${sp.hits} 条）——多半是一条口径问题，不是一个一个手滑">×${sp.chapters} 章</span>` : '';
      return `
    <div class="pk-row">
      <div class="pk-head">
        <span class="pk-badge ${b.cls}">${b.label}</span>
        <b class="pk-word">${esc(it.word)}</b>
        ${recur}
        <span class="pk-para">${esc(it.para)}</span>
        <span class="pk-gloss">${esc(it.gloss)}</span>
        <span class="pk-src">${esc(it.source === 'dict' ? '词典正本' : it.source === 'model' ? '模型候选·需过目' : it.source === 'engine' ? '引擎客观项' : '教师词典')}</span>
      </div>
      <div class="pk-sentence">${esc(it.sentence)}</div>
      ${
        it.kind === 'engine'
          ? /* 引擎客观项要么是**段级**判断（超长句/篇幅），要么是"这个词本来就没注"——
               三个键（补注/换成/忽略）在这里并不都成立。诚实的做法是给一条去风险队列处理的路，
               再加一个"我看过了"，不硬塞三个不成立的按钮。 */
            `<div class="pk-actions">
        <button data-pk-act="goto" data-pk-i="${i}" title="引擎客观项在「风险队列」里有完整上下文与处理入口（原句 / 改写句 / 触发规则）——这里只把它一并列出，不重复造一套操作">去风险队列处理 →</button>
        <button data-pk-act="keep" data-pk-i="${i}" title="我看过了，不用管——只记一笔「我看过了」，免得每次重生成又来问。只在当前层生效，不向下传播。">③ 忽略（记我看过了）</button>
      </div>`
          : `<div class="pk-actions">
        <button data-pk-act="annotate" data-pk-i="${i}" title="保留原词，在正文里给它加中文注释（如 cynical（冷嘲的））。正文先打标记，点「按标记修改」才真正写入。会随层级传播到 M/B。">① 补注：${esc(it.gloss)}</button>
        <span class="pk-rewrite">
          <span class="pk-label">② 换成</span>
          <input data-pk-input="${i}" placeholder="替换词" value="${esc(it.replacement ?? '')}" />
          <button data-pk-act="rewrite" data-pk-i="${i}" title="把上面填的词作为替换词记下来（生成时照它换）。留空则由管线自己找课标内的简单词。换词只写下级待办，不直接改下级正文。">确定</button>
        </span>
        <button data-pk-act="keep" data-pk-i="${i}" title="这个词不用管——不改、不注，只记一笔「我看过了」。作用是不再让它每次重生成都冒出来问你。注意：这条只在当前一层生效，不向下传播（上级觉得不用管，不代表下级也不用管）。">③ 忽略（不加注）</button>
      </div>`
      }
    </div>`;
    })
    .join('');
  const progress = pendingProgressOf(queue.items);
  const chapterBars = progress.chapters
    .slice(0, 12)
    .map((c) => `<span class="pk-chapter${c.chapter === chapter ? ' cur' : ''}" title="${esc(c.chapter)}：待确认 ${c.todo} 条 / 已处理 ${c.done} 条">${esc(c.chapter)}<b>${c.todo}</b></span>`)
    .join('');
  host.innerHTML = `
    <div class="pk-pane">
      <div class="pk-title"><b>${esc(chapter)} · ${esc(queue.tier)} · 待确认 ${todo.length} 条</b>
        <span class="pk-dim">｜已处理 ${done} 条｜判据强弱：★正本加注词 → 引擎客观项 → 正本 → 补注</span></div>
      <div class="pk-progress" title="全书（本层）进度：待确认 ${progress.todo} 条 / 已处理 ${progress.done} 条 / 共 ${progress.total} 条">
        <b>全书 ${progress.todo} 条待确认</b>
        <span class="pk-dim">已处理 ${progress.done} · 共 ${progress.total} · 还有 ${chaptersWithTodo} 章没清完（数字=各章待确认）</span>
        <div class="pk-chapters">${chapterBars}</div>
      </div>
      <div class="pk-toolbar">
        <div class="pk-chips">${chips}</div>
        <button class="pk-chip${paneSort === 'freq' ? ' active' : ''}" data-pk-sort="1" title="按词频排序：同一个词在越多章出现越靠前——跨章复现的多半是一条口径问题，处理一条顶一批">词频优先</button>
      </div>
      <div class="pk-batch">
        <span class="pk-dim">批量（对当前筛选出的 <b>${shown.length}</b> 条）</span>
        <button data-pk-batch="annotate" title="把当前筛选出的每一条都按 ① 补注记下来（正文先打标记，仍要点「按标记修改」才写入——这一步不会直接改正文）">全部 ① 补注</button>
        <button data-pk-batch="keep" title="把当前筛选出的每一条都按 ③ 忽略记下来（不加注、不换词，只记「我看过了」）">全部 ③ 忽略</button>
      </div>
      <div class="pk-legend">
        <b>三个键什么意思</b>
        <span>① <b>补注</b>——保留这个词，给它加中文注释（正文先打标记，点「按标记修改」才写入）</span>
        <span>② <b>换成 ___</b>——直接填你想换成的词（留空则由管线找课标内的简单词）；换词只写下级待办，不直接改下级正文</span>
        <span>③ <b>忽略</b>——不用管它：不注也不换，只记一笔「我看过了」，免得每次重生成又来问。<b>只在当前层生效，不向下传播</b></span>
        <span class="pk-dim">看到 <b>★正本加注词</b> 基本就是照章点 ①（你自己的知识库定了「要加注」）；判据最硬的一批可以先用「全部 ①」扫一遍，仍然要你点「按标记修改」才落进正文。</span>
        <span class="pk-dim"><b>引擎·规则号</b>那几条是机器确定的客观项（超长句 / 漏注 / 正文混入中文 / 篇幅偏离）——它们真正的处理入口在「风险队列」（那里有原句、改写句与触发规则），这里把它们一并列出，是为了**一张表看全**，不再两处各看一半。</span>
      </div>
      ${shown.length ? rows : '<div class="empty">这一档没有待确认项。</div>'}
    </div>`;

  host.querySelectorAll<HTMLElement>('[data-pk-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      paneFilter = btn.dataset.pkFilter as PaneFilter;
      void renderAnnotatePane();
    });
  });
  host.querySelector('[data-pk-sort]')?.addEventListener('click', () => {
    paneSort = paneSort === 'freq' ? 'judge' : 'freq';
    void renderAnnotatePane();
  });
  host.querySelectorAll<HTMLElement>('[data-pk-batch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.pkBatch as 'annotate' | 'keep';
      void decideMany(s, path, queue, shown, act);
    });
  });
  host.querySelectorAll<HTMLElement>('[data-pk-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.pkAct as 'annotate' | 'rewrite' | 'keep' | 'goto';
      /* 引擎客观项：三个键在这里不成立，只把人送回风险队列那套完整入口，不重复造操作 */
      if (act === 'goto') {
        io.switchTo('risk');
        return;
      }
      const i = Number(btn.dataset.pkI);
      const box = host.querySelector<HTMLInputElement>(`[data-pk-input="${i}"]`);
      void decide(s, path, queue, shown[i]!, act, box?.value);
    });
  });
}

/**
 * 批量 ① / ③（Wayne 2026-09-13："★114 条判据最硬，现在也得一条条点"）。
 *
 * 三条纪律：
 *   · **只处理当前筛选出来的**——教师看到的范围就是他批量的范围，不许背着他多改；
 *   · **必须显式确认**——弹窗写清楚条数与动作，"仍然要你确认才落"；
 *   · **只打标记、不写正文**——①/③ 都只记台账与标记，正文仍要教师自己点「按标记修改」。
 *     （这也是它敢一次批量的前提：批错了可以撤销，正文没被动过。）
 */
async function decideMany(s: FileSession, path: string, queue: PendingQueue, items: PendingItem[], act: 'annotate' | 'keep'): Promise<void> {
  if (!items.length) return;
  const label = act === 'annotate' ? '① 补注' : '③ 忽略（不加注）';
  const ok = window.confirm(
    `把当前筛选出的 ${items.length} 条全部按「${label}」记下来？\n\n· 只记决定与标记，**不会直接改正文**——正文仍要你点「按标记修改」才写入。\n· ② 换写不在批量范围内（每条要填不同的词）。`,
  );
  if (!ok) return;
  for (const it of items) await decide(s, path, queue, it, act, undefined, { silent: true });
  await saveQueue(path, queue);
  await renderAnnotatePane();
  void refreshPendingBanner();
}

/**
 * 三种决定的**传播口径**（教师 2026-09-13 定调，沿用项目既有的层级传播三类）：
 *   ① 补注 → `annotate`：操作即资产，直接落实到下级文本
 *   ② 换成 X → `rewrite`：只写下级 `_待复核/层级传播_待办.md`（不直接改下级正文）
 *   ③ 忽略 → **`none`**：**只在当前这一层生效，不向下传播**
 *      ——上级觉得"这个词不用管"，不等于下级也觉得不用管（三层的学生词库本来就不同）
 */
const PROPAGATION: Record<'annotate' | 'rewrite' | 'keep', 'none' | 'annotate' | 'rewrite'> = {
  annotate: 'annotate',
  rewrite: 'rewrite',
  keep: 'none',
};

async function decide(
  s: FileSession,
  path: string,
  queue: PendingQueue,
  it: PendingItem,
  act: 'annotate' | 'rewrite' | 'keep',
  replacement?: string,
  /* 批量调用时由 decideMany 统一落盘/重渲染一次——逐条重渲染会让 114 条把面板刷 114 遍 */
  opts: { silent?: boolean } = {},
): Promise<void> {
  const repl = (replacement ?? '').trim();
  it.status = act === 'annotate' ? 'annotated' : act === 'rewrite' ? 'rewrite' : 'keep';
  it.decidedAt = new Date().toISOString();
  if (act === 'rewrite' && repl) it.replacement = repl;
  if (act === 'keep') {
    /* ③ 忽略：**只记一条"决定"，不产生任何标记**（教师 2026-09-13 踩出来的机制打架）。
       写成标记的后果：AI 审核建议流程会把它当待办，拿"这个词忽略"去问一次 AI、
       产出一条空建议，再被引擎复核报 `⚠︎ 仍含超长`——一条"什么都不做"的决定凭空长出一串动作。
       它要的两件事（留审计、下次别再问）分别由**台账**和**队列 status** 兜住，不需要标记。 */
    const decision: Mark = {
      id: newMarkId(),
      level: 'word',
      word: it.word,
      type: 'otherw',
      note: '教师判定：这个词忽略，不注也不换（只在当前层生效）',
      pi: -1,
      si: -1,
      ts: Date.now(),
    };
    void recordCalibration(s, decision, { teacher: teacherOf(), file: s.fileName, action: 'add', propagation: 'none', kind: 'decision' });
  } else {
    /* ① 补注（`zh`）/ ② 换写（`simpl`）都是**真待办**，要落成标记，让 App 既有的
       「按标记修改 / 词汇简化」流程接手；位置照正文定位（`pi:-1` 的标记点不动、也点不亮）。 */
    const type: Mark['type'] = act === 'annotate' ? 'zh' : 'simpl';
    const note = act === 'annotate' ? it.gloss : repl ? `教师指定替换：${it.word} → ${repl}` : '教师判定：不值得保留，生成时换掉';
    const spots = locateWord(s.md, it.word);
    if (spots.length) {
      const p = spots[0]!;
      io.addMark(s, { id: newMarkId(), level: 'word', pi: p.pi, si: p.si, wi: p.wi, word: it.word, type, note, ts: Date.now() });
    } else {
      /* 找不到词面：**不许静默丢**——决定照记，但要说清"标记没落下"。 */
      const synthetic: Mark = { id: newMarkId(), level: 'word', word: it.word, type, note, pi: -1, si: -1, ts: Date.now() };
      void recordCalibration(s, synthetic, { teacher: teacherOf(), file: s.fileName, action: 'add', propagation: PROPAGATION[act], kind: 'mark' });
      console.warn(`${act}：正文里找不到「${it.word}」，只记了台账、没打标记`);
    }
  }
  if (opts.silent) return;
  await saveQueue(path, queue);
  await renderAnnotatePane();
  void refreshPendingBanner();
}
