/**
 * UI 基础件（WP-F 拆分底座）：元素定位 $ / 状态行 setStatus / toast /
 * 标记弹层元素与开关 / 批量总结浮层 —— 各拆分模块的公共依赖（只依赖 state，无业务逻辑）。
 */

import { esc, S } from './state.js';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function setStatus(msg: string, cls = ''): void {
  $('status').innerHTML = msg ? `<span class="${cls}">${esc(msg)}</span>` : '';
}

export function toast(msg: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  let box = document.getElementById('toast-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast-box';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(
    () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 400);
    },
    kind === 'err' ? 6000 : 2600,
  );
}

window.addEventListener('error', (e) => toast('脚本错误：' + e.message, 'err'));
window.addEventListener('unhandledrejection', (e) => toast('异步错误：' + ((e.reason as Error)?.message ?? String(e.reason)), 'err'));

/* ---------- 标记弹层（词/短语/句面板与编辑器共用的浮层底座） ---------- */

export const pop = $('pop');

export function hidePop(): void {
  pop.classList.remove('open');
  S.popSession = null;
}

export function placePop(x: number, y: number): void {
  pop.classList.add('open');
  const rect = pop.getBoundingClientRect();
  const px = Math.min(Math.max(8, x), window.innerWidth - rect.width - 8);
  const py = Math.min(Math.max(8, y), window.innerHeight - rect.height - 8);
  pop.style.left = px + 'px';
  pop.style.top = py + 'px';
}

/* ---------- 批量执行总结面板（右下角浮层）：应用/⚠/拦下/落建议页 一张表看清 ---------- */

export function showSummaryPop(html: string): void {
  let el = document.getElementById('summary-pop');
  if (!el) {
    el = document.createElement('div');
    el.id = 'summary-pop';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.classList.add('open');
  el.querySelector('#sum-close')?.addEventListener('click', () => el!.classList.remove('open'));
  el.querySelector('#sum-suggest')?.addEventListener('click', () => {
    el!.classList.remove('open');
    window.dispatchEvent(new CustomEvent('layertext:open-suggest'));
  });
}
