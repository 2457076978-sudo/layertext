/**
 * 书架域（WP-F 拆分）：工作区（_工作区.json 三版本）/ 书架（书封网格/清单/搜索/分组/进度）/
 * 版本选择页 / 目录侧滑面板（章节+书签）/ 会话恢复 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { S, esc } from './state.js';
import { $, setStatus, toast, hidePop } from './uikit.js';
import { activeSession, fileSummary, loadBuiltinDemo, openPathIntoSession, renderAll, syncChrome } from './main.js';
import { ensureClassGroups } from './settings.js';
import { loadBookConfig } from './bookio.js';
import { scrollEl, scrollNow } from './edit.js';
import { saveConfig } from './ai.js';
import { jumpToBookmark } from './review.js';
import {} from './pure.js';
import { buildVersionCards, coverTitlePx, filterShelfBooks, parseWorkspaces, progressPct, shelfGroupsOf, tocItemName, workspaceChipName } from './bookpure.js';

/* ---------- 工作区（书目录 _工作区.json：3 层次=3 工作区，浏览器标签式切换） ---------- */

export async function loadWorkspaces(dir: string): Promise<void> {
  /* 章目录在 书根/重制三版/第X章/ 这么深——`_工作区.json` 却在书根。
   * 只向上找一层的话，打开正文章节会"找不到"并**清空**刚载入的工作区（2026-09-12 真机复现：
   * 恢复上次会话时 README 先载入了工作区、随后第一章把它清掉，目录退化成只列 README）。
   * 与 findProjectFile 同款：最多向上 5 层。 */
  let d = dir;
  for (let i = 0; i < 5 && d && d !== '/'; i++) {
    try {
      const raw = await invoke<string>('read_text_file', { path: `${d}/_工作区.json` });
      const ws = parseWorkspaces(raw);
      if (ws.length > 0) {
        S.workspaces = ws;
        if (!S.activeWorkspace || !ws.some((w) => w.名 === S.activeWorkspace)) S.activeWorkspace = null;
        return;
      }
    } catch {
      /* 有意兜底：这一层没有 _工作区.json 就再上一层（章目录 → 书稿根目录） */
    }
    const up = d.slice(0, d.lastIndexOf('/'));
    if (up === d) break;
    d = up;
  }
  S.workspaces = [];
  S.activeWorkspace = null;
}

async function activateWorkspace(name: string): Promise<void> {
  S.activeWorkspace = name;
  const w = S.workspaces.find((x) => x.名 === name);
  renderVersionSwitcher();
  if (w?.定制目标) {
    await ensureClassGroups(); // 绑定口径的前提：分组就位（幂等，未就位才读一次盘）
    if (S.activeWorkspace === name && S.classTargets.some((t) => t.id === w.定制目标)) {
      S.selectedIds = [w.定制目标];
      fileSummary();
      renderVersionSwitcher();
    } else if (S.activeWorkspace === name) {
      setStatus(`工作区【${name}】绑定的口径 ${w.定制目标} 在分组文件里没找到（<svg class="ico"><use href="#i-users"/></svg>班级定制里可查目录位置）`, 'dirty');
    }
  }
}

/** 当前文件属于哪个工作区（反查 `_工作区.json` 的文件清单；不属于任何工作区返回 null） */
export function workspaceOfFile(path: string | null | undefined): { 名: string; 定制目标?: string; 文件: string[] } | null {
  if (!path) return null;
  return S.workspaces.find((w) => w.文件.includes(path)) ?? null;
}

/**
 * 把工作区上下文对齐到**当前会话**：正文属于哪个工作区，目录/班级口径就跟着哪个。
 *
 * 为什么必须有这一步（2026-09-12 真机复现）：`activeWorkspace` 此前只在**显式点工作区条/⌘1-3**
 * 时设置；切换文件标签、启动恢复会话都只改 `activeIdx`——于是"明明在读 A 层第一章，
 * activeWorkspace 却是空"：目录退化成扫描书根目录（那里只有一个 README），看起来就是
 * "目录不能切换其他章节"；班级口径也会跟着上一个工作区走错。上下文从当前文件**派生**，
 * 而不是指望每个入口都记得维护它——`renderAll` 每次渲染都会经过这里，切到哪章对齐到哪章。
 */
export function alignWorkspaceToSession(): void {
  const w = workspaceOfFile(activeSession()?.sourcePath);
  if (w && S.activeWorkspace !== w.名) void activateWorkspace(w.名);
}

/** 切工作区的完整闭环（工作区条点击与 ⌘1-3 共用）：绑定口径 → 当前正文属于该版本则就地切换，否则翻开该版本第一章 */
export function switchWorkspace(name: string): void {
  void activateWorkspace(name);
  const w = S.workspaces.find((x) => x.名 === name);
  if (!w) return;
  const cur = activeSession()?.sourcePath ?? null;
  const curInWs = cur !== null && w.文件.includes(cur);
  if (curInWs) {
    setStatus(`工作区已切换：${name}${w.定制目标 ? `（口径 ${w.定制目标}）` : ''}`, 'saved');
    return;
  }
  openPathIntoSession(w.文件[0])
    .then(() => setStatus(`已进入【${name}】${workspaceChipName(w.文件[0])}`, 'saved'))
    .catch((e) => setStatus('打开失败：' + e, 'err'));
}

/* ---------- 书架（首页：示例 + 我的书；点书 → 先选版本 → 再进工作区） ---------- */

interface ShelfBook {
  名: string;
  目录: string;
  副标题?: string;
  最近打开?: string;
  /** 分组（右键书卡指派；空=未分组。书多之前只做轻量指派，不做管理弹层） */
  分组?: string;
}

async function shelfPath(): Promise<string> {
  const dir = await invoke<string>('config_dir');
  return `${dir}/书架.json`;
}

async function loadShelf(): Promise<ShelfBook[]> {
  try {
    const raw = await invoke<string>('read_text_file', { path: await shelfPath() });
    const j = JSON.parse(raw) as { 书?: ShelfBook[] };
    return Array.isArray(j.书) ? j.书.filter((b) => b.名 && b.目录) : [];
  } catch (e) {
    /* 返回空表本身没错，错在**它后面接着会发生什么**：书架显示成空的，教师往里加一本书，
     * saveShelf 就把整份注册表覆盖成"只有这一本"。所以这里必须喊一声，并让他先别加书。 */
    setStatus(`书架读不出来：${String(e)}——显示为空**不代表你的书没了**；先别往里加书，否则会覆盖原注册表`, 'err');
    return [];
  }
}

async function saveShelf(books: ShelfBook[]): Promise<void> {
  await invoke('write_text_file', { path: await shelfPath(), content: JSON.stringify({ 说明: 'LayerText 书架——我的书注册表', 书: books }, null, 1) });
}

export async function renderShelf(): Promise<void> {
  syncChrome(); // 书架=无章节上下文：进书架即收起章节级界面（不依赖调用方先走 renderAll）
  const el = $('reader');
  try {
    await renderShelfInner(el);
  } catch (e) {
    el.innerHTML = `<div class="empty"><b>书架加载失败</b><br/>${esc(String(e))}<br/><span style="font-size:12px">把这条错误发给开发者即可修复</span></div>`;
  }
}

function shelfColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h},45%,45%)`;
}

/** 封面图：书目录里的 cover/封面.{jpg,jpeg,png,webp}——找到即用；没有就用书名文字封面 */
async function coverDataUrl(dir: string): Promise<string | null> {
  try {
    const imgs = await invoke<string[]>('list_cover_images', { dir });
    if (!imgs.length) return null;
    const p = imgs[0].toLowerCase();
    const mime = p.endsWith('.png') ? 'png' : p.endsWith('.webp') ? 'webp' : 'jpeg';
    const b64 = await invoke<string>('read_file_base64', { path: imgs[0] });
    return `data:image/${mime};base64,${b64}`;
  } catch {
    /* 有意兜底：没有封面图＝用书名色块封面（书架上看得见"这是文字封面"，不是空白卡片）。 */
    return null;
  }
}

/** 书封 HTML：有图全幅显示（书名落底部渐变条），无图用色块+居中书名（字号按书名长度自适应，极端长名换行4行内可见） */
function coverHtml(名: string, img: string | null, boxW = 150): string {
  const style = img ? `background-image:url(${img})` : `background:${shelfColor(名)}`;
  return `<div class="shelf-cover${img ? ' has-img' : ''}" style="${style}">
    <div class="cover-title" style="font-size:${coverTitlePx(名, boxW)}px">${esc(名)}</div>
  </div>`;
}

/** 阅读进度记账：打开过的章节去重累计 + 最近章/时间；total 缺失时补记全书章数 */
export function touchProgress(path: string | null): void {
  if (path === null || S.currentBookDir === null) return;
  const all = (S.appConfig.progress ??= {});
  const rec = (all[S.currentBookDir] ??= { chapters: [] });
  if (!rec.chapters.includes(path)) rec.chapters.push(path);
  rec.lastChapter = path;
  rec.lastAt = new Date().toLocaleDateString('sv-SE');
}

async function renderShelfInner(el: HTMLElement): Promise<void> {
  const books = await loadShelf();
  const covers = new Map<string, string | null>();
  await Promise.all(books.map(async (b) => covers.set(b.目录, await coverDataUrl(b.目录))));
  renderShelfChrome(el, books, covers);
  renderShelfGrid(el, books, covers);
  bindShelfChrome(el, books, covers);
}

/** 书架页骨架（继续上次 hero / 标题 / 工具行 / 分组条 / 正文容器 / 脚注）——进书架渲染一次 */
function renderShelfChrome(el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  const groups = shelfGroupsOf(books);
  const ls = S.appConfig.lastSession;
  // 首屏 hero：上次在读的书（封面+书名+工作区章名+审校进度+一键继续）——打开 App 第一眼=你的阅读工作台
  const heroBook = ls?.files?.length ? books.find((b) => b.目录 === ls.bookDir) : undefined;
  const heroHtml = heroBook
    ? (() => {
        const img = covers.get(heroBook.目录);
        const prog = S.appConfig.progress?.[heroBook.目录];
        const pct = prog ? progressPct(prog.chapters.length, prog.total) : 0;
        const lastFile = ls!.files[Math.min(ls!.activeIdx, ls!.files.length - 1)]?.path.split('/').pop() ?? '';
        return `<div class="shelf-hero" id="shelf-resume" title="回到上次编辑的章节">
      <div class="hero-cover${img ? ' has-img' : ''}" style="${img ? `background-image:url(${img})` : `background:${shelfColor(heroBook.名)}`}"></div>
      <div class="hero-info">
        <div class="hero-title">${esc(heroBook.名)}</div>
        <div class="hero-sub">${esc(ls!.workspace ? ls!.workspace + ' · ' : '')}${esc(lastFile)} <span class="dim">（${esc(ls!.savedAt)}）</span></div>
        <div class="hero-progress" title="审校进度：${pct}%"><i style="width:${pct}%"></i></div>
      </div>
      <button class="hero-go"><svg class="ico"><use href="#i-play"/></svg>继续上次编辑</button>
    </div>`;
      })()
    : '';
  el.innerHTML = `
    <div class="shelf">
      ${heroHtml}
      <div class="shelf-h"><svg class="ico"><use href="#i-books"/></svg>我的书架</div>
      <div class="shelf-tools">
        <input type="search" id="shelf-q" placeholder="搜索书名 / 分组…" value="${esc(S.shelfQ)}"/>
        <span class="viewseg">
          <button id="view-grid" title="书封视图——挑书"><svg class="ico"><use href="#i-grid"/></svg>书封</button>
          <button id="view-list" title="清单视图——管审校进度"><svg class="ico"><use href="#i-list"/></svg>进度</button>
        </span>
        <span class="dim" id="shelf-count" style="font-size:11px"></span>
      </div>
      ${
        groups.length
          ? `<div class="shelf-groups" id="shelf-groups">
        <span class="gchip" data-group="">全部</span>
        <span class="gchip" data-group="__none__">未分组</span>
        ${groups.map((g) => `<span class="gchip" data-group="${esc(g)}">${esc(g)}</span>`).join('')}
      </div>`
          : ''
      }
      <div id="shelf-body"></div>
    </div>`;
}

/** 书卡正文区（网格=挑书 / 列表=管审校进度）。搜索、分组、切视图只更新这里——搜索框不动，输入焦点天然保持 */
function renderShelfGrid(el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  const view = S.appConfig.shelfView ?? 'grid';
  const shown = filterShelfBooks(books, { q: S.shelfQ, group: S.shelfGroup });
  const prog = S.appConfig.progress ?? {};
  const pctOf = (b: ShelfBook): number => {
    const r = prog[b.目录];
    return r ? progressPct(r.chapters.length, r.total) : 0;
  };
  const timeOf = (b: ShelfBook): string => prog[b.目录]?.lastAt ?? b.最近打开 ?? '';
  const progHtml = (b: ShelfBook): string => {
    const pct = pctOf(b);
    return `<div class="shelf-progress" title="审校进度：${pct}%"><i style="width:${pct}%"></i></div><div class="shelf-progress-pct">${pct ? `已审 ${pct}%` : '未开始'}</div>`;
  };
  const coverStyle = (b: ShelfBook): string => {
    const img = covers.get(b.目录);
    return img ? `background-image:url(${img})` : `background:${shelfColor(b.名)}`;
  };
  const badgeHtml = (b: ShelfBook): string => (b.分组?.trim() ? `<span class="shelf-badge">${esc(b.分组.trim())}</span>` : '');

  const gridCards = shown
    .map(
      (b) => `<div class="shelf-card" data-shelf="${esc(b.目录)}" title="打开《${esc(b.名)}》${b.分组 ? ' · 分组 ' + esc(b.分组) : '（右键可设分组）'}">
    <div class="shelf-cover${covers.get(b.目录) ? ' has-img' : ''}" style="${coverStyle(b)}"><div class="cover-title" style="font-size:${coverTitlePx(b.名)}px">${esc(b.名)}</div></div>
    <div class="shelf-info">
      <div class="shelf-sub">${esc(b.副标题 ?? '')}</div>
      ${timeOf(b) ? `<div class="shelf-meta">${esc('最近 ' + timeOf(b))}</div>` : ''}
      ${progHtml(b)}
    </div>
  </div>`,
    )
    .join('');
  const rowCards = shown
    .map(
      (b) => `<div class="shelf-row" data-shelf="${esc(b.目录)}" title="打开《${esc(b.名)}》（右键可设分组）">
      <div class="row-cover" style="${coverStyle(b)}"></div>
      <div class="row-main">
        <div class="row-name">${esc(b.名)}${badgeHtml(b)}</div>
        <div class="row-sub">${esc(b.副标题 ?? '')}</div>
      </div>
      <div class="row-progress">${progHtml(b)}</div>
      <div class="row-time">${esc(timeOf(b))}</div>
    </div>`,
    )
    .join('');
  const emptyHint = '没有匹配的书——换个搜索词，或点分组「全部」';
  const body = el.querySelector<HTMLElement>('#shelf-body');
  if (!body) return;
  body.innerHTML =
    view === 'list'
      ? `<div class="shelf-grid list">${rowCards || `<div class="dim" style="padding:20px 4px">${emptyHint}</div>`}
        <div class="shelf-row add-row" id="shelf-add">＋ 添加书稿文件夹</div></div>`
      : `<div class="shelf-grid">
        <div class="shelf-card demo" id="shelf-demo" title="打开内置示例">
          <div class="shelf-cover" style="background:${shelfColor('龟兔赛跑')}"><div class="cover-title" style="font-size:${coverTitlePx('龟兔赛跑')}px">龟兔赛跑</div></div>
          <div class="shelf-info"><div class="shelf-sub">内置示例 · 含示例词库</div></div>
        </div>
        ${gridCards || `<div class="dim" style="grid-column:1/-1;padding:16px 4px">${emptyHint}</div>`}
        <div class="shelf-card add" id="shelf-add" title="把一个书稿文件夹注册到书架（目录里放 cover.jpg 作书封，_词库.csv / _工作区.json 自动生效）">
          <div class="shelf-cover">＋</div>
          <div class="shelf-info"><div class="shelf-sub">添加书稿文件夹</div></div>
        </div>
      </div>`;
  const count = el.querySelector<HTMLElement>('#shelf-count');
  if (count) count.textContent = `${shown.length === books.length ? `${books.length} 本` : `${shown.length}/${books.length} 本`}`;
  for (const id of ['view-grid', 'view-list']) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('cur', (id === 'view-grid') === (view === 'grid'));
  }
  // 分组条当前项高亮（搜索不改分组，随分组点击同步）
  el.querySelectorAll<HTMLElement>('[data-group]').forEach((chip) => {
    const g = chip.dataset.group ?? '';
    const active = S.shelfGroup === null ? g === '' : S.shelfGroup === '' ? g === '__none__' : g === S.shelfGroup;
    chip.classList.toggle('cur', active);
  });
  bindShelfCards(el, books);
}

/** 骨架上的固定交互：继续上次 / 示例 / 添加 / 搜索 / 视图 / 分组条 */
function bindShelfChrome(el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  document.getElementById('shelf-resume')?.addEventListener('click', () => void resumeLastSession());
  document.getElementById('shelf-demo')?.addEventListener('click', () => loadBuiltinDemo());
  document.getElementById('shelf-add')?.addEventListener('click', () => void addBookToShelf());
  const q = document.getElementById('shelf-q') as HTMLInputElement | null;
  q?.addEventListener('input', () => {
    S.shelfQ = q.value;
    renderShelfGrid(el, books, covers); // 局部刷新正文区，搜索框与焦点原地不动
  });
  document.getElementById('view-grid')?.addEventListener('click', () => setShelfView('grid', el, books, covers));
  document.getElementById('view-list')?.addEventListener('click', () => setShelfView('list', el, books, covers));
  el.querySelectorAll<HTMLElement>('[data-group]').forEach((chip) =>
    chip.addEventListener('click', () => {
      const g = chip.dataset.group ?? '';
      S.shelfGroup = g === '' ? null : g === '__none__' ? '' : g;
      renderShelfGrid(el, books, covers);
    }),
  );
}

/** 书卡交互（data-shelf=书目录，目录是书的唯一主键——过滤与重渲染后依旧指向同一本） */
function bindShelfCards(el: HTMLElement, books: ShelfBook[]): void {
  el.querySelectorAll<HTMLElement>('[data-shelf]').forEach((card) => {
    const b = books.find((x) => x.目录 === card.dataset.shelf);
    if (!b) return;
    card.addEventListener('click', () => void openBook(b));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showShelfCtxMenu(b, books, e.clientX, e.clientY);
    });
  });
}

/** 视图切换（持久化）：网格=挑书，列表=管进度——只重绘正文区 */
function setShelfView(v: 'grid' | 'list', el: HTMLElement, books: ShelfBook[], covers: Map<string, string | null>): void {
  S.appConfig.shelfView = v;
  void saveConfig();
  renderShelfGrid(el, books, covers);
}

/** 书卡右键轻量分组菜单：指派到现有分组 / 新建（书多之前保持轻量；保存后整页刷新让分组条同步） */
function showShelfCtxMenu(b: ShelfBook, books: ShelfBook[], x: number, y: number): void {
  closeShelfCtxMenu();
  const menu = document.createElement('div');
  menu.className = 'shelf-ctxmenu';
  menu.id = 'shelf-ctxmenu';
  const curGroup = b.分组?.trim() ?? '';
  const groups = shelfGroupsOf(books);
  menu.innerHTML =
    `<div class="ci ${curGroup === '' ? 'cur' : ''}" data-g="">未分组</div>` +
    groups.map((g) => `<div class="ci ${curGroup === g ? 'cur' : ''}" data-g="${esc(g)}">${esc(g)}</div>`).join('') +
    `<div class="sep"></div><input id="ctx-new-group" placeholder="新建分组名，回车确认"/>`;
  menu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  document.body.appendChild(menu);
  const pick = async (g: string): Promise<void> => {
    closeShelfCtxMenu();
    const name = g.trim();
    const fresh = await loadShelf();
    const target = fresh.find((x) => x.目录 === b.目录);
    if (!target) return;
    target.分组 = name || undefined; // undefined 不入 JSON，等于未分组
    await saveShelf(fresh);
    await renderShelf();
    setStatus(name ? `《${b.名}》已移入分组「${name}」` : `《${b.名}》已设为未分组`, 'saved');
  };
  menu.querySelectorAll<HTMLElement>('[data-g]').forEach((ci) => ci.addEventListener('click', () => void pick(ci.dataset.g ?? '')));
  const inp = menu.querySelector('#ctx-new-group') as HTMLInputElement | null;
  inp?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && inp.value.trim()) void pick(inp.value);
  });
  setTimeout(() => document.addEventListener('mousedown', closeShelfCtxMenu, { once: true }), 0);
}

export function closeShelfCtxMenu(): void {
  document.getElementById('shelf-ctxmenu')?.remove();
}

async function addBookToShelf(): Promise<void> {
  const dir = await openFileDialog({ directory: true });
  if (typeof dir !== 'string' || !dir) return;
  try {
    const files = (await invoke<string[]>('list_dir', { dir })).filter((f) => /\.(md|txt|docx)$/i.test(f));
    let wsCount = 0,
      chCount = files.length;
    try {
      const ws = parseWorkspaces(await invoke<string>('read_text_file', { path: `${dir}/_工作区.json` }));
      wsCount = ws.length;
      chCount = ws.reduce((n, w) => n + w.文件.length, 0);
    } catch {
      /* 有意兜底：这本书没有 _工作区.json＝单卷书，照样能注册；下面按"文件数"写副标题。 */
    }
    if (chCount === 0) {
      setStatus('该文件夹没有可打开的章节文件（.md/.txt/.docx）', 'err');
      return;
    }
    const books = await loadShelf();
    if (books.some((b) => b.目录 === dir)) {
      setStatus('这本书已在书架上', 'saved');
      return;
    }
    const 名 = dir.slice(dir.lastIndexOf('/') + 1) || dir;
    books.push({ 名, 目录: dir, 副标题: wsCount ? `${wsCount} 个版本 · ${chCount} 章` : `${chCount} 个文件`, 最近打开: new Date().toLocaleDateString('sv-SE') });
    await saveShelf(books);
    await renderShelf();
    setStatus(`已加入书架：${名}（${wsCount ? wsCount + ' 个版本' : chCount + ' 个文件'}）——点书选版本`, 'saved');
  } catch (e) {
    setStatus('添加失败：' + e, 'err');
  }
}

/** 点书：加载配置与工作区 → 停在版本选择页（不直接进第一个工作区） */
async function openBook(b: ShelfBook): Promise<void> {
  try {
    await loadBookConfig(b.目录);
    await loadWorkspaces(b.目录);
    S.currentBookDir = b.目录; // 进度记账锚定书根
    // 全书章数（进度百分比分母）：有工作区按版本文件总数计，单卷书按目录章文件数计
    const total = S.workspaces.length > 0 ? S.workspaces.reduce((n, w) => n + w.文件.length, 0) : (await invoke<string[]>('list_dir', { dir: b.目录 })).filter((f) => /\.(md|txt)$/i.test(f)).length;
    const rec = ((S.appConfig.progress ??= {})[b.目录] ??= { chapters: [] });
    if (total > 0) rec.total = total;
    const books = await loadShelf();
    const i = books.findIndex((x) => x.目录 === b.目录);
    if (i >= 0) {
      books[i].最近打开 = new Date().toLocaleDateString('sv-SE');
      await saveShelf(books);
    }
    S.appConfig.lastSession = { bookDir: b.目录, workspace: undefined, files: [], activeIdx: 0, savedAt: new Date().toLocaleString('zh-CN') };
    void saveConfig();
    renderBookVersions(b);
  } catch (e) {
    setStatus('打开书失败：' + e, 'err');
  }
}

/** 版本选择页（两级导航第二步）：一本书的各版本卡片；点了版本才进工作区 */
function renderBookVersions(b: ShelfBook): void {
  syncChrome(); // 版本页=书级页面：章节工具与视图行按无会话上下文收起
  const el = $('reader');
  const cards = buildVersionCards(S.workspaces);
  void coverDataUrl(b.目录).then((img) => {
    const mini = document.getElementById('ver-cover');
    if (mini) mini.innerHTML = coverHtml(b.名, img, 96);
  });
  el.innerHTML = `
    <div class="ver-sel">
      <div class="ver-back" id="ver-back">← 返回书架</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <div id="ver-cover" style="width: 96px; flex-shrink: 0"></div>
        <div class="ver-h">《${esc(b.名)}》<span class="dim">选一个版本进入</span></div>
      </div>
      ${
        cards.length
          ? `<div class="ver-grid">
        ${cards
          .map(
            (c) => `<div class="ver-card" data-ver="${c.idx}" title="进入【${esc(c.名)}】工作区">
          <div class="ver-name">${esc(c.名)}</div>
          <div class="ver-desc">${esc(c.desc)}</div>
          <div class="ver-first">从「${esc(c.first)}」开始</div>
          <div class="ver-go">进入工作区 →</div>
        </div>`,
          )
          .join('')}
      </div>`
          : `<div class="dim" style="margin-top:14px;line-height:1.9">这本书还没有分层配置（_工作区.json）。<br/>· 直接读：上方「打开文件…」选书稿文件夹里的章节 md 即可（${esc(b.副标题 ?? '')}）。<br/>· 要分 B/M/A 三个版本：在书稿根目录建 _工作区.json（可以让右侧 AI 助手帮你生成，说"帮我写 _工作区.json"即可）。</div>`
      }
    </div>`;
  document.getElementById('ver-back')?.addEventListener('click', () => backToShelf());
  el.querySelectorAll('[data-ver]').forEach((card) =>
    card.addEventListener('click', () => {
      const w = S.workspaces[Number((card as HTMLElement).dataset.ver)];
      if (w) switchWorkspace(w.名); // 绑定口径 + 翻开该版本第一章的完整闭环
    }),
  );
}

/** 点版本：绑定口径 → 翻开该版本第一章 */
/** 回书架：关掉全部章节会话（标记与正文改动早已自动落盘），工作区条一并收起 */
export function backToShelf(): void {
  saveLastSession();
  S.sessions = [];
  S.activeIdx = -1;
  S.workspaces = [];
  S.activeWorkspace = null;
  S.currentBookDir = null;
  closeToc();
  hidePop();
  renderAll();
}

/* ---------- 目录侧滑面板（章节 + 审校状态徽标 + 本章书签；审校台的目录，不是小说目录） ---------- */

export function tocPanelEl(): HTMLElement | null {
  return document.getElementById('toc-panel');
}

function ensureTocDom(): { mask: HTMLElement; panel: HTMLElement } {
  let mask = document.getElementById('toc-mask');
  let panel = tocPanelEl();
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'toc-mask';
    mask.addEventListener('mousedown', () => closeToc());
    document.body.appendChild(mask);
  }
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = 'toc-panel';
    panel.innerHTML = `
      <div class="toc-h"><svg class="ico"><use href="#i-list"/></svg>目录<span class="dim" id="toc-sub"></span><button id="toc-close" title="关闭（Esc）">×</button></div>
      <div class="toc-list" id="toc-list"></div>
      <div class="toc-bm-h" id="toc-bm-h" style="display:none"><svg class="ico sm"><use href="#i-bookmark"/></svg>本章书签 <span class="cnt" id="toc-bm-cnt"></span><span class="dim" style="font-weight:400;font-size:10.5px">— 双击正文段号收藏</span></div>
      <div class="toc-bm" id="toc-bm"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('#toc-close')?.addEventListener('click', () => closeToc());
  }
  return { mask, panel: panel! };
}

export function toggleToc(): void {
  const panel = tocPanelEl();
  if (panel?.classList.contains('open')) {
    closeToc();
    return;
  }
  const s = activeSession();
  if (!s) {
    toast('先打开一章，目录跟着书走');
    return;
  }
  const { mask, panel: p } = ensureTocDom();
  p.classList.add('open');
  mask.classList.add('open');
  void refreshToc();
}

export function closeToc(): void {
  tocPanelEl()?.classList.remove('open');
  document.getElementById('toc-mask')?.classList.remove('open');
}

/** 目录章节数据源：当前工作区文件 → 书目录单章 md → 已打开会话（单文件模式） */
export async function tocChapters(): Promise<string[]> {
  const active = S.workspaces.find((w) => w.名 === S.activeWorkspace);
  if (active) return active.文件;
  if (S.currentBookDir) {
    try {
      const fs = await invoke<string[]>('list_dir', { dir: S.currentBookDir });
      return fs.filter((f) => /\.(md|txt)$/i.test(f));
    } catch (e) {
      /* 空表会让目录、看板、档案页一起说"没有章节"（看板那句甚至是"从书架进入一本书"——
       * 而教师明明就在一本书里）。空表可以返回，但真正的错因必须露出来。 */
      setStatus(`读章节列表失败：${String(e)}——不一定是"这本书没有章节"，先确认目录还在不在`, 'err');
      return [];
    }
  }
  return S.sessions.map((x) => x.sourcePath).filter((x): x is string => !!x);
}

export async function refreshToc(): Promise<void> {
  const panel = tocPanelEl();
  if (!panel) return;
  const s = activeSession();
  const cur = s?.sourcePath ?? null;
  const chapters = await tocChapters();
  document.getElementById('toc-sub')!.textContent =
    `${S.currentBookDir ? (S.currentBookDir.split('/').pop() ?? '') : '本次打开'}${S.activeWorkspace ? ' · ' + S.activeWorkspace : ''} · ${chapters.length} 章`;
  const list = document.getElementById('toc-list')!;
  if (!chapters.length) {
    list.innerHTML = `<div class="toc-bm-empty">当前没有书上下文（单章模式）——从书架点书进入后，这里列全书章节并显示各章审校状态。</div>`;
  } else {
    list.innerHTML = chapters
      .map(
        (f) =>
          `<div class="toc-item ${f === cur ? 'cur' : ''}" data-tocf="${esc(f)}" title="${esc(f)}"><span class="t" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(tocItemName(chapters, f))}</span><span class="toc-badge" data-badge="${esc(f)}">…</span></div>`,
      )
      .join('');
    list.querySelectorAll('[data-tocf]').forEach((item) =>
      item.addEventListener('click', () => {
        const f = (item as HTMLElement).dataset.tocf!;
        closeToc();
        openPathIntoSession(f)
          .then(() => setStatus(`已打开：${tocItemName(chapters, f)}（工作区【${S.activeWorkspace ?? '—'}】口径）`, 'saved'))
          .catch((e) => setStatus('打开失败：' + e, 'err'));
      }),
    );
    // 各章审校状态：批量读 _审校标记.json，标记数进徽标（读不到=未标记；路径含特殊字符，用 dataset 匹配不用属性选择器）
    const badgeOf = (f: string): HTMLElement | null => [...list.querySelectorAll<HTMLElement>('[data-badge]')].find((b) => b.dataset.badge === f) ?? null;
    for (const f of chapters) {
      if (f === cur) {
        const b = badgeOf(f);
        if (b) b.textContent = s ? `${s.review.marks.length} 标记` : '当前';
        continue;
      }
      void (async () => {
        let label = '未标记';
        try {
          const base = f.slice(f.lastIndexOf('/') + 1).replace(/\.(md|txt|markdown|docx)$/i, '');
          const mp = `${f.slice(0, f.lastIndexOf('/'))}/${base}_审校标记.json`;
          const j = JSON.parse(await invoke<string>('read_text_file', { path: mp })) as { marks?: unknown[] };
          const n = Array.isArray(j.marks) ? j.marks.length : 0;
          if (n) label = `${n} 标记`;
        } catch {
          /* 有意兜底：这一章还没有标记文件＝还没审过（缺失文件本来就是报错的），徽标显示"未标记"。 */
        }
        const b = badgeOf(f);
        if (b) b.textContent = label;
      })();
    }
  }
  // 本章书签区
  const bmBox = document.getElementById('toc-bm');
  const bmH = document.getElementById('toc-bm-h');
  const bms = s?.review.bookmarks ?? [];
  bmH!.style.display = 'flex';
  document.getElementById('toc-bm-cnt')!.textContent = String(bms.length);
  bmBox!.innerHTML = bms.length
    ? bms
        .map((b) => `<div class="toc-bm-item" data-bm="${b.pi}"><span class="p">★P${String(b.pi + 1).padStart(2, '0')}</span><span class="t" title="${esc(b.text)}">${esc(b.text)}</span></div>`)
        .join('')
    : `<div class="toc-bm-empty">本章还没有书签——正文中双击段落号（P01/P02…）即可收藏，回头从这里一键跳回。</div>`;
  bmBox!.querySelectorAll('[data-bm]').forEach((item) =>
    item.addEventListener('click', () => {
      jumpToBookmark(Number((item as HTMLElement).dataset.bm));
    }),
  );
}

/**
 * 版本切换器（2026-09-13 排版重构·方案 B）。
 *
 * 原先是一条常驻的「版本栏」：三个版本胶囊 + 一个章节下拉，占满一整行 38px——而教师一天可能就切两三次。
 * 现在收成一个下拉：点开是**版本列表 + 本版章节列表**（章节下拉的功能一并收进来，没丢），
 * 省下的一整行还给了上下文栏里的章节标签。**多一次点击，换一条横栏**，这笔账划算。
 */
export function renderVersionSwitcher(): void {
  const btn = document.getElementById('ver-switch');
  const nameEl = document.getElementById('ver-name');
  const pop = document.getElementById('ver-pop');
  const bar = document.getElementById('ctxbar');
  if (!btn || !nameEl || !pop || !bar) return;
  if (S.workspaces.length === 0) {
    /* 没有工作区（单文件/示例模式）：整条上下文栏交给章节标签与章节动作，版本位收起 */
    btn.style.display = 'none';
    pop.classList.remove('open');
    pop.innerHTML = '';
    return;
  }
  btn.style.display = '';
  const active = S.workspaces.find((w) => w.名 === S.activeWorkspace);
  nameEl.textContent = S.activeWorkspace ?? '未选择版本';
  btn.classList.toggle('unset', !S.activeWorkspace);
  const cur = activeSession()?.sourcePath ?? null;
  const chNameOf = (f: string, i: number): string =>
    f
      .split('/')
      .slice(0, -1)
      .reverse()
      .find((part) => /^第.+章$/.test(part)) ?? `章节 ${i + 1}`;
  pop.innerHTML =
    `<div class="ver-pop-h">版本</div>` +
    S.workspaces
      .map(
        (w) =>
          `<button class="ver-item${w.名 === S.activeWorkspace ? ' active' : ''}" data-ws="${esc(w.名)}" title="${w.定制目标 ? `绑定定制口径 ${w.定制目标}` : '切换到这个版本'}">${esc(w.名)}${w.定制目标 ? `<span class="dim">${esc(w.定制目标)}</span>` : ''}</button>`,
      )
      .join('') +
    (active
      ? `<div class="ver-pop-h">本版章节（${active.文件.length}）</div>` +
        active.文件.map((f, i) => `<button class="ver-item ch${f === cur ? ' active' : ''}" data-ch="${esc(f)}">${esc(chNameOf(f, i))}</button>`).join('')
      : '');
  pop.querySelectorAll<HTMLElement>('[data-ws]').forEach((el) =>
    el.addEventListener('click', () => {
      closeVersionPop();
      switchWorkspace(el.dataset.ws!);
    }),
  );
  pop.querySelectorAll<HTMLElement>('[data-ch]').forEach((el) =>
    el.addEventListener('click', () => {
      closeVersionPop();
      void openPathIntoSession(el.dataset.ch!).catch((e) => setStatus('打开失败：' + e, 'err'));
    }),
  );
}

function closeVersionPop(): void {
  document.getElementById('ver-pop')?.classList.remove('open');
}

/** 点开/收起版本面板。点面板外或按 Esc 收起——与其它弹层同一套手感。 */
export function toggleVersionPop(): void {
  const pop = document.getElementById('ver-pop');
  if (!pop) return;
  pop.classList.toggle('open');
}

/* ---- 会话恢复：回到上次编辑 ---- */
let lastSessionTimer: ReturnType<typeof setTimeout> | null = null;
export function saveLastSession(): void {
  if (S.sessions.length === 0) return;
  const cur = activeSession();
  if (cur) cur.scrollTop = scrollNow();
  const dir = S.sessions.find((x) => x.sourcePath)?.sourcePath;
  S.appConfig.lastSession = {
    /* 书根锚定（书架注册目录）：hero"继续上次编辑"按 bookDir===书.目录 匹配，
     * 写章目录会导致匹配永远失败（章目录在书根下多层）；无书上下文时退回文件父目录 */
    bookDir: S.currentBookDir ?? (dir ? dir.slice(0, dir.lastIndexOf('/')) : undefined),
    workspace: S.activeWorkspace ?? undefined,
    files: S.sessions.filter((x) => x.sourcePath).map((x) => ({ path: x.sourcePath!, scroll: x.scrollTop ?? 0 })),
    activeIdx: S.activeIdx,
    savedAt: new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };
  void saveConfig();
}
export function scheduleSaveLastSession(): void {
  if (lastSessionTimer) clearTimeout(lastSessionTimer);
  lastSessionTimer = setTimeout(saveLastSession, 1500);
}
async function resumeLastSession(): Promise<void> {
  const ls = S.appConfig.lastSession;
  if (!ls?.files?.length) {
    toast('没有上次的编辑记录');
    return;
  }
  S.currentBookDir = ls.bookDir ?? null; // 进度记账锚定回书根
  let opened = 0;
  const failedFiles: string[] = [];
  for (const f of ls.files) {
    try {
      await openPathIntoSession(f.path);
      opened++;
    } catch {
      /* 文件可能被移走，跳过——但**要记下是哪几个**：只丢一个文件时下面那句
       * "上次的文件都打不开了"不会触发，教师会以为"上次就只开了这几章"。 */
      failedFiles.push(f.path.slice(f.path.lastIndexOf('/') + 1));
    }
  }
  if (opened === 0) {
    S.currentBookDir = null; // 文件全部失效：还原书根锚定，回书架重新选书
    toast('上次的文件都打不开了（可能被移动）', 'err');
    return;
  }
  if (failedFiles.length) toast(`有 ${failedFiles.length} 个上次的文件打不开了（可能被移动）：${failedFiles.slice(0, 3).join('、')}`, 'err');
  if (ls.workspace && S.workspaces.some((w) => w.名 === ls.workspace)) switchWorkspace(ls.workspace);
  const idx = Math.min(ls.activeIdx, S.sessions.length - 1);
  S.activeIdx = idx;
  const s = activeSession();
  if (s && (ls.files[idx]?.scroll ?? 0) > 0) {
    setTimeout(() => {
      const el = scrollEl();
      if (el) el.scrollTop = ls.files[idx].scroll;
    }, 60);
  }
  renderAll();
  toast(`已回到上次：${ls.workspace ? ls.workspace + ' · ' : ''}${s?.fileName ?? ''}（${ls.savedAt}）`, 'ok');
}
