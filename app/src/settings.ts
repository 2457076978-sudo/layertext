/**
 * 设置域（WP-F 拆分）：班级多人定制（分组/个人勾选·句长最严/复现并集）/ 阅读主题与行距 / 阅读字号 /
 * AI 设置弹层（服务商/Key/备用/三开关）/ 设置弹层 / 简化标准弹层 —— 从 main.ts 整块迁出，行为零变化。
 */

import { invoke } from '@tauri-apps/api/core';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { S, esc } from './state.js';
import { $, setStatus, toast } from './uikit.js';
import {
  activeSession,
  fileSummary,
  mergedSelection,
  renderAll,
  reinforceWordsNow,
  scheduleHeatRail,
  updateModePill,
} from './main.js';
import { showVocabEditor } from './pipew.js';
import {
  AI_PROVIDERS,
  aiErrHuman,
  loadConfig,
  reloadPrompts,
  saveConfig,
  simplifyMaxLen,
} from './ai.js';
import { filterTargets, type ClassTarget } from './pure.js';

/* ---------- 班级多人定制（折叠多选栏，feature/reinforce） ---------- */

export async function loadClassGroups(): Promise<void> {
  try {
    const dir = await invoke<string>('class_groups_dir');
    const files = (await invoke<string[]>('list_dir', { dir })).filter((f) => f.toLowerCase().endsWith('.json'));
    const targets: ClassTarget[] = [];
    for (const f of files) {
      try {
        const j = JSON.parse(await invoke<string>('read_text_file', { path: f })) as { targets?: ClassTarget[] };
        if (Array.isArray(j.targets)) targets.push(...j.targets);
      } catch {
        /* 单个文件损坏跳过 */
      }
    }
    S.classTargets = targets;
    S.selectedIds = S.selectedIds.filter((id) => targets.some((t) => t.id === id));
  } catch {
    S.classTargets = [];
  }
}

/** 分组就位保证：已加载直接返回；加载一次后记住（目录里确实没有分组文件也算"就位"，避免反复读盘）。
 *  需要重读盘的场景只有用户显式点「刷新分组文件」。 */
let classGroupsReady = false;
export function ensureClassGroups(): Promise<void> {
  if (classGroupsReady) return Promise.resolve();
  classGroupsReady = true;
  return loadClassGroups();
}

function renderClsPanel(): void {
  let panel = document.getElementById('cls-panel') as HTMLElement | null;
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'cls-panel';
    panel.style.cssText =
      'position:fixed;top:44px;right:12px;z-index:300;width:340px;max-height:70vh;overflow:auto;background:#fff;border:1px solid #cfd8dc;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.16);padding:12px;font-size:13px;display:none';
    document.body.appendChild(panel);
  }
  const groups = S.classTargets.filter((t) => t.类型 === '组');
  const persons = S.classTargets.filter((t) => t.类型 === '人');
  if (S.classTargets.length === 0) {
    panel.innerHTML = `<div style="display:flex;justify-content:space-between"><b><svg class="ico"><use href="#i-users"/></svg>班级定制</b><button id="cls-close">×</button></div>
      <div class="dim" style="line-height:1.8;margin-top:6px">未找到分组文件。把画像导出的分组 JSON 放到：<br><code>~/Documents/LayerText配置/班级分组/</code><br>（班级画像目录运行 <code>python3 画像_分组导出.py</code> 自动生成），然后点「刷新」。</div>
      <button id="cls-reload" style="margin-top:8px"><svg class="ico"><use href="#i-refresh"/></svg>刷新</button>`;
  } else {
    const q = ((document.getElementById('cls-search') as HTMLInputElement | null)?.value ?? '').trim();
    const shown = filterTargets(persons, q);
    const sel = mergedSelection();
    const ck = (t: ClassTarget) =>
      `<label style="display:inline-block;margin:2px 6px;white-space:nowrap"><input type="checkbox" data-cls-id="${esc(t.id)}" ${S.selectedIds.includes(t.id) ? 'checked' : ''}/> ${esc(t.名称)}${t.句长上限 ? `<span class="dim">≤${t.句长上限}词</span>` : ''}</label>`;
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center"><b><svg class="ico"><use href="#i-users"/></svg>班级定制（${S.classTargets.length} 目标）</b>
        <span><button id="cls-clear" title="清空选择">清空</button> <button id="cls-close">×</button></span></div>
      <div style="margin:6px 0 2px"><b>分组</b></div>
      <div>${groups.map(ck).join('') || '<span class="dim">无</span>'}</div>
      <details ${q ? 'open' : ''} style="margin-top:6px"><summary style="cursor:pointer">个人（${persons.length}）${q ? '· 搜索中' : ''}</summary>
        <input id="cls-search" placeholder="搜索姓名…" style="width:96%;margin:6px 0" value="${esc(q)}"/>
        <div style="max-height:200px;overflow:auto;border:1px solid #eceff1;border-radius:4px;padding:4px">${shown.map(ck).join('') || '<span class="dim">无匹配</span>'}</div>
      </details>
      <div style="margin-top:8px;padding:6px 8px;background:${sel.active ? '#e8f5e9' : '#f5f5f5'};border-radius:4px;line-height:1.7">
        ${
          sel.active
            ? `已选 <b>${S.selectedIds.length}</b> 目标【${esc(sel.label)}】<br/>句长 ≤<b>${sel.minLen}</b> 词 ｜ 共同已学词 <b>${sel.knownInter.length}</b> ｜ 本篇复现队列 <b>${sel.dueUnion.length}</b> 词${sel.dueUnion.length ? '：' + esc(sel.dueUnion.slice(0, 6).join(', ')) + (sel.dueUnion.length > 6 ? '…' : '') : ''}<br/><span class="dim">对「质检本章 / 整章改写 / 全书批处理」生效；简化稿自动带目标标签</span>`
            : '未选择——质检与简化用全局词库口径。勾选目标后按“句长取最严、复现词取并集”执行。'
        }
      </div>
      <div style="margin-top:6px"><button id="cls-reload"><svg class="ico"><use href="#i-refresh"/></svg>刷新分组文件</button> <span class="dim">目录：~/Documents/LayerText配置/班级分组/</span></div>`;
    const search = document.getElementById('cls-search') as HTMLInputElement | null;
    search?.addEventListener('input', () => renderClsPanel());
    const keepFocus = q && search;
    if (keepFocus) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }
  const bind = (id: string, fn: () => void) => document.getElementById(id)?.addEventListener('click', fn);
  bind('cls-close', () => {
    panel!.style.display = 'none';
  });
  bind(
    'cls-reload',
    () =>
      void loadClassGroups().then(() => {
        classGroupsReady = true;
        renderClsPanel();
        fileSummary();
      }),
  );
  bind('cls-clear', () => {
    S.selectedIds = [];
    renderClsPanel();
    fileSummary();
  });
  panel.querySelectorAll<HTMLInputElement>('input[data-cls-id]').forEach((el) => {
    el.addEventListener('change', () => {
      const id = el.dataset.clsId!;
      if (el.checked) S.selectedIds.push(id);
      else S.selectedIds = S.selectedIds.filter((x) => x !== id);
      renderClsPanel();
      fileSummary();
    });
  });
}


/* ---------- 阅读体验：主题（白/灰/深色）与行距 ---------- */

const THEMES: { key: 'light' | 'gray' | 'dark'; label: string; icon: string }[] = [
  { key: 'light', label: '白', icon: 'i-sun' },
  { key: 'gray', label: '灰', icon: 'i-contrast' },
  { key: 'dark', label: '深色', icon: 'i-moon' },
];

export function applyTheme(): void {
  const t = S.appConfig.theme ?? 'light';
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.innerHTML = `<svg class="ico"><use href="#${THEMES.find((x) => x.key === t)?.icon ?? 'i-sun'}"/></svg>`;
    btn.title = `主题：${THEMES.map((x) => (x.key === t ? `【${x.label}】` : x.label)).join('/')}，点击切换`;
  }
}

export function stepTheme(): void {
  const cur = S.appConfig.theme ?? 'light';
  const next = THEMES[(THEMES.findIndex((x) => x.key === cur) + 1) % THEMES.length].key;
  S.appConfig.theme = next;
  applyTheme();
  void saveConfig();
  toast(`主题：${THEMES.find((x) => x.key === next)!.label}`);
}

const LINE_HEIGHTS = [1.7, 1.9, 2.1];

export function applyReaderLineHeight(): void {
  document.documentElement.style.setProperty('--read-lh', String(S.appConfig.lineHeight ?? 2.1));
}

function setReaderLineHeight(v: number): void {
  S.appConfig.lineHeight = v;
  applyReaderLineHeight();
  void saveConfig();
  toast(`行距 ${v}`);
}


/** 班级多人定制面板：工具栏不再常驻，入口在 质检 菜单 与 设置 弹层 */
export function toggleClsPanel(): void {
  const p = document.getElementById('cls-panel') as HTMLElement | null;
  if (!p) return;
  const show = p.style.display === 'none' || !p.style.display;
  renderClsPanel();
  p.style.display = show ? 'block' : 'none';
}


/* ================= AI 审核建议（AI 只出候选，教师握定稿权） ================= */

/** 当前 AI 会话历史（同章节内"按指令调整"时携带；应用修订或切换会话后清空） */
export const aiPop = $('ai-pop');

export function showAiSettings(): void {
  aiPop.innerHTML = `
    <div class="pop-h">AI 设置（第一次配置，照着做即可）</div>
    <div class="fld"><label>① 选择 AI 服务商（选一个你有账号的）</label>
      <select id="ai-provider">${AI_PROVIDERS.map((p, i) => `<option value="${i}">${p.name}</option>`).join('')}</select></div>
    <div class="fld"><label>② API 地址（选服务商后自动填好，一般不用改）</label>
      <input id="ai-url" placeholder="https://api.deepseek.com/v1" /></div>
    <div class="fld"><label>③ 模型（选服务商后自动推荐）</label>
      <select id="ai-model-sel"></select><input id="ai-model" placeholder="模型名" style="display:none" /></div>
    <div class="fld"><label>④ API Key（一串密钥，形如 sk-…；只存这台电脑，不会发给别人）</label>
      <input id="ai-key" type="password" placeholder="粘贴你的 Key" />
      <div class="key-tip" id="ai-key-tip" style="color:var(--muted);font-size:11px;margin-top:3px"></div></div>
    <div class="fld"><label>长期审校约定（可选；写上你每次都要 AI 遵守的要求，如"人名保留原文"）</label>
      <textarea id="ai-instructions" style="width:100%;height:50px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit;resize:vertical;"></textarea></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-auto" style="width:auto;margin-top:3px" /> <span><b>AI 改写直接生效</b>（全局）：点标记、批量「✨AI审核建议」、逐句改写的全部结果<b>自动应用</b>，无需再点 ✓，改写的句子会绿色高亮一闪变成新句。关闭则改为候选模式（正文行内 ✓/✗）</span></label></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-trust" style="width:auto;margin-top:3px" /> <span><b>信任模式</b>：允许 AI 助手在对话中直接修改正文（你说"直接改"即生效）</span></label></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-inplace" style="width:auto;margin-top:3px" checked /> <span><b>直接修改原稿文件</b>（推荐）：改动直接写进书稿本身，不另存工作稿——<b>首次修改前自动备份</b>原始版（xxx_原始备份.md），随时可整体还原。关闭则另存工作稿、原稿不动</span></label></div>
    <div class="fld"><label style="display:flex;align-items:flex-start;gap:6px"><input type="checkbox" id="ai-lowthink" style="width:auto;margin-top:3px" checked /> <span><b>关闭思考</b>（推荐）：直接关闭模型的深度思考（thinking=disabled）——改写任务不需要，关了更快更省更稳</span></label></div>
    <div class="fld"><label>备用供应商（可选）：主服务商连不上/报错时按顺序自动切换。Key 留空 = 复用上面第 ④ 步的主 Key（适合同服务商多模型）</label>
      <div id="ai-fb-rows"></div>
      <button id="ai-fb-add" style="font-size:12px">＋ 添加备用</button></div>
    <div class="row-btns">
      <button id="ai-save" class="primary">保存</button>
      <button id="ai-test">测试连接（填完 ①-④ 就点这个）</button>
      <button id="ai-close">关闭</button>
    </div>
    <div class="test-out" id="ai-test-out"></div>
    <div class="hint-txt">这是什么？AI 功能（改写建议 / AI 简化本章 / AI 助手对话）需要连接一个 AI 服务。上面四步配好后，AI 只负责"给建议"，每条建议都会先经本机质检引擎复核，最后由你点头才生效。不知道 Key 从哪来？点菜单 帮助 → 如何获取 AI 的 Key。<br/>每次 AI 调用（用了哪家/花了多少 tokens）自动记入成本台账，复盘页可查。</div>`;
  aiPop.classList.add('open');

  const urlEl = $('ai-url') as HTMLInputElement;
  const modelSel = $('ai-model-sel') as HTMLSelectElement;
  const modelEl = $('ai-model') as HTMLInputElement;

  const applyProvider = (i: number) => {
    const p = AI_PROVIDERS[i];
    if (p.url) urlEl.value = p.url;
    $('ai-key-tip').textContent = 'Key 从哪来：' + p.keyTip;
    if (p.models.length) {
      modelSel.style.display = '';
      modelEl.style.display = 'none';
      modelSel.innerHTML = p.models.map((m) => `<option ${m === S.appConfig.model ? 'selected' : ''}>${m}</option>`).join('');
    } else {
      modelSel.style.display = 'none';
      modelEl.style.display = '';
    }
  };
  $('ai-provider').addEventListener('change', () => applyProvider(Number(($('ai-provider') as HTMLSelectElement).value)));
  const cur = $('ai-key') as HTMLInputElement;

  /* 备用供应商行（failover）：名称/地址/模型/Key(空=复用主Key) */
  const fbRows = $('ai-fb-rows')!;
  const addFbRow = (name = '', url = '', model = '', key = '') => {
    const div = document.createElement('div');
    div.className = 'rw-row';
    div.innerHTML = `<input class="fb-name" value="${esc(name)}" placeholder="名称(如 智谱备用)" style="max-width:90px" />
      <input class="fb-url" value="${esc(url)}" placeholder="API 地址 /v1" />
      <input class="fb-model" value="${esc(model)}" placeholder="模型名" style="max-width:110px" />
      <input class="fb-key" type="password" value="${esc(key)}" placeholder="Key(空=用主Key)" style="max-width:110px" />
      <button class="x">×</button>`;
    div.querySelector('.x')!.addEventListener('click', () => div.remove());
    fbRows.appendChild(div);
  };
  const collectFb = () =>
    [...fbRows.querySelectorAll('.rw-row')]
      .map((r) => ({
        name: (r.querySelector('.fb-name') as HTMLInputElement).value.trim(),
        baseUrl: (r.querySelector('.fb-url') as HTMLInputElement).value.trim().replace(/\/+$/, ''),
        model: (r.querySelector('.fb-model') as HTMLInputElement).value.trim(),
        key: (r.querySelector('.fb-key') as HTMLInputElement).value.trim(),
      }))
      .filter((r) => r.baseUrl && r.model);
  $('ai-fb-add').addEventListener('click', () => addFbRow());
  for (const f of S.appConfig.failover ?? []) addFbRow(f.name ?? '', f.baseUrl ?? '', f.model ?? '');

  void (async () => {
    await loadConfig();
    const key = await invoke<string>('load_api_key');
    const matched = AI_PROVIDERS.findIndex((p) => p.url && p.url === S.appConfig.baseUrl);
    ($('ai-provider') as HTMLSelectElement).value = String(matched >= 0 ? matched : AI_PROVIDERS.length - 1);
    urlEl.value = S.appConfig.baseUrl ?? '';
    if (matched >= 0) applyProvider(matched);
    else {
      modelSel.style.display = 'none';
      modelEl.style.display = '';
      modelEl.value = S.appConfig.model ?? '';
    }
    cur.value = key ?? '';
    ($('ai-instructions') as HTMLTextAreaElement).value = S.appConfig.instructions ?? '';
    ($('ai-auto') as HTMLInputElement).checked = S.appConfig.autoRewriteOnMark ?? false;
    ($('ai-trust') as HTMLInputElement).checked = S.appConfig.trustEdit ?? false;
    ($('ai-inplace') as HTMLInputElement).checked = S.appConfig.inPlaceEdit ?? true;
    ($('ai-lowthink') as HTMLInputElement).checked = S.appConfig.lowThinking !== false;
  })();

  const currentModel = () => (modelSel.style.display !== 'none' ? modelSel.value : modelEl.value.trim());

  $('ai-close').addEventListener('click', () => aiPop.classList.remove('open'));
  $('ai-save').addEventListener('click', async () => {
    const out = $('ai-test-out');
    try {
      S.appConfig.baseUrl = urlEl.value.trim();
      S.appConfig.model = currentModel();
      S.appConfig.instructions = ($('ai-instructions') as HTMLTextAreaElement).value.trim();
      S.appConfig.autoRewriteOnMark = ($('ai-auto') as HTMLInputElement).checked;
      updateModePill();
      S.appConfig.trustEdit = ($('ai-trust') as HTMLInputElement).checked;
      S.appConfig.inPlaceEdit = ($('ai-inplace') as HTMLInputElement).checked;
      S.appConfig.lowThinking = ($('ai-lowthink') as HTMLInputElement).checked;
      const fbs = collectFb();
      S.appConfig.failover = fbs.length ? fbs.map((f) => ({ name: f.name, baseUrl: f.baseUrl, model: f.model })) : undefined;
      await saveConfig();
      const k = cur.value.trim();
      if (k) await invoke('save_api_key', { key: k });
      for (let i = 0; i < fbs.length; i++) {
        if (fbs[i].key) await invoke('save_api_key', { key: fbs[i].key, account: 'fb' + i });
      }
      reloadPrompts();
      out.textContent = fbs.length ? `✓ 已保存（Key 存入本机钥匙串；备用供应商 ${fbs.length} 个，主服务商失败时按序自动切换）` : '✓ 已保存（Key 存入本机钥匙串）';
    } catch (e) {
      out.textContent = '✗ 保存失败：' + e;
    }
  });
  $('ai-test').addEventListener('click', async () => {
    const out = $('ai-test-out');
    const url = (urlEl.value.trim() || '').replace(/\/+$/, '');
    const model = currentModel();
    const key = cur.value.trim();
    if (!key) {
      out.textContent = '第 ④ 步还没填 Key（一串 sk- 开头的字符）';
      return;
    }
    if (!url || !model) {
      out.textContent = '第 ① 步先选服务商，地址和模型会自动填好';
      return;
    }
    out.textContent = '连接中…';
    try {
      const resp = await tauriFetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: '只回复两个字：正常' }] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
      out.textContent = '✓ 连接成功——点「保存」就配好了';
    } catch (e) {
      out.textContent = '✗ ' + aiErrHuman(e);
    }
  });
}


/* ---- 阅读字号 ---- */
/** 正文字号：写 CSS 变量 --read-fs（正文/行内建议统一跟随；英文正文默认 17——x-height 小，须大于界面字级） */
export function applyReaderFont(): void {
  document.documentElement.style.setProperty('--read-fs', String(S.appConfig.readerFont ?? 17) + 'px');
}
export function stepReaderFont(d: number): void {
  const n = Math.min(26, Math.max(13, (S.appConfig.readerFont ?? 17) + d));
  S.appConfig.readerFont = n;
  applyReaderFont();
  scheduleHeatRail();
  void saveConfig();
  toast('字号 ' + n + 'px');
}


/* ---- 设置弹层 ---- */
export function toggleSettings(): void {
  let pop = document.getElementById('settings-pop');
  if (pop) {
    const show = pop.style.display === 'none';
    pop.style.display = show ? 'block' : 'none';
    if (show) renderSettings();
    return;
  }
  pop = document.createElement('div');
  pop.id = 'settings-pop';
  pop.style.display = 'block';
  document.body.appendChild(pop);
  renderSettings();
}
function renderSettings(): void {
  const pop = document.getElementById('settings-pop');
  if (!pop) return;
  const sel = mergedSelection();
  const rw = reinforceWordsNow();
  const row = (label: string, ctrl: string) => `<div class="set-row"><span>${label}</span>${ctrl}</div>`;
  pop.innerHTML = `<div class="pop-h"><svg class="ico"><use href="#i-settings"/></svg>设置 <span class="dim" style="font-weight:400;font-size:12px">（改完即存）</span></div>
    ${row('阅读字号', `<button id="set-fm">A－</button> <b id="set-fv">${S.appConfig.readerFont ?? 17}</b>px <button id="set-fp">A＋</button>`)}
    ${row('行间距', `<span class="seg">${LINE_HEIGHTS.map((h) => `<button class="${(S.appConfig.lineHeight ?? 2.1) === h ? 'cur' : ''}" data-lh="${h}">${h}</button>`).join('')}</span>`)}
    ${row('主题', `<span class="seg">${THEMES.map((t) => `<button class="${(S.appConfig.theme ?? 'light') === t.key ? 'cur' : ''}" data-theme="${t.key}">${t.label}</button>`).join('')}</span>`)}
    ${row('句长上限（简化标准）', `<button id="set-len">调整（${simplifyMaxLen()} 词）</button>`)}
    ${row('直接修改原稿（首改自动备份）', `<input type="checkbox" id="set-inplace" ${(S.appConfig.inPlaceEdit ?? true) ? 'checked' : ''}/>`)}
    ${row('AI 改写直接生效', `<input type="checkbox" id="set-autorew" ${S.appConfig.autoRewriteOnMark ? 'checked' : ''}/>`)}
    ${row('词库', `<span class="dim">课标1600（内置）${S.vocabCsvText ? ` + ${esc(S.vocabName ?? '自定义词库')}` : ''}${S.termsText ? ' + 术语表' : ''}</span> <button id="set-vocab" title="在应用内增删教师词库词条（内置课标不动）；保存到书目录 _词库.csv 并立即生效">编辑…</button>`)}
    ${row('复现队列', `<span class="dim">${rw ? `${esc(S.reinforceName ?? '已学词')} · ${rw.length} 词 · ⑩指标与简化注入已启用` : '未启用（班级定制勾选后自动生效）'}</span>`)}
    ${row('班级定制口径', `<button id="set-cls">${sel.active ? `【${esc(sel.label)}】句长≤${sel.minLen} · 更换` : '选择班级…'}</button>`)}
    <div class="dim" style="margin-top:8px">LayerText v1.1 · 词库以书目录 _词库.csv 为准</div>`;
  pop.querySelectorAll<HTMLElement>('[data-lh]').forEach((b) =>
    b.addEventListener('click', () => {
      setReaderLineHeight(Number(b.dataset.lh));
      renderSettings();
    }),
  );
  pop.querySelectorAll<HTMLElement>('[data-theme]').forEach((b) =>
    b.addEventListener('click', () => {
      S.appConfig.theme = b.dataset.theme as 'light' | 'gray' | 'dark';
      applyTheme();
      void saveConfig();
      renderSettings();
    }),
  );
  document.getElementById('set-vocab')?.addEventListener('click', () => {
    toggleSettings(); // 关设置弹层再开编辑器，避免叠层
    showVocabEditor();
  });
  document.getElementById('set-fm')?.addEventListener('click', () => {
    stepReaderFont(-1);
    renderSettings();
  });
  document.getElementById('set-fp')?.addEventListener('click', () => {
    stepReaderFont(1);
    renderSettings();
  });
  document.getElementById('set-len')?.addEventListener('click', () => {
    showStandardPop();
  });
  document.getElementById('set-cls')?.addEventListener('click', () => {
    toggleClsPanel();
  });
  document.getElementById('set-inplace')?.addEventListener('change', (e) => {
    S.appConfig.inPlaceEdit = (e.target as HTMLInputElement).checked;
    void saveConfig();
    toast('已保存');
  });
  document.getElementById('set-autorew')?.addEventListener('change', (e) => {
    S.appConfig.autoRewriteOnMark = (e.target as HTMLInputElement).checked;
    void saveConfig();
    toast('已保存');
  });
}


export const tierPop = $('tier-pop');

export function showStandardPop(): void {
  tierPop.innerHTML = `
    <div class="pop-h">简化标准 —— 句长上限</div>
    <p class="dim" style="margin:4px 0 10px;line-height:1.8">
      本工具不预设难度层：简化到什么程度由<b>你的词库</b>决定（学生学过什么词，就简化到词库内）。
      句长上限是唯一的硬标准，影响：体检参考值、AI 改写与整章简化。<br/>
      需要<b>更简的版本</b>？不用选"更低的层"——把简化结果再导入、再简化一遍就行，句子会更短更浅。</p>
    <div class="fld" style="display:flex;align-items:center;gap:8px">
      <label style="margin:0">句长上限</label>
      <input type="number" id="std-maxlen" value="${simplifyMaxLen()}" min="8" max="30" style="width:64px" /> 词/句
      <span class="dim">（默认 16；学生基础弱可降到 12~14）</span>
    </div>
    <div class="row-btns">
      <button id="std-save" class="primary">保存</button>
      <button id="std-reset">恢复默认（16 词）</button>
      <button id="std-close">关闭</button>
    </div>`;
  tierPop.classList.add('open');
  $('std-close').addEventListener('click', () => tierPop.classList.remove('open'));
  const apply = async (v: number | undefined) => {
    S.appConfig.simplify = v === undefined ? undefined : { maxLen: v };
    await saveConfig();
    tierPop.classList.remove('open');
    const s = activeSession();
    if (s) renderAll();
    setStatus(v === undefined ? '简化标准已恢复默认（16 词/句）' : `简化标准已保存：句长上限 ${v} 词/句`, 'saved');
  };
  $('std-reset').addEventListener('click', () => void apply(undefined));
  $('std-save').addEventListener('click', () => {
    const v = Number(($('std-maxlen') as HTMLInputElement).value);
    void apply(v >= 8 && v <= 30 ? v : undefined);
  });
}
