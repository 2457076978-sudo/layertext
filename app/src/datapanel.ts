/** 数据面板（Data Panel）· 规范 v1 第八节的实现
 *
 * 设计要点：
 *  ① 文件是正本，**教师不碰文件**——在面板里增删改，由面板写回；
 *  ② 写前校验、写后校验，**不允许绕过**（否则面板会变成新的污染源）；
 *  ③ 正本 vs 派生要区分：派生的只读、标灰；
 *  ④ 每次编辑追加一行变更日志。
 *
 * 本文件分两层：
 *  - 纯逻辑（parse/validate/upsert/delete）：可在 node 下直接测试，不依赖 Tauri
 *  - DOM 渲染（renderDataPane）：依赖 invoke 与页面容器
 */
/** IO 注入点 —— 纯逻辑（parse/validate/upsert/delete）完全不依赖它，
 *  因此可以在 node 下直接测试，不必启动 App。生产环境走 Tauri。 */
export interface PanelIo {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  appendLog(name: string, line: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
}

export let io: PanelIo = {
  async read(path) {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke('read_text_file', { path });
  },
  async write(path, content) {
    const mod = await import('@tauri-apps/api/core');
    await mod.invoke('write_text_file', { path, content });
  },
  async appendLog(name, line) {
    const mod = await import('@tauri-apps/api/core');
    await mod.invoke('append_log', { name, line });
  },
  async listDir(dir) {
    const mod = await import('@tauri-apps/api/core');
    return mod.invoke<string[]>('list_dir', { dir });
  },
};

/** 在某本书的根目录里找 调适项目_*.json（数据面板靠它知道各数据文件在哪）。
 *  找不到则逐级向上再试一层，方便 调适工作区/ 这类层级。 */
export async function findProjectConfig(bookDir: string): Promise<Record<string, unknown> | null> {
  // 向上找三层：配置常放在书的上一级（如 名著阅读工作区/调适项目_X.json，而书开的是 调适工作区/）
  const dirs: string[] = [];
  let cur = bookDir.replace(/\/+$/, '');
  for (let i = 0; i < 3 && cur && cur !== '/'; i++) {
    dirs.push(cur);
    cur = cur.replace(/\/[^/]+$/, '');
  }
  for (const d of dirs) {
    try {
      const files = await io.listDir(d);
      const hit = files.find((f) => /^调适项目_.+\.json$/.test(f));
      if (hit) return JSON.parse(await io.read(`${d}/${hit}`)) as Record<string, unknown>;
    } catch { /* 继续试下一层 */ }
  }
  return null;
}

/** 测试/替换用 */
export function setIo(next: PanelIo): void { io = next; }

/* ══════════════ 数据类型定义 ══════════════ */

export type ColType = 'text' | 'int' | 'enum';

export interface Column {
  key: string;
  type: ColType;
  /** enum 类型的允许值 */
  values?: string[];
  /** 是否必填 */
  required?: boolean;
  hint?: string;
}

export interface DataKind {
  id: string;
  label: string;
  /** 从项目配置里取文件路径的键；支持点号路径（书级数据在 书级.* 下） */
  pathKey: string;
  format: 'csv' | 'txt' | 'json';
  columns?: Column[];
  /** 唯一键列（csv） */
  uniqueBy?: string;
  /** 派生文件：只读 */
  derived?: boolean;
  note: string;
}

export const DATA_KINDS: DataKind[] = [
  {
    id: 'vocab', label: '词库', pathKey: '词库', format: 'csv', uniqueBy: '词',
    note: '判定"学生学过没有"的唯一锚。只能来自权威来源（课标/教材词表），AI 补的词必须核对后方可入库。',
    columns: [
      { key: '词', type: 'text', required: true },
      { key: '类型', type: 'enum', values: ['单词', '课标词', '短语', '句型', '待定词'], required: true,
        hint: '只有 单词/课标词/待定词 会被当作"学生已学"；不确定时填「待定词」' },
      { key: '词性', type: 'text' },
      { key: '释义', type: 'text' },
      { key: '来源册', type: 'text', required: true, hint: '教材册次或「课标1600」' },
      { key: '来源单元', type: 'text' },
      { key: '音标', type: 'text' },
      { key: '备注', type: 'text' },
    ],
  },
  {
    id: 'kb', label: '知识库', pathKey: '书级.知识库', format: 'csv', uniqueBy: '词',
    note: '每本书一份：教师确认的加注词 + 换词倾向，注入生成提示词。',
    columns: [
      { key: '类型', type: 'enum', values: ['加注词', '换词倾向'], required: true },
      { key: '词', type: 'text', required: true, hint: '英文，小写' },
      { key: '值', type: 'text', hint: '加注词填中文释义；换词倾向留空' },
      { key: '来源数', type: 'int' },
    ],
  },
  {
    id: 'dict', label: '注释词典', pathKey: '书级.词典', format: 'csv', uniqueBy: '词',
    note: '跨章同词同义的正本。⚠ 一个词只允许一个释义——同名多义会由校验拦下。',
    columns: [
      { key: '词', type: 'text', required: true },
      { key: '释义', type: 'text', required: true, hint: '2–6 个汉字' },
      { key: '来源', type: 'text' },
    ],
  },
  {
    id: 'proper', label: '专名表', pathKey: '书级.专名表', format: 'txt',
    note: '每本书一份：人名/地名/作品名。QC 不计生词、改写不加注。⚠ 漏一个主要人物就会把名字注成普通名词。',
  },
  {
    id: 'groups', label: '分层参数', pathKey: '分层正本', format: 'json',
    note: '分层参数的唯一正本（json）。App 分组配置与 Markdown 参数表都由它派生；本页只读，改参数请用导出脚本回环校验。',
  },
];

/* ══════════════ 纯逻辑（可测） ══════════════ */

/** 宽容 CSV 解析（BOM / 引号 / CRLF），与 tools/validate_data.mjs 同口径 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', inQ = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function parseTxt(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export interface Table { header: string[]; rows: Record<string, string>[] }

export function toTable(text: string): Table {
  const rows = parseCsv(text);
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0]!.map((h) => h.trim());
  return {
    header,
    rows: rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

export function fromTable(t: Table): string {
  const lines = [t.header.join(',')];
  for (const r of t.rows) lines.push(t.header.map((h) => csvCell(r[h] ?? '')).join(','));
  return '\uFEFF' + lines.join('\n') + '\n';
}

/** 校验一个单元（csv 一行 / txt 一行）——返回错误信息数组，空数组=通过 */
export function validateUnit(kind: DataKind, unit: Record<string, string>, table?: Table): string[] {
  const errs: string[] = [];
  if (kind.id === 'proper') {
    const w = (unit['词'] ?? '').trim();
    if (!w) errs.push('专名为空');
    else if (!/^[a-z][a-z '-]*$/.test(w)) errs.push(`专名「${w}」含非法字符（只能小写字母、空格、连字符、撇号）`);
    return errs;
  }
  if (!kind.columns) return errs;
  for (const c of kind.columns) {
    const v = (unit[c.key] ?? '').trim();
    if (c.required && !v) { errs.push(`「${c.key}」为必填，不能为空`); continue; }
    if (!v) continue;
    if (c.type === 'int' && !/^\d+$/.test(v)) errs.push(`「${c.key}」必须是数字，实际「${v}」`);
    if (c.type === 'enum' && c.values && !c.values.includes(v)) {
      errs.push(`「${c.key}」取值「${v}」不合法，只能是：${c.values.join(' / ')}`);
    }
  }
  // 唯一性 / 同词多义
  if (table && kind.uniqueBy) {
    const key = (unit[kind.uniqueBy] ?? '').trim().toLowerCase();
    if (key) {
      const dup = table.rows.filter((r) => (r[kind.uniqueBy!] ?? '').trim().toLowerCase() === key);
      if (kind.id === 'dict' && dup.length) {
        const glosses = new Set(dup.map((r) => (r['释义'] ?? '').trim()));
        glosses.add((unit['释义'] ?? '').trim());
        if (glosses.size > 1) errs.push(`同词多义：「${key}」已有释义 ${[...glosses].join(' / ')}（规范冻结：一词只允许一个释义）`);
      }
      if (kind.id === 'kb' && dup.length) {
        // 知识库允许同词不同「类型」，但不允许完全重复
        if (dup.some((r) => (r['类型'] ?? '') === (unit['类型'] ?? ''))) errs.push(`「${key}」在「${unit['类型']}」下已存在`);
      }
    }
  }
  return errs;
}

/** 整份文件校验——写前/写后都用它 */
export function validateText(kind: DataKind, text: string): string[] {
  const errs: string[] = [];
  if (kind.format === 'json') {
    try {
      const d = JSON.parse(text);
      if (!d || typeof d !== 'object') errs.push('JSON 根节点应为对象');
      else if (!Array.isArray(d.groups)) errs.push('缺 groups 数组');
      else {
        const ids = new Set<string>();
        d.groups.forEach((g: Record<string, unknown>, i: number) => {
          const p = `groups[${i}]`;
          for (const k of ['id', '名称', '类型']) if (!g[k]) errs.push(`${p}.${k} 缺失`);
          if (g['类型'] && !['组', '人'].includes(String(g['类型']))) errs.push(`${p}.类型 取值非法`);
          if (g['类型'] === '组' && g['成员数'] === undefined) errs.push(`${p}.成员数 缺失（组必填）`);
          const id = String(g['id'] ?? '');
          if (id) { if (ids.has(id)) errs.push(`${p}.id 重复：${id}`); ids.add(id); }
        });
      }
    } catch (e) { errs.push('JSON 解析失败：' + String(e)); }
    return errs;
  }
  if (kind.format === 'txt') {
    const lines = parseTxt(text);
    if (!lines.length) errs.push('文件为空');
    const seen = new Set<string>();
    lines.forEach((l, i) => {
      const e = validateUnit(kind, { 词: l });
      e.forEach((x) => errs.push(`第 ${i + 1} 行：${x}`));
      if (seen.has(l)) errs.push(`第 ${i + 1} 行：「${l}」重复`);
      seen.add(l);
    });
    return errs;
  }
  const t = toTable(text);
  if (!t.header.length) { errs.push('文件无表头'); return errs; }
  if (kind.columns) {
    for (const c of kind.columns) if (!t.header.includes(c.key)) errs.push(`缺列「${c.key}」（现有：${t.header.join(',')}）`);
  }
  const seen = new Set<string>();
  t.rows.forEach((r, i) => {
    // 校验第 i 行时，唯一性/多义检查必须**排除该行自身**，否则每一行都会被判成"已存在"
    const peer: Table = { header: t.header, rows: t.rows.filter((_, j) => j !== i) };
    for (const e of validateUnit(kind, r, peer)) errs.push(`第 ${i + 2} 行：${e}`);
    if (kind.uniqueBy) {
      const k = `${r['类型'] ?? ''}:${(r[kind.uniqueBy!] ?? '').toLowerCase()}`;
      if (r[kind.uniqueBy!]) { if (seen.has(k)) errs.push(`第 ${i + 2} 行：「${r[kind.uniqueBy!]}」重复`); seen.add(k); }
    }
  });
  return errs;
}

/** 新增或更新一行（按 uniqueBy 定位）。返回新文本 + 是否需要写盘 */
export function upsertRow(kind: DataKind, text: string, unit: Record<string, string>): { text: string; error?: string } {
  const errs = validateText(kind, text);
  const t = toTable(text);
  // 关键：校验"这一行"时必须先把**待替换的那一行**排除出去，
  // 否则"更新已有行"会被唯一性检查当成"重复"而拒绝。
  const key0 = kind.uniqueBy ?? t.header[0]!;
  const kv0 = (unit[key0] ?? '').trim().toLowerCase();
  const peer: Table = { header: t.header, rows: t.rows.filter((r) => (r[key0] ?? '').trim().toLowerCase() !== kv0) };
  const unitErrs = validateUnit(kind, unit, peer);
  if (unitErrs.length) return { text, error: unitErrs.join('；') };
  const key = kind.uniqueBy ?? t.header[0]!;
  const kv = (unit[key] ?? '').trim().toLowerCase();
  const idx = t.rows.findIndex((r) => (r[key] ?? '').trim().toLowerCase() === kv);
  if (idx >= 0) t.rows[idx] = { ...t.rows[idx], ...unit };
  else t.rows.push(Object.fromEntries(t.header.map((h) => [h, unit[h] ?? ''])));
  const out = fromTable(t);
  const post = validateText(kind, out);
  if (post.length) return { text, error: '写入后校验未通过：' + post.slice(0, 3).join('；') };
  void errs;
  return { text: out };
}

export function deleteRow(kind: DataKind, text: string, keyValue: string): { text: string; error?: string } {
  const t = toTable(text);
  const key = kind.uniqueBy ?? t.header[0]!;
  const before = t.rows.length;
  t.rows = t.rows.filter((r) => (r[key] ?? '').trim().toLowerCase() !== keyValue.trim().toLowerCase());
  if (t.rows.length === before) return { text, error: `找不到「${keyValue}」` };
  return { text: fromTable(t) };
}

/** 专名表：一行一名 */
export function upsertProperLine(text: string, word: string): { text: string; error?: string } {
  const w = word.trim().toLowerCase();
  const e = validateUnit({ id: 'proper' } as DataKind, { 词: w });
  if (e.length) return { text, error: e.join('；') };
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.some((l) => l.trim().toLowerCase() === w)) return { text, error: `「${w}」已存在` };
  lines.push(w);
  return { text: lines.join('\n') + '\n' };
}

export function deleteProperLine(text: string, word: string): { text: string; error?: string } {
  const w = word.trim().toLowerCase();
  const lines = text.split('\n');
  const out = lines.filter((l) => l.trim().toLowerCase() !== w || l.startsWith('#'));
  if (out.length === lines.length) return { text, error: `找不到「${w}」` };
  return { text: out.join('\n') };
}

/** 按点号路径取配置值（'书级.专名表' → project.书级.专名表） */
export function getPath(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/* ══════════════ 状态与 IO ══════════════ */

export interface PanelState {
  active: string;
  tables: Record<string, { text: string; errs: string[] }>;
  filter: string;
  log: string[];
}

/** 项目配置：字段名→值（值为字符串或嵌套对象）。取值处显式转换。 */
export type ProjectConfig = Record<string, unknown>;

export const panelState: PanelState & { project: ProjectConfig | null } =
  { active: 'vocab', tables: {}, filter: '', log: [], project: null };

/** 载入全部数据文件（含校验） */
export async function loadAll(kinds: DataKind[], project: ProjectConfig): Promise<void> {
  for (const k of kinds) {
    const path = getPath(project, k.pathKey) as string | undefined;
    if (!path) { panelState.tables[k.id] = { text: '', errs: [`项目配置缺「${k.pathKey}」`] }; continue; }
    try {
      const text = await io.read(path);
      panelState.tables[k.id] = { text, errs: validateText(k, text) };
    } catch (e) {
      panelState.tables[k.id] = { text: '', errs: [`读取失败：${String(e)}`] };
    }
  }
}

/** 保存：写前校验 → 写 → 写后校验 → 追加变更日志 */
export async function save(
  kind: DataKind, project: ProjectConfig, newText: string, what: string,
): Promise<{ ok: boolean; error?: string }> {
  const pre = validateText(kind, newText);
  if (pre.length) return { ok: false, error: '写前校验未通过：' + pre.slice(0, 3).join('；') };
  const path = getPath(project, kind.pathKey) as string | undefined;
  if (!path) return { ok: false, error: `项目配置缺「${kind.pathKey}」` };
  try {
    await io.write(path, newText);
  } catch (e) { return { ok: false, error: `写入失败：${String(e)}` }; }
  const back = await io.read(path);
  const post = validateText(kind, back);
  if (post.length) return { ok: false, error: '写后校验未通过（文件已写入，请检查）：' + post.slice(0, 3).join('；') };

  panelState.tables[kind.id] = { text: back, errs: [] };
  const line = `${new Date().toISOString()} | ${kind.label} | ${what} | ${path}`;
  panelState.log.unshift(line);
  try {
    await io.appendLog('数据面板变更日志.csv', line);
  } catch { /* 留痕尽力而为，不阻塞 */ }
  return { ok: true };
}

/* ══════════════ DOM 渲染 ══════════════ */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function renderDataPane(bookDir: string): Promise<void> {
  const el = document.getElementById('pane-data');
  if (!el) return;

  if (!panelState.project) {
    const found = bookDir ? await findProjectConfig(bookDir) : null;
    if (!found) {
      el.innerHTML = `<div class="dp"><div class="dp-note dp-err">
        没找到 <code>调适项目_*.json</code>。<br>数据面板靠它定位各数据文件——
        请先在一本书的根目录放一份（模板见 <code>templates/调适项目_模板.json</code>），再重新打开本书。</div></div>`;
      return;
    }
    panelState.project = found;
    await loadAll(DATA_KINDS, found);
  }
  const project = panelState.project;

  const cur = DATA_KINDS.find((k) => k.id === panelState.active)!;
  const st = panelState.tables[cur.id] ?? { text: '', errs: [] };

  const tabs = DATA_KINDS.map((k) => {
    const e = panelState.tables[k.id]?.errs?.length ?? 0;
    return `<button class="dp-tab${k.id === cur.id ? ' active' : ''}" data-dp-tab="${k.id}">
      ${esc(k.label)}${e ? `<span class="dp-badge">${e}</span>` : ''}${k.derived ? '<span class="dp-ro">只读</span>' : ''}</button>`;
  }).join('');

  let body = '';
  if (cur.derived) {
    body = `<div class="dp-note dp-derived">此文件为<b>正本</b>，但其 App 分组配置与 Markdown 参数表为<b>派生</b>——改这里，然后重跑导出脚本。</div>`;
  }
  if (cur.format === 'json') {
    let data: { groups?: Record<string, unknown>[] } | null = null;
    try { data = JSON.parse(st.text); } catch { /* 解析失败时下面按空表渲染 */ }
    const gs = data?.groups ?? [];
    const 组 = gs.filter((g) => g['类型'] === '组');
    const 人 = gs.filter((g) => g['类型'] === '人');
    body += `<div class="dp-toolbar"><span class="dp-count">${组.length} 个组 · ${人.length} 个个人条目 · 合计 ${组.reduce((a, g) => a + (Number(g['成员数']) || 0), 0)} 人</span></div>
      <table class="dp-table"><thead><tr>
        <th>梯队</th><th>人数</th><th>句长上限</th><th>覆盖目标</th><th>生词率上限</th><th>支架密度</th><th>已学词</th><th>到期词</th>
      </tr></thead><tbody>${组.map((g) => `<tr>
        <td><b>${esc(String(g['名称'] ?? g['id']))}</b></td><td>${esc(String(g['成员数'] ?? ''))}</td>
        <td>${esc(String(g['句长上限'] ?? ''))}</td><td>${esc(String(g['覆盖目标'] ?? ''))}%</td>
        <td>${esc(String(g['生词率上限'] ?? ''))}%</td><td>${esc(String(g['支架密度'] ?? ''))}</td>
        <td>${((g['已学词'] as unknown[]) ?? []).length}</td><td>${((g['到期词'] as unknown[]) ?? []).length}</td>
      </tr>`).join('')}</tbody></table>
      <div class="dp-note" style="margin-top:10px">个人条目 ${人.length} 条（每人独立参数，此处折叠）。改动请编辑正本后重跑 <code>分层_导出App配置.py</code>。</div>`;
  } else if (cur.format === 'txt') {
    const lines = parseTxt(st.text);
    body += `<div class="dp-toolbar">
      <input id="dp-new" placeholder="新增专名（小写）"><button id="dp-add">添加</button>
      <input id="dp-filter" placeholder="筛选" value="${esc(panelState.filter)}">
      <span class="dp-count">${lines.length} 条</span></div>
      <div class="dp-list">${lines
        .filter((l) => !panelState.filter || l.includes(panelState.filter.toLowerCase()))
        .map((l) => `<div class="dp-row"><code>${esc(l)}</code><button data-dp-del="${esc(l)}">删除</button></div>`)
        .join('')}</div>`;
  } else {
    const t = toTable(st.text);
    const rows = t.rows.filter((r) => !panelState.filter ||
      Object.values(r).some((v) => String(v).toLowerCase().includes(panelState.filter.toLowerCase())));
    body += `<div class="dp-toolbar">
      <input id="dp-filter" placeholder="筛选" value="${esc(panelState.filter)}">
      <span class="dp-count">${t.rows.length} 行</span></div>
      <table class="dp-table"><thead><tr>${t.header.map((h) => `<th>${esc(h)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>${t.header.map((h) => `<td>${esc(r[h] ?? '')}</td>`).join('')}
        <td><button data-dp-del="${esc(r[cur.uniqueBy ?? t.header[0]!] ?? '')}">删除</button></td></tr>`).join('')}</tbody></table>`;
  }

  el.innerHTML = `<div class="dp">
      <div class="dp-head"><b>数据</b><span class="dp-sub">${esc(cur.note)}</span></div>
      <div class="dp-tabs">${tabs}</div>
      ${st.errs.length ? `<div class="dp-note dp-err">⚠ ${st.errs.length} 个校验问题：<br>${st.errs.slice(0, 5).map(esc).join('<br>')}${st.errs.length > 5 ? '<br>…' : ''}</div>` : '<div class="dp-note dp-ok">✓ 校验通过</div>'}
      ${body}
      ${panelState.log.length ? `<div class="dp-log"><b>本次改动</b><br>${panelState.log.slice(0, 5).map(esc).join('<br>')}</div>` : ''}
    </div>`;

  el.querySelectorAll('[data-dp-tab]').forEach((b) =>
    b.addEventListener('click', () => { panelState.active = (b as HTMLElement).dataset.dpTab!; void renderDataPane(bookDir); }));
  el.querySelector('#dp-filter')?.addEventListener('input', (e) => {
    panelState.filter = (e.target as HTMLInputElement).value; void renderDataPane(bookDir);
  });
  el.querySelector('#dp-add')?.addEventListener('click', async () => {
    const inp = el.querySelector('#dp-new') as HTMLInputElement;
    const r = upsertProperLine(st.text, inp.value);
    if (r.error) { alert(r.error); return; }
    const res = await save(cur, project, r.text, `新增专名 ${inp.value.trim().toLowerCase()}`);
    if (!res.ok) alert(res.error); else void renderDataPane(bookDir);
  });
  el.querySelectorAll('[data-dp-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      const key = (b as HTMLElement).dataset.dpDel!;
      if (!confirm(`确认删除「${key}」？`)) return;
      const r = cur.format === 'txt' ? deleteProperLine(st.text, key) : deleteRow(cur, st.text, key);
      if (r.error) { alert(r.error); return; }
      const res = await save(cur, project, r.text, `删除 ${key}`);
      if (!res.ok) alert(res.error); else void renderDataPane(bookDir);
    }));
}
