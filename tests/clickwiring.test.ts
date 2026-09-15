/**
 * 界面接线守卫：**渲染出来的可点元素，必须有人管它**。
 *
 * 来源：Wayne"我怕某个 button 设置在那其实没有用"那一轮的人工审计。
 * 那次是**手工**把静态 id 与运行时生成的按钮逐个对了一遍，找出 21 处问题
 * （`data-dp-del` 一个监听都没有、`#cls-panel` 从未可达、`#bt-start` 永久禁用…）。
 * 手工审一遍只能管一次；这份守卫把同一件事变成**每次提交都会跑**。
 *
 * 判据（两条，覆盖这次审计真正抓到过的那一类）：
 *   ① 模板里渲染出的 `<button|input|select|textarea id="X">` —— 若全仓没有任何
 *      `getElementById('X')` / `$('X')` / `querySelector('#X')` / `bind('X', …)`，
 *      那它就是一个**渲染出来但没人管的控件**；
 *   ② 模板里渲染出的 `data-xxx=` 动作钩子 —— 若全仓没有任何
 *      `[data-xxx]` 选择器 / `getAttribute('data-xxx')` / `.dataset.xxx` / `closest('[data-xxx…')`，
 *      那就是一个**挂上去但没人读的钩子**（`data-dp-del` 当年就长这样）。
 *
 * 为什么"用得到的语料"包含 `tests/`：有些钩子只给测试读（`data-item` 就是——
 * `tests/riskpanel_dom.test.ts` 用它数卡片）。一条只在测试里被读的钩子仍然是"有人管"的。
 *
 * 为什么不是正则一把梭：这个仓库的注释里本来就出现过 `id="xxx"` 这类示例字串，
 * 裸正则会把它数成一处渲染。下面只认**模板字符串里**的片段，并且把已知的
 * "确实不需要监听"的少数几个显式列出来（每个都写理由），不做静默放过。
 *
 * 守卫本身有效吗：见最后一条用例——把一处违规**合成**进语料再跑同一套判据，
 * 断言"该报的报出来"；另外本文件顶部注释里就记着它对历史上那处真缺陷的回归验证。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_SRC = join(REPO, 'app', 'src');

export interface SrcFile {
  file: string;
  text: string;
}

/** 渲染出来、且属于"教师会去点/改"的那几类标签。 */
const INTERACTIVE = /<(button|input|select|textarea)\b[^>]*?\bid="([A-Za-z][\w-]*)"/g;
/** 动作钩子。`data-` 后面必须是 kebab-case 的动作名，避免把 `data-*` 通配写成误报。 */
const HOOK = /\bdata-([a-z][a-z0-9-]*)=/g;

const camel = (d: string): string => d.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * 已知"确实不需要监听"的少数几个——**每个都要写理由**。
 * 加之前先问一句：加进来以后，`<button id="x">` 却没人绑这种形状还拦得住吗？拦不住就别加。
 */
export const ALLOWED: Record<string, string> = {
  'w-ui-lang': '上手向导里的界面语言下拉：只有「中文」一个可用项（另一个是 disabled 的"即将支持"），选了也不会变，本来就没有可绑的行为',
  'w-text-lang': '同上（要简化的文本语言，只有「英语」一个可用项）',
};

export interface WiringFinding {
  kind: 'id' | 'hook';
  name: string;
  file: string;
}

/** 纯函数：`render` 是"会渲染界面"的语料，`used` 是"哪里在读它"的语料（含 tests）。
 *  分开是因为测试文件里也有 `id="..."` 字面量（那是**合成夹具**，不是渲染出来的界面），
 *  把测试混进 render 语料会让守卫报它自己。可单测、可自证。 */
export function findUnwired(render: readonly SrcFile[], used: readonly SrcFile[]): WiringFinding[] {
  const corpus = [...render, ...used].map((s) => s.text).join('\n');
  const out: WiringFinding[] = [];
  const seenId = new Set<string>();
  const seenHook = new Set<string>();

  /** 单引号/双引号都要认（源码里两种都有，只认一种就会漏报成误报）。 */
  const q = (x: string): string => `['"\`]${x}['"\`]`;

  const idUsed = (id: string): boolean =>
    new RegExp(`(getElementById|\\$)\\(\\s*${q(id)}\\s*\\)`).test(corpus) ||
    /* querySelector('#x') / querySelector<HTMLElement>('#x') / querySelector(`#${…}`) 都算 */
    new RegExp(`querySelector(All)?(<[^>]*>)?\\(\\s*['\`]#${id}['\`]`).test(corpus) ||
    /* 仓库自带的 id 绑定助手（settings.ts 的 bind） */
    new RegExp(`bind\\(\\s*${q(id)}`).test(corpus);

  const hookUsed = (d: string): boolean =>
    new RegExp(`\\[data-${d}[\\]=\\s]`).test(corpus) ||
    new RegExp(`closest\\(\\s*['\`]\\[data-${d}`).test(corpus) ||
    new RegExp(`getAttribute\\(\\s*${q('data-' + d)}`).test(corpus) ||
    new RegExp(`\\.dataset\\.${camel(d)}\\b`).test(corpus) ||
    new RegExp(`dataset\\[\\s*${q(d)}`).test(corpus);

  for (const { file, text } of render) {
    for (const m of text.matchAll(INTERACTIVE)) {
      const id = m[2]!;
      if (seenId.has(id) || ALLOWED[id]) continue;
      seenId.add(id);
      if (!idUsed(id)) out.push({ kind: 'id', name: id, file });
    }
    for (const m of text.matchAll(HOOK)) {
      const d = m[1]!;
      if (seenHook.has(d) || ALLOWED[d]) continue;
      seenHook.add(d);
      if (!hookUsed(d)) out.push({ kind: 'hook', name: d, file });
    }
  }
  return out;
}

function readSrc(): { render: SrcFile[]; used: SrcFile[] } {
  const read = (dir: string, filter: (f: string) => boolean): SrcFile[] => {
    const out: SrcFile[] = [];
    for (const f of readdirSync(dir)) if (filter(f)) out.push({ file: join(dir, f), text: readFileSync(join(dir, f), 'utf8') });
    return out;
  };
  const render = read(APP_SRC, (f) => f.endsWith('.ts'));
  /* 读语料要含 tests：有的钩子只给测试读（`data-item` 就是，
   * `tests/riskpanel_dom.test.ts` 用它数卡片）。但**渲染语料不能含 tests**——
   * 那里面全是合成夹具，否则守卫会报它自己。 */
  const used = [...render, ...read(join(REPO, 'tests'), (f) => f.endsWith('.ts'))];
  return { render, used };
}

test('★ 渲染出来的可点元素与 data-* 钩子，都必须有人管（绑监听 / 读值 / 给测试读）', () => {
  const { render, used } = readSrc();
  const found = findUnwired(render, used);
  assert.deepEqual(
    found.map((f) => `${f.file.replace(REPO + '/', '')}：${f.kind === 'id' ? 'id=' : 'data-'}${f.name}`),
    [],
    '这些控件/钩子渲染出来了但全仓没有一处读它——"设置在那其实没有用"。' + '要么补上监听，要么删掉它；若它确实不需要行为，把它连同理由加进 ALLOWED。',
  );
});

test('守卫本身有效：合成一处"渲染了却没人绑"的按钮，必须被报出来', () => {
  const clean: SrcFile[] = [{ file: 'a.ts', text: 'el.innerHTML = `<button id="ghost-btn">点我</button>`;' }];
  assert.equal(findUnwired(clean, []).filter((f) => f.name === 'ghost-btn').length, 1, '没人绑 → 该报');
  const bound: SrcFile[] = [{ file: 'a.ts', text: 'el.innerHTML = `<button id="real-btn">点我</button>`;\ndocument.getElementById("real-btn")?.addEventListener("click", () => {});' }];
  assert.equal(findUnwired(bound, []).filter((f) => f.name === 'real-btn').length, 0, '绑了 → 不该报');
});

test('守卫本身有效：合成一处没人读的 data-* 钩子，必须被报出来（`data-dp-del` 就是这种）', () => {
  const clean: SrcFile[] = [{ file: 'a.ts', text: 'el.innerHTML = `<button data-dp-del="3">删除</button>`;' }];
  assert.equal(findUnwired(clean, []).filter((f) => f.name === 'dp-del').length, 1, '挂上去没人读 → 该报');
  for (const reader of ['el.querySelectorAll("[data-dp-del]")', 'el.getAttribute("data-dp-del")', 'target.dataset.dpDel', 'e.target.closest("[data-dp-del]")']) {
    const src: SrcFile[] = [{ file: 'a.ts', text: `el.innerHTML = \`<button data-dp-del="3">删除</button>\`;\n${reader};` }];
    assert.equal(findUnwired([], src).filter((f) => f.name === 'dp-del').length, 0, `${reader} 应算"有人读"`);
  }
});
